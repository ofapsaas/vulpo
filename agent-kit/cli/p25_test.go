package main_test

// fb-020-006 spec v1.1 §2.2 / P25: `vlpmcp call` prints content[0] on stdout
// as today and every additional text item of content on stderr.

import (
	"encoding/json"
	"strings"
	"testing"
)

const p25OdooTabText = `{"odoo_tab":{"tabId":24,"origin":"https://x.example","db":"d"}}`

// p25Run runs `vlpmcp call` against a fresh fake whose tools/call returns
// defaultCallText as content[0] followed by extra text items.
func p25Run(t *testing.T, extra []string, args ...string) runResult {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callExtraTexts = extra })
	env := newEnv(t, f.URL())
	res := runVlpmcp(t, env, "", args...)
	expectExit(t, res, 0)
	return res
}

func TestP25_CallExtraContentItemsGoToStderr(t *testing.T) {
	single := p25Run(t, nil, "call", "vlp_listTabs")
	multi := p25Run(t, []string{p25OdooTabText}, "call", "vlp_listTabs")

	if multi.Stdout != single.Stdout {
		t.Errorf("fb-020-006 %s: stdout with 2 content items = %q, want exactly the 1-item stdout %q",
			t.Name(), multi.Stdout, single.Stdout)
	}
	if got := stripOneNewline(multi.Stdout); got != defaultCallText {
		t.Errorf("fb-020-006 %s: stdout = %q, want content[0].text %q", t.Name(), got, defaultCallText)
	}
	expectContains(t, "stderr (2 content items)", multi.Stderr, p25OdooTabText)
	expectNotContains(t, "stdout (2 content items)", multi.Stdout, "odoo_tab")
}

func TestP25_CallEachExtraItemOnStderr(t *testing.T) {
	second := `{"note":"second extra item"}`
	res := p25Run(t, []string{p25OdooTabText, second}, "call", "vlp_listTabs")

	if got := stripOneNewline(res.Stdout); got != defaultCallText {
		t.Errorf("fb-020-006 %s: stdout = %q, want content[0].text %q", t.Name(), got, defaultCallText)
	}
	expectContains(t, "stderr (3 content items)", res.Stderr, p25OdooTabText)
	expectContains(t, "stderr (3 content items)", res.Stderr, second)
}

func TestP25_CallSingleItemStderrUnchanged(t *testing.T) {
	res := p25Run(t, nil, "call", "vlp_listTabs")
	if strings.TrimSpace(res.Stderr) != "" {
		t.Errorf("fb-020-006 %s: stderr with 1 content item = %q, want empty as before", t.Name(), res.Stderr)
	}
}

func TestP25_RawOutputUnchanged(t *testing.T) {
	single := p25Run(t, nil, "call", "--raw", "vlp_listTabs")
	multi := p25Run(t, []string{p25OdooTabText}, "call", "--raw", "vlp_listTabs")

	if multi.Stderr != single.Stderr {
		t.Errorf("fb-020-006 %s: --raw stderr with 2 items = %q, want same as 1 item %q", t.Name(), multi.Stderr, single.Stderr)
	}
	var resp struct {
		JSONRPC string `json:"jsonrpc"`
		Result  struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(multi.Stdout), &resp); err != nil {
		t.Fatalf("fb-020-006 %s: --raw stdout is not a JSON-RPC response: %v\nstdout: %q", t.Name(), err, multi.Stdout)
	}
	c := resp.Result.Content
	if resp.JSONRPC != "2.0" || len(c) != 2 || c[0].Text != defaultCallText || c[1].Text != p25OdooTabText {
		t.Errorf("fb-020-006 %s: --raw stdout = %q, want the full envelope with both content items", t.Name(), multi.Stdout)
	}
}
