// fake_mcp_test.go — in-process fake of the Vulpo MCP Streamable HTTP
// transport (/mcp), per fb-025-001 spec §3.3. Pure stdlib (net/http/httptest).
//
// It mirrors the wire contract the proxy must speak:
//   - auth: x-vlp-token absent/wrong -> 401
//   - initialize -> 200 + Mcp-Session-Id (protocolVersion registered)
//   - tools/call with absent/invalid Mcp-Session-Id -> 404
//   - Accept must contain application/json (else 406)
//   - tools/call "vlp_eval" -> double envelope content[0].text =
//     {"result":"<json string of {status,ct,url,body}>"}
//   - tools/call "vlp_listTabs" -> content[0].text = a BARE JSON array of tab
//     objects [{id,url,title,windowId,active,pinned,index}] (spec §3.7)
//   - programmable table path -> {status,ct,body,url} matched against the eval
//     code (a url with "/web/login" drives P4a)
//   - overlap flag per tabId (P14) and a per-eval delay (P6 timeout)
//   - full request registry (headers, arguments, body, counter) for assertions
package main_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	noExtensionMsg = "No extension connected for token"
	noTabMsgPrefix = "No extension has tab"
)

// fakePage is the canned result of one proxied `POST /app/<route>`: exactly
// the {status, ct, url, body} tuple the eval returns.
type fakePage struct {
	status int
	ct     string
	body   string
	url    string
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int
	Message string
}

type recorded struct {
	HTTPMethod      string
	Path            string
	Method          string
	ID              json.RawMessage
	Token           string
	ContentType     string
	Accept          string
	SessionID       string // Mcp-Session-Id sent by the proxy
	IssuedSession   string // Mcp-Session-Id returned by the fake (initialize)
	Status          int
	ToolName        string
	Arguments       json.RawMessage
	Body            string // raw request body (P5: must not carry the token)
	Cookie          string // Cookie header the proxy sent (P2: must be empty)
	HasCookie       bool
	ProtocolVersion string // initialize params.protocolVersion
}

type fakeResponse struct {
	status  int
	session string
	text    string
	msg     map[string]any
	delay   time.Duration
}

type fakeMCP struct {
	srv *httptest.Server

	mu         sync.Mutex
	token      string
	serverName string
	sessions   map[string]bool
	seq        int
	reqs       []recorded

	pages       map[string]fakePage
	defaultPage fakePage
	tabs        []map[string]any

	evalErr    *rpcError
	callDelay  time.Duration
	callStatus int
	reject404  bool
	expireNext int

	inFlight map[int]bool
	overlap  bool
}

func newFakeMCP(t *testing.T) *fakeMCP {
	t.Helper()
	f := &fakeMCP{
		token:      sentinelToken,
		serverName: "vulpo-proxy-fake",
		sessions:   map[string]bool{},
		pages:      map[string]fakePage{},
		defaultPage: fakePage{
			status: 200,
			ct:     "application/json; charset=utf-8",
			body:   sampleRPCResponse,
			url:    "https://www.odoo.sh/app/default",
		},
		tabs:     []map[string]any{tabWire(22, "https://www.odoo.sh/app", "odoo.sh", 0)},
		inFlight: map[int]bool{},
	}
	f.srv = httptest.NewServer(f)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMCP) URL() string { return f.srv.URL + "/mcp" }

func (f *fakeMCP) set(fn func(f *fakeMCP)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeMCP) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func (f *fakeMCP) resetRequests() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = nil
}

func (f *fakeMCP) addPage(path string, p fakePage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pages[path] = p
}

func (f *fakeMCP) byMethod(method string) []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recorded
	for _, r := range f.reqs {
		if r.Method == method {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeMCP) toolCalls(name string) []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recorded
	for _, r := range f.reqs {
		if r.Method == "tools/call" && r.ToolName == name {
			out = append(out, r)
		}
	}
	return out
}

// overlapped reports whether two evals to the same tab were ever in flight at
// the same time (P14).
func (f *fakeMCP) overlapped() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.overlap
}

func (f *fakeMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	cookie := r.Header.Get("Cookie")
	rec := recorded{
		HTTPMethod:  r.Method,
		Path:        r.URL.Path,
		Token:       r.Header.Get("x-vlp-token"),
		ContentType: r.Header.Get("Content-Type"),
		Accept:      r.Header.Get("Accept"),
		SessionID:   r.Header.Get("Mcp-Session-Id"),
		Cookie:      cookie,
		HasCookie:   cookie != "",
		Body:        string(body),
	}
	var req rpcRequest
	parseErr := json.Unmarshal(body, &req)
	rec.Method = req.Method
	rec.ID = req.ID
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		rec.ProtocolVersion = p.ProtocolVersion
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &p)
		rec.ToolName = p.Name
		rec.Arguments = p.Arguments
	}

	// Overlap bookkeeping for vlp_eval, held across the simulated eval delay.
	isEval := rec.Method == "tools/call" && rec.ToolName == "vlp_eval"
	if isEval {
		tabID := argTabID(rec.Arguments)
		f.mu.Lock()
		if f.inFlight[tabID] {
			f.overlap = true
		}
		f.inFlight[tabID] = true
		f.mu.Unlock()
		defer func() {
			f.mu.Lock()
			f.inFlight[tabID] = false
			f.mu.Unlock()
		}()
	}

	f.mu.Lock()
	resp := f.decide(&rec, req, parseErr)
	rec.Status = resp.status
	rec.IssuedSession = resp.session
	f.reqs = append(f.reqs, rec)
	f.mu.Unlock()

	if resp.delay > 0 {
		timer := time.NewTimer(resp.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
	}
	if resp.session != "" {
		w.Header().Set("Mcp-Session-Id", resp.session)
	}
	if resp.msg == nil {
		if resp.text != "" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
		w.WriteHeader(resp.status)
		_, _ = io.WriteString(w, resp.text)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.status)
	_, _ = io.WriteString(w, marshalNoHTML(resp.msg))
}

