// fb-025-002 spec §3.3 P5–P8 (RED). Prefix TestR (C-9).
package main_test

import (
	"testing"
)

// ---------------------------------------------------------------------------
// P5. Closed classification table of -32000 (RED)
// ---------------------------------------------------------------------------

// r5EvalError drives one allowed request whose page eval fails with a static
// -32000 message, and returns the fake plus the proxy response.
func r5EvalError(t *testing.T, msg string) (*fakeMCP, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.evalErr = &rpcError{Code: -32000, Message: msg} })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	return f, res
}

// r5Recovers drives a discarded tab whose navigate clears the discard -> 200.
// C-1 (fb-025-003, ratified HITL 2026-10-05): the caller pins the route. The
// generic-candidate witness (TestR5a) is re-pointed to a READ route because the
// 003 guard restricts recovery to read; the host-permission witness (TestR5b)
// stays on /app/x (D-2: host-permission recovers on every route).
func r5Recovers(t *testing.T, raw, path string) (*fakeMCP, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.discardedMsg = raw
		f.navigateRecovers = true
	})
	f.addPage(path, fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh" + path})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", path, sampleRPCRequest, nil)
	requireFakeReached(t, f)
	return f, res
}

func TestR5a_CandidateRecovers(t *testing.T) {
	f, res := r5Recovers(t, rawCandidate, "/app/project/x/get_info")
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: candidate -32000 did not trigger recovery (navigate=%d)", t.Name(), got)
	}
}

func TestR5b_HostPermissionRecovers(t *testing.T) {
	f, res := r5Recovers(t, rawHostPerm, "/app/x")
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: 'Missing host permission' candidate did not trigger recovery (navigate=%d)", t.Name(), got)
	}
}

func TestR5c_PlanMode(t *testing.T) {
	f, res := r5EvalError(t, rawPlanMode)
	expectStatus(t, res, 502)
	// §3.5.1 (enmendada 2026-10-05): el body es SIEMPRE JSON válido (json.Marshal,
	// como 001); el raw de Plan mode contiene comillas, así que se compara sobre
	// el campo `error` DECODIFICADO (módulo escape JSON), nunca sobre los bytes.
	decoded := decodeErrorField(t, res.Body)
	expectContains(t, "decoded error", decoded, litPlanMode)
	expectContains(t, "decoded error", decoded, rawPlanMode) // raw preserved modulo JSON escape
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: Plan mode must not recover (navigate=%d activate=%d)", t.Name(), navigateCount(f), activateCount(f))
	}
}

func TestR5d_RateLimit(t *testing.T) {
	f, res := r5EvalError(t, rawRateLimit)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litRateLimit)
	expectContains(t, "body", string(res.Body), rawRateLimit)
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: rate limit must not recover", t.Name())
	}
}

func TestR5e_CodeTooLarge(t *testing.T) {
	f, res := r5EvalError(t, rawCodeTooLarge)
	expectStatus(t, res, 413)
	expectContains(t, "body", string(res.Body), litCodeTooLarge)
	expectContains(t, "body", string(res.Body), rawCodeTooLarge)
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: 'Code too large' must not recover", t.Name())
	}
}

func TestR5f_Superseded(t *testing.T) {
	f, res := r5EvalError(t, rawSuperseded)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litSuperseded)
	expectContains(t, "body", string(res.Body), "superseded")
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: superseded is terminal and must not recover", t.Name())
	}
}

func TestR5g_Disconnected(t *testing.T) {
	f, res := r5EvalError(t, rawDisconnected)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litDisconnected)
	expectContains(t, "body", string(res.Body), rawDisconnected)
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: extension disconnected must fail fast, not recover", t.Name())
	}
}

func TestR5h_NoTab(t *testing.T) {
	f, res := r5EvalError(t, "No extension has tab 42")
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litNoTab)
	expectContains(t, "body", string(res.Body), "No extension has tab")
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: no-tab must not recover", t.Name())
	}
}

