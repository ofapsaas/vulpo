package main_test

// fb-021-mvp §3 C1 (token), C2 (URL), C3 (session), C4 (headers and response).

import (
	"mime"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// C1. Token
// ---------------------------------------------------------------------------

func TestC1_TokenFileMissingExit3(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	missing := filepath.Join(env.Dir, "absent", "token")
	env.Vars["VLP_TOKEN_FILE"] = missing

	for _, args := range [][]string{{"ping"}, {"call", "vlp_listTabs"}} {
		res := runVlpmcp(t, env, "", args...)
		expectExit(t, res, 3)
		expectContains(t, "stderr", res.Stderr, "token file not found: "+missing)
	}
}

func TestC1_TokenFileDefaultPath(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	delete(env.Vars, "VLP_TOKEN_FILE")

	res := runVlpmcp(t, env, "", "ping")
	expectExit(t, res, 3)
	expectContains(t, "stderr", res.Stderr, "token file not found: ")
	expectContains(t, "stderr", res.Stderr, filepath.Join(".config", "vulpo", "token"))

	writeFileMode(t, filepath.Join(env.Home, ".config", "vulpo", "token"), sentinelToken+"\n", 0o600)
	f.resetRequests()
	res = runVlpmcp(t, env, "", "ping")
	expectExit(t, res, 0)
	expectAllRequestsCarryToken(t, f.requests())
}

func TestC1_TokenFileLooseModeExit3(t *testing.T) {
	for _, mode := range []os.FileMode{0o644, 0o640, 0o604, 0o660} {
		t.Run(mode.String(), func(t *testing.T) {
			f := newFakeMCP(t)
			env := newEnv(t, f.URL())
			writeFileMode(t, env.TokenFile, sentinelToken+"\n", mode)

			res := runVlpmcp(t, env, "", "ping")
			expectExit(t, res, 3)
			expectContains(t, "stderr", res.Stderr, "token file must be mode 0600: "+env.TokenFile)
		})
	}
}

func TestC1_TokenTrimmedFromFile(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	writeFileMode(t, env.TokenFile, "\t  "+sentinelToken+"  \n\n", 0o600)

	res := runVlpmcp(t, env, "", "ping")
	expectExit(t, res, 0)
	expectAllRequestsCarryToken(t, f.requests())
}

func TestC1_NoFlagOrArgumentAcceptsToken(t *testing.T) {
	const argvToken = "fbtok-FROM-ARGV-c1-0001"
	f := newFakeMCP(t)
	// The fake only accepts the argv token; the token file holds sentinelToken.
	f.set(func(f *fakeMCP) { f.token = argvToken })
	env := newEnv(t, f.URL())

	cases := [][]string{
		{"ping", "--token", argvToken},
		{"--token", argvToken, "ping"},
		{"ping", "--token=" + argvToken},
		{"tools", "--token", argvToken},
		{"call", "--token", argvToken, "vlp_listTabs"},
		{"call", "vlp_listTabs", "{}", argvToken},
	}
	for _, args := range cases {
		res := runVlpmcp(t, env, "", args...)
		if res.Exit == 0 {
			t.Errorf("fb-021 %s: vlpmcp %q exited 0: a token passed through argv was accepted", t.Name(), args)
		}
	}
	for i, r := range f.requests() {
		if r.Token == argvToken {
			t.Errorf("fb-021 %s: request %d (%s) carried the argv token in x-vlp-token", t.Name(), i, r.Method)
		}
	}
}

// ---------------------------------------------------------------------------
// C2. URL
// ---------------------------------------------------------------------------

// The default http://127.0.0.1:8765/mcp is deliberately not exercised: the
// real Vulpo server listens there on this host (see ambiguity list).
func TestC2_URLFromEnv(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.srv.URL+"/c2/custom-mcp")

	res := runVlpmcp(t, env, "", "ping")
	expectExit(t, res, 0)
	reqs := f.requests()
	if len(reqs) == 0 {
		t.Fatalf("fb-021 %s: the server at VLP_URL received no request", t.Name())
	}
	for i, r := range reqs {
		if r.Path != "/c2/custom-mcp" {
			t.Errorf("fb-021 %s: request %d went to path %q, want /c2/custom-mcp", t.Name(), i, r.Path)
		}
	}
}

// ---------------------------------------------------------------------------
// C3. Session
// ---------------------------------------------------------------------------

func TestC3_SessionPersistedMode0600(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 0)
	reqs := f.requests()
	if len(reqs) < 2 || reqs[0].Method != "initialize" {
		t.Fatalf("fb-021 %s: without a stored session want initialize first, got %v", t.Name(), methodsOf(reqs))
	}
	issued := reqs[0].IssuedSession
	call := lastWithMethod(reqs, "tools/call")
	if call == nil {
		t.Fatalf("fb-021 %s: no tools/call after initialize, got %v", t.Name(), methodsOf(reqs))
	}
	if call.SessionID != issued {
		t.Errorf("fb-021 %s: tools/call Mcp-Session-Id = %q, want the issued %q", t.Name(), call.SessionID, issued)
	}
	expectSessionFile(t, env.SessionFile, issued)
}

func TestC3_SessionDefaultPathCreatesDir(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	delete(env.Vars, "VLP_SESSION_FILE")

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 0)
	issued := ""
	if initReq := lastWithMethod(f.requests(), "initialize"); initReq != nil {
		issued = initReq.IssuedSession
	}
	expectSessionFile(t, filepath.Join(env.Home, ".cache", "vulpo", "session"), issued)
}

