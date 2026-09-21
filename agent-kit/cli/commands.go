package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type toolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// connect reads the token and returns a ready client, or prints the token error.
func connect(cfg config, stderr io.Writer) (*client, int) {
	token, err := readToken(cfg.tokenFile)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return nil, exitCodeOf(err)
	}
	return newClient(cfg, token, stderr), exitOK
}

// report prints err to stderr and returns its exit code.
func report(stderr io.Writer, err error) int {
	if err != nil {
		fmt.Fprintln(stderr, err)
	}
	return exitCodeOf(err)
}

// ---- tools (C5) ----

func parseTools(args []string) (commandRunner, error) {
	mode, schemaName := "lines", ""
	switch {
	case len(args) == 0:
	case len(args) == 1 && args[0] == "--json":
		mode = "json"
	case len(args) == 2 && args[0] == "--schema":
		mode, schemaName = "schema", args[1]
	default:
		return nil, fmt.Errorf("tools: unexpected arguments %q", args)
	}
	return func(cfg config, _ io.Reader, stdout, stderr io.Writer) int {
		c, code := connect(cfg, stderr)
		if c == nil {
			return code
		}
		rawTools, tools, err := listTools(c)
		if err != nil {
			return report(stderr, err)
		}
		switch mode {
		case "json":
			printLine(stdout, string(rawTools))
		case "schema":
			return printSchema(stdout, stderr, tools, schemaName)
		default:
			for _, t := range tools {
				fmt.Fprintf(stdout, "%s\t%s\n", t.Name, firstSentence(t.Description))
			}
		}
		return exitOK
	}, nil
}

func listTools(c *client) (json.RawMessage, []toolInfo, error) {
	payload, err := c.request(c.message("tools/list", nil), "tools/list", "")
	if err != nil {
		return nil, nil, err
	}
	env, err := decodeEnvelope(payload)
	if err != nil {
		return nil, nil, err
	}
	var result struct {
		Tools json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(env.Result, &result); err != nil || len(result.Tools) == 0 {
		return nil, nil, fail(exitHTTP, "tools/list result has no tools array")
	}
	var tools []toolInfo
	if err := json.Unmarshal(result.Tools, &tools); err != nil {
		return nil, nil, fail(exitHTTP, "tools/list tools is not an array of tools: %v", err)
	}
	return result.Tools, tools, nil
}

func printSchema(stdout, stderr io.Writer, tools []toolInfo, name string) int {
	for _, t := range tools {
		if t.Name == name {
			printLine(stdout, string(t.InputSchema))
			return exitOK
		}
	}
	fmt.Fprintf(stderr, "unknown tool: %s (list them with: vlpmcp tools)\n", name)
	return exitUsage
}

// firstSentence returns the description up to and including the first ". ",
// or all of it on one line (A2).
func firstSentence(desc string) string {
	oneLine := strings.TrimSpace(strings.ReplaceAll(desc, "\n", " "))
	if i := strings.Index(oneLine, ". "); i >= 0 {
		return oneLine[:i+1]
	}
	return oneLine
}

// ---- call (C6) ----

func parseCall(args []string) (commandRunner, error) {
	raw := false
	if len(args) > 0 && args[0] == "--raw" {
		raw, args = true, args[1:]
	}
	if len(args) < 1 || len(args) > 2 || strings.HasPrefix(args[0], "-") {
		return nil, errors.New("call needs <tool> and an optional JSON argument")
	}
	tool, argsJSON := args[0], "{}"
	if len(args) == 2 {
		argsJSON = args[1]
	}
	return func(cfg config, stdin io.Reader, stdout, stderr io.Writer) int {
		arguments, err := callArguments(argsJSON, stdin)
		if err != nil {
			return usageError(stderr, err.Error())
		}
		c, code := connect(cfg, stderr)
		if c == nil {
			return code
		}
		return runCall(c, tool, arguments, raw, stdout, stderr)
	}, nil
}

func callArguments(argsJSON string, stdin io.Reader) (json.RawMessage, error) {
	if argsJSON == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return nil, fmt.Errorf("reading arguments from stdin: %v", err)
		}
		argsJSON = string(data)
	}
	argsJSON = strings.TrimSpace(argsJSON)
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(argsJSON), &obj); err != nil {
		return nil, fmt.Errorf("arguments must be a JSON object: %v", err)
	}
	return json.RawMessage(argsJSON), nil
}

func runCall(c *client, tool string, arguments json.RawMessage, raw bool, stdout, stderr io.Writer) int {
	texts, payload, err := callTool(c, tool, arguments)
	if raw && payload != nil {
		printLine(stdout, string(payload))
		return report(stderr, err)
	}
	if err != nil {
		return report(stderr, err)
	}
	printLine(stdout, texts[0])
	for _, extra := range texts[1:] {
		printLine(stderr, extra)
	}
	return exitOK
}