// decide must be called with f.mu held.
func (f *fakeMCP) decide(rec *recorded, req rpcRequest, parseErr error) fakeResponse {
	if rec.HTTPMethod != http.MethodPost {
		return fakeResponse{status: http.StatusMethodNotAllowed, text: "method not allowed"}
	}
	if rec.Token != f.token {
		return fakeResponse{status: http.StatusUnauthorized, text: "invalid token"}
	}
	if !strings.Contains(rec.Accept, "application/json") {
		return fakeResponse{status: http.StatusNotAcceptable, text: "not acceptable"}
	}
	if parseErr != nil {
		return fakeResponse{status: http.StatusBadRequest, text: "invalid JSON"}
	}

	session := ""
	if req.Method == "initialize" {
		f.seq++
		session = fmt.Sprintf("fake-session-%d", f.seq)
		f.sessions[session] = true
	} else {
		if rec.SessionID == "" || !f.sessions[rec.SessionID] || f.reject404 {
			return fakeResponse{status: http.StatusNotFound, text: "session not found"}
		}
		if f.expireNext > 0 {
			f.expireNext--
			delete(f.sessions, rec.SessionID)
			return fakeResponse{status: http.StatusNotFound, text: "session not found"}
		}
	}
	if len(req.ID) == 0 {
		return fakeResponse{status: http.StatusAccepted, session: session}
	}
	if rec.Method == "tools/call" && f.callStatus != 0 {
		return fakeResponse{status: f.callStatus, text: "forced status"}
	}

	msg := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	var delay time.Duration
	switch req.Method {
	case "initialize":
		msg["result"] = map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": f.serverName, "version": "0.4.1"},
		}
	case "tools/list":
		msg["result"] = map[string]any{"tools": []any{}}
	case "tools/call":
		switch rec.ToolName {
		case "vlp_listTabs":
			msg["result"] = map[string]any{
				"content": []any{map[string]any{"type": "text", "text": f.tabsText()}},
			}
		case "vlp_eval":
			if f.evalErr != nil {
				msg["error"] = map[string]any{"code": f.evalErr.Code, "message": f.evalErr.Message}
			} else {
				page := f.pageFor(rec.Arguments)
				msg["result"] = map[string]any{
					"content": []any{map[string]any{"type": "text", "text": pageEnvelope(page)}},
				}
			}
			delay = f.callDelay
		default:
			msg["error"] = map[string]any{"code": -32601, "message": "tool not found"}
		}
	default:
		msg["error"] = map[string]any{"code": -32601, "message": "method not found"}
	}
	return fakeResponse{status: http.StatusOK, session: session, msg: msg, delay: delay}
}

// pageFor picks the programmable page whose path key appears in the eval code
// (longest key wins for determinism); defaultPage when nothing matches.
func (f *fakeMCP) pageFor(args json.RawMessage) fakePage {
	var a struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(args, &a)
	best := ""
	for k := range f.pages {
		if strings.Contains(a.Code, k) && len(k) > len(best) {
			best = k
		}
	}
	if best != "" {
		return f.pages[best]
	}
	return f.defaultPage
}

// tabsText returns the exact content[0].text the real server emits for
// vlp_listTabs: a BARE JSON array of tab objects (spec §3.7, Enmienda 1) — NOT
// an object {"tabs":[...],"count":N}. Emitting the object shape would let the
// proxy parse a wire Vulpo never sends (the fb-025-001 review BLOCKING #1:
// the old fake made P7 pass against the wrong wire).
func (f *fakeMCP) tabsText() string {
	return marshalNoHTML(f.tabs)
}

// tabWire builds one element of the vlp_listTabs result exactly as the
// extension emits it (background.js listTabs -> tabs.map), per spec §3.7:
// {id,url,title,windowId,active,pinned,index}.
func tabWire(id int, url, title string, index int) map[string]any {
	return map[string]any{
		"id":       id,
		"url":      url,
		"title":    title,
		"windowId": 1,
		"active":   index == 0,
		"pinned":   false,
		"index":    index,
	}
}

// pageEnvelope builds the double envelope the real server emits:
// content[0].text = {"result":"<json string of {status,ct,url,body}>"}.
func pageEnvelope(p fakePage) string {
	pageJSON := marshalNoHTML(map[string]any{
		"status": p.status,
		"ct":     p.ct,
		"url":    p.url,
		"body":   p.body,
	})
	return marshalNoHTML(map[string]any{"result": pageJSON})
}

// marshalNoHTML encodes without HTML escaping so page bodies round-trip
// byte-for-byte (P1).
func marshalNoHTML(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(buf.String(), "\n")
}

func argTabID(args json.RawMessage) int {
	var a struct {
		TabID int `json:"tabId"`
	}
	_ = json.Unmarshal(args, &a)
	return a.TabID
}