func TestC3_SessionReusedAcrossCalls(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 0)
	expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 0)

	reqs := f.requests()
	if n := countMethod(reqs, "initialize"); n != 1 {
		t.Errorf("fb-021 %s: initialize sent %d times for 2 calls, want 1 (%v)", t.Name(), n, methodsOf(reqs))
	}
	var sessions []string
	for _, r := range reqs {
		if r.Method == "tools/call" {
			sessions = append(sessions, r.SessionID)
		}
	}
	if len(sessions) != 2 || sessions[0] == "" || sessions[0] != sessions[1] {
		t.Errorf("fb-021 %s: tools/call sessions = %q, want two equal non-empty ids", t.Name(), sessions)
	}
}

func TestC3_Reinitialize404Once(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 0)

	f.expireAllSessions() // server restart: the stored session is now unknown
	f.resetRequests()

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != defaultCallText {
		t.Errorf("fb-021 %s: stdout after retry = %q, want %q", t.Name(), got, defaultCallText)
	}
	reqs := f.requests()
	if n := countStatus(reqs, 404); n != 1 {
		t.Errorf("fb-021 %s: %d responses were 404, want 1 (%v)", t.Name(), n, methodsOf(reqs))
	}
	if n := countMethod(reqs, "initialize"); n != 1 {
		t.Errorf("fb-021 %s: initialize sent %d times after a 404, want 1 (%v)", t.Name(), n, methodsOf(reqs))
	}
	if n := countMethod(reqs, "tools/call"); n != 2 {
		t.Errorf("fb-021 %s: tools/call sent %d times, want 2 (original + one retry) (%v)", t.Name(), n, methodsOf(reqs))
	}
	if last := lastWithMethod(reqs, "tools/call"); last != nil && last.Status != 200 {
		t.Errorf("fb-021 %s: retried tools/call got HTTP %d, want 200", t.Name(), last.Status)
	}
	issued := ""
	if initReq := lastWithMethod(reqs, "initialize"); initReq != nil {
		issued = initReq.IssuedSession
	}
	expectSessionFile(t, env.SessionFile, issued)
}

func TestC3_Second404Exit4(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 0)

	f.set(func(f *fakeMCP) { f.reject404 = true })
	f.resetRequests()

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 4)
	reqs := f.requests()
	if n := countMethod(reqs, "initialize"); n != 1 {
		t.Errorf("fb-021 %s: initialize sent %d times, want exactly 1 (%v)", t.Name(), n, methodsOf(reqs))
	}
	if n := countMethod(reqs, "tools/call"); n != 2 {
		t.Errorf("fb-021 %s: tools/call sent %d times, want 2 (one retry only) (%v)", t.Name(), n, methodsOf(reqs))
	}
}

// ---------------------------------------------------------------------------
// C4. Headers and response
// ---------------------------------------------------------------------------

func TestC4_HeadersOnEveryPOST(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	for _, args := range [][]string{
		{"ping"},
		{"tools"},
		{"call", "vlp_getFrame", `{"tabId":1}`},
	} {
		expectExit(t, runVlpmcp(t, env, "", args...), 0)
	}

	reqs := f.requests()
	if len(reqs) == 0 {
		t.Fatalf("fb-021 %s: the fake server received no request", t.Name())
	}
	for i, r := range reqs {
		if r.HTTPMethod != "POST" {
			t.Errorf("fb-021 %s: request %d used HTTP %s, want POST", t.Name(), i, r.HTTPMethod)
		}
		if r.Token != sentinelToken {
			t.Errorf("fb-021 %s: request %d (%s) x-vlp-token is not the trimmed token file content", t.Name(), i, r.Method)
		}
		if mt, _, err := mime.ParseMediaType(r.ContentType); err != nil || mt != "application/json" {
			t.Errorf("fb-021 %s: request %d (%s) Content-Type = %q, want application/json", t.Name(), i, r.Method, r.ContentType)
		}
		if !strings.Contains(r.Accept, "application/json") || !strings.Contains(r.Accept, "text/event-stream") {
			t.Errorf("fb-021 %s: request %d (%s) Accept = %q, want application/json, text/event-stream", t.Name(), i, r.Method, r.Accept)
		}
	}
}

func TestC4_SSEResponseParsed(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.sse = true })
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != defaultCallText {
		t.Errorf("fb-021 %s: stdout from an SSE response = %q, want %q", t.Name(), got, defaultCallText)
	}
}

// ---------------------------------------------------------------------------
// Helpers shared by the C1–C4 tests
// ---------------------------------------------------------------------------

func expectAllRequestsCarryToken(t *testing.T, reqs []recorded) {
	t.Helper()
	if len(reqs) == 0 {
		t.Fatalf("fb-021 %s: the fake server received no request", t.Name())
	}
	for i, r := range reqs {
		if r.Token != sentinelToken {
			t.Errorf("fb-021 %s: request %d (%s) did not carry the trimmed token from the file", t.Name(), i, r.Method)
		}
	}
}

func expectSessionFile(t *testing.T, path, sessionID string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Errorf("fb-021 %s: session file: %v", t.Name(), err)
		return
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("fb-021 %s: session file %s mode = %#o, want 0600", t.Name(), path, uint32(perm))
	}
	if sessionID != "" {
		expectContains(t, "session file", readFileOrEmpty(path), sessionID)
	}
}

func lastWithMethod(reqs []recorded, method string) *recorded {
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Method == method {
			return &reqs[i]
		}
	}
	return nil
}
