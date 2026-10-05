// fb-025-003 spec §3.3 P5–P8 (RED/GUARD). Prefix TestW (AUDIT §2).
package main_test

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// P5. VLP_RECOVER_ON_WRITE opt-in (RED P5a; GUARD P5b/P5c)
// ---------------------------------------------------------------------------

func TestW5a_KnobOffNoRecoveryOnWrite(t *testing.T) {
	// writeEnv defaults the knob to "0": the default-safe policy of D-1/D-3.
	f, res := runRecovery(t, "/app/branch/1/fork", nil)
	assertNoRecovery(t, f, res, rawCandidate)
}

func TestW5b_KnobOnRecoversWrite(t *testing.T) {
	f, res := runRecovery(t, "/app/branch/1/fork", map[string]string{"VLP_RECOVER_ON_WRITE": "1"})
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-003 %s: knob=1 did not enable recovery on a write route (navigate=%d)", t.Name(), got)
	}
	if got := pageEvalCount(f); got != 2 {
		t.Errorf("fb-025-003 %s: page evals = %d, want exactly 2 with the knob on", t.Name(), got)
	}
}

func TestW5c_KnobOffStillRecoversRead(t *testing.T) {
	f, res := runRecovery(t, readRecoveryRoute, nil)
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-003 %s: knob=0 must not disable READ recovery (navigate=%d)", t.Name(), got)
	}
	if got := pageEvalCount(f); got != 2 {
		t.Errorf("fb-025-003 %s: page evals = %d, want exactly 2", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// P6. Surface unchanged: the allowlist governs only the retry, not the surface
// ---------------------------------------------------------------------------

func TestW6a_GetAppForbidden(t *testing.T) {
	f := newFakeMCP(t)
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/app/", "", nil)
	expectStatus(t, res, 403)
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025-003 %s: GET /app/ reached the transport (%d requests); want 0", t.Name(), got)
	}
}

func TestW6b_OutsideAppForbidden(t *testing.T) {
	f := newFakeMCP(t)
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/other/x", sampleRPCRequest, nil)
	expectStatus(t, res, 403)
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025-003 %s: a path outside /app/ reached the transport (%d requests); want 0", t.Name(), got)
	}
}

func TestW6c_MetacharsForbidden(t *testing.T) {
	f := newFakeMCP(t)
	env := writeEnv(t, f, nil)
	startProxy(t, env)
	before := len(f.requests())

	for _, target := range []string{"/app//x", "/app/a\\b", "/app/@x", "/app/http://evil", "/app/../x"} {
		res := proxyRaw(t, env, "POST", target, nil, sampleRPCRequest)
		if res.Status != 403 {
			t.Errorf("fb-025-003 %s: POST %q status = %d, want 403", t.Name(), target, res.Status)
		}
	}
	if got := len(f.requests()); got != before {
		t.Errorf("fb-025-003 %s: forbidden paths reached the transport (%d -> %d)", t.Name(), before, got)
	}
}

func TestW6d_UnknownWriteRouteStillPassthrough(t *testing.T) {
	// The read allowlist must NOT restrict the surface (D-13/I-15): a write
	// route the allowlist never pinned still passes byte-for-byte.
	_, _, res := runWritePassthrough(t, unknownRoute, fakePage{
		status: 200,
		ct:     "application/json",
		body:   sampleRPCResponse,
		url:    "https://www.odoo.sh" + unknownRoute,
	}, sampleRPCRequest, nil)

	expectStatus(t, res, 200)
	if string(res.Body) != sampleRPCResponse {
		t.Errorf("fb-025-003 %s: body = %q, want passthrough %q", t.Name(), res.Body, sampleRPCResponse)
	}
}

// ---------------------------------------------------------------------------
// P7. Business-error mapping without new codes (GUARD)
// ---------------------------------------------------------------------------

func TestW7a_NonCandidateRowsUnchanged(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		lit    string
		status int
	}{
		{"plan_mode", rawPlanMode, litPlanMode, 502},
		{"rate_limit", rawRateLimit, litRateLimit, 502},
		{"code_too_large", rawCodeTooLarge, litCodeTooLarge, 413},
		{"superseded", rawSuperseded, litSuperseded, 502},
		{"disconnected", rawDisconnected, litDisconnected, 502},
		{"hub_timeout", rawHubTimeout, litHubIdleTimeout, 504},
		{"unknown", rawUnknown, litToolError, 502},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) { f.evalErr = &rpcError{Code: -32000, Message: tc.raw} })
			env := writeEnv(t, f, nil)
			startProxy(t, env)

			res := proxyClientDo(t, env, "POST", "/app/branch/1/fork", sampleRPCRequest, nil)
			requireFakeReached(t, f)
			expectStatus(t, res, tc.status)
			decoded := decodeErrorField(t, res.Body)
			expectContains(t, "decoded error", decoded, tc.lit)
			expectContains(t, "decoded error", decoded, tc.raw)
			if navigateCount(f)+activateCount(f) != 0 {
				t.Errorf("fb-025-003 %s: a non-candidate -32000 recovered (navigate=%d activate=%d)", t.Name(), navigateCount(f), activateCount(f))
			}
		})
	}
}

