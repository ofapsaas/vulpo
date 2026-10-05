// fb-025-001 spec §3.3 P1–P4. One test per postcondition (sub-lettered).
package main_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// P1. Passthrough byte-a-byte
// ---------------------------------------------------------------------------

func TestP1a_PassthroughByteForByte(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/my/inventory", fakePage{
		status: 200,
		ct:     "application/json; charset=utf-8",
		body:   sampleRPCResponse,
		url:    "https://www.odoo.sh/app/my/inventory",
	})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/my/inventory", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if got := res.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("fb-025 %s: Content-Type = %q, want the page ct byte-for-byte", t.Name(), got)
	}
	if string(res.Body) != sampleRPCResponse {
		t.Errorf("fb-025 %s: body = %q, want byte-for-byte %q", t.Name(), res.Body, sampleRPCResponse)
	}

	// Guard: the fake was called and the body parses as JSON-RPC.
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request; the proxy did not evaluate", t.Name())
	}
	var rpc map[string]any
	if err := json.Unmarshal(res.Body, &rpc); err != nil {
		t.Fatalf("fb-025 %s: body is not JSON-RPC: %v (%q)", t.Name(), err, res.Body)
	}
	if rpc["jsonrpc"] != "2.0" || rpc["result"] == nil {
		t.Errorf("fb-025 %s: body missing jsonrpc/result: %v", t.Name(), rpc)
	}
}

