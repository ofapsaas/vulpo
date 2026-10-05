// Contract tests for vlp-odoosh-proxy (fb-025-001-proxy-readonly, spec v1 §3).
//
// Black-box: TestMain builds the binary from this module (CGO_ENABLED=0) and
// every test runs it as a long-lived subprocess against an in-process fake of
// the Vulpo MCP Streamable HTTP transport (fake_mcp_test.go) pointed to by
// VLP_URL. No network, no real extension, no odoosh-mcp (spec §3.3, tier T-go).
//
// The tests live in package main_test so no identifier here can collide with
// the implementation's package main (anti-AP-14: assert only observable
// wire/HTTP behaviour, never internal symbols).
package main_test

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	// sentinelToken is the only token the fake MCP accepts by default. C5: it
	// must never show up in the eval code, the MCP body, the log or os.Args.
	sentinelToken = "odoosh-tok-SENTINEL-2b7e4a19c0f3d8a6"
	// sentinelCookie is the value odoosh-mcp sends as `Cookie: session_id=...`.
	// C5: the proxy must drop it and never persist/log/reflect it.
	sentinelCookie = "SENTINEL-COOKIE-9f1c3e7a2d5b8046"

	specRef = "docs/specs/fb-025-001-proxy-readonly/spec.md"

	// sampleRPCResponse is a realistic odoo.sh control-plane response used as
	// the page body (valid JSON-RPC with jsonrpc/result, no HTML chars).
	sampleRPCResponse = `{"jsonrpc":"2.0","id":1,"result":{"data":[]}}`
	// sampleRPCRequest is the JSON-RPC body odoosh-mcp POSTs to /app/<route>.
	sampleRPCRequest = `{"jsonrpc":"2.0","method":"call","params":{"model":"res.partner"}}`
)

var (
	proxyBin      string
	proxyBuildErr error
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "vlp-odoosh-proxy-contract-")
	if err != nil {
		proxyBuildErr = fmt.Errorf("creating build dir: %w", err)
	} else {
		proxyBin = filepath.Join(dir, "vlp-odoosh-proxy")
		proxyBuildErr = goBuild(proxyBin)
	}
	code := m.Run()
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
	os.Exit(code)
}

// goBuild runs `go build [extra...] -o out .` in the module directory with
// CGO_ENABLED=0 (spec D-2, §3.5).
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
	if proxyBuildErr != nil {
		t.Fatalf("%s: vlp-odoosh-proxy does not build (%s): %v", t.Name(), specRef, proxyBuildErr)
	}
	return proxyBin
}

// ---------------------------------------------------------------------------
// Environment and long-lived server runner
// ---------------------------------------------------------------------------

type testEnv struct {
	Dir       string
	Home      string
	TokenFile string
	LogFile   string
	Port      int
	Addr      string
	// Vars is the complete environment of the subprocess (hermetic: nothing is
	// inherited). Delete a key to leave that variable unset.
	Vars map[string]string
}

func (e *testEnv) list() []string {
	out := make([]string, 0, len(e.Vars))
	for k, v := range e.Vars {
		out = append(out, k+"="+v)
	}
	return out
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("fb-025 %s: reserving a free port: %v", t.Name(), err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// newEnv prepares a HOME, a 0600 token file holding sentinelToken, a proxy log
// path and a dedicated loopback port, all inside t.TempDir(). VLP_URL points at
// the fake MCP. Callers mutate Vars to exercise P9 (bind/port) and P8 (token).
func newEnv(t *testing.T, fakeURL string) *testEnv {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("mkdir home: %v", err)
	}
	port := freePort(t)
	e := &testEnv{
		Dir:       dir,
		Home:      home,
		TokenFile: filepath.Join(dir, "secrets", "token"),
		LogFile:   filepath.Join(dir, "proxy.log"),
		Port:      port,
		Addr:      fmt.Sprintf("127.0.0.1:%d", port),
	}
	writeFileMode(t, e.TokenFile, sentinelToken+"\n", 0o600)
	e.Vars = map[string]string{
		"HOME":             home,
		"PATH":             os.Getenv("PATH"),
		"VLP_URL":          fakeURL,
		"VLP_TOKEN_FILE":   e.TokenFile,
		"VLP_PROXY_LOG":    e.LogFile,
		"VLP_PROXY_BIND":   "127.0.0.1",
		"VLP_PROXY_PORT":   strconv.Itoa(port),
		"VLP_EVAL_TIMEOUT": "2",
		// Explicit tab id: isolates P1–P6/P8–P14 from the vlp_listTabs wire.
		// Only P7 exercises discovery (its p7Env deletes this key), so the
		// other postconditions stay independent of the tab-listing shape.
		"VLP_EVAL_TAB": "22",
	}
	return e
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type proxyProc struct {
	cmd     *exec.Cmd
	env     *testEnv
	stdout  lockedBuf
	stderr  lockedBuf
	exited  chan struct{}
	waitErr error
}

func (p *proxyProc) wait() {
	p.waitErr = p.cmd.Wait()
	close(p.exited)
}

func (p *proxyProc) stop() {
	select {
	case <-p.exited:
		return
	default:
	}
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.exited:
	case <-time.After(2 * time.Second):
	}
}

// startProxy launches the binary and waits (readiness loop) until the
// configured loopback port accepts a TCP connection. The proxy is a
// long-lived server, so readiness is a dial, not a request.
func startProxy(t *testing.T, env *testEnv) *proxyProc {
	t.Helper()
	bin := requireBinary(t)
	cmd := exec.Command(bin)
	cmd.Env = env.list()
	cmd.Dir = env.Dir
	p := &proxyProc{cmd: cmd, env: env, exited: make(chan struct{})}
	cmd.Stdout = &p.stdout
	cmd.Stderr = &p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("fb-025 %s: starting vlp-odoosh-proxy: %v", t.Name(), err)
	}
	go p.wait()

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-p.exited:
			t.Fatalf("fb-025 %s: proxy exited before becoming ready on %s: %v\nstdout: %s\nstderr: %s",
				t.Name(), env.Addr, p.waitErr, p.stdout.String(), p.stderr.String())
		default:
		}
		conn, err := net.DialTimeout("tcp", env.Addr, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			t.Cleanup(p.stop)
			return p
		}
		time.Sleep(50 * time.Millisecond)
	}
	p.stop()
	t.Fatalf("fb-025 %s: proxy not ready on %s within 10s\nstdout: %s\nstderr: %s",
		t.Name(), env.Addr, p.stdout.String(), p.stderr.String())
	return nil
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type httpResult struct {
	Status int
	Header http.Header
	Body   []byte
}

