package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

const maxStdioLine = 64 << 20

// runStdio bridges line-delimited JSON-RPC on stdin/stdout to the server (C12).
func runStdio(cfg config, stdin io.Reader, stdout, stderr io.Writer) int {
	c, code := connect(cfg, stderr)
	if c == nil {
		return code
	}
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64<<10), maxStdioLine)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		reply := c.forward(line)
		if reply != nil {
			fmt.Fprintf(stdout, "%s\n", reply)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(stderr, "vlpmcp mcp-stdio: reading stdin: %v\n", err)
		return exitUsage
	}
	return exitOK
}

// forward relays one client message and returns the single-line reply, or
// nil for notifications.
func (c *client) forward(line []byte) []byte {
	var head struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp mcp-stdio: invalid JSON-RPC line: %v\n", err)
		return rpcErrorLine(json.RawMessage("null"), -32700, "parse error")
	}
	isNotification := len(head.ID) == 0

	payload, err := c.relay(line, head.Method, head.Params.Name)
	if err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp mcp-stdio: %s: %v\n", head.Method, err)
		if isNotification {
			return nil
		}
		return rpcErrorLine(head.ID, -32000, "vlpmcp: "+err.Error())
	}
	if isNotification || len(payload) == 0 {
		return nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, payload); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp mcp-stdio: server response is not JSON: %v\n", err)
		return rpcErrorLine(head.ID, -32000, "vlpmcp: server response is not JSON")
	}
	return compact.Bytes()
}

// relay sends the client's initialize as-is (its result is the server's) and
// everything else through the session/retry logic.
func (c *client) relay(line []byte, method, name string) ([]byte, error) {
	if method != "initialize" {
		tool := ""
		if method == "tools/call" {
			tool = name
		}
		return c.request(line, method, tool)
	}
	resp, err := c.post(line, method, "")
	if err != nil {
		return nil, err
	}
	if err := checkStatus(resp); err != nil {
		return nil, err
	}
	return resp.payload, nil
}

func rpcErrorLine(id json.RawMessage, code int, message string) []byte {
	data, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
	if err != nil {
		panic(fmt.Sprintf("vlpmcp: marshal error response: %v", err))
	}
	return data
}
