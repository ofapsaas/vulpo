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
	// readyStateProbeCode is the exact eval code that reads document.readyState
	// (spec §3.4; the fake discriminates probe vs page eval on it).
	readyStateProbeCode = "document.readyState"
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
	// /healthz and /readyz are evaluated before the path guard (spec D-5, §3.6).
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		p.healthz(w)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/readyz" {
		p.readyz(w)
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

	tabID, tabURL, err := p.resolveTab()
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	// The per-tab lock spans the whole cycle, including any recovery, so evals
	// to the same tab never overlap (D-12, P12).
	release := p.locker.lock(tabID)
	defer release()

	pg, rpcErr, err := p.evalOnce(tabID, code)
	if err != nil {
		p.writeClientError(w, err)
		return
	}
	if rpcErr != nil {
		p.handleToolError(w, rpcErr, tabID, tabURL, code)
		return
	}
	p.writePage(w, pg)
}

// evalOnce runs one vlp_eval and unwraps its result. A tool error is returned
// separately so the caller can classify it; a transport error is returned as
// err (spec §3.5).
func (p *proxy) evalOnce(tabID int, code string) (page, *rpcError, error) {
	resp, err := p.client.callTool("vlp_eval", map[string]any{"tabId": tabID, "code": code})
	if err != nil {
		return page{}, nil, err
	}
	text, rpcErr, err := toolText(resp.body)
	if err != nil {
		return page{}, nil, errors.New("upstream response is malformed")
	}
	if rpcErr != nil {
		return page{}, rpcErr, nil
	}
	pg, err := decodePage(text)
	if err != nil {
		return page{}, nil, errors.New("upstream eval result is malformed")
	}
	return pg, nil, nil
}

// resolveTab returns the target tab: VLP_EVAL_TAB when set, otherwise the
// first tab whose url starts with VLP_TAB_URL_PREFIX. Discovery retries with
// linear backoff to absorb the readiness race after a reconnection (D-10, P8);
// the tab id is never cached.
func (p *proxy) resolveTab() (int, string, error) {
	if p.cfg.evalTab != "" {
		id, err := strconv.Atoi(p.cfg.evalTab)
		if err != nil {
			return 0, "", fmt.Errorf("VLP_EVAL_TAB is not a tab id: %q", p.cfg.evalTab)
		}
		return id, "", nil
	}

	var lastErr error
	for attempt := 0; attempt <= p.cfg.resolveRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * p.cfg.resolveBackoff)
		}
		tabs, err := p.listTabs()
		if err != nil {
			return 0, "", err
		}
		for _, tab := range tabs {
			if strings.HasPrefix(tab.URL, p.cfg.tabPrefix) {
				return tab.ID, tab.URL, nil
			}
		}
		lastErr = fmt.Errorf("no tab found with url prefix %q", p.cfg.tabPrefix)
	}
	return 0, "", lastErr
}

// tabInfo is one element of the vlp_listTabs wire: a BARE JSON array of tab
// objects in content[0].text (spec §3.7).
type tabInfo struct {
	ID  int    `json:"id"`
	URL string `json:"url"`
}

// listTabs calls vlp_listTabs and parses the bare array wire (the object shape
// {"tabs":[…]} is accepted too for robustness).
func (p *proxy) listTabs() ([]tabInfo, error) {
	resp, err := p.client.callTool("vlp_listTabs", map[string]any{})
	if err != nil {
		return nil, err
	}
	text, rpcErr, err := toolText(resp.body)
	if err != nil || rpcErr != nil {
		return nil, errors.New("cannot list Vulpo tabs")
	}
	return parseTabs(text)
}

func parseTabs(text string) ([]tabInfo, error) {
	var tabs []tabInfo
	if err := json.Unmarshal([]byte(text), &tabs); err == nil {
		return tabs, nil
	}
	var listing struct {
		Tabs []tabInfo `json:"tabs"`
	}
	if err := json.Unmarshal([]byte(text), &listing); err != nil {
		return nil, errors.New("cannot list Vulpo tabs")
	}
	return listing.Tabs, nil
}

