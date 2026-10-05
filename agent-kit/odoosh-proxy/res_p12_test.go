// fb-025-002 spec §3.3 P12 (RED): 001 invariants preserved while recovering.
// Prefix TestR (C-9).
package main_test

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestR12_InvariantsDuringRecovery fires two concurrent requests at the same
// discarded tab (recoverable via navigate). It asserts the recovery 200s AND
// that the 001 invariants hold during recovery: Cookie dropped, no secrets in
// the log, no session file, and no overlapping evals to the same tab (the
// recovery must run inside the per-tab lock).
func TestR12_InvariantsDuringRecovery(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) {
		f.discarded = true
		f.discardedTab = 22
		f.navigateRecovers = true
		f.callDelay = 150 * time.Millisecond // widen the overlap window
	})
	f.addPage("/app/project/x/get_info", fakePage{status: 200, ct: "application/json", body: sampleRPCResponse, url: "https://www.odoo.sh/app/project/x/get_info"})
	env := recoveryEnv(t, f, nil)
	startProxy(t, env)

	before := snapshotFiles(t, env.Dir)

	var wg sync.WaitGroup
	results := make([]httpResult, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = proxyClientDoErr(env, "POST", "/app/project/x/get_info", sampleRPCRequest, map[string]string{
				"Cookie": "session_id=" + sentinelCookie,
			})
		}(i)
	}
	wg.Wait()

	requireFakeReached(t, f)
	for i, err := range errs {
		if err != nil {
			t.Fatalf("fb-025-002 %s: concurrent request %d failed: %v", t.Name(), i, err)
		}
	}
	for i, res := range results {
		if res.Status != 200 {
			t.Errorf("fb-025-002 %s: request %d status = %d, want 200 (recovery) — body %q", t.Name(), i, res.Status, res.Body)
		}
	}

	// I-2: the incoming Cookie is never forwarded to the transport.
	for i, r := range f.requests() {
		if r.HasCookie || strings.Contains(r.Cookie, sentinelCookie) {
			t.Errorf("fb-025-002 %s: request %d forwarded a Cookie: %q", t.Name(), i, r.Cookie)
		}
		if strings.Contains(r.Body, sentinelCookie) {
			t.Errorf("fb-025-002 %s: request %d body carries the cookie", t.Name(), i)
		}
	}

	// I-1/I-5: no secret in the log.
	log := readFileOrEmpty(env.LogFile)
	expectNotContains(t, "proxy log", log, sentinelCookie)
	expectNotContains(t, "proxy log", log, sentinelToken)

	// I-9: no session file / no secret persisted during recovery.
	after := snapshotFiles(t, env.Dir)
	for _, path := range diffFiles(before, after) {
		if strings.Contains(strings.ToLower(filepath.Base(path)), "session") {
			t.Errorf("fb-025-002 %s: proxy created a session file during recovery: %s (D-8)", t.Name(), path)
		}
		content := readFileOrEmpty(path)
		if strings.Contains(content, sentinelCookie) || strings.Contains(content, sentinelToken) {
			t.Errorf("fb-025-002 %s: artifact %s leaked a secret during recovery", t.Name(), path)
		}
	}

	// D-12: evals to the same tab must not overlap while recovering.
	if f.overlapped() {
		t.Errorf("fb-025-002 %s: evals to the same tab overlapped during recovery (per-tab lock violated)", t.Name())
	}
}