func TestW7b_SessionExpiredAndLoginOnWrite(t *testing.T) {
	// Body SessionExpiredException -> passthrough.
	const expired = `{"jsonrpc":"2.0","id":1,"error":{"code":100,"message":"SessionExpiredException"}}`
	_, _, exp := runWritePassthrough(t, "/app/project/x/set_settings", fakePage{
		status: 200,
		ct:     "application/json",
		body:   expired,
		url:    "https://www.odoo.sh/app/project/x/set_settings",
	}, writeSetSettingsBody, nil)
	expectStatus(t, exp, 200)
	if string(exp.Body) != expired {
		t.Errorf("fb-025-003 %s: SessionExpiredException body = %q, want passthrough %q", t.Name(), exp.Body, expired)
	}

	// url with /web/login -> 302.
	_, _, login := runWritePassthrough(t, "/app/branch/1/fork", fakePage{
		status: 200,
		ct:     "text/html; charset=utf-8",
		body:   "<html>login</html>",
		url:    "https://www.odoo.sh/web/login?redirect=/app/branch/1/fork",
	}, writeForkBody, nil)
	expectStatus(t, login, 302)
}

func TestW7c_StatusSetClosed(t *testing.T) {
	allowed := map[int]bool{200: true, 302: true, 403: true, 413: true, 502: true, 504: true}

	fOK := newFakeMCP(t)
	fOK.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	envOK := writeEnv(t, fOK, nil)
	startProxy(t, envOK)
	passthrough := proxyClientDo(t, envOK, "POST", "/app/branch/1/fork", sampleRPCRequest, nil)

	fLogin := newFakeMCP(t)
	fLogin.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "text/html", body: "<html>", url: "https://www.odoo.sh/web/login"})
	envLogin := writeEnv(t, fLogin, nil)
	startProxy(t, envLogin)
	login := proxyClientDo(t, envLogin, "POST", "/app/branch/1/fork", sampleRPCRequest, nil)

	fForbidden := newFakeMCP(t)
	envForbidden := writeEnv(t, fForbidden, nil)
	startProxy(t, envForbidden)
	forbidden := proxyClientDo(t, envForbidden, "POST", "/other/x", sampleRPCRequest, nil)

	fOversized := newFakeMCP(t)
	envOversized := writeEnv(t, fOversized, nil)
	startProxy(t, envOversized)
	oversized := proxyClientDo(t, envOversized, "POST", "/app/"+strings.Repeat("a", 25000), sampleRPCRequest, nil)

	_, guard := runRecovery(t, "/app/branch/1/fork", nil)

	fTimeout := newFakeMCP(t)
	fTimeout.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	fTimeout.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	envTimeout := writeEnv(t, fTimeout, map[string]string{"VLP_EVAL_TIMEOUT": "1"})
	startProxy(t, envTimeout)
	timeout := proxyClientDo(t, envTimeout, "POST", "/app/branch/1/fork", sampleRPCRequest, nil)

	seen := map[string]int{
		"passthrough": passthrough.Status,
		"login":       login.Status,
		"forbidden":   forbidden.Status,
		"oversized":   oversized.Status,
		"guard":       guard.Status,
		"timeout":     timeout.Status,
	}
	for name, s := range seen {
		if !allowed[s] {
			t.Errorf("fb-025-003 %s: scenario %s produced status %d, outside the closed set {200,302,403,413,502,504} (P7)", t.Name(), name, s)
		}
	}
}

// ---------------------------------------------------------------------------
// P8. 001/002 invariants preserved under a write request (GUARD)
// ---------------------------------------------------------------------------

func TestW8a_CookieDroppedOnWrite(t *testing.T) {
	f, env, res := runWritePassthrough(t, "/app/branch/1/fork", fakePage{
		status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork",
	}, writeForkBody, map[string]string{"Cookie": "session_id=" + sentinelCookie})

	expectStatus(t, res, 200)
	for i, r := range f.requests() {
		if r.HasCookie || strings.Contains(r.Cookie, sentinelCookie) {
			t.Errorf("fb-025-003 %s: request %d forwarded a Cookie: %q", t.Name(), i, r.Cookie)
		}
		if strings.Contains(r.Body, sentinelCookie) {
			t.Errorf("fb-025-003 %s: request %d body carries the cookie", t.Name(), i)
		}
		if strings.Contains(argCode(r.Arguments), sentinelCookie) {
			t.Errorf("fb-025-003 %s: request %d eval code carries the cookie", t.Name(), i)
		}
	}
	expectNotContains(t, "proxy log", readFileOrEmpty(env.LogFile), sentinelCookie)
}

