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

	// fb-025-002 programmable resilience state (spec §3.4). Every field has a
	// neutral zero value so the 001 suite is unaffected; connected is the one
	// exception (zero false would break 001) and is set true in newFakeMCP.
	connected           bool     // false => vlp_listTabs/vlp_eval -> -32000 noExtensionMsg
	discarded           bool     // stateful "tab discarded": page eval -> -32000 candidate
	discardedTab        int      // tab the discard applies to (0 = any tab)
	discardedMsg        string   // raw -32000 while discarded ("" => generic Firefox text)
	navigateRecovers    bool     // a vlp_navigate to the tab clears discarded
	activateRecovers    bool     // a vlp_activateTab to the tab clears discarded
	readyStates         []string // probe sequence (pop; last repeats; empty => "complete")
	lastReadyState      string
	listTabsEmpty       int  // first K vlp_listTabs calls return []
	listTabsAlwaysEmpty bool // every vlp_listTabs call returns []
	transportHuge       int  // >0 => pad the tools/call response beyond this many bytes
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
		// fb-025-002 §6: connected must default true, or every 001 test that
		// reaches vlp_listTabs/vlp_eval would get a spurious -32000.
		connected: true,
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
			if !f.connected {
				msg["error"] = map[string]any{"code": -32000, "message": noExtensionMsg}
				break
			}
			if f.listTabsAlwaysEmpty || f.listTabsEmpty > 0 {
				if f.listTabsEmpty > 0 {
					f.listTabsEmpty--
				}
				// H4: emit a bare empty ARRAY, never null (marshalNoHTML(nil)).
				msg["result"] = map[string]any{
					"content": []any{map[string]any{"type": "text", "text": "[]"}},
				}
				break
			}
			msg["result"] = map[string]any{
				"content": []any{map[string]any{"type": "text", "text": f.tabsText()}},
			}
		case "vlp_eval":
			// §6 priority: connected -> probe -> discarded -> evalErr -> page.
			if !f.connected {
				msg["error"] = map[string]any{"code": -32000, "message": noExtensionMsg}
			} else if isReadyStateProbe(argCode(rec.Arguments)) {
				// H2: readyState probe -> {"result":"<readyState>"} (plain string).
				msg["result"] = map[string]any{
					"content": []any{map[string]any{"type": "text", "text": marshalNoHTML(map[string]any{"result": f.nextReadyState()})}},
				}
			} else if f.discarded && (f.discardedTab == 0 || argTabID(rec.Arguments) == f.discardedTab) {
				raw := f.discardedMsg
				if raw == "" {
					raw = discardedCandidateMsg
				}
				msg["error"] = map[string]any{"code": -32000, "message": raw}
			} else if f.evalErr != nil {
				msg["error"] = map[string]any{"code": f.evalErr.Code, "message": f.evalErr.Message}
			} else {
				page := f.pageFor(rec.Arguments)
				msg["result"] = map[string]any{
					"content": []any{map[string]any{"type": "text", "text": pageEnvelope(page)}},
				}
			}
			delay = f.callDelay
		case "vlp_navigate":
			// Wire pinned in spec §3.4: {"success":true,"tabId":<id>,"url":"<url>"}.
			if !f.connected {
				msg["error"] = map[string]any{"code": -32000, "message": noExtensionMsg}
				break
			}
			var a struct {
				TabID int    `json:"tabId"`
				URL   string `json:"url"`
			}
			_ = json.Unmarshal(rec.Arguments, &a)
			if f.discarded && f.navigateRecovers && (f.discardedTab == 0 || a.TabID == f.discardedTab) {
				f.discarded = false
			}
			msg["result"] = map[string]any{
				"content": []any{map[string]any{"type": "text", "text": marshalNoHTML(map[string]any{"success": true, "tabId": a.TabID, "url": a.URL})}},
			}
		case "vlp_activateTab":
			// Wire pinned in spec §3.4: {"success":true,"tabId":<id>,"title":…,"url":…}.
			if !f.connected {
				msg["error"] = map[string]any{"code": -32000, "message": noExtensionMsg}
				break
			}
			var a struct {
				TabID int `json:"tabId"`
			}
			_ = json.Unmarshal(rec.Arguments, &a)
			if f.discarded && f.activateRecovers && (f.discardedTab == 0 || a.TabID == f.discardedTab) {
				f.discarded = false
			}
			title, url := f.tabInfo(a.TabID)
			msg["result"] = map[string]any{
				"content": []any{map[string]any{"type": "text", "text": marshalNoHTML(map[string]any{"success": true, "tabId": a.TabID, "title": title, "url": url})}},
			}
		default:
			msg["error"] = map[string]any{"code": -32601, "message": "tool not found"}
		}
		// C-8: keep content[0].text a SMALL page and carry the excess in an
		// ignored field, so 001 (no transport cap) still returns 200 and the
		// P10 failure is by the missing capability, not the wrong reason.
		if f.transportHuge > 0 {
			msg["padding"] = strings.Repeat("x", f.transportHuge)
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

// ---------------------------------------------------------------------------
// fb-025-002 fake helpers (spec §3.4)
// ---------------------------------------------------------------------------

// readyStateProbe is the exact eval code that reads document.readyState.
const readyStateProbe = "document.readyState"

// discardedCandidateMsg is the generic Firefox message surfaced for an
// inactive/discarded tab (spec 002 §3.4 #1, §3.5.1).
const discardedCandidateMsg = "An unexpected error occurred"

// argCode extracts the `code` argument of a vlp_eval call (spec §3.4).
func argCode(args json.RawMessage) string {
	var a struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(args, &a)
	return a.Code
}

// isReadyStateProbe reports whether an eval code is the readyState probe
// (H7: exact match after trim, so it never depends on the page marker).
func isReadyStateProbe(code string) bool {
	return strings.TrimSpace(code) == readyStateProbe
}

// nextReadyState pops the programmed readyState sequence; the last value
// repeats, and an empty sequence yields "complete" (spec §3.4 #4). Must be
// called with f.mu held.
func (f *fakeMCP) nextReadyState() string {
	if len(f.readyStates) > 0 {
		s := f.readyStates[0]
		f.readyStates = f.readyStates[1:]
		f.lastReadyState = s
		return s
	}
	if f.lastReadyState != "" {
		return f.lastReadyState
	}
	return "complete"
}

// tabInfo returns the title/url the extension reports for a tab id.
func (f *fakeMCP) tabInfo(id int) (title, url string) {
	for _, t := range f.tabs {
		if v, ok := t["id"].(int); ok && v == id {
			title, _ = t["title"].(string)
			url, _ = t["url"].(string)
			return title, url
		}
	}
	return "", ""
}