func TestR5i_Unknown(t *testing.T) {
	f, res := r5EvalError(t, rawUnknown)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litToolError)
	expectContains(t, "body", string(res.Body), rawUnknown)
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: an unknown -32000 must not recover (I-13)", t.Name())
	}
}

// TestR5_DistinctTerminalTransient pins that the two connection-failure rows
// carry distinct semantics (P5): superseded [terminal] vs disconnected
// [transient].
func TestR5_DistinctTerminalTransient(t *testing.T) {
	_, super := r5EvalError(t, rawSuperseded)
	_, disc := r5EvalError(t, rawDisconnected)
	if string(super.Body) == string(disc.Body) {
		t.Errorf("fb-025-002 %s: superseded and disconnected bodies are identical: %q", t.Name(), super.Body)
	}
	expectContains(t, "superseded body", string(super.Body), "terminal")
	expectContains(t, "disconnected body", string(disc.Body), "transient")
}

// ---------------------------------------------------------------------------
// P6. Recovery is disableable (GUARD: 001 already returns 502 without recovery)
// ---------------------------------------------------------------------------

func TestR6_RecoverDisabled(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.evalErr = &rpcError{Code: -32000, Message: rawCandidate} })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, map[string]string{"VLP_RECOVER_ON_AMBIGUOUS": "0"})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), rawCandidate) // raw preserved
	if got := pageEvalCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: page evals = %d, want exactly 1 (no retry when recovery is off)", t.Name(), got)
	}
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: recovery disabled but the proxy loaded the tab (navigate=%d activate=%d)", t.Name(), navigateCount(f), activateCount(f))
	}
}

// ---------------------------------------------------------------------------
// P7. Reactive, not proactive (GUARD)
// ---------------------------------------------------------------------------

func TestR7_ReactiveNotProactive(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 200)
	if navigateCount(f)+activateCount(f) != 0 {
		t.Errorf("fb-025-002 %s: a successful first eval triggered recovery (navigate=%d activate=%d)", t.Name(), navigateCount(f), activateCount(f))
	}
	if got := pageEvalCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: page evals = %d, want exactly 1 (no pre-flight)", t.Name(), got)
	}
	if got := probeCount(f); got != 0 {
		t.Errorf("fb-025-002 %s: readyState probes = %d, want 0 on the happy path", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// P8. Readiness race: retry with backoff, no cache (RED/GUARD)
// ---------------------------------------------------------------------------

// p8Env has no VLP_EVAL_TAB, forcing tab resolution via vlp_listTabs.
func p8Env(t *testing.T, f *fakeMCP) *testEnv {
	t.Helper()
	env := newEnv(t, f.URL())
	delete(env.Vars, "VLP_EVAL_TAB")
	env.Vars["VLP_RESOLVE_BACKOFF_MS"] = "20"
	return env
}

func TestR8a_ReadinessRetry(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.listTabsEmpty = 2 }) // first 2 calls -> [], then the tab
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := p8Env(t, f)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 200)
	if got := listTabsCount(f); got < 3 {
		t.Errorf("fb-025-002 %s: vlp_listTabs calls = %d, want >= 3 (retry past the empty window)", t.Name(), got)
	}
}

func TestR8b_AlwaysEmpty(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.listTabsAlwaysEmpty = true })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := p8Env(t, f)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	if got := listTabsCount(f); got < 2 {
		t.Errorf("fb-025-002 %s: vlp_listTabs calls = %d, want >= 2 (bounded retry, no single-shot 502)", t.Name(), got)
	}
}

func TestR8c_NoCache(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := p8Env(t, f)
	startProxy(t, env)

	for i := 0; i < 2; i++ {
		res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
		expectStatus(t, res, 200)
	}
	if got := listTabsCount(f); got < 2 {
		t.Errorf("fb-025-002 %s: vlp_listTabs calls = %d across 2 requests, want >= 2 (no cached tabId)", t.Name(), got)
	}
}