// lookupTabURL resolves the current url of a fixed tab id. Only the recovery
// path uses it, so the normal VLP_EVAL_TAB path still avoids vlp_listTabs
// (D-13, preserves P7b of 001).
func (p *proxy) lookupTabURL(tabID int) (string, error) {
	tabs, err := p.listTabs()
	if err != nil {
		return "", err
	}
	for _, tab := range tabs {
		if tab.ID == tabID {
			return tab.URL, nil
		}
	}
	return "", fmt.Errorf("no tab with id %d", tabID)
}

// toolClass is one row of the closed classification table (spec §3.5.1).
type toolClass struct {
	status  int
	prefix  string
	recover bool // a candidate for a discarded tab (D-1)
}

// classifyToolMessage maps a tool error message to the closed table. A message
// outside the table is a generic 502 that never recovers (D-11, I-13).
func classifyToolMessage(msg string) toolClass {
	switch {
	case strings.Contains(msg, "An unexpected error occurred"),
		strings.Contains(msg, "Missing host permission for the tab"):
		return toolClass{recover: true}
	case strings.Contains(msg, "command_timeout:"):
		return toolClass{status: http.StatusGatewayTimeout, prefix: "hub idle timeout: "}
	case strings.Contains(msg, "blocked in Plan mode"):
		return toolClass{status: http.StatusBadGateway, prefix: "plan mode: "}
	case strings.Contains(msg, "Rate limit exceeded"):
		return toolClass{status: http.StatusBadGateway, prefix: "rate limit: "}
	case strings.Contains(msg, "Code too large"):
		return toolClass{status: http.StatusRequestEntityTooLarge, prefix: "code too large: "}
	case strings.Contains(msg, "superseded"):
		return toolClass{status: http.StatusBadGateway, prefix: "superseded [terminal]: "}
	case strings.Contains(msg, "extension disconnected"):
		return toolClass{status: http.StatusBadGateway, prefix: "extension disconnected [transient]: "}
	case strings.Contains(msg, "No extension has tab"):
		return toolClass{status: http.StatusBadGateway, prefix: "no tab: "}
	default:
		return toolClass{status: http.StatusBadGateway, prefix: "tool error: "}
	}
}

// handleToolError classifies a tool error and, for a discarded-tab candidate,
// runs one bounded recovery cycle. Every classified body antepones a semantic
// mark to the raw message, which is always preserved as a substring
// (spec §3.5.1/C-10).
func (p *proxy) handleToolError(w http.ResponseWriter, rpcErr *rpcError, tabID int, tabURL, code string) {
	cls := classifyToolMessage(rpcErr.Message)
	if !cls.recover {
		writeError(w, cls.status, cls.prefix+rpcErr.Message)
		return
	}
	if !p.cfg.recoverOnAmbiguous {
		// D-7 of 001 preserved: an ambiguous -32000 with recovery off is a
		// plain 502 carrying the raw message.
		writeError(w, http.StatusBadGateway, rpcErr.Message)
		return
	}
	p.recoverTab(w, tabID, tabURL, code, rpcErr.Message)
}

