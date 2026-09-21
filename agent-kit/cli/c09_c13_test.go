package main_test

// fb-021-mvp §3 C9 (ping), C10 (doctor), C11 (log), C12 (mcp-stdio), C13 (version).

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// C9. vlpmcp ping
// ---------------------------------------------------------------------------

func TestC9_PingPrintsOK(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "ping")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != "ok" {
		t.Errorf("fb-021 %s: stdout = %q, want %q", t.Name(), got, "ok")
	}
	reqs := f.requests()
	firstInit, lastPing := -1, -1
	for i, r := range reqs {
		if r.Method == "initialize" && firstInit < 0 {
			firstInit = i
		}
		if r.Method == "ping" && r.Status == 200 {
			lastPing = i
		}
	}
	if firstInit < 0 || lastPing < 0 || firstInit > lastPing {
		t.Errorf("fb-021 %s: want initialize followed by ping, got %v", t.Name(), methodsOf(reqs))
	}
}

// ---------------------------------------------------------------------------
// C10. vlpmcp doctor
// ---------------------------------------------------------------------------

func TestC10_DoctorAllOKExit0(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "doctor")
	expectExit(t, res, 0)
	expectLine(t, "stdout", res.Stdout, "server: ok")
	expectLine(t, "stdout", res.Stdout, "token: ok")
	expectLine(t, "stdout", res.Stdout, "extension: connected")
	if call := lastWithMethod(f.requests(), "tools/call"); call == nil || call.ToolName != "vlp_listTabs" {
		t.Errorf("fb-021 %s: doctor must decide the extension state by calling vlp_listTabs (%v)", t.Name(), methodsOf(f.requests()))
	}
}

func TestC10_DoctorExtensionNotConnectedExit9(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.callResult = func(string, json.RawMessage) (string, *rpcError) {
			return "", &rpcError{Code: -32000, Message: noExtensionMsg}
		}
	})
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "doctor")
	expectExit(t, res, 9)
	expectLine(t, "stdout", res.Stdout, "server: ok")
	expectLine(t, "stdout", res.Stdout, "token: ok")
	expectLine(t, "stdout", res.Stdout, "extension: not connected")
}

func TestC10_DoctorInvalidTokenExit7(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.token = "fbtok-some-other-tenant" })
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "doctor")
	expectExit(t, res, 7)
	expectLine(t, "stdout", res.Stdout, "server: ok")
	expectLine(t, "stdout", res.Stdout, "token: invalid")
}

func TestC10_DoctorServerUnreachableExit8(t *testing.T) {
	env := newEnv(t, unreachableURL(t))

	res := runVlpmcp(t, env, "", "doctor")
	expectExit(t, res, 8)
	expectLine(t, "stdout", res.Stdout, "server: unreachable")
}

func TestC10_DoctorTokenMissingExit3(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())
	env.Vars["VLP_TOKEN_FILE"] = filepath.Join(env.Dir, "absent", "token")

	res := runVlpmcp(t, env, "", "doctor")
	expectExit(t, res, 3)
	expectLine(t, "stdout", res.Stdout, "token: missing")
}

// ---------------------------------------------------------------------------
// C11. JSONL log
// ---------------------------------------------------------------------------

func TestC11_LogLinesOnlyAllowedFields(t *testing.T) {
	const argValue = "ARGVALUE-c11-q9w8"
	const resultValue = "RESULTVALUE-c11-z7x6"
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.callResult = func(string, json.RawMessage) (string, *rpcError) {
			return `{"secret":"` + resultValue + `"}`, nil
		}
	})
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_getFrame", `{"tabId":7,"note":"`+argValue+`"}`)
	expectExit(t, res, 0)

	logText := readFileOrEmpty(env.LogFile)
	lines := nonEmptyLines(logText)
	if len(lines) == 0 {
		t.Fatalf("fb-021 %s: VLP_LOG has no JSONL line after a call", t.Name())
	}
	allowed := map[string]bool{"ts": true, "method": true, "tool": true, "ms": true, "exit": true}
	sawCall := false
	for i, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Errorf("fb-021 %s: log line %d is not a JSON object: %v (%q)", t.Name(), i, err, line)
			continue
		}
		for key := range entry {
			if !allowed[key] {
				t.Errorf("fb-021 %s: log line %d has field %q; only ts, method, tool, ms, exit are allowed", t.Name(), i, key)
			}
		}
		for _, key := range []string{"ts", "method", "ms", "exit"} {
			if _, ok := entry[key]; !ok {
				t.Errorf("fb-021 %s: log line %d lacks field %q (%q)", t.Name(), i, key, line)
			}
		}
		if entry["method"] == "tools/call" && entry["tool"] == "vlp_getFrame" {
			sawCall = true
		}
	}
	if !sawCall {
		t.Errorf("fb-021 %s: no log line with method tools/call and tool vlp_getFrame\nlog: %q", t.Name(), logText)
	}
	for _, secret := range []string{argValue, resultValue} {
		if strings.Contains(logText, secret) {
			t.Errorf("fb-021 %s: the log contains %q (arguments or results must not be logged)", t.Name(), secret)
		}
	}

	expectExit(t, runVlpmcp(t, env, "", "ping"), 0)
	if after := len(nonEmptyLines(readFileOrEmpty(env.LogFile))); after <= len(lines) {
		t.Errorf("fb-021 %s: log went from %d to %d lines after another request; want lines appended", t.Name(), len(lines), after)
	}
}

