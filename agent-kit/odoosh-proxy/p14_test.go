// fb-025-001 spec §3.3 P14 (D-12): per-tab serialization.
package main_test

import (
	"sync"
	"testing"
	"time"
)

// TestP14_PerTabSerialization fires two concurrent requests at the same tab.
// The fake flags any overlap between evals to the same tabId; the proxy must
// serialize them, so no overlap is allowed and the fake must see >= 2 evals.
func TestP14_PerTabSerialization(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 200 * time.Millisecond }) // widen the overlap window
	f.addPage("/app/x", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/x"})
	env := newEnv(t, f.URL())
	env.Vars["VLP_EVAL_TAB"] = "22" // both requests target the same tab
	startProxy(t, env)

	var wg sync.WaitGroup
	results := make([]httpResult, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = proxyClientDoErr(env, "POST", "/app/x", sampleRPCRequest, nil)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("fb-025 %s: concurrent request %d failed: %v", t.Name(), i, err)
		}
	}
	for i, res := range results {
		if res.Status != 200 {
			t.Errorf("fb-025 %s: concurrent request %d status = %d, want 200", t.Name(), i, res.Status)
		}
	}

	evals := f.toolCalls("vlp_eval")
	if len(evals) < 2 {
		t.Fatalf("fb-025 %s: fake observed %d evals, want >= 2 (the guard needs both evals)", t.Name(), len(evals))
	}
	if f.overlapped() {
		t.Errorf("fb-025 %s: two concurrent evals to the same tab overlapped (D-12 serialization violated)", t.Name())
	}
}