var noRedirectClient = &http.Client{
	Timeout: 15 * time.Second,
	// P4a expects the proxy's own 302; the test client must not follow it.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// proxyClientDoErr is the goroutine-safe variant (P14 fires it concurrently).
func proxyClientDoErr(env *testEnv, method, path, body string, headers map[string]string) (httpResult, error) {
	req, err := http.NewRequest(method, "http://"+env.Addr+path, strings.NewReader(body))
	if err != nil {
		return httpResult{}, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := noRedirectClient.Do(req)
	if err != nil {
		return httpResult{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return httpResult{}, err
	}
	return httpResult{Status: resp.StatusCode, Header: resp.Header, Body: data}, nil
}

func proxyClientDo(t *testing.T, env *testEnv, method, path, body string, headers map[string]string) httpResult {
	t.Helper()
	res, err := proxyClientDoErr(env, method, path, body, headers)
	if err != nil {
		t.Fatalf("fb-025 %s: %s %s against proxy %s: %v", t.Name(), method, path, env.Addr, err)
	}
	return res
}

// proxyRaw sends a request with a verbatim request-target. P3 needs literal
// `//`, `\`, `@`, `://` and `..` in the path, which net/url would rewrite.
func proxyRaw(t *testing.T, env *testEnv, method, rawTarget string, headers map[string]string, body string) httpResult {
	t.Helper()
	conn, err := net.DialTimeout("tcp", env.Addr, 5*time.Second)
	if err != nil {
		t.Fatalf("fb-025 %s: dialing proxy %s: %v", t.Name(), env.Addr, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))

	var b strings.Builder
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", method, rawTarget)
	fmt.Fprintf(&b, "Host: %s\r\n", env.Addr)
	for k, v := range headers {
		fmt.Fprintf(&b, "%s: %s\r\n", k, v)
	}
	fmt.Fprintf(&b, "Content-Length: %d\r\n", len(body))
	b.WriteString("Connection: close\r\n\r\n")
	b.WriteString(body)
	if _, err := io.WriteString(conn, b.String()); err != nil {
		t.Fatalf("fb-025 %s: writing %s %s: %v", t.Name(), method, rawTarget, err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("fb-025 %s: reading response for %s %s: %v", t.Name(), method, rawTarget, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return httpResult{Status: resp.StatusCode, Header: resp.Header, Body: data}
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

func expectStatus(t *testing.T, res httpResult, want int) {
	t.Helper()
	if res.Status != want {
		t.Errorf("fb-025 %s: status = %d, want %d\nbody: %q", t.Name(), res.Status, want, res.Body)
	}
}

func expectContains(t *testing.T, label, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("fb-025 %s: %s does not contain %q\n%s: %q", t.Name(), label, want, label, got)
	}
}

func expectNotContains(t *testing.T, label, got, unwanted string) {
	t.Helper()
	if strings.Contains(got, unwanted) {
		t.Errorf("fb-025 %s: %s contains %q\n%s: %q", t.Name(), label, unwanted, label, got)
	}
}

// expectNoSecrets enforces I-5: no token, cookie or access_token in a body.
func expectNoSecrets(t *testing.T, label string, body []byte) {
	t.Helper()
	s := string(body)
	for _, secret := range []string{sentinelToken, sentinelCookie, "access_token"} {
		if strings.Contains(s, secret) {
			t.Errorf("fb-025 %s: %s leaks secret %q: %q", t.Name(), label, secret, s)
		}
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

func snapshotFiles(t *testing.T, root string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			out[p] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("fb-025 %s: snapshot of %s: %v", t.Name(), root, err)
	}
	return out
}

func diffFiles(before, after map[string]bool) []string {
	var out []string
	for p := range after {
		if !before[p] {
			out = append(out, p)
		}
	}
	return out
}

// procArgs reads the subprocess argv (P5: the token must never be an argument).
func procArgs(t *testing.T, pid int) string {
	t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		t.Fatalf("fb-025 %s: reading /proc/%d/cmdline: %v", t.Name(), pid, err)
	}
	return strings.ReplaceAll(string(data), "\x00", " ")
}

// walkContains reports whether any file under root contains needle (P10/P11d).
func walkContains(t *testing.T, root, needle string) (string, bool) {
	t.Helper()
	found := ""
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.Contains(readFileOrEmpty(p), needle) {
			found = p
			return fs.SkipAll
		}
		return nil
	})
	return found, found != ""
}
