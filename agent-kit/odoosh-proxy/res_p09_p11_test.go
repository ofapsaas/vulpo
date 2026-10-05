// fb-025-002 spec §3.3 P9–P11 (RED). Prefix TestR (C-9).
package main_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// P10. Transport read cap, pre-decode (RED)
// ---------------------------------------------------------------------------

// TestR10_TransportCap: the fake emits a tools/call response larger than the
// 2 MiB transport cap while keeping content[0].text a SMALL page (C-8). 001
// (no cap) reads it all and returns 200; 002 must reject with its own transport
// cap message and never serve a partial/truncated page.
func TestR10_TransportCap(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.transportHuge = (2 << 20) + 1 }) // response > 2 MiB
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litTransportCap)
	if strings.Contains(string(res.Body), sampleRPCResponse) {
		t.Errorf("fb-025-002 %s: transport cap response leaked the page (partial/truncated body)", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}

// ---------------------------------------------------------------------------
// P9. Classified timeouts (RED)
// ---------------------------------------------------------------------------

func TestR9a_EvalTimeout(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, map[string]string{"VLP_EVAL_TIMEOUT": "1"})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 504)
	expectContains(t, "body", string(res.Body), litEvalTimeout)
	expectNoSecrets(t, "body", res.Body)
}

func TestR9b_HubTimeout(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.evalErr = &rpcError{Code: -32000, Message: rawHubTimeout} })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 504)
	expectContains(t, "body", string(res.Body), litHubIdleTimeout)
	expectContains(t, "body", string(res.Body), rawHubTimeout)
	expectNoSecrets(t, "body", res.Body)
}

// TestR9_TwoTimeoutsDistinct pins that the two 504s carry different semantics.
func TestR9_TwoTimeoutsDistinct(t *testing.T) {
	fc := newFakeMCP(t)
	fc.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	fc.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	envC := recoveryEnv(t, fc, map[string]string{"VLP_EVAL_TIMEOUT": "1"})
	startProxy(t, envC)
	client := proxyClientDo(t, envC, "POST", "/app/x", sampleRPCRequest, nil)

	fh := newFakeMCP(t)
	fh.set(func(f *fakeMCP) { f.evalErr = &rpcError{Code: -32000, Message: rawHubTimeout} })
	fh.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	envH := recoveryEnv(t, fh, nil)
	startProxy(t, envH)
	hub := proxyClientDo(t, envH, "POST", "/app/x", sampleRPCRequest, nil)

	if client.Status != 504 || hub.Status != 504 {
		t.Fatalf("fb-025-002 %s: statuses = %d/%d, want 504/504", t.Name(), client.Status, hub.Status)
	}
	if string(client.Body) == string(hub.Body) {
		t.Errorf("fb-025-002 %s: eval timeout and hub idle timeout produce the same body %q", t.Name(), client.Body)
	}
}

// ---------------------------------------------------------------------------
// P11. GET /readyz (RED) — /healthz stays liveness-only
// ---------------------------------------------------------------------------

func readyzBody(t *testing.T, res httpResult) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(res.Body, &m); err != nil {
		t.Fatalf("fb-025-002 %s: /readyz body is not JSON: %v (%q)", t.Name(), err, res.Body)
	}
	return m
}

func TestR11a_ReadyzOK(t *testing.T) {
	f := newFakeMCP(t) // connected, one tab with the VLP_TAB_URL_PREFIX url
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/readyz", "", nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 200)
	m := readyzBody(t, res)
	if m["status"] != "ready" {
		t.Errorf("fb-025-002 %s: /readyz status = %v, want ready", t.Name(), m["status"])
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestR11b_ReadyzDisconnected(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.connected = false })
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/readyz", "", nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 503)
	m := readyzBody(t, res)
	if m["status"] != "not_ready" {
		t.Errorf("fb-025-002 %s: /readyz status = %v, want not_ready", t.Name(), m["status"])
	}
	if m["error"] == nil || m["error"] == "" {
		t.Errorf("fb-025-002 %s: /readyz not_ready has no motivo: %v", t.Name(), m)
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestR11c_ReadyzNoTabConsultsChain(t *testing.T) {
	f := newFakeMCP(t)
	// A tab that does NOT start with VLP_TAB_URL_PREFIX -> no usable tab.
	f.set(func(f *fakeMCP) { f.tabs = []map[string]any{tabWire(9, "https://other.example/x", "other", 0)} })
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/readyz", "", nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 503)
	if got := listTabsCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: /readyz did not consult vlp_listTabs (%d calls)", t.Name(), got)
	}
	m := readyzBody(t, res)
	if m["status"] != "not_ready" {
		t.Errorf("fb-025-002 %s: /readyz status = %v, want not_ready", t.Name(), m["status"])
	}
}

// TestR11d_NoSecrets is a guard: neither the ready (200) nor the not-ready
// (503) body may carry token/cookie/access_token.
func TestR11d_NoSecrets(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	ok := proxyClientDo(t, env, "GET", "/readyz", "", nil)
	expectNoSecrets(t, "readyz body", ok.Body)

	f.set(func(f *fakeMCP) { f.connected = false })
	down := proxyClientDo(t, env, "GET", "/readyz", "", nil)
	expectNoSecrets(t, "readyz not-ready body", down.Body)
}

func TestR11e_HealthzUnchanged(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, res, 200)
	m := readyzBody(t, res)
	if m["status"] != "ok" {
		t.Errorf("fb-025-002 %s: /healthz status = %v, want ok", t.Name(), m["status"])
	}
	// D-5/D-11: /healthz is liveness-only and must not consult the chain.
	if got := len(f.requests()); got != 0 {
		t.Errorf("fb-025-002 %s: /healthz consulted the MCP chain (%d fake requests)", t.Name(), got)
	}
}

func TestR11f_OtherPaths403(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	startProxy(t, env)

	for _, p := range []string{"/other", "/readyz/extra", "/healthz/extra", "/"} {
		res := proxyClientDo(t, env, "GET", p, "", nil)
		if res.Status != 403 {
			t.Errorf("fb-025-002 %s: GET %q status = %d, want 403 (only /healthz and /readyz are GET-allowlisted)", t.Name(), p, res.Status)
		}
	}
}
