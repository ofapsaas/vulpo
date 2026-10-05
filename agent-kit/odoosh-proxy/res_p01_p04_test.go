// fb-025-002 spec §3.3 P1–P4 (RED). Prefix TestR to avoid colliding with the
// 001 suite's TestP… names (AUDIT §2.3, C-9).
package main_test

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// P1. Discarded tab recovered without focus (RED)
// ---------------------------------------------------------------------------

func TestR1a_DiscardedRecoveredNoFocus(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = true
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 200)
	if string(res.Body) != sampleRPCResponse {
		t.Errorf("fb-025-002 %s: body = %q, want the recovered page %q", t.Name(), res.Body, sampleRPCResponse)
	}

	// Guard: the primary recovery is vlp_navigate to the resolved URL.
	navs := f.toolCalls("vlp_navigate")
	if len(navs) == 0 {
		t.Errorf("fb-025-002 %s: proxy did not call vlp_navigate to reload the discarded tab", t.Name())
	} else {
		last := navs[len(navs)-1]
		if got := argTabID(last.Arguments); got != 22 {
			t.Errorf("fb-025-002 %s: vlp_navigate tabId = %d, want 22", t.Name(), got)
		}
		if !strings.Contains(string(last.Arguments), "https://www.odoo.sh/app") {
			t.Errorf("fb-025-002 %s: vlp_navigate args = %s, want the resolved tab url", t.Name(), last.Arguments)
		}
	}
	// I-12: the default recovery never steals focus.
	if got := activateCount(f); got != 0 {
		t.Errorf("fb-025-002 %s: vlp_activateTab called %d time(s) with the default focus policy; want 0", t.Name(), got)
	}
	// The original page eval is re-emitted exactly once (original + retry).
	if got := pageEvalCount(f); got != 2 {
		t.Errorf("fb-025-002 %s: page evals = %d, want exactly 2 (original + one retry)", t.Name(), got)
	}
	// The proxy waited on document.readyState before retrying.
	if got := probeCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: readyState probes = %d, want >= 1", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// P2. Focus fallback is opt-in (RED)
// ---------------------------------------------------------------------------

func p2Resilience(t *testing.T, allowFocus bool, activateRecovers bool) (*fakeMCP, httpResult) {
	t.Helper()
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = false
		f.activateRecovers = activateRecovers
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	extra := map[string]string{}
	if allowFocus {
		extra["VLP_RECOVER_ALLOW_FOCUS"] = "1"
	}
	env := recoveryEnv(t, f, extra)
	startProxy(t, env)
	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	return f, res
}

func TestR2a_FocusFallbackOptIn(t *testing.T) {
	f, res := p2Resilience(t, true, true)
	expectStatus(t, res, 200)
	if got := activateCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: vlp_activateTab calls = %d, want exactly 1 (opt-in fallback)", t.Name(), got)
	}
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: vlp_navigate calls = %d, want >= 1 (primary attempt first)", t.Name(), got)
	}
}

func TestR2b_FocusDisabledNoActivate(t *testing.T) {
	f, res := p2Resilience(t, false, true)
	expectStatus(t, res, 502)
	if got := activateCount(f); got != 0 {
		t.Errorf("fb-025-002 %s: vlp_activateTab calls = %d with focus disabled; want 0 (I-12)", t.Name(), got)
	}
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-002 %s: vlp_navigate calls = %d, want >= 1", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// P3. Wait for readyState:complete + bounded deadline (RED)
// ---------------------------------------------------------------------------

func TestR3a_WaitReadyComplete(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = true
		f.readyStates = []string{"loading", "complete"}
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 200)
	if got := probeCount(f); got < 2 {
		t.Errorf("fb-025-002 %s: readyState probes = %d, want >= 2 (loading then complete)", t.Name(), got)
	}
	// The retry must come AFTER the proxy observed complete.
	lastProbeBeforeLastPage(t, f)
}

func TestR3b_DeadlineExhausted(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = true
		f.readyStates = []string{"loading"} // never complete
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, map[string]string{
		"VLP_RECOVER_READY_DEADLINE_MS": "300",
		"VLP_RECOVER_READY_POLL_MS":     "50",
	})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)

	probes := probeCount(f)
	if probes < 1 {
		t.Errorf("fb-025-002 %s: readyState probes = %d, want >= 1", t.Name(), probes)
	}
	// Bounded by DEADLINE/POLL (+ slack): no infinite loop (I-11).
	if max := 300/50 + 6; probes > max {
		t.Errorf("fb-025-002 %s: readyState probes = %d, want <= %d (bounded by the deadline)", t.Name(), probes, max)
	}
	// Never complete => the original eval is not re-emitted.
	if got := pageEvalCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: page evals = %d, want 1 (no retry before complete)", t.Name(), got)
	}
}

// ---------------------------------------------------------------------------
// P4. One bounded cycle; persistent failure -> classified 502 (RED)
// ---------------------------------------------------------------------------

func TestR4a_BoundedCycleNoFocus(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = false
		f.activateRecovers = false
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litRecoveryFailed)
	expectContains(t, "body", string(res.Body), rawCandidate)

	if got := navigateCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: vlp_navigate calls = %d, want exactly 1 (bounded cycle)", t.Name(), got)
	}
	if got := activateCount(f); got != 0 {
		t.Errorf("fb-025-002 %s: vlp_activateTab calls = %d, want 0 (focus default off)", t.Name(), got)
	}
	if got := pageEvalCount(f); got > 2 {
		t.Errorf("fb-025-002 %s: page evals = %d, want <= 2 (I-11)", t.Name(), got)
	}
}

func TestR4b_BoundedCycleFocus(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = false
		f.activateRecovers = false
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, map[string]string{"VLP_RECOVER_ALLOW_FOCUS": "1"})
	startProxy(t, env)

	res := proxyClientDo(t, env, "POST", "/app/project/x/get_info", sampleRPCRequest, nil)
	requireFakeReached(t, f)
	expectStatus(t, res, 502)
	expectContains(t, "body", string(res.Body), litRecoveryFailed)

	if got := navigateCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: vlp_navigate calls = %d, want exactly 1", t.Name(), got)
	}
	if got := activateCount(f); got != 1 {
		t.Errorf("fb-025-002 %s: vlp_activateTab calls = %d, want exactly 1 (bounded fallback)", t.Name(), got)
	}
	if got := pageEvalCount(f); got > 3 {
		t.Errorf("fb-025-002 %s: page evals = %d, want <= 3 (I-11)", t.Name(), got)
	}
}
