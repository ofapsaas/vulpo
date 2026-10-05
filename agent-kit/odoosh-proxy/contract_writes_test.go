// fb-025-003-proxy-writes — shared helpers for the 003 RED suite (spec §3.4/§3.5,
// AUDIT §4.2/§4.3). Black-box, package main_test: everything here observes only
// the HTTP surface of the proxy and the wire recorded by the extended fake. No
// symbol of the implementation's package main is referenced (anti-AP-14, C-3).
package main_test

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// §3.6 normative guard literal (C-7). The guard 502 is distinguishable from
// `recovery failed:` and `tool error:` and preserves the raw tool message as a
// substring of the DECODED `error` field (C-6).
// ---------------------------------------------------------------------------

const litRecoveryNotAttempted = "recovery not attempted for non-read route:"

// readRecoveryRoute is R2 of §3.4 (bootstrap's get_info): the READ route used
// by the C-1 reconciliation and by P3. It must be non-ambiguous and recoverable.
const readRecoveryRoute = "/app/project/x/get_info"

// ambiguousRoute is §3.4's read/write route, EXCLUDED by fail-safe: it must
// never recover (a write on it could be duplicated).
const ambiguousRoute = "/app/user/profile"

// unknownRoute is a route the allowlist never pinned: fail-safe non-read.
const unknownRoute = "/app/no_such_route"

// writeRoutes is the P2 non-read table (AUDIT §4.3 P2a): the 11 write tails
// named in the audit, on the real control-plane shapes measured in discovery
// §2.2. Each is non-read under §3.4 (fail-safe).
var writeRoutes = []string{
	"/app/branch/1/fork",
	"/app/project/x/set_settings",
	"/app/branch/1/allow_ip",
	"/app/build/1/dump",
	"/app/branch/1/merge_into",
	"/app/branch/1/delete",
	"/app/branch/1/add_submodule",
	"/app/project/x/create_submodule_deploy_key",
	"/app/user_access/1/set_access_level",
	"/app/notification/1/dismiss",
	"/app/build/1/flamegraph/start",
}

// readRoutes is the §3.4 allowlist (R1–R12), one representative route per
// pattern (AUDIT §4.6). Each must recover under the guard.
var readRoutes = []string{
	"/app/projects",                    // R1
	"/app/project/x/get_info",          // R2
	"/app/project/x/get_settings",      // R3
	"/app/project/x/status",            // R4
	"/app/project/x/branches",          // R5
	"/app/project/x/builds_per_branch", // R6
	"/app/project/x/backups",           // R7
	"/app/project/x/audit_logs",        // R8
	"/app/branch/1/history",            // R9
	"/app/branch/1/get_settings",       // R10
	"/app/build/1/errors",              // R11
	"/app/github/get_user_profile",     // R12
}

// malformedReadPaths look like READ routes but break the exact segment/tail
// matcher (§3.4 fail-safe): they must NOT recover.
var malformedReadPaths = []string{
	"/app/project/x/get_info_extra",
	"/app/projects/extra",
	"/app/project/x/get_info/extra",
	"/app/branch/1/history/extra",
	"/app/github/get_user_profile/extra",
	"/app/build/1/errors/extra",
}

// Write request bodies pinned in spec §3.5 (JSON-RPC of a control-plane write).
const (
	writeForkBody        = `{"jsonrpc":"2.0","method":"call","params":{"new_branch_name":"staging-vulpo-test","stage":"production"}}`
	writeSetSettingsBody = `{"jsonrpc":"2.0","method":"call","params":{"settings":{"debug":false}}}`
)

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// writeEnv builds a hermetic recovery env with the 003 knob set explicitly to
// the safe default `0` (spec §3.2/D-3). extra overrides/adds vars (e.g. the
// knob to `1` for P5b). It reuses the 002 recoveryEnv (explicit tab 22, short
// recovery timings) so a write request exercises the same transport surface.
func writeEnv(t *testing.T, f *fakeMCP, extra map[string]string) *testEnv {
	t.Helper()
	base := map[string]string{"VLP_RECOVER_ON_WRITE": "0"}
	for k, v := range extra {
		base[k] = v
	}
	return recoveryEnv(t, f, base)
}

// ---------------------------------------------------------------------------
// G1/C-2: extract the request body the proxy embedded in an eval code.
// ---------------------------------------------------------------------------