// ---------------------------------------------------------------------------
// C12. vlpmcp mcp-stdio
// ---------------------------------------------------------------------------

const stdioInitializeLine = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fb021-contract","version":"0"}}}` + "\n"

const stdioHandshake = stdioInitializeLine +
	`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
	`{"jsonrpc":"2.0","id":"c12-list","method":"tools/list"}` + "\n"

type stdioMessage struct {
	ID     any             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// parseStdioOutput requires every stdout line to be a JSON object (logs go to
// stderr only) and returns them in order.
func parseStdioOutput(t *testing.T, stdout string) []stdioMessage {
	t.Helper()
	var out []stdioMessage
	for i, line := range nonEmptyLines(stdout) {
		var msg stdioMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			t.Errorf("fb-021 %s: stdout line %d is not a JSON-RPC message: %v (%q)", t.Name(), i, err, line)
			continue
		}
		out = append(out, msg)
	}
	return out
}

func findByID(msgs []stdioMessage, id any) *stdioMessage {
	for i := range msgs {
		switch msgs[i].ID.(type) {
		case float64, string: // JSON-RPC ids; other decoded types may be uncomparable
			if msgs[i].ID == id {
				return &msgs[i]
			}
		}
	}
	return nil
}

func toolNames(t *testing.T, result json.RawMessage) []string {
	t.Helper()
	var r struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		t.Errorf("fb-021 %s: tools/list result is not {tools:[...]}: %v (%q)", t.Name(), err, string(result))
		return nil
	}
	var names []string
	for _, tool := range r.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestC12_StdioHandshake(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.serverName = "vulpo-fake-c12" })
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, stdioHandshake, "mcp-stdio")
	expectExit(t, res, 0)
	if n := len(nonEmptyLines(res.Stdout)); n != 2 {
		t.Errorf("fb-021 %s: got %d stdout lines, want 2 (initialize, tools/list; the notification yields none)\nstdout: %q", t.Name(), n, res.Stdout)
	}
	msgs := parseStdioOutput(t, res.Stdout)

	initResp := findByID(msgs, float64(1))
	if initResp == nil {
		t.Fatalf("fb-021 %s: no response with id 1 (initialize)\nstdout: %q", t.Name(), res.Stdout)
	}
	var initResult struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(initResp.Result, &initResult); err != nil || initResult.ServerInfo.Name != "vulpo-fake-c12" {
		t.Errorf("fb-021 %s: initialize result = %q, want the server's initialize result (serverInfo.name vulpo-fake-c12)", t.Name(), string(initResp.Result))
	}

	list := findByID(msgs, "c12-list")
	if list == nil {
		t.Fatalf("fb-021 %s: no response with id \"c12-list\" (tools/list)\nstdout: %q", t.Name(), res.Stdout)
	}
	if names := toolNames(t, list.Result); strings.Join(names, ",") != "vlp_listTabs,vlp_getFrame" {
		t.Errorf("fb-021 %s: tools/list names = %v, want [vlp_listTabs vlp_getFrame]", t.Name(), names)
	}

	expectAllRequestsCarryToken(t, f.requests())
}

func TestC12_StdioSessionRetryOn404(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.expireNext = 1
		f.expireMethod = "tools/list"
	})
	env := newEnv(t, f.URL())

	stdin := stdioInitializeLine + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n"
	res := runVlpmcp(t, env, stdin, "mcp-stdio")
	expectExit(t, res, 0)

	list := findByID(parseStdioOutput(t, res.Stdout), float64(2))
	if list == nil {
		t.Fatalf("fb-021 %s: no response with id 2 after a session 404\nstdout: %q", t.Name(), res.Stdout)
	}
	if names := toolNames(t, list.Result); len(names) != 2 {
		t.Errorf("fb-021 %s: tools/list after re-initialize returned %v, want 2 tools", t.Name(), names)
	}
	reqs := f.requests()
	if n := countStatus(reqs, 404); n != 1 {
		t.Errorf("fb-021 %s: %d responses were 404, want 1 (%v)", t.Name(), n, methodsOf(reqs))
	}
	expectAllRequestsCarryToken(t, reqs)
}

func TestC12_StdioEOFExit0(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "mcp-stdio")
	expectExit(t, res, 0)
	if lines := nonEmptyLines(res.Stdout); len(lines) != 0 {
		t.Errorf("fb-021 %s: stdout on immediate EOF = %q, want nothing", t.Name(), res.Stdout)
	}
}

// ---------------------------------------------------------------------------
// C13. vlpmcp version
// ---------------------------------------------------------------------------

func TestC13_VersionDefaultDev(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "version")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != "dev" {
		t.Errorf("fb-021 %s: stdout = %q, want %q", t.Name(), got, "dev")
	}
}

func TestC13_VersionInjectedWithLdflags(t *testing.T) {
	requireBinary(t)
	const injected = "0.0.0-fb021-contract"
	bin := filepath.Join(t.TempDir(), "vlpmcp-versioned")
	if err := goBuild(bin, "-ldflags", "-X main.version="+injected); err != nil {
		t.Fatalf("fb-021 %s: go build -ldflags '-X main.version=%s': %v", t.Name(), injected, err)
	}
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runBinary(t, bin, env, "", "version")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != injected {
		t.Errorf("fb-021 %s: stdout = %q, want the injected version %q", t.Name(), got, injected)
	}
}
