// fb-025-001 spec §3.3 P5–P8. One test per postcondition (sub-lettered).
package main_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// P5. Token only in the header; never payload/code/log/argv
// ---------------------------------------------------------------------------

func TestP5_TokenOnlyInHeader(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	p := startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	if res.Status != 200 {
		t.Fatalf("fb-025 %s: request did not succeed (%d); cannot audit the wire", t.Name(), res.Status)
	}

	sawEval := false
	for i, r := range f.requests() {
		if r.Method != "tools/call" || r.ToolName != "vlp_eval" {
			continue
		}
		sawEval = true
		if r.Token != sentinelToken {
			t.Errorf("fb-025 %s: request %d x-vlp-token = %q, want the sentinel token", t.Name(), i, r.Token)
		}
		if strings.Contains(string(r.Arguments), sentinelToken) {
			t.Errorf("fb-025 %s: request %d eval arguments contain the token: %s", t.Name(), i, r.Arguments)
		}
		if strings.Contains(r.Body, sentinelToken) {
			t.Errorf("fb-025 %s: request %d MCP body contains the token", t.Name(), i)
		}
	}
	if !sawEval {
		t.Fatalf("fb-025 %s: no vlp_eval reached the fake; cannot audit the token placement", t.Name())
	}

	expectNotContains(t, "proxy log", readFileOrEmpty(env.LogFile), sentinelToken)
	expectNotContains(t, "os.Args", procArgs(t, p.cmd.Process.Pid), sentinelToken)
	expectNotContains(t, "stdout", p.stdout.String(), sentinelToken)
	expectNotContains(t, "stderr", p.stderr.String(), sentinelToken)
}

// ---------------------------------------------------------------------------
// P6. Distinguishable errors, no secrets
// ---------------------------------------------------------------------------

// p6EvalError runs one allowed request whose eval fails with err and returns
// the proxy response.
func p6EvalError(t *testing.T, err *rpcError) httpResult {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.evalErr = err })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	return res
}

func TestP6a_ExtensionDisconnected(t *testing.T) {
	res := p6EvalError(t, &rpcError{Code: -32000, Message: noExtensionMsg})
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), "No extension connected for token")
	expectNoSecrets(t, "body", res.Body)
}

func TestP6b_TabNotFound(t *testing.T) {
	res := p6EvalError(t, &rpcError{Code: -32000, Message: "No extension has tab 42"})
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), "No extension has tab")
	expectNoSecrets(t, "body", res.Body)
}

func TestP6c_GenericToolError(t *testing.T) {
	res := p6EvalError(t, &rpcError{Code: -32000, Message: "tab was discarded"})
	expectStatus(t, res, 502)
	expectNoSecrets(t, "body", res.Body)
}

func TestP6d_TimeoutGives504(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TIMEOUT"] = "1" // C-4: short timeout
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 504)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestP6e_RateLimitGives502(t *testing.T) {
	res := p6EvalError(t, &rpcError{Code: -32000, Message: "Rate limit exceeded"})
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), "Rate limit exceeded")
	expectNoSecrets(t, "body", res.Body)
}

func TestP6f_OversizedEvalCodeGives413(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	longPath := "/app/" + strings.Repeat("a", 25000) // eval code > 20 000 chars
	res := proxyClientDo(t, env, "POST", longPath, sampleRPCRequest, nil)
	expectStatus(t, res, 413)
	if len(f.requests()) != 0 {
		t.Errorf("fb-025 %s: the fake was called despite the oversized eval code (%d requests)", t.Name(), len(f.requests()))
	}
}

func TestP6g_OversizedResponseGives502(t *testing.T) {
	f := newFakeMCP(t)
	big := strings.Repeat("x", (1<<20)+10) // decoded body > 1 MiB
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: big, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 502)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestP6h_InvalidUpstreamTokenGives502(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.token = "not-the-sentinel-token" })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 502)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestP6_TwoMessagesDistinct(t *testing.T) {
	disconnected := p6EvalError(t, &rpcError{Code: -32000, Message: noExtensionMsg})
	noTab := p6EvalError(t, &rpcError{Code: -32000, Message: "No extension has tab 42"})
	if string(disconnected.Body) == string(noTab.Body) {
		t.Errorf("fb-025 %s: 'extension disconnected' and 'tab not found' produce the same body %q; they must be distinguishable", t.Name(), disconnected.Body)
	}
	expectContains(t, "disconnected body", string(disconnected.Body), "No extension connected for token")
	expectContains(t, "no-tab body", string(noTab.Body), noTabMsgPrefix)
}