// extractEvalBody returns the JSON-RPC request body the proxy serialized into
// the XHR of an eval code. The proxy quotes the body (strconv.Quote, discovery
// §4.1), so the helper locates the quoted literal around `jsonrpc`, unquotes it
// and requires it to JSON-parse with a `jsonrpc` field. It does NOT hardcode the
// quoting (G1).
func extractEvalBody(t *testing.T, code string) string {
	t.Helper()
	idx := strings.Index(code, "jsonrpc")
	if idx < 0 {
		t.Fatalf("fb-025-003 %s: eval code does not embed a JSON-RPC body (no jsonrpc): %q", t.Name(), code)
	}
	brace := strings.LastIndex(code[:idx], "{")
	if brace < 0 {
		t.Fatalf("fb-025-003 %s: no `{` before jsonrpc in eval code: %q", t.Name(), code)
	}
	open := strings.LastIndex(code[:brace], `"`)
	if open < 0 {
		t.Fatalf("fb-025-003 %s: no opening quote before the embedded body: %q", t.Name(), code)
	}
	end := -1
	for i := open + 1; i < len(code); i++ {
		switch code[i] {
		case '\\':
			i++ // skip the escaped byte
		case '"':
			end = i
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		t.Fatalf("fb-025-003 %s: unterminated quoted body in eval code: %q", t.Name(), code)
	}
	lit := code[open : end+1]
	body, err := strconv.Unquote(lit)
	if err != nil {
		body = code[open+1 : end] // tolerate a non-Go-quoted embedding
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil || m["jsonrpc"] == nil {
		t.Fatalf("fb-025-003 %s: embedded body is not JSON-RPC (err=%v): %q (code=%q)", t.Name(), err, body, code)
	}
	return body
}

// ---------------------------------------------------------------------------
// G3/C-4: assert the guard did NOT recover (message + counters, never status).
// ---------------------------------------------------------------------------

// assertNoRecovery enforces the guard's non-read behaviour (P2): 502, the guard
// message with the raw preserved on the DECODED error field, exactly one page
// eval and no navigate/activate. It never asserts on status alone (C-4).
func assertNoRecovery(t *testing.T, f *fakeMCP, res httpResult, raw string) {
	t.Helper()
	expectStatus(t, res, 502)
	decoded := decodeErrorField(t, res.Body)
	expectContains(t, "decoded error", decoded, litRecoveryNotAttempted)
	expectContains(t, "decoded error", decoded, raw)
	if got := pageEvalCount(f); got != 1 {
		t.Errorf("fb-025-003 %s: page evals = %d, want exactly 1 (the guard must not re-emit the write)", t.Name(), got)
	}
	if got := navigateCount(f); got != 0 {
		t.Errorf("fb-025-003 %s: vlp_navigate = %d, want 0 (guard must not recover a non-read route)", t.Name(), got)
	}
	if got := activateCount(f); got != 0 {
		t.Errorf("fb-025-003 %s: vlp_activateTab = %d, want 0 (guard must not recover a non-read route)", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// Scenario drivers
// ---------------------------------------------------------------------------

// runRecovery drives one request whose first page eval hits the generic -32000
// candidate (rawCandidate) while the tab is discarded and a navigate clears it
// (contrafáctico: recovery would succeed if attempted). Under the guard, a
// non-read route must return 502 without re-emitting (P2/P5a); a READ route
// recovers (P3/P5c).
func runRecovery(t *testing.T, route string, extra map[string]string) (*fakeMCP, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = true
	})
	env := writeEnv(t, f, extra)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", route, sampleRPCRequest, nil)
	requireFakeReached(t, f)
	return f, res
}

// runHostPerm drives the same discarded scenario but with the host-permission
// candidate, which D-2 treats as pre-execution: it recovers on EVERY route.
func runHostPerm(t *testing.T, route string) (*fakeMCP, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.discardedMsg = rawHostPerm
		f.navigateRecovers = true
	})
	env := writeEnv(t, f, nil)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", route, sampleRPCRequest, nil)
	requireFakeReached(t, f)
	return f, res
}

// runWritePassthrough sends one write request whose page succeeds, returning
// the fake and the proxy response.
func runWritePassthrough(t *testing.T, route string, page fakePage, body string, headers map[string]string) (*fakeMCP, *testEnv, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.addPage(route, page)
	env := writeEnv(t, f, nil)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", route, body, headers)
	requireFakeReached(t, f)
	return f, env, res
}

// ---------------------------------------------------------------------------
// G2/C-9: fail-loud at startup (mirrors 001 TestP9b).
// ---------------------------------------------------------------------------

// startProxyExpectExit starts the binary and requires it to exit on its own
// within a short deadline, returning the exit code and combined output. A proxy
// that keeps running (no fail-loud) makes the test fail.
func startProxyExpectExit(t *testing.T, env *testEnv) (int, string) {
	t.Helper()
	bin := requireBinary(t)
	cmd := exec.Command(bin)
	cmd.Env = env.list()
	cmd.Dir = env.Dir
	var out lockedBuf
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("fb-025-003 %s: starting vlp-odoosh-proxy: %v", t.Name(), err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-done:
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		return code, out.String()
	case <-time.After(4 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("fb-025-003 %s: proxy did not exit within 4s on an invalid knob; expected fail-loud\noutput: %s", t.Name(), out.String())
	}
	return 0, ""
}
