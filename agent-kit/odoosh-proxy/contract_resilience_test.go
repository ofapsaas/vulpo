// fb-025-002-proxy-resiliencia — RED helpers (spec §3.4/§3.5.1, AUDIT §4.2).
//
// Black-box, package main_test: everything here observes only the HTTP surface
// of the proxy and the wire recorded by the extended fake. No symbol of the
// implementation's package main is referenced (anti-AP-14, C-3).
package main_test

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// §3.5.1 normative classification literals (prefixes the proxy must antepone;
// the raw tool message is always preserved as a substring — C-7/C-10).
// ---------------------------------------------------------------------------

const (
	litRecoveryFailed = "recovery failed:"
	litPlanMode       = "plan mode:"
	litRateLimit      = "rate limit:"
	litCodeTooLarge   = "code too large:"
	litHubIdleTimeout = "hub idle timeout:"
	litSuperseded     = "superseded [terminal]:"
	litDisconnected   = "extension disconnected [transient]:"
	litNoTab          = "no tab:"
	litToolError      = "tool error:"
	litEvalTimeout    = "eval timeout"
	litTransportCap   = "transport response too large"
)

// Raw hub/extension messages used to drive the closed classification table
// (spec §3.5/§3.5.1). Each contains the marker the table keys on.
const (
	rawCandidate    = "An unexpected error occurred"
	rawHostPerm     = "Missing host permission for the tab"
	rawPlanMode     = `Tool "eval" blocked in Plan mode (read-only profile)`
	rawRateLimit    = "Rate limit exceeded"
	rawCodeTooLarge = "Code too large"
	rawHubTimeout   = "command_timeout: no activity for 45s"
	rawSuperseded   = "connection superseded by a newer client"
	rawDisconnected = "extension disconnected"
	rawUnknown      = "something the closed table never pinned"
)

// ---------------------------------------------------------------------------
// Recovery environment + wire counters
// ---------------------------------------------------------------------------

// recoveryEnv builds a hermetic env pointing at f, with the explicit tab 22
// (isolating P1..P6/P9..P12 from vlp_listTabs discovery, like 001 newEnv) and
// short recovery timings so the RED runs fast. extra overrides/adds vars.
func recoveryEnv(t *testing.T, f *fakeMCP, extra map[string]string) *testEnv {
	t.Helper()
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22"
	env.Vars["VLP_RECOVER_READY_POLL_MS"] = "20"
	env.Vars["VLP_RECOVER_READY_DEADLINE_MS"] = "1500"
	env.Vars["VLP_RESOLVE_BACKOFF_MS"] = "20"
	for k, v := range extra {
		env.Vars[k] = v
	}
	return env
}

// requireFakeReached is the positive guard (C-5): the proxy must actually hit
// the transport before a test asserts on its behaviour.
func requireFakeReached(t *testing.T, f *fakeMCP) {
	t.Helper()
	if len(f.requests()) == 0 {
		t.Fatalf("fb-025-002 %s: the fake MCP received no request; the proxy never reached the transport", t.Name())
	}
}

// evalCodes returns the eval `code`s in arrival order (probe vs page).
func evalCodes(f *fakeMCP) []string {
	var out []string
	for _, r := range f.toolCalls("vlp_eval") {
		out = append(out, strings.TrimSpace(argCode(r.Arguments)))
	}
	return out
}

func countEvalCode(f *fakeMCP, code string) int {
	n := 0
	for _, c := range evalCodes(f) {
		if c == code {
			n++
		}
	}
	return n
}

// probeCount counts readyState probes; pageEvalCount counts page evals.
func probeCount(f *fakeMCP) int    { return countEvalCode(f, readyStateProbe) }
func pageEvalCount(f *fakeMCP) int { return len(evalCodes(f)) - probeCount(f) }

func navigateCount(f *fakeMCP) int { return len(f.toolCalls("vlp_navigate")) }
func activateCount(f *fakeMCP) int { return len(f.toolCalls("vlp_activateTab")) }
func listTabsCount(f *fakeMCP) int { return len(f.toolCalls("vlp_listTabs")) }

// evalOrder returns the eval kinds in arrival order ("probe"/"page") so a test
// can assert the readyState probe precedes the recovery retry (P3, §3.4 #4).
func evalOrder(f *fakeMCP) []string {
	var out []string
	for _, r := range f.toolCalls("vlp_eval") {
		if isReadyStateProbe(argCode(r.Arguments)) {
			out = append(out, "probe")
		} else {
			out = append(out, "page")
		}
	}
	return out
}

// lastProbeBeforeLastPage asserts the last readyState probe happened before the
// last page eval (the proxy must not re-emit the original eval before it saw a
// probe).
func lastProbeBeforeLastPage(t *testing.T, f *fakeMCP) {
	t.Helper()
	order := evalOrder(f)
	lastProbe, lastPage := -1, -1
	for i, k := range order {
		switch k {
		case "probe":
			lastProbe = i
		case "page":
			lastPage = i
		}
	}
	if lastProbe < 0 {
		t.Errorf("fb-025-002 %s: no readyState probe reached the fake (order %v)", t.Name(), order)
		return
	}
	if lastPage < 0 || lastProbe > lastPage {
		t.Errorf("fb-025-002 %s: recovery retry did not follow the readyState probe (order %v)", t.Name(), order)
	}
}
