package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// maxEvalCode is Vulpo's derived code cap (spec D-10): beyond it -> 413.
	maxEvalCode = 20000
	// maxResponseBody is the 1 MiB ceiling on the decoded page body (D-10):
	// beyond it the proxy rejects with 502 instead of truncating.
	maxResponseBody = 1 << 20
)

// proxy is the HTTP handler: it discards the Cookie, enforces the allowlist,
// translates POST /app/* into a Vulpo eval and maps errors (spec §3).
type proxy struct {
	cfg    config
	client *mcpClient
	locker *tabLocker
	logMu  sync.Mutex
}

func newProxy(cfg config, client *mcpClient) *proxy {
	return &proxy{cfg: cfg, client: client, locker: newTabLocker()}
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// /healthz is evaluated before the path guard (spec D-5, §3.4).
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		p.healthz(w)
		return
	}
	if !allowedRequest(r) {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	p.handleApp(w, r)
}

// allowedRequest enforces the allowlist: POST and a clean /app/ path (spec P3).
func allowedRequest(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	path := r.URL.Path
	if !strings.HasPrefix(path, "/app/") {
		return false
	}
	for _, bad := range []string{"//", "\\", "@", "://", ".."} {
		if strings.Contains(path, bad) {
			return false
		}
	}
	return true
}

// handleApp runs one allowed request: build the eval, resolve the tab, call
// Vulpo serialized per tab and answer with the page or a mapped error.
func (p *proxy) handleApp(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "cannot read request body")
		return
	}
	path := r.URL.Path
	code := buildEvalCode(path, string(body))
	if len(code) > maxEvalCode {
		writeError(w, http.StatusRequestEntityTooLarge, "eval code exceeds 20000 characters")
		return
	}

	// The Cookie is discarded: only its presence is logged, never its value.
	p.logRequest(r, path)

	tabID, err := p.resolveTab()
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	release := p.locker.lock(tabID)
	resp, err := p.client.callTool("vlp_eval", map[string]any{"tabId": tabID, "code": code})
	release()
	if err != nil {
		p.writeClientError(w, err)
		return
	}

	text, rpcErr, err := toolText(resp.body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream response is malformed")
		return
	}
	if rpcErr != nil {
		writeError(w, http.StatusBadGateway, rpcErr.Message)
		return
	}
	page, err := decodePage(text)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream eval result is malformed")
		return
	}
	p.writePage(w, page)
}

// resolveTab returns the target tab: VLP_EVAL_TAB when set, otherwise the
// first tab whose url starts with VLP_TAB_URL_PREFIX (spec P7).
func (p *proxy) resolveTab() (int, error) {
	if p.cfg.evalTab != "" {
		id, err := strconv.Atoi(p.cfg.evalTab)
		if err != nil {
			return 0, fmt.Errorf("VLP_EVAL_TAB is not a tab id: %q", p.cfg.evalTab)
		}
		return id, nil
	}

	resp, err := p.client.callTool("vlp_listTabs", map[string]any{})
	if err != nil {
		return 0, errors.New("cannot list Vulpo tabs")
	}
	text, rpcErr, err := toolText(resp.body)
	if err != nil || rpcErr != nil {
		return 0, errors.New("cannot list Vulpo tabs")
	}
	// The real vlp_listTabs wire is a BARE JSON array of tab objects in
	// content[0].text (spec §3.7, Enmienda 1). The object shape
	// {"tabs":[…]} is accepted too for robustness.
	type tabInfo struct {
		ID  int    `json:"id"`
		URL string `json:"url"`
	}
	var tabs []tabInfo
	if err := json.Unmarshal([]byte(text), &tabs); err != nil {
		var listing struct {
			Tabs []tabInfo `json:"tabs"`
		}
		if err := json.Unmarshal([]byte(text), &listing); err != nil {
			return 0, errors.New("cannot list Vulpo tabs")
		}
		tabs = listing.Tabs
	}
	for _, tab := range tabs {
		if strings.HasPrefix(tab.URL, p.cfg.tabPrefix) {
			return tab.ID, nil
		}
	}
	return 0, fmt.Errorf("no tab found with url prefix %q", p.cfg.tabPrefix)
}

