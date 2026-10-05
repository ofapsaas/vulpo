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
	"sync"
	"time"
)

// protocolVersion is the MCP revision the Vulpo server speaks (spec D-1).
const protocolVersion = "2025-06-18"

var (
	// errSessionLost is returned when a re-initialized session 404s again.
	errSessionLost = errors.New("mcp session lost after re-initializing")
	// errUpstreamAuth is returned when Vulpo rejects the token (401).
	errUpstreamAuth = errors.New("mcp upstream rejected the token")
	// errEvalTimeout is returned when a request exceeds VLP_EVAL_TIMEOUT.
	errEvalTimeout = errors.New("eval timed out")
)

// mcpClient speaks the MCP Streamable HTTP transport against VLP_URL. The
// session id lives only in memory (D-8); on a 404 the client re-initializes
// once and retries once, exactly like vlpmcp (spec D-1, P11).
type mcpClient struct {
	url     string
	token   string
	http    *http.Client
	sessMu  sync.Mutex
	session string
	idMu    sync.Mutex
	nextID  int
}

func newMCPClient(url, token string, timeout time.Duration) *mcpClient {
	return &mcpClient{
		url:   url,
		token: token,
		http:  &http.Client{Timeout: timeout},
	}
}

type mcpResponse struct {
	status  int
	body    []byte
	session string
}

// message builds a JSON-RPC request with a fresh id.
func (c *mcpClient) message(method string, params any) []byte {
	c.idMu.Lock()
	c.nextID++
	id := c.nextID
	c.idMu.Unlock()
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	data, err := json.Marshal(msg)
	if err != nil {
		panic(fmt.Sprintf("vlp-odoosh-proxy: marshal %s request: %v", method, err))
	}
	return data
}

func (c *mcpClient) initializeMessage() []byte {
	return c.message("initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "vlp-odoosh-proxy", "version": version},
	})
}

// initializeLocked opens a session; sessMu must be held by the caller.
func (c *mcpClient) initializeLocked() error {
	resp, err := c.post(c.initializeMessage(), "")
	if err != nil {
		return err
	}
	if err := statusError(resp); err != nil {
		return err
	}
	if resp.session != "" {
		c.session = resp.session
	}
	return nil
}

// request sends msg within a session, initializing when needed and retrying
// once after a 404 (spec P11c).
func (c *mcpClient) request(msg []byte) (*mcpResponse, error) {
	c.sessMu.Lock()
	if c.session == "" {
		if err := c.initializeLocked(); err != nil {
			c.sessMu.Unlock()
			return nil, err
		}
	}
	session := c.session
	c.sessMu.Unlock()

	resp, err := c.post(msg, session)
	if err != nil {
		return nil, err
	}
	if resp.status == http.StatusNotFound {
		c.sessMu.Lock()
		c.session = ""
		if err := c.initializeLocked(); err != nil {
			c.sessMu.Unlock()
			return nil, err
		}
		session = c.session
		c.sessMu.Unlock()

		resp, err = c.post(msg, session)
		if err != nil {
			return nil, err
		}
		if resp.status == http.StatusNotFound {
			return nil, errSessionLost
		}
	}
	return resp, nil
}

// callTool invokes an MCP tool and maps the transport status to an error.
func (c *mcpClient) callTool(name string, args any) (*mcpResponse, error) {
	msg := c.message("tools/call", map[string]any{"name": name, "arguments": args})
	resp, err := c.request(msg)
	if err != nil {
		return nil, err
	}
	if err := statusError(resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// post sends one message with the v2 headers and returns the raw answer.
func (c *mcpClient) post(msg []byte, session string) (*mcpResponse, error) {
	req, err := http.NewRequest(http.MethodPost, c.url, bytes.NewReader(msg))
	if err != nil {
		return nil, fmt.Errorf("invalid VLP_URL %q: %w", c.url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("x-vlp-token", c.token)
	}
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	httpResp, err := c.http.Do(req)
	if err != nil {
		if isTimeout(err) {
			return nil, errEvalTimeout
		}
		return nil, err
	}
	defer httpResp.Body.Close()
	body, err := io.ReadAll(httpResp.Body)
	if err != nil {
		if isTimeout(err) {
			return nil, errEvalTimeout
		}
		return nil, err
	}
	return &mcpResponse{
		status:  httpResp.StatusCode,
		body:    body,
		session: httpResp.Header.Get("Mcp-Session-Id"),
	}, nil
}

// statusError maps the HTTP status of an MCP answer to a transport error.
func statusError(resp *mcpResponse) error {
	switch resp.status {
	case http.StatusOK, http.StatusAccepted:
		return nil
	case http.StatusUnauthorized:
		return errUpstreamAuth
	}
	return fmt.Errorf("mcp answered HTTP %d", resp.status)
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// rpcError is a JSON-RPC error object.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type toolResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// toolText extracts content[0].text from a tools/call answer. A tool error is
// returned separately so callers can map it without treating it as a
// malformed response.
func toolText(payload []byte) (string, *rpcError, error) {
	var env rpcEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return "", nil, fmt.Errorf("mcp response is not JSON-RPC: %w", err)
	}
	if env.Error != nil {
		return "", env.Error, nil
	}
	var tr toolResult
	if err := json.Unmarshal(env.Result, &tr); err != nil {
		return "", nil, fmt.Errorf("mcp tool result is malformed: %w", err)
	}
	if len(tr.Content) == 0 {
		return "", nil, errors.New("mcp tool result has no content")
	}
	return tr.Content[0].Text, nil, nil
}
