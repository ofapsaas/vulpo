package main_test

// fb-021-mvp §3 C5 (vlpmcp tools) and C6 (vlpmcp call).

import (
	"encoding/json"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// C5. vlpmcp tools
// ---------------------------------------------------------------------------

func TestC5_ToolsOneLinePerTool(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "tools")
	expectExit(t, res, 0)

	// First sentence of each fixture description (see ambiguity A2 on the period).
	want := map[string]string{
		"vlp_listTabs": "List the open browser tabs",
		"vlp_getFrame": "Read the frame map of a tab",
	}
	lines := nonEmptyLines(res.Stdout)
	if len(lines) != len(want) {
		t.Fatalf("fb-021 %s: got %d lines, want one per tool (%d)\nstdout: %q", t.Name(), len(lines), len(want), res.Stdout)
	}
	seen := map[string]bool{}
	for _, line := range lines {
		fields := strings.Split(line, "\t")
		if len(fields) != 2 {
			t.Errorf("fb-021 %s: line %q is not name<TAB>sentence", t.Name(), line)
			continue
		}
		sentence, ok := want[fields[0]]
		if !ok {
			t.Errorf("fb-021 %s: unexpected tool name %q", t.Name(), fields[0])
			continue
		}
		seen[fields[0]] = true
		if got := strings.TrimSpace(fields[1]); got != sentence && got != sentence+"." {
			t.Errorf("fb-021 %s: %s description = %q, want its first sentence %q", t.Name(), fields[0], got, sentence+".")
		}
	}
	if len(seen) != len(want) {
		t.Errorf("fb-021 %s: tools listed = %v, want %v", t.Name(), seen, want)
	}
}

func TestC5_ToolsJSONRawArray(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "tools", "--json")
	expectExit(t, res, 0)
	expectJSONEqual(t, "stdout of tools --json", []byte(res.Stdout), defaultTools())
}

func TestC5_ToolsSchema(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "tools", "--schema", "vlp_getFrame")
	expectExit(t, res, 0)
	expectJSONEqual(t, "stdout of tools --schema", []byte(res.Stdout), defaultTools()[1]["inputSchema"])
}

func TestC5_ToolsSchemaUnknownExit2(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "tools", "--schema", "vlp_doesNotExist")
	expectExit(t, res, 2)
}

// ---------------------------------------------------------------------------
// C6. vlpmcp call <tool> [json]
// ---------------------------------------------------------------------------

func TestC6_CallPrintsTextVerbatim(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 0)
	if got := stripOneNewline(res.Stdout); got != defaultCallText {
		t.Errorf("fb-021 %s: stdout = %q, want result.content[0].text as-is %q", t.Name(), got, defaultCallText)
	}
	call := lastWithMethod(f.requests(), "tools/call")
	if call == nil {
		t.Fatalf("fb-021 %s: no tools/call reached the server", t.Name())
	}
	if call.ToolName != "vlp_listTabs" {
		t.Errorf("fb-021 %s: tools/call name = %q, want vlp_listTabs", t.Name(), call.ToolName)
	}
	expectJSONEqual(t, "tools/call arguments (default {})", call.Arguments, map[string]any{})
}

func TestC6_CallArgsPositional(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_getFrame", `{"tabId":7,"filter":"x"}`)
	expectExit(t, res, 0)
	call := lastWithMethod(f.requests(), "tools/call")
	if call == nil {
		t.Fatalf("fb-021 %s: no tools/call reached the server", t.Name())
	}
	expectJSONEqual(t, "tools/call arguments", call.Arguments, map[string]any{"tabId": 7, "filter": "x"})
}

func TestC6_CallArgsFromStdin(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, `{"tabId":9,"filter":"from-stdin"}`+"\n", "call", "vlp_getFrame", "-")
	expectExit(t, res, 0)
	call := lastWithMethod(f.requests(), "tools/call")
	if call == nil {
		t.Fatalf("fb-021 %s: no tools/call reached the server", t.Name())
	}
	expectJSONEqual(t, "tools/call arguments", call.Arguments, map[string]any{"tabId": 9, "filter": "from-stdin"})
}

func TestC6_JSONRPCErrorExit5(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.callResult = func(string, json.RawMessage) (string, *rpcError) {
			return "", &rpcError{Code: -32000, Message: noExtensionMsg}
		}
	})
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 5)
	expectContains(t, "stderr", res.Stderr, "error -32000: "+noExtensionMsg)
}

func TestC6_RawPrintsFullJSONRPCResponse(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "call", "--raw", "vlp_listTabs")
	expectExit(t, res, 0)
	var resp struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(res.Stdout), &resp); err != nil {
		t.Fatalf("fb-021 %s: --raw stdout is not a JSON-RPC response: %v\nstdout: %q", t.Name(), err, res.Stdout)
	}
	if resp.JSONRPC != "2.0" || len(resp.ID) == 0 {
		t.Errorf("fb-021 %s: --raw response lacks jsonrpc/id: %q", t.Name(), res.Stdout)
	}
	if len(resp.Result.Content) != 1 || resp.Result.Content[0].Type != "text" || resp.Result.Content[0].Text != defaultCallText {
		t.Errorf("fb-021 %s: --raw result.content = %+v, want the full envelope with text %q", t.Name(), resp.Result.Content, defaultCallText)
	}
}