// callTool returns the text of result.content[0] followed by the text of every
// additional item of type text, the raw payload (when the server answered) and
// the error, if any.
func callTool(c *client, tool string, arguments json.RawMessage) ([]string, []byte, error) {
	msg := c.message("tools/call", map[string]any{"name": tool, "arguments": arguments})
	payload, err := c.request(msg, "tools/call", tool)
	if err != nil {
		return nil, nil, err
	}
	env, err := decodeEnvelope(payload)
	if err != nil {
		return nil, payload, err
	}
	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(env.Result, &result); err != nil || len(result.Content) == 0 {
		return nil, payload, fail(exitRPC, "tools/call result has no content[0].text")
	}
	texts := []string{result.Content[0].Text}
	for _, item := range result.Content[1:] {
		if item.Type == "text" {
			texts = append(texts, item.Text)
		}
	}
	return texts, payload, nil
}

// ---- ping (C9) ----

func runPing(cfg config, _ io.Reader, stdout, stderr io.Writer) int {
	c, code := connect(cfg, stderr)
	if c == nil {
		return code
	}
	if err := c.initialize(); err != nil {
		return report(stderr, err)
	}
	payload, err := c.request(c.message("ping", nil), "ping", "")
	if err != nil {
		return report(stderr, err)
	}
	if _, err := decodeEnvelope(payload); err != nil {
		return report(stderr, err)
	}
	printLine(stdout, "ok")
	return exitOK
}

// ---- doctor (C10, A4) ----

// doctorMaxTimeout: doctor is a quick health check; it never inherits the long
// VLP_TIMEOUT default meant for Odoo operations (fb-020-007 §9.7 B5).
const doctorMaxTimeout = 120 * time.Second

func runDoctor(cfg config, _ io.Reader, stdout, stderr io.Writer) int {
	cfg.timeout = min(cfg.timeout, doctorMaxTimeout)
	token, tokenErr := readToken(cfg.tokenFile)
	c := newClient(cfg, token, stderr)

	// Any HTTP answer proves the server is up, even a 401 for a missing or
	// malformed token (a malformed one is never sent: token is "").
	initPayload, initErr := c.initializePayload()
	if exitCodeOf(initErr) == exitNetwork {
		fmt.Fprintln(stdout, "server: unreachable")
		return report(stderr, initErr)
	}
	fmt.Fprintln(stdout, "server: ok")

	if errors.Is(tokenErr, errInvalidTokenFile) {
		fmt.Fprintln(stdout, "token: invalid file")
		return report(stderr, tokenErr)
	}
	if tokenErr != nil {
		fmt.Fprintln(stdout, "token: missing")
		return report(stderr, tokenErr)
	}
	if exitCodeOf(initErr) == exitInvalidToken {
		fmt.Fprintln(stdout, "token: invalid")
		return report(stderr, initErr)
	}
	if initErr != nil {
		return report(stderr, initErr)
	}
	fmt.Fprintln(stdout, "token: ok")
	warnOutdatedKit(stdout, initPayload)

	_, _, err := callTool(c, "vlp_listTabs", json.RawMessage("{}"))
	if isNoExtension(err) {
		fmt.Fprintln(stdout, "extension: not connected")
		return exitNoExtension
	}
	if err != nil {
		return report(stderr, err)
	}
	fmt.Fprintln(stdout, "extension: connected")
	return exitOK
}

// warnOutdatedKit prints the kit line when both revisions are known and
// differ (§2.6). It is a warning only: it never changes the exit code.
func warnOutdatedKit(stdout io.Writer, initPayload []byte) {
	if kitRevision == "" || kitRevision == "dev" {
		return
	}
	var answer struct {
		Result struct {
			Meta map[string]any `json:"_meta"`
		} `json:"result"`
	}
	if err := json.Unmarshal(initPayload, &answer); err != nil {
		return
	}
	serverRevision, _ := answer.Result.Meta["vulpo/agentKitRevision"].(string)
	if serverRevision == "" || serverRevision == kitRevision {
		return
	}
	fmt.Fprintf(stdout, "kit: outdated (installed %s, server expects %s); update: extract the current agent kit and run install.sh\n",
		kitRevision, serverRevision)
}

func isNoExtension(err error) bool {
	var ee *exitError
	return errors.As(err, &ee) && ee.code == exitRPC &&
		strings.HasPrefix(ee.msg, "error -32000:") && strings.Contains(ee.msg, "No extension connected")
}
