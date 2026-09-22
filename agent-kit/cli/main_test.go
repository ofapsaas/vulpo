// Contract tests for vlpmcp (fb-021-mvp spec v1.1, §3 C1–C13).
//
// Black-box: TestMain builds the binary from this module and every test runs
// it as a subprocess against an httptest fake of the Vulpo MCP server
// (behaviour mirrored from docs/epics/fb-021-agent-kit/discovery-notes.md §1).
// The tests live in package main_test so no identifier here can collide with
// the implementation's package main.
package main_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	// sentinelToken is the only token the fake server accepts by default.
	// C8: this string must never show up in stdout, stderr or the log.
	sentinelToken = "fbtok-SENTINEL-7f3a9c1e5d20b8e4"

	// defaultCallText is what tools/call returns by default. Spacing, HTML
	// characters, escaped quotes and non-ASCII make any re-encoding visible (C6).
	defaultCallText = `{"tabs": [{"id":7, "title":"Ventas <SO042> & \"Cía\""}],   "count":1}`

	noExtensionMsg = "No extension connected for token"

	specRef = "docs/specs/cli/spec.md"
)

var (
	vlpmcpBin      string
	vlpmcpBuildErr error
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "vlpmcp-contract-")
	if err != nil {
		vlpmcpBuildErr = fmt.Errorf("creating build dir: %w", err)
	} else {
		vlpmcpBin = filepath.Join(dir, "vlpmcp")
		vlpmcpBuildErr = goBuild(vlpmcpBin)
	}
	code := m.Run()
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
	os.Exit(code)
}

// goBuild runs `go build [extra...] -o out .` in the module directory with
// CGO_ENABLED=0 (spec D3).
func goBuild(out string, extra ...string) error {
	args := append([]string{"build"}, extra...)
	args = append(args, "-o", out, ".")
	cmd := exec.Command("go", args...)
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(buf.String()))
	}
	return nil
}

func requireBinary(t *testing.T) string {
	t.Helper()
	if vlpmcpBuildErr != nil {
		t.Fatalf("%s: vlpmcp does not build (%s): %v", t.Name(), specRef, vlpmcpBuildErr)
	}
	return vlpmcpBin
}

// ---------------------------------------------------------------------------
// Environment and subprocess runner
// ---------------------------------------------------------------------------

type testEnv struct {
	Dir         string
	Home        string
	TokenFile   string
	SessionFile string
	LogFile     string
	// Vars is the complete environment of the subprocess (hermetic: nothing
	// is inherited). Delete a key to leave that variable unset.
	Vars map[string]string
}

// newEnv prepares a HOME, a 0600 token file holding sentinelToken (surrounded
// by whitespace, C1), a session file path and a log file path, all inside
// t.TempDir().
func newEnv(t *testing.T, url string) *testEnv {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("mkdir home: %v", err)
	}
	e := &testEnv{
		Dir:         dir,
		Home:        home,
		TokenFile:   filepath.Join(dir, "secrets", "token"),
		SessionFile: filepath.Join(dir, "state", "session"),
		LogFile:     filepath.Join(dir, "calls.jsonl"),
	}
	writeFileMode(t, e.TokenFile, "  "+sentinelToken+" \n", 0o600)
	if err := os.MkdirAll(filepath.Dir(e.SessionFile), 0o700); err != nil {
		t.Fatalf("mkdir state: %v", err)
	}
	e.Vars = map[string]string{
		"HOME":                   home,
		"PATH":                   os.Getenv("PATH"),
		"VLP_URL":          url,
		"VLP_TOKEN_FILE":   e.TokenFile,
		"VLP_SESSION_FILE": e.SessionFile,
		"VLP_LOG":          e.LogFile,
	}
	return e
}

func (e *testEnv) list() []string {
	out := make([]string, 0, len(e.Vars))
	for k, v := range e.Vars {
		out = append(out, k+"="+v)
	}
	return out
}

type runResult struct {
	Args    []string
	Stdout  string
	Stderr  string
	Exit    int
	Elapsed time.Duration
}

func runVlpmcp(t *testing.T, env *testEnv, stdin string, args ...string) runResult {
	t.Helper()
	return runBinary(t, requireBinary(t), env, stdin, args...)
}

func runBinary(t *testing.T, bin string, env *testEnv, stdin string, args ...string) runResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env.list()
	cmd.Dir = env.Dir
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	start := time.Now()
	err := cmd.Run()
	res := runResult{Args: args, Stdout: stdout.String(), Stderr: stderr.String(), Elapsed: time.Since(start)}
	if ctx.Err() != nil {
		t.Fatalf("fb-021 %s: vlpmcp %q did not finish within 30s\nstdout: %q\nstderr: %q", t.Name(), args, res.Stdout, res.Stderr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("fb-021 %s: running vlpmcp %q: %v", t.Name(), args, err)
		}
		res.Exit = exitErr.ExitCode()
	}
	return res
}