// ---------------------------------------------------------------------------
// P7. Tab resolution by origin
// ---------------------------------------------------------------------------

func p7Env(t *testing.T, tabs []map[string]any) (*fakeMCP, *testEnv) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.tabs = tabs })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	// P7a/P7c exercise discovery: clear the explicit tab so the proxy must
	// call vlp_listTabs and parse the bare array. P7b re-sets it to 33.
	delete(env.Vars, "VLP_EVAL_TAB")
	return f, env
}

func TestP7a_DiscoverTabByPrefix(t *testing.T) {
	f, env := p7Env(t, []map[string]any{
		tabWire(11, "https://other.example/x", "other", 0),
		tabWire(22, "https://www.odoo.sh/app", "odoo.sh", 1),
	})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if len(f.toolCalls("vlp_listTabs")) == 0 {
		t.Errorf("fb-025 %s: proxy did not call vlp_listTabs to discover the tab", t.Name())
	}
	evals := f.toolCalls("vlp_eval")
	if len(evals) == 0 {
		t.Fatalf("fb-025 %s: no vlp_eval reached the fake", t.Name())
	}
	if got := argTabID(evals[len(evals)-1].Arguments); got != 22 {
		t.Errorf("fb-025 %s: eval tabId = %d, want 22 (url prefix match)", t.Name(), got)
	}
}

func TestP7b_ExplicitTabSkipsDiscovery(t *testing.T) {
	f, env := p7Env(t, []map[string]any{
		tabWire(11, "https://other.example/x", "other", 0),
	})
	env.Vars["VLP_EVAL_TAB"] = "33"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if got := len(f.toolCalls("vlp_listTabs")); got != 0 {
		t.Errorf("fb-025 %s: proxy called vlp_listTabs %d time(s) despite VLP_EVAL_TAB being set", t.Name(), got)
	}
	evals := f.toolCalls("vlp_eval")
	if len(evals) == 0 {
		t.Fatalf("fb-025 %s: no vlp_eval reached the fake", t.Name())
	}
	if got := argTabID(evals[len(evals)-1].Arguments); got != 33 {
		t.Errorf("fb-025 %s: eval tabId = %d, want the configured 33", t.Name(), got)
	}
}

func TestP7c_NoMatchingTabGives502(t *testing.T) {
	f, env := p7Env(t, []map[string]any{
		tabWire(1, "https://other.example/x", "other", 0),
	})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 502)
	if len(f.toolCalls("vlp_listTabs")) == 0 {
		t.Errorf("fb-025 %s: proxy did not call vlp_listTabs", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}

// ---------------------------------------------------------------------------
// P8. Healthcheck
// ---------------------------------------------------------------------------

func TestP8a_HealthzOK(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, res, 200)
	var m map[string]any
	if err := json.Unmarshal(res.Body, &m); err != nil {
		t.Errorf("fb-025 %s: /healthz body is not JSON: %v (%q)", t.Name(), err, res.Body)
	} else if m["status"] != "ok" {
		t.Errorf("fb-025 %s: /healthz status = %v, want ok", t.Name(), m["status"])
	}
	// Guard: /healthz must not consult the Vulpo chain (D-11).
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025 %s: /healthz consulted the MCP chain (%d fake requests)", t.Name(), got)
	}
	expectNoSecrets(t, "body", res.Body)
}

// P8b/P8c start with a valid 0600 token (so §3.2's startup guard is satisfied
// and the service comes up) and then make the token unreadable: /healthz must
// re-check the token and report 503. This reconciles §3.2 ("no arranca" on a
// bad token at startup) with §3.4 ("503 si el token falta o modo ≠ 0600").
func TestP8b_HealthzUnavailableMissingToken(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	// Guard: healthy while the 0600 token is readable.
	ok := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, ok, 200)

	if err := os.Remove(env.TokenFile); err != nil {
		t.Fatalf("fb-025 %s: removing the token file: %v", t.Name(), err)
	}
	res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, res, 503)
	expectContains(t, "body", string(res.Body), "unavailable")
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025 %s: /healthz consulted the MCP chain (%d fake requests)", t.Name(), got)
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestP8c_HealthzUnavailableLooseMode(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	// Guard: healthy while the 0600 token is readable.
	ok := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, ok, 200)

	writeFileMode(t, env.TokenFile, sentinelToken+"\n", 0o644)
	res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, res, 503)
	expectContains(t, "body", string(res.Body), "unavailable")
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025 %s: /healthz consulted the MCP chain (%d fake requests)", t.Name(), got)
	}
	expectNoSecrets(t, "body", res.Body)
}