// recoverTab runs the bounded recovery cycle (D-3, I-11): load the tab, wait
// for readyState:complete, re-emit the original eval once; an opt-in focus
// fallback adds at most one more load + retry. Persistent failure -> 502
// "recovery failed: <raw>".
func (p *proxy) recoverTab(w http.ResponseWriter, tabID int, tabURL, code, raw string) {
	last := raw

	url := tabURL
	if url == "" {
		if resolved, err := p.lookupTabURL(tabID); err == nil {
			url = resolved
		}
	}
	// Primary, no focus: navigate to the current url (D-2).
	if url != "" {
		if _, err := p.client.callTool("vlp_navigate", map[string]any{"tabId": tabID, "url": url}); err == nil {
			if p.waitReady(tabID) == nil {
				pg, rpcErr, err := p.evalOnce(tabID, code)
				if err != nil {
					p.writeClientError(w, err)
					return
				}
				if rpcErr == nil {
					p.writePage(w, pg)
					return
				}
				last = rpcErr.Message
			}
		}
	}

	// Opt-in fallback that steals focus (D-2), bounded to one attempt.
	if p.cfg.recoverAllowFocus {
		if _, err := p.client.callTool("vlp_activateTab", map[string]any{"tabId": tabID}); err == nil {
			if p.waitReady(tabID) == nil {
				pg, rpcErr, err := p.evalOnce(tabID, code)
				if err != nil {
					p.writeClientError(w, err)
					return
				}
				if rpcErr == nil {
					p.writePage(w, pg)
					return
				}
				last = rpcErr.Message
			}
		}
	}

	writeError(w, http.StatusBadGateway, "recovery failed: "+last)
}

// waitReady polls document.readyState until it reports "complete" or the
// deadline expires (D-3). The number of probes is bounded by
// deadline/poll + 1.
func (p *proxy) waitReady(tabID int) error {
	deadline := time.Now().Add(p.cfg.recoverReadyDeadline)
	for {
		if time.Now().After(deadline) {
			return errors.New("readyState did not reach complete before the deadline")
		}
		resp, err := p.client.callTool("vlp_eval", map[string]any{"tabId": tabID, "code": readyStateProbeCode})
		if err != nil {
			return err
		}
		text, rpcErr, err := toolText(resp.body)
		if err != nil {
			return err
		}
		if rpcErr == nil {
			var probe struct {
				Result string `json:"result"`
			}
			if err := json.Unmarshal([]byte(text), &probe); err == nil && strings.TrimSpace(probe.Result) == "complete" {
				return nil
			}
		}
		time.Sleep(p.cfg.recoverReadyPoll)
	}
}

// readyz is a readiness probe: it consults the extension and the tab, unlike
// /healthz which is liveness-only (D-5, §3.6). It is bounded by
// VLP_READYZ_TIMEOUT_MS.
func (p *proxy) readyz(w http.ResponseWriter) {
	result := make(chan string, 1)
	go func() { result <- p.readiness() }()
	select {
	case motivo := <-result:
		if motivo == "" {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
			return
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": motivo})
	case <-time.After(p.cfg.readyzTimeout):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "readiness probe timed out"})
	}
}

// readiness returns "" when the chain is ready, or a secret-free motivo.
func (p *proxy) readiness() string {
	tabs, err := p.listTabs()
	if err != nil {
		return "extension unreachable"
	}
	tabID := -1
	for _, tab := range tabs {
		if strings.HasPrefix(tab.URL, p.cfg.tabPrefix) {
			tabID = tab.ID
			break
		}
	}
	if tabID < 0 {
		return "no tab with the configured url prefix"
	}
	resp, err := p.client.callTool("vlp_eval", map[string]any{"tabId": tabID, "code": readyStateProbeCode})
	if err != nil {
		return "tab is not evaluable"
	}
	if _, rpcErr, err := toolText(resp.body); err != nil || rpcErr != nil {
		return "tab is not evaluable"
	}
	return ""
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

// writeClientError maps MCP transport errors (spec §3.5/§3.5.1).
func (p *proxy) writeClientError(w http.ResponseWriter, err error) {
	var capErr *transportCapError
	switch {
	case errors.Is(err, errEvalTimeout):
		writeError(w, http.StatusGatewayTimeout, "eval timeout")
	case errors.As(err, &capErr):
		writeError(w, http.StatusBadGateway, capErr.Error())
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
	// The documented error body is {"error":"<msg>"} and the raw tool message
	// must be preserved VERBATIM as a substring (spec §3.5.1/C-10). The
	// template is therefore filled literally: re-encoding would escape the
	// quotes a raw message may carry (e.g. Plan mode) and break preservation.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":"`+msg+`"}`+"\n")
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
