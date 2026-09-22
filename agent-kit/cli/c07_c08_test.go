package main_test

// fb-021-mvp §3 C7 (exit codes) and C8 (the token is never emitted).

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// C7. Exit codes
// ---------------------------------------------------------------------------

func TestC7_UsageExit2(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	for _, args := range [][]string{{"no-such-subcommand"}, {"call"}} {
		expectExit(t, runVlpmcp(t, env, "", args...), 2)
	}
}

func TestC7_InvalidTokenExit7(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.token = "fbtok-some-other-tenant" })
	env := newEnv(t, f.URL())

	for _, args := range [][]string{{"ping"}, {"tools"}, {"call", "vlp_listTabs"}} {
		res := runVlpmcp(t, env, "", args...)
		expectExit(t, res, 7)
		expectContains(t, "stderr", res.Stderr, "invalid token (401)")
	}
}

func TestC7_HTTPStatusExit4(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusNotAcceptable, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) { f.callStatus = status })
			env := newEnv(t, f.URL())

			expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 4)
		})
	}
}

func TestC7_UnreachableExit8(t *testing.T) {
	env := newEnv(t, unreachableURL(t))

	for _, args := range [][]string{{"ping"}, {"call", "vlp_listTabs"}} {
		expectExit(t, runVlpmcp(t, env, "", args...), 8)
	}
}

func TestC7_TimeoutExit8(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 10 * time.Second })
	env := newEnv(t, f.URL())
	env.Vars["VLP_TIMEOUT"] = "1"

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 8)
	if res.Elapsed >= 8*time.Second {
		t.Errorf("fb-021 %s: vlpmcp took %v with VLP_TIMEOUT=1 against a 10s handler", t.Name(), res.Elapsed)
	}
}

// ---------------------------------------------------------------------------
// C8. The token never appears in stdout, stderr or the log
// ---------------------------------------------------------------------------

func TestC8_TokenNeverEmitted(t *testing.T) {
	otherTenant := func(t *testing.T, f *fakeMCP, env *testEnv) {
		f.set(func(f *fakeMCP) { f.token = "fbtok-some-other-tenant" })
	}
	rpcFailure := func(t *testing.T, f *fakeMCP, env *testEnv) {
		f.set(func(f *fakeMCP) {
			f.callResult = func(string, json.RawMessage) (string, *rpcError) {
				return "", &rpcError{Code: -32000, Message: noExtensionMsg}
			}
		})
	}

	scenarios := []struct {
		name  string
		setup func(t *testing.T, f *fakeMCP, env *testEnv)
		stdin string
		args  []string
	}{
		{name: "call ok", args: []string{"call", "vlp_listTabs"}},
		{name: "call raw", args: []string{"call", "--raw", "vlp_listTabs"}},
		{name: "tools json", args: []string{"tools", "--json"}},
		{name: "ping", args: []string{"ping"}},
		{name: "doctor ok", args: []string{"doctor"}},
		{name: "invalid token call", setup: otherTenant, args: []string{"call", "vlp_listTabs"}},
		{name: "invalid token raw", setup: otherTenant, args: []string{"call", "--raw", "vlp_listTabs"}},
		{name: "invalid token doctor", setup: otherTenant, args: []string{"doctor"}},
		{name: "jsonrpc error", setup: rpcFailure, args: []string{"call", "vlp_listTabs"}},
		{name: "jsonrpc error raw", setup: rpcFailure, args: []string{"call", "--raw", "vlp_listTabs"}},
		{name: "doctor not connected", setup: rpcFailure, args: []string{"doctor"}},
		{
			name:  "http 500",
			setup: func(t *testing.T, f *fakeMCP, env *testEnv) { f.set(func(f *fakeMCP) { f.callStatus = 500 }) },
			args:  []string{"call", "vlp_listTabs"},
		},
		{
			name: "second 404",
			setup: func(t *testing.T, f *fakeMCP, env *testEnv) {
				runVlpmcp(t, env, "", "call", "vlp_listTabs")
				f.set(func(f *fakeMCP) { f.reject404 = true })
			},
			args: []string{"call", "vlp_listTabs"},
		},
		{
			name:  "unreachable",
			setup: func(t *testing.T, f *fakeMCP, env *testEnv) { env.Vars["VLP_URL"] = unreachableURL(t) },
			args:  []string{"call", "vlp_listTabs"},
		},
		{
			name: "timeout",
			setup: func(t *testing.T, f *fakeMCP, env *testEnv) {
				f.set(func(f *fakeMCP) { f.callDelay = 10 * time.Second })
				env.Vars["VLP_TIMEOUT"] = "1"
			},
			args: []string{"call", "vlp_listTabs"},
		},
		{
			name: "token file mode 0644",
			setup: func(t *testing.T, f *fakeMCP, env *testEnv) {
				writeFileMode(t, env.TokenFile, sentinelToken+"\n", 0o644)
			},
			args: []string{"call", "vlp_listTabs"},
		},
		{name: "usage error", args: []string{"call"}},
		{name: "mcp-stdio", stdin: stdioHandshake, args: []string{"mcp-stdio"}},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			f := newFakeMCP(t)
			env := newEnv(t, f.URL())
			if sc.setup != nil {
				sc.setup(t, f, env)
			}
			res := runVlpmcp(t, env, sc.stdin, sc.args...)
			outputs := []struct{ label, text string }{
				{"stdout", res.Stdout},
				{"stderr", res.Stderr},
				{"VLP_LOG", readFileOrEmpty(env.LogFile)},
			}
			for _, out := range outputs {
				// The output itself is not printed, so the test log never carries the token either.
				if strings.Contains(out.text, sentinelToken) {
					t.Errorf("fb-021 %s: the token value appears in %s of vlpmcp %q (exit %d)", t.Name(), out.label, sc.args, res.Exit)
				}
			}
		})
	}
}
