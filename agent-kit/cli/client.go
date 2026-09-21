package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// client speaks MCP over HTTP to the Vulpo server (C2–C4, C11).
type client struct {
	cfg     config
	token   string
	session string
	http    *http.Client
	stderr  io.Writer
	nextID  int
}

// response is one HTTP answer; payload is the JSON-RPC message (JSON or SSE data).
type response struct {
	status  int
	payload []byte
}

// rpcEnvelope is the part of a JSON-RPC response vlpmcp inspects.
type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func newClient(cfg config, token string, stderr io.Writer) *client {
	return &client{
		cfg:     cfg,
		token:   token,
		session: readSession(cfg.sessionFile),
		http:    &http.Client{Timeout: cfg.timeout},
		stderr:  stderr,
	}
}

func (c *client) newID() int {
	c.nextID++
	return c.nextID
}

// message builds a JSON-RPC request with a fresh id.
func (c *client) message(method string, params any) []byte {
	msg := map[string]any{"jsonrpc": "2.0", "id": c.newID(), "method": method}
	if params != nil {
		msg["params"] = params
	}
	data, err := json.Marshal(msg)
	if err != nil {
		panic(fmt.Sprintf("vlpmcp: marshal %s request: %v", method, err))
	}
	return data
}

func (c *client) initializeMessage() []byte {
	return c.message("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "vlpmcp", "version": version},
	})
}

// initialize opens (or revalidates) the session and stores it on disk.
func (c *client) initialize() error {
	_, err := c.initializePayload()
	return err
}

// initializePayload is initialize returning the server's JSON-RPC answer.
func (c *client) initializePayload() ([]byte, error) {
	resp, err := c.post(c.initializeMessage(), "initialize", "")
	if err != nil {
		return nil, err
	}
	if err := checkStatus(resp); err != nil {
		return nil, err
	}
	return resp.payload, nil
}

// request sends msg within a session: it initializes when there is none and,
// on a 404, re-initializes once and retries once (C3). A nil payload means
// the server accepted a notification (202).
func (c *client) request(msg []byte, method, tool string) ([]byte, error) {
	if c.session == "" {
		if err := c.initialize(); err != nil {
			return nil, err
		}
	}
	resp, err := c.post(msg, method, tool)
	if err != nil {
		return nil, err
	}
	if resp.status == http.StatusNotFound {
		c.dropSession()
		if err := c.initialize(); err != nil {
			return nil, err
		}
		if resp, err = c.post(msg, method, tool); err != nil {
			return nil, err
		}
		if resp.status == http.StatusNotFound {
			return nil, fail(exitHTTP, "session not found (HTTP 404) after re-initializing")
		}
	}
	if err := checkStatus(resp); err != nil {
		return nil, err
	}
	return resp.payload, nil
}

// checkStatus maps HTTP statuses to exit errors (C7, A7).
func checkStatus(resp *response) error {
	switch resp.status {
	case http.StatusOK, http.StatusAccepted:
		return nil
	case http.StatusUnauthorized:
		return fail(exitInvalidToken, "invalid token (401)")
	}
	return fail(exitHTTP, "server answered HTTP %d", resp.status)
}

// post sends one message, stores a newly issued session and logs the request.
func (c *client) post(msg []byte, method, tool string) (*response, error) {
	start := time.Now()
	resp, err := c.send(msg)
	logExit := exitNetwork
	if resp != nil {
		logExit = resp.status
	}
	c.logRequest(start, method, tool, logExit)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (c *client) send(msg []byte) (*response, error) {
	req, err := http.NewRequest(http.MethodPost, c.cfg.url, bytes.NewReader(msg))
	if err != nil {
		return nil, fail(exitUsage, "invalid VLP_URL %q: %v", c.cfg.url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if c.token != "" {
		req.Header.Set("x-vlp-token", c.token)
	}
	if c.session != "" {
		req.Header.Set("Mcp-Session-Id", c.session)
	}
	httpResp, err := c.http.Do(req)
	if isClientTimeout(err) {
		return nil, c.noAnswerError()
	}
	if err != nil {
		return nil, fail(exitNetwork, "server unreachable: %v", err)
	}
	defer httpResp.Body.Close()
	body, err := io.ReadAll(httpResp.Body)
	if isClientTimeout(err) {
		return nil, c.noAnswerError()
	}
	if err != nil {
		return nil, fail(exitNetwork, "reading server response: %v", err)
	}
	if issued := httpResp.Header.Get("Mcp-Session-Id"); httpResp.StatusCode == http.StatusOK && issued != "" && issued != c.session {
		c.storeSession(issued)
	}
	payload := body
	if strings.HasPrefix(httpResp.Header.Get("Content-Type"), "text/event-stream") {
		payload = sseData(body)
	}
	return &response{status: httpResp.StatusCode, payload: payload}, nil
}

func (c *client) noAnswerError() error {
	return fail(exitNetwork, "no answer from server within %ds (VLP_TIMEOUT); the server may still be processing the request", int(c.cfg.timeout/time.Second))
}

// isClientTimeout reports whether err is vlpmcp's own VLP_TIMEOUT expiring
// (fb-020-007 §2.5), as opposed to the server being unreachable.
func isClientTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// sseData joins the data: lines of the first SSE event.
func sseData(body []byte) []byte {
	var data []string
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" && len(data) > 0 {
			break
		}
		if rest, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(rest, " "))
		}
	}
	return []byte(strings.Join(data, "\n"))
}

// decodeEnvelope parses a JSON-RPC response; a server "error" becomes exit 5.
func decodeEnvelope(payload []byte) (*rpcEnvelope, error) {
	var env rpcEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, fail(exitHTTP, "server response is not JSON-RPC: %v", err)
	}
	if env.Error != nil {
		return &env, fail(exitRPC, "error %d: %s", env.Error.Code, env.Error.Message)
	}
	return &env, nil
}

func readSession(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// storeSession writes the session id atomically with mode 0600 (C3).
func (c *client) storeSession(id string) {
	c.session = id
	path := c.cfg.sessionFile
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot create session dir: %v\n", err)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(id+"\n"), 0o600); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot save session: %v\n", err)
		return
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot save session: %v\n", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot save session: %v\n", err)
	}
}

func (c *client) dropSession() {
	c.session = ""
	if err := os.Remove(c.cfg.sessionFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot remove session file: %v\n", err)
	}
}

// logEntry is the only shape written to VLP_LOG (C11): no arguments,
// results or token.
type logEntry struct {
	TS     string `json:"ts"`
	Method string `json:"method"`
	Tool   string `json:"tool,omitempty"`
	MS     int64  `json:"ms"`
	Exit   int    `json:"exit"`
}

func (c *client) logRequest(start time.Time, method, tool string, exit int) {
	if c.cfg.logFile == "" {
		return
	}
	line, err := json.Marshal(logEntry{
		TS:     start.UTC().Format(time.RFC3339Nano),
		Method: method,
		Tool:   tool,
		MS:     time.Since(start).Milliseconds(),
		Exit:   exit,
	})
	if err != nil {
		panic(fmt.Sprintf("vlpmcp: marshal log entry: %v", err))
	}
	f, err := os.OpenFile(c.cfg.logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot open VLP_LOG: %v\n", err)
		return
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		fmt.Fprintf(c.stderr, "vlpmcp: warning: cannot write VLP_LOG: %v\n", err)
	}
}