func TestP1b_NonOKStatusPassthrough(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"boom"}}`
	f := newFakeMCP(t)
	f.addPage("/app/my/inventory", fakePage{
		status: 500,
		ct:     "application/json",
		body:   body,
		url:    "https://www.odoo.sh/app/my/inventory",
	})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/my/inventory", sampleRPCRequest, nil)
	expectStatus(t, res, 500)
	if string(res.Body) != body {
		t.Errorf("fb-025 %s: body = %q, want the real 500 body %q", t.Name(), res.Body, body)
	}
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	var rpc map[string]any
	if err := json.Unmarshal(res.Body, &rpc); err != nil || rpc["jsonrpc"] == nil {
		t.Errorf("fb-025 %s: body is not JSON-RPC: %v (%q)", t.Name(), err, res.Body)
	}
}

// ---------------------------------------------------------------------------
// P2. Cookie discard
// ---------------------------------------------------------------------------

func p2Page(t *testing.T) (*fakeMCP, *testEnv) {
	t.Helper()
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{
		status: 200,
		ct:     "application/json; charset=utf-8",
		body:   sampleRPCResponse,
		url:    "https://www.odoo.sh/app/x",
	})
	env := newEnv(t, f.URL())
	startProxy(t, env)
	return f, env
}

func TestP2a_CookieNotForwarded(t *testing.T) {
	f, env := p2Page(t)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, map[string]string{
		"Cookie": "session_id=" + sentinelCookie,
	})
	expectStatus(t, res, 200)

	reqs := f.requests()
	if len(reqs) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	for i, r := range reqs {
		if r.HasCookie {
			t.Errorf("fb-025 %s: request %d (%s) forwarded a Cookie header: %q", t.Name(), i, r.Method, r.Cookie)
		}
		if strings.Contains(r.Cookie, sentinelCookie) {
			t.Errorf("fb-025 %s: request %d carries the cookie value", t.Name(), i)
		}
		if strings.Contains(r.Body, sentinelCookie) {
			t.Errorf("fb-025 %s: request %d body carries the cookie value", t.Name(), i)
		}
	}
}

func TestP2b_LogRedactsCookie(t *testing.T) {
	f, env := p2Page(t)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, map[string]string{
		"Cookie": "session_id=" + sentinelCookie,
	})
	expectStatus(t, res, 200)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}

	log := readFileOrEmpty(env.LogFile)
	if log == "" {
		t.Fatalf("fb-025 %s: proxy log %s was not written; the incoming Cookie must be logged as <redacted>", t.Name(), env.LogFile)
	}
	expectNotContains(t, "proxy log", log, sentinelCookie)
	expectContains(t, "proxy log", log, "<redacted>")
}

func TestP2c_ResponseIndependentOfCookie(t *testing.T) {
	f, env := p2Page(t)
	withCookie := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, map[string]string{
		"Cookie": "session_id=" + sentinelCookie,
	})
	without := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)

	if withCookie.Status != 200 || without.Status != 200 {
		t.Fatalf("fb-025 %s: statuses = %d/%d, want 200/200", t.Name(), withCookie.Status, without.Status)
	}
	if withCookie.Status != without.Status || string(withCookie.Body) != string(without.Body) {
		t.Errorf("fb-025 %s: response depends on the cookie: with=%d/%q without=%d/%q",
			t.Name(), withCookie.Status, withCookie.Body, without.Status, without.Body)
	}
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
}

func TestP2d_ProxyResponseHasNoCookie(t *testing.T) {
	_, env := p2Page(t)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, map[string]string{
		"Cookie": "session_id=" + sentinelCookie,
	})
	expectStatus(t, res, 200)
	if v := res.Header.Get("Set-Cookie"); v != "" {
		t.Errorf("fb-025 %s: proxy response set Set-Cookie: %q", t.Name(), v)
	}
	if v := res.Header.Get("Cookie"); v != "" {
		t.Errorf("fb-025 %s: proxy response carries Cookie: %q", t.Name(), v)
	}
}

// ---------------------------------------------------------------------------
// P3. Allowlist
// ---------------------------------------------------------------------------

func fakeCount(f *fakeMCP) int { return len(f.requests()) }

func TestP3a_OutsideAppForbidden(t *testing.T) {
	f, env := p2Page(t)
	before := fakeCount(f)
	res := proxyClientDo(t, env, "POST", "/other/x", sampleRPCRequest, nil)
	expectStatus(t, res, 403)
	if got := fakeCount(f); got != before {
		t.Errorf("fb-025 %s: fake counter changed (%d -> %d); a forbidden path must not evaluate", t.Name(), before, got)
	}
}

func TestP3b_ForbiddenPathMetachars(t *testing.T) {
	f, env := p2Page(t)
	targets := []string{"/app//x", "/app/a\\b", "/app/@x", "/app/http://evil"}
	before := fakeCount(f)
	for _, target := range targets {
		res := proxyRaw(t, env, "POST", target, nil, sampleRPCRequest)
		if res.Status != 403 {
			t.Errorf("fb-025 %s: POST %q status = %d, want 403", t.Name(), target, res.Status)
		}
	}
	if got := fakeCount(f); got != before {
		t.Errorf("fb-025 %s: fake counter changed (%d -> %d); forbidden paths must not evaluate", t.Name(), before, got)
	}
}

func TestP3c_NonPOSTAndUnknownGETForbidden(t *testing.T) {
	f, env := p2Page(t)
	before := fakeCount(f)
	// GET on /app (P3c) and GET on any non-healthz path (§3.4).
	for _, target := range []string{"/app/x", "/other", "/healthz/extra"} {
		res := proxyRaw(t, env, "GET", target, nil, "")
		if res.Status != 403 {
			t.Errorf("fb-025 %s: GET %q status = %d, want 403", t.Name(), target, res.Status)
		}
	}
	if got := fakeCount(f); got != before {
		t.Errorf("fb-025 %s: fake counter changed (%d -> %d)", t.Name(), before, got)
	}
}

func TestP3d_TraversalForbidden(t *testing.T) {
	f, env := p2Page(t)
	before := fakeCount(f)
	res := proxyRaw(t, env, "POST", "/app/../x", nil, sampleRPCRequest)
	expectStatus(t, res, 403)
	if got := fakeCount(f); got != before {
		t.Errorf("fb-025 %s: fake counter changed (%d -> %d); traversal must not evaluate", t.Name(), before, got)
	}
}

// ---------------------------------------------------------------------------
// P4. Expired session -> auth
// ---------------------------------------------------------------------------

func TestP4a_LoginURLMapsTo302(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/my/inventory", fakePage{
		status: 200,
		ct:     "text/html; charset=utf-8",
		body:   "<html><body>login</body></html>",
		url:    "https://www.odoo.sh/web/login?redirect=/app/my/inventory",
	})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/my/inventory", sampleRPCRequest, nil)
	expectStatus(t, res, 302)
	if len(res.Body) != 0 {
		t.Errorf("fb-025 %s: 302 must have an empty body, got %q", t.Name(), res.Body)
	}
	if v := res.Header.Get("Set-Cookie"); v != "" {
		t.Errorf("fb-025 %s: 302 must not carry a Cookie: %q", t.Name(), v)
	}
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
}

func TestP4b_SessionExpiredBodyPassthrough(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":1,"error":{"code":100,"message":"SessionExpiredException"}}`
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: body, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if string(res.Body) != body {
		t.Errorf("fb-025 %s: body = %q, want passthrough %q", t.Name(), res.Body, body)
	}
	expectContains(t, "body", string(res.Body), "SessionExpiredException")
}

func TestP4c_InsufficientScopeBodyPassthrough(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":1,"error":{"code":200,"message":"InsufficientScopeError"}}`
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: body, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if string(res.Body) != body {
		t.Errorf("fb-025 %s: body = %q, want passthrough %q", t.Name(), res.Body, body)
	}
	expectContains(t, "body", string(res.Body), "InsufficientScopeError")
}