func TestW8b_TokenOnlyInHeaderOnWrite(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	env := writeEnv(t, f, nil)
	p := startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/branch/1/fork", writeForkBody, nil)
	if res.Status != 200 {
		t.Fatalf("fb-025-003 %s: write request did not succeed (%d); cannot audit the wire", t.Name(), res.Status)
	}
	sawEval := false
	for i, r := range f.requests() {
		if r.Method != "tools/call" || r.ToolName != "vlp_eval" {
			continue
		}
		sawEval = true
		if r.Token != sentinelToken {
			t.Errorf("fb-025-003 %s: request %d x-vlp-token = %q, want the sentinel token", t.Name(), i, r.Token)
		}
		if strings.Contains(string(r.Arguments), sentinelToken) {
			t.Errorf("fb-025-003 %s: request %d eval arguments contain the token", t.Name(), i)
		}
		if strings.Contains(r.Body, sentinelToken) {
			t.Errorf("fb-025-003 %s: request %d MCP body contains the token", t.Name(), i)
		}
	}
	if !sawEval {
		t.Fatalf("fb-025-003 %s: no vlp_eval reached the fake; cannot audit the token placement", t.Name())
	}
	expectNotContains(t, "proxy log", readFileOrEmpty(env.LogFile), sentinelToken)
	expectNotContains(t, "os.Args", procArgs(t, p.cmd.Process.Pid), sentinelToken)
	expectNotContains(t, "stdout", p.stdout.String(), sentinelToken)
	expectNotContains(t, "stderr", p.stderr.String(), sentinelToken)
}

func TestW8c_NoSessionFileOnWrite(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	before := snapshotFiles(t, env.Dir)
	res := proxyClientDo(t, env, "POST", "/app/branch/1/fork", writeForkBody, map[string]string{"Cookie": "session_id=" + sentinelCookie})
	if res.Status != 200 {
		t.Fatalf("fb-025-003 %s: write request failed (%d); cannot audit disk artifacts", t.Name(), res.Status)
	}
	requireFakeReached(t, f)
	after := snapshotFiles(t, env.Dir)

	for _, path := range diffFiles(before, after) {
		if strings.Contains(strings.ToLower(filepath.Base(path)), "session") {
			t.Errorf("fb-025-003 %s: proxy created a session file: %s (I-9)", t.Name(), path)
		}
		content := readFileOrEmpty(path)
		if strings.Contains(content, sentinelCookie) || strings.Contains(content, sentinelToken) {
			t.Errorf("fb-025-003 %s: artifact %s leaked a secret", t.Name(), path)
		}
	}
	log := readFileOrEmpty(env.LogFile)
	expectNotContains(t, "proxy log", log, sentinelCookie)
	expectNotContains(t, "proxy log", log, sentinelToken)
	for _, r := range f.requests() {
		if r.IssuedSession == "" {
			continue
		}
		if path, found := walkContains(t, env.Dir, r.IssuedSession); found {
			t.Errorf("fb-025-003 %s: MCP session id written to %s (I-9)", t.Name(), path)
		}
	}
}

func TestW8d_OversizedWriteCode413(t *testing.T) {
	f := newFakeMCP(t)
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	longPath := "/app/" + strings.Repeat("a", 25000) // eval code > 20 000 chars
	res := proxyClientDo(t, env, "POST", longPath, sampleRPCRequest, nil)
	expectStatus(t, res, 413)
	if len(f.requests()) != 0 {
		t.Errorf("fb-025-003 %s: the fake was called despite the oversized code (%d requests)", t.Name(), len(f.requests()))
	}
}

func TestW8e_ResponseCapOnWrite502(t *testing.T) {
	big := strings.Repeat("x", (1<<20)+10) // decoded body > 1 MiB
	_, _, res := runWritePassthrough(t, "/app/branch/1/fork", fakePage{
		status: 200, ct: "application/json", body: big, url: "https://www.odoo.sh/app/branch/1/fork",
	}, writeForkBody, nil)

	expectStatus(t, res, 502)
	expectNoSecrets(t, "body", res.Body)
}

func TestW8f_TransportCapOnWrite502(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.transportHuge = (2 << 20) + 1 }) // response > 2 MiB
	f.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/branch/1/fork", writeForkBody, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litTransportCap)
	expectNoSecrets(t, "body", res.Body)
}

func TestW8g_PerTabSerializationOnWrite(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 200 * time.Millisecond }) // widen the overlap window
	f.addPage("/app/branch/1/fork", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/branch/1/fork"})
	env := writeEnv(t, f, nil)
	startProxy(t, env)

	var wg sync.WaitGroup
	results := make([]httpResult, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = proxyClientDoErr(env, "POST", "/app/branch/1/fork", writeForkBody, nil)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("fb-025-003 %s: concurrent write %d failed: %v", t.Name(), i, err)
		}
	}
	for i, res := range results {
		if res.Status != 200 {
			t.Errorf("fb-025-003 %s: concurrent write %d status = %d, want 200", t.Name(), i, res.Status)
		}
	}
	evals := f.toolCalls("vlp_eval")
	if len(evals) < 2 {
		t.Fatalf("fb-025-003 %s: fake observed %d evals, want >= 2", t.Name(), len(evals))
	}
	if f.overlapped() {
		t.Errorf("fb-025-003 %s: two concurrent writes to the same tab overlapped (per-tab serialization violated)", t.Name())
	}
}