// buildEvalCode wraps the path and body in a synchronous same-origin XHR that
// returns JSON.stringify({status,ct,url,body}) (spec §3.1 D-1, P1/P4).
func buildEvalCode(path, body string) string {
	return "(function(){" +
		"var x=new XMLHttpRequest();" +
		"x.open(\"POST\"," + strconv.Quote(path) + ",false);" +
		"x.setRequestHeader(\"Content-Type\",\"application/json\");" +
		"x.send(" + strconv.Quote(body) + ");" +
		"var ct=x.getResponseHeader(\"Content-Type\")||\"\";" +
		"return JSON.stringify({status:x.status,ct:ct,url:x.responseURL,body:x.responseText});" +
		"})()"
}

// page is the tuple the eval returns for one proxied request.
type page struct {
	Status int    `json:"status"`
	CT     string `json:"ct"`
	URL    string `json:"url"`
	Body   string `json:"body"`
}

// decodePage unwraps the double envelope: content[0].text ->
// {"result":"<json string of {status,ct,url,body}>"} (spec §3.3).
func decodePage(text string) (page, error) {
	var outer struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal([]byte(text), &outer); err != nil {
		return page{}, err
	}
	var pg page
	if err := json.Unmarshal([]byte(outer.Result), &pg); err != nil {
		return page{}, err
	}
	return pg, nil
}

// writePage reproduces the page or maps an expired session / oversized body.
func (p *proxy) writePage(w http.ResponseWriter, pg page) {
	if strings.Contains(pg.URL, "/web/login") {
		w.WriteHeader(http.StatusFound) // expired session -> OdooShAuthError (P4a)
		return
	}
	if len(pg.Body) > maxResponseBody {
		writeError(w, http.StatusBadGateway, "upstream response exceeds 1 MiB")
		return
	}
	if pg.CT != "" {
		w.Header().Set("Content-Type", pg.CT)
	}
	w.WriteHeader(pg.Status)
	_, _ = io.WriteString(w, pg.Body)
}

// writeClientError maps MCP transport errors (spec §3.6).
func (p *proxy) writeClientError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errEvalTimeout):
		writeError(w, http.StatusGatewayTimeout, "eval timed out")
	case errors.Is(err, errUpstreamAuth):
		writeError(w, http.StatusBadGateway, "upstream authentication failed")
	case errors.Is(err, errSessionLost):
		writeError(w, http.StatusBadGateway, "mcp session could not be established")
	default:
		writeError(w, http.StatusBadGateway, "upstream transport error")
	}
}

// healthz is a liveness probe: it re-checks the token file on every request
// and never consults the Vulpo chain (spec D-11, §3.4, P8).
func (p *proxy) healthz(w http.ResponseWriter) {
	if reason := tokenProblem(p.cfg.tokenFile); reason != "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable",
			"error":  reason,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// logRequest appends one minimal line; the Cookie value is never recorded.
func (p *proxy) logRequest(r *http.Request, path string) {
	if p.cfg.logFile == "" {
		return
	}
	cookie := "<redacted>"
	if r.Header.Get("Cookie") == "" {
		cookie = "-"
	}
	line := fmt.Sprintf("%s method=%s path=%s cookie=%s\n",
		time.Now().UTC().Format(time.RFC3339Nano), r.Method, path, cookie)

	p.logMu.Lock()
	defer p.logMu.Unlock()
	f, err := os.OpenFile(p.cfg.logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// tabLocker serializes evals per tab id (spec D-12, P14).
type tabLocker struct {
	mu sync.Mutex
	m  map[int]*sync.Mutex
}

func newTabLocker() *tabLocker {
	return &tabLocker{m: map[int]*sync.Mutex{}}
}

func (t *tabLocker) lock(id int) func() {
	t.mu.Lock()
	l, ok := t.m[id]
	if !ok {
		l = &sync.Mutex{}
		t.m[id] = l
	}
	t.mu.Unlock()
	l.Lock()
	return l.Unlock
}
