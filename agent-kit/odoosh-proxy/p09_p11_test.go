// fb-025-001 spec §3.3 P9–P11. One test per postcondition (sub-lettered).
package main_test

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// P9. Config by env
// ---------------------------------------------------------------------------

func TestP9a_ConfiguredPortRespected(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL()) // newEnv picks a non-default free port in VLP_PROXY_PORT
	startProxy(t, env)

	// The configured port must serve: /healthz is the observable proof.
	res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
	expectStatus(t, res, 200)
}

func TestP9b_NonLoopbackWithoutOptInFailsLoud(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	env.Vars["VLP_PROXY_BIND"] = "0.0.0.0" // no VLP_PROXY_ALLOW_NON_LOOPBACK

	bin := requireBinary(t)
	cmd := exec.Command(bin)
	cmd.Env = env.list()
	cmd.Dir = env.Dir
	var out lockedBuf
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("fb-025 %s: starting vlp-odoosh-proxy: %v", t.Name(), err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		if err == nil {
			t.Errorf("fb-025 %s: proxy started on a non-loopback bind without VLP_PROXY_ALLOW_NON_LOOPBACK=1", t.Name())
		}
	case <-time.After(4 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		t.Errorf("fb-025 %s: proxy did not refuse to start on a non-loopback bind without opt-in\noutput: %s", t.Name(), out.String())
	}
}

// ---------------------------------------------------------------------------
// P10. No cookie/secret on disk; no session file (D-8)
// ---------------------------------------------------------------------------

func TestP10_NoSecretsOnDiskNoSessionFile(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	startProxy(t, env)

	before := snapshotFiles(t, env.Dir)
	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, map[string]string{
		"Cookie": "session_id=" + sentinelCookie,
	})
	if res.Status != 200 {
		t.Fatalf("fb-025 %s: request failed (%d); cannot audit disk artifacts", t.Name(), res.Status)
	}
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	after := snapshotFiles(t, env.Dir)

	for _, path := range diffFiles(before, after) {
		if strings.Contains(strings.ToLower(filepath.Base(path)), "session") {
			t.Errorf("fb-025 %s: proxy created a session file: %s (D-8)", t.Name(), path)
		}
		content := readFileOrEmpty(path)
		if strings.Contains(content, sentinelCookie) {
			t.Errorf("fb-025 %s: artifact %s contains the cookie", t.Name(), path)
		}
		if strings.Contains(content, sentinelToken) {
			t.Errorf("fb-025 %s: artifact %s contains the token", t.Name(), path)
		}
	}

	log := readFileOrEmpty(env.LogFile)
	expectNotContains(t, "proxy log", log, sentinelCookie)
	expectNotContains(t, "proxy log", log, sentinelToken)

	// D-8: the MCP session id must live only in memory.
	for _, r := range f.requests() {
		if r.IssuedSession == "" {
			continue
		}
		if path, found := walkContains(t, env.Dir, r.IssuedSession); found {
			t.Errorf("fb-025 %s: MCP session id written to %s (D-8)", t.Name(), path)
		}
	}
}

// ---------------------------------------------------------------------------
// P11. v2 transport
// ---------------------------------------------------------------------------

func TestP11a_InitializeProtocolVersionAndSession(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)

	inits := f.byMethod("initialize")
	if len(inits) == 0 {
		t.Fatalf("fb-025 %s: proxy did not call initialize", t.Name())
	}
	if got := inits[0].ProtocolVersion; got != "2025-06-18" {
		t.Errorf("fb-025 %s: initialize protocolVersion = %q, want 2025-06-18", t.Name(), got)
	}
	issued := inits[0].IssuedSession
	if issued == "" {
		t.Fatalf("fb-025 %s: initialize did not issue a session", t.Name())
	}
	evals := f.toolCalls("vlp_eval")
	if len(evals) == 0 {
		t.Fatalf("fb-025 %s: no vlp_eval reached the fake", t.Name())
	}
	if got := evals[0].SessionID; got != issued {
		t.Errorf("fb-025 %s: tools/call Mcp-Session-Id = %q, want the issued %q", t.Name(), got, issued)
	}
}

func TestP11b_ToolsCallHeaders(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)

	calls := f.byMethod("tools/call")
	if len(calls) == 0 {
		t.Fatalf("fb-025 %s: no tools/call reached the fake", t.Name())
	}
	for i, r := range calls {
		if r.Token != sentinelToken {
			t.Errorf("fb-025 %s: call %d x-vlp-token = %q, want the sentinel token", t.Name(), i, r.Token)
		}
		if r.SessionID == "" {
			t.Errorf("fb-025 %s: call %d has no Mcp-Session-Id", t.Name(), i)
		}
		if !strings.Contains(r.Accept, "application/json") {
			t.Errorf("fb-025 %s: call %d Accept = %q, want application/json", t.Name(), i, r.Accept)
		}
		if !strings.Contains(r.ContentType, "application/json") {
			t.Errorf("fb-025 %s: call %d Content-Type = %q, want application/json", t.Name(), i, r.ContentType)
		}
	}
}

func TestP11c_404ReinitializeAndRetryOnce(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.expireNext = 1 }) // the next tools/call 404s and drops the session
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)
	if got := len(f.byMethod("initialize")); got != 2 {
		t.Errorf("fb-025 %s: initialize calls = %d, want 2 (one re-initialize after 404)", t.Name(), got)
	}
	if got := len(f.toolCalls("vlp_eval")); got != 2 {
		t.Errorf("fb-025 %s: vlp_eval calls = %d, want 2 (one retry after 404)", t.Name(), got)
	}
}

func TestP11c_Second404GivesUp(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.reject404 = true }) // every non-initialize request 404s
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 502)
	if got := len(f.byMethod("initialize")); got != 2 {
		t.Errorf("fb-025 %s: initialize calls = %d, want exactly 2 (retry once, no more)", t.Name(), got)
	}
	if got := len(f.toolCalls("vlp_eval")); got != 2 {
		t.Errorf("fb-025 %s: vlp_eval calls = %d, want exactly 2 (retry once, no more)", t.Name(), got)
	}
	expectNoSecrets(t, "body", res.Body)
}

func TestP11d_SessionInMemoryOnly(t *testing.T) {
	f := newFakeMCP(t)
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 200)

	sid := ""
	for _, r := range f.requests() {
		if r.IssuedSession != "" {
			sid = r.IssuedSession
		}
	}
	if sid == "" {
		t.Fatalf("fb-025 %s: no MCP session was issued", t.Name())
	}
	if path, found := walkContains(t, env.Dir, sid); found {
		t.Errorf("fb-025 %s: MCP session id persisted to %s (D-8)", t.Name(), path)
	}
}

func TestP11e_401Gives502WithoutSecrets(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.token = "not-the-sentinel-token" })
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/x", sampleRPCRequest, nil)
	expectStatus(t, res, 502)
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025 %s: the fake MCP received no request", t.Name())
	}
	expectNoSecrets(t, "body", res.Body)
}