// ---------------------------------------------------------------------------
// Fake MCP server (mirrors discovery-notes.md §1)
// ---------------------------------------------------------------------------

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
	HTTPMethod    string
	Path          string
	Method        string
	ID            json.RawMessage
	Token         string
	ContentType   string
	Accept        string
	SessionID     string // Mcp-Session-Id sent by the client
	IssuedSession string // Mcp-Session-Id returned by the fake (initialize)
	Status        int
	ToolName      string
	Arguments     json.RawMessage
}

type fakeResponse struct {
	status  int
	session string
	text    string // plain-text body when msg is nil
	msg     map[string]any
	delay   time.Duration
}

type fakeMCP struct {
	srv *httptest.Server

	mu         sync.Mutex
	token      string
	sse        bool
	serverName string
	tools      []map[string]any
	callResult func(name string, args json.RawMessage) (string, *rpcError)
	callDelay  time.Duration
	callStatus int  // non-zero: tools/call answers with this HTTP status
	reject404  bool // every non-initialize request answers 404
	expireNext int  // the next N non-initialize requests answer 404 and drop their session
	sessions   map[string]bool
	seq        int
	reqs       []recorded

	// expireMethod, if set, limits expireNext to requests with this JSON-RPC method.
	expireMethod string

	// kitRevision, if non-empty, is returned by initialize as
	// _meta["vulpo/agentKitRevision"] (fb-020-006 §2.6). Empty: no key.
	kitRevision string

	// callExtraTexts, if non-empty, are appended to a successful tools/call
	// result as additional {"type":"text"} content items after content[0]
	// (fb-020-006 §2.2, P25). Empty: single-item content as before.
	callExtraTexts []string
}

func newFakeMCP(t *testing.T) *fakeMCP {
	t.Helper()
	f := &fakeMCP{
		token:      sentinelToken,
		serverName: "vulpo-fake",
		tools:      defaultTools(),
		callResult: func(string, json.RawMessage) (string, *rpcError) { return defaultCallText, nil },
		sessions:   map[string]bool{},
	}
	f.srv = httptest.NewServer(f)
	t.Cleanup(f.srv.Close)
	return f
}

func defaultTools() []map[string]any {
	return []map[string]any{
		{
			"name":        "vlp_listTabs",
			"description": "List the open browser tabs. Returns id, title and url for each tab.",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
		{
			"name":        "vlp_getFrame",
			"description": "Read the frame map of a tab. Use filters to reduce the payload.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"tabId":  map[string]any{"type": "number", "description": "Tab id"},
					"filter": map[string]any{"type": "string"},
				},
				"required": []any{"tabId"},
			},
		},
	}
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

// expireAllSessions simulates a server restart: every stored session is gone.
func (f *fakeMCP) expireAllSessions() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = map[string]bool{}
}

func (f *fakeMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	rec := recorded{
		HTTPMethod:  r.Method,
		Path:        r.URL.Path,
		Token:       r.Header.Get("x-vlp-token"),
		ContentType: r.Header.Get("Content-Type"),
		Accept:      r.Header.Get("Accept"),
		SessionID:   r.Header.Get("Mcp-Session-Id"),
	}
	var req rpcRequest
	parseErr := json.Unmarshal(body, &req)
	rec.Method = req.Method
	rec.ID = req.ID
	if req.Method == "tools/call" {
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &p)
		rec.ToolName = p.Name
		rec.Arguments = p.Arguments
	}

	f.mu.Lock()
	resp := f.decide(&rec, req, parseErr)
	rec.Status = resp.status
	rec.IssuedSession = resp.session
	f.reqs = append(f.reqs, rec)
	sse := f.sse
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
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // the real server does not HTML-escape either
	_ = enc.Encode(resp.msg)
	data := bytes.TrimRight(buf.Bytes(), "\n")
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(resp.status)
		_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.status)
	_, _ = w.Write(data)
}

