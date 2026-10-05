// fb-025-003 spec §3.3 P1–P4 (RED). Prefix TestW to avoid colliding with the
// 001 (TestP…) and 002 (TestR…) suites (AUDIT §2).
package main_test

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// P1. Passthrough byte-a-byte of real writes (GUARD)
// ---------------------------------------------------------------------------

func TestW1a_WritePassthroughByteForByte(t *testing.T) {
	const ct = "application/json; charset=utf-8"
	f, _, res := runWritePassthrough(t, "/app/branch/1/fork", fakePage{
		status: 200,
		ct:     ct,
		body:   sampleRPCResponse,
		url:    "https://www.odoo.sh/app/branch/1/fork",
	}, writeForkBody, nil)

	expectStatus(t, res, 200)
	if got := res.Header.Get("Content-Type"); got != ct {
		t.Errorf("fb-025-003 %s: Content-Type = %q, want the page ct byte-for-byte", t.Name(), got)
	}
	if string(res.Body) != sampleRPCResponse {
		t.Errorf("fb-025-003 %s: body = %q, want byte-for-byte %q", t.Name(), res.Body, sampleRPCResponse)
	}

	// Guard (P1): the fake saw the route and the request body, byte-for-byte,
	// inside the eval code (the route is cited, the body is embedded).
	evals := f.toolCalls("vlp_eval")
	if len(evals) == 0 {
		t.Fatalf("fb-025-003 %s: no vlp_eval reached the fake", t.Name())
	}
	pageCode := ""
	for _, r := range evals {
		if c := argCode(r.Arguments); !isReadyStateProbe(c) {
			pageCode = c
		}
	}
	if pageCode == "" {
		t.Fatalf("fb-025-003 %s: no page eval reached the fake", t.Name())
	}
	if !strings.Contains(pageCode, "/app/branch/1/fork") {
		t.Errorf("fb-025-003 %s: eval code does not cite the write route: %q", t.Name(), pageCode)
	}
	if got := extractEvalBody(t, pageCode); got != writeForkBody {
		t.Errorf("fb-025-003 %s: embedded request body = %q, want byte-for-byte %q", t.Name(), got, writeForkBody)
	}
}

func TestW1b_WriteBusinessErrorPassthrough(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"boom"}}`
	_, _, res := runWritePassthrough(t, "/app/project/x/set_settings", fakePage{
		status: 200,
		ct:     "application/json",
		body:   body,
		url:    "https://www.odoo.sh/app/project/x/set_settings",
	}, writeSetSettingsBody, nil)

	expectStatus(t, res, 200)
	if string(res.Body) != body {
		t.Errorf("fb-025-003 %s: body = %q, want the business-error passthrough %q", t.Name(), res.Body, body)
	}
}

func TestW1c_WriteNon2xxPassthrough(t *testing.T) {
	const body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal"}}`
	_, _, res := runWritePassthrough(t, "/app/branch/1/allow_ip", fakePage{
		status: 500,
		ct:     "application/json",
		body:   body,
		url:    "https://www.odoo.sh/app/branch/1/allow_ip",
	}, "", nil)

	expectStatus(t, res, 500)
	if string(res.Body) != body {
		t.Errorf("fb-025-003 %s: body = %q, want the real 500 body %q", t.Name(), res.Body, body)
	}
}

// ---------------------------------------------------------------------------
// P2. Guard: generic -32000 on a NON-read route does not recover (RED)
// ---------------------------------------------------------------------------

func TestW2a_WriteRoutesNoRecovery(t *testing.T) {
	for _, route := range writeRoutes {
		t.Run(strings.TrimPrefix(route, "/app/"), func(t *testing.T) {
			f, res := runRecovery(t, route, nil)
			assertNoRecovery(t, f, res, rawCandidate)
		})
	}
}

func TestW2b_AmbiguousUserProfileNoRecovery(t *testing.T) {
	f, res := runRecovery(t, ambiguousRoute, nil)
	assertNoRecovery(t, f, res, rawCandidate)
}

func TestW2c_UnknownRouteNoRecovery(t *testing.T) {
	f, res := runRecovery(t, unknownRoute, nil)
	assertNoRecovery(t, f, res, rawCandidate)
}

func TestW2d_MalformedReadPathsNoRecovery(t *testing.T) {
	for _, route := range malformedReadPaths {
		t.Run(strings.TrimPrefix(route, "/app/"), func(t *testing.T) {
			f, res := runRecovery(t, route, nil)
			assertNoRecovery(t, f, res, rawCandidate)
		})
	}
}

// ---------------------------------------------------------------------------
// P3. Guard: generic -32000 on a READ route recovers, as in 002 (GUARD)
// ---------------------------------------------------------------------------

func TestW3_ReadRoutesRecover(t *testing.T) {
	for _, route := range readRoutes {
		t.Run(strings.TrimPrefix(route, "/app/"), func(t *testing.T) {
			f, res := runRecovery(t, route, nil)
			expectStatus(t, res, 200)
			if got := navigateCount(f); got < 1 {
				t.Errorf("fb-025-003 %s: vlp_navigate = %d, want >= 1 (READ route must recover)", t.Name(), got)
			}
			if got := pageEvalCount(f); got != 2 {
				t.Errorf("fb-025-003 %s: page evals = %d, want exactly 2 (original + retry)", t.Name(), got)
			}
			if got := probeCount(f); got < 1 {
				t.Errorf("fb-025-003 %s: readyState probes = %d, want >= 1", t.Name(), got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P4. Host-permission candidate recovers on ALL routes (GUARD, D-2 witness)
// ---------------------------------------------------------------------------

func TestW4a_HostPermissionRecoversWriteRoute(t *testing.T) {
	f, res := runHostPerm(t, "/app/branch/1/fork")
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-003 %s: host-permission on a write route did not recover (navigate=%d)", t.Name(), got)
	}
	if got := pageEvalCount(f); got != 2 {
		t.Errorf("fb-025-003 %s: page evals = %d, want exactly 2", t.Name(), got)
	}
}

func TestW4b_HostPermissionRecoversReadRoute(t *testing.T) {
	f, res := runHostPerm(t, readRecoveryRoute)
	expectStatus(t, res, 200)
	if got := navigateCount(f); got < 1 {
		t.Errorf("fb-025-003 %s: host-permission on a read route did not recover (navigate=%d)", t.Name(), got)
	}
	if got := pageEvalCount(f); got != 2 {
		t.Errorf("fb-025-003 %s: page evals = %d, want exactly 2", t.Name(), got)
	}
}
