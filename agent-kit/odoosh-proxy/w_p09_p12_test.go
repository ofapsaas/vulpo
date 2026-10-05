// fb-025-003 spec §3.3 P12 (RED/GUARD). P9/P10/P11 are PINs without a file
// (AUDIT §4.2). Prefix TestW (AUDIT §2).
package main_test

import "testing"

// TestW12a_InvalidKnobFailsLoud: VLP_RECOVER_ON_WRITE != 0/1 must fail loud at
// startup (spec §3.2/D-3, C-9). 001/002 ignore the var and start, so this is RED.
func TestW12a_InvalidKnobFailsLoud(t *testing.T) {
	f := newFakeMCP(t)
	env := writeEnv(t, f, map[string]string{"VLP_RECOVER_ON_WRITE": "maybe"})

	code, out := startProxyExpectExit(t, env)
	if code == 0 {
		t.Errorf("fb-025-003 %s: proxy started with VLP_RECOVER_ON_WRITE=maybe; want fail-loud (exit != 0)\noutput: %s", t.Name(), out)
	}
}

// TestW12b_ValidKnobStarts: both valid values must start the proxy with the
// corresponding policy (spec §3.2/D-3).
func TestW12b_ValidKnobStarts(t *testing.T) {
	for _, v := range []string{"0", "1"} {
		t.Run("knob="+v, func(t *testing.T) {
			f := newFakeMCP(t)
			env := writeEnv(t, f, map[string]string{"VLP_RECOVER_ON_WRITE": v})
			startProxy(t, env) // fatals if the proxy refuses to start

			res := proxyClientDo(t, env, "GET", "/healthz", "", nil)
			expectStatus(t, res, 200)
		})
	}
}