// decide must be called with f.mu held.
func (f *fakeMCP) decide(rec *recorded, req rpcRequest, parseErr error) fakeResponse {
	if rec.HTTPMethod != http.MethodPost {
		return fakeResponse{status: http.StatusMethodNotAllowed, text: "method not allowed"}
	}
	if rec.Token != f.token {
		return fakeResponse{status: http.StatusUnauthorized, text: "invalid token"}
	}
	if !strings.Contains(rec.Accept, "application/json") && !strings.Contains(rec.Accept, "text/event-stream") {
		return fakeResponse{status: http.StatusNotAcceptable, text: "not acceptable"}
	}
	if parseErr != nil {
		return fakeResponse{status: http.StatusBadRequest, text: "invalid JSON"}
	}
	session := ""
	if req.Method == "initialize" {
		if rec.SessionID != "" && f.sessions[rec.SessionID] {
			session = rec.SessionID
		} else {
			f.seq++
			session = fmt.Sprintf("fake-session-%d", f.seq)
			f.sessions[session] = true
		}
	} else {
		if rec.SessionID == "" {
			return fakeResponse{status: http.StatusBadRequest, text: "missing Mcp-Session-Id"}
		}
		if !f.sessions[rec.SessionID] || f.reject404 {
			return fakeResponse{status: http.StatusNotFound, text: "session not found"}
		}
		if f.expireNext > 0 && (f.expireMethod == "" || f.expireMethod == req.Method) {
			f.expireNext--
			delete(f.sessions, rec.SessionID)
			return fakeResponse{status: http.StatusNotFound, text: "session not found"}
		}
	}
	if len(req.ID) == 0 {
		return fakeResponse{status: http.StatusAccepted, session: session}
	}
	if req.Method == "tools/call" && f.callStatus != 0 {
		return fakeResponse{status: f.callStatus, text: "forced status"}
	}
	msg := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	var delay time.Duration
	switch req.Method {
	case "initialize":
		initResult := map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": f.serverName, "version": "0.5.0"},
		}
		if f.kitRevision != "" {
			initResult["_meta"] = map[string]any{"vulpo/agentKitRevision": f.kitRevision}
		}
		msg["result"] = initResult
	case "tools/list":
		msg["result"] = map[string]any{"tools": f.tools}
	case "ping":
		msg["result"] = map[string]any{}
	case "tools/call":
		text, rpcErr := f.callResult(rec.ToolName, rec.Arguments)
		if rpcErr != nil {
			msg["error"] = map[string]any{"code": rpcErr.Code, "message": rpcErr.Message}
		} else {
			content := []any{map[string]any{"type": "text", "text": text}}
			for _, extra := range f.callExtraTexts {
				content = append(content, map[string]any{"type": "text", "text": extra})
			}
			msg["result"] = map[string]any{"content": content}
		}
		delay = f.callDelay
	default:
		msg["error"] = map[string]any{"code": -32601, "message": "method not found"}
	}
	return fakeResponse{status: http.StatusOK, session: session, msg: msg, delay: delay}
}

// unreachableURL returns the URL of a server that has already been closed.
func unreachableURL(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.NotFoundHandler())
	u := srv.URL + "/mcp"
	srv.Close()
	return u
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

func expectExit(t *testing.T, res runResult, want int) {
	t.Helper()
	if res.Exit != want {
		t.Errorf("fb-021 %s: vlpmcp %q exit = %d, want %d\nstdout: %q\nstderr: %q",
			t.Name(), res.Args, res.Exit, want, res.Stdout, res.Stderr)
	}
}

func expectContains(t *testing.T, label, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("fb-021 %s: %s does not contain %q\n%s: %q", t.Name(), label, want, label, got)
	}
}

func expectNotContains(t *testing.T, label, got, unwanted string) {
	t.Helper()
	if strings.Contains(got, unwanted) {
		t.Errorf("fb-021 %s: %s contains %q\n%s: %q", t.Name(), label, unwanted, label, got)
	}
}

// expectLine checks that some line of out, trimmed, equals line exactly.
func expectLine(t *testing.T, label, out, line string) {
	t.Helper()
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) == line {
			return
		}
	}
	t.Errorf("fb-021 %s: %s has no line %q\n%s: %q", t.Name(), label, line, label, out)
}

// stripOneNewline removes at most one trailing newline (see ambiguity A1).
func stripOneNewline(s string) string {
	return strings.TrimSuffix(s, "\n")
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

func countMethod(reqs []recorded, method string) int {
	n := 0
	for _, r := range reqs {
		if r.Method == method {
			n++
		}
	}
	return n
}

func countStatus(reqs []recorded, status int) int {
	n := 0
	for _, r := range reqs {
		if r.Status == status {
			n++
		}
	}
	return n
}

func methodsOf(reqs []recorded) []string {
	out := make([]string, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, fmt.Sprintf("%s(%d)", r.Method, r.Status))
	}
	return out
}

// normalizeJSON round-trips v through encoding/json so fixtures compare
// with values decoded from the CLI's output.
func normalizeJSON(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return out
}

func decodeJSON(t *testing.T, label string, data []byte) (any, bool) {
	t.Helper()
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Errorf("fb-021 %s: %s is not valid JSON: %v\n%s: %q", t.Name(), label, err, label, string(data))
		return nil, false
	}
	return out, true
}

func expectJSONEqual(t *testing.T, label string, got []byte, want any) {
	t.Helper()
	decoded, ok := decodeJSON(t, label, got)
	if !ok {
		return
	}
	if norm := normalizeJSON(t, want); !reflect.DeepEqual(decoded, norm) {
		t.Errorf("fb-021 %s: %s = %v, want %v", t.Name(), label, decoded, norm)
	}
}

func writeFileMode(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chmod(path, mode); err != nil { // WriteFile's mode is subject to umask
		t.Fatalf("chmod %s: %v", path, err)
	}
}

func readFileOrEmpty(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}
