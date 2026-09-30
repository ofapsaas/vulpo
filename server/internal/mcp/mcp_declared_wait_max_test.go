// fb-024-act-timeout-techo — sub-fase RED (docs/specs/fb-024-act-timeout-techo/spec.md §3.2, P5–P6).
//
// D-2: el MCP rechaza, ANTES de despachar, toda espera declarada numérica
// > 60000 ms en los 5 parámetros del spec (vlp_act.waitMs,
// vlp_act.frame.waitMs, vlp_navigate.frame.waitMs, vlp_getFrame.waitMs,
// vlp_waitForElement.timeout). Texto EXACTO del tool error:
//
//	<tool>: <param> must be at most 60000 ms (got <valor>); nothing was dispatched
//
// con <valor> = strconv.FormatFloat(v, 'f', -1, 64). I-4: el hub NO recorta;
// la única cota es esta validación del MCP previa al despacho (hub recibe 0
// commands). Los valores no numéricos, ≤ 0 o ausentes pasan verbatim (relay
// sin type-assert, P18 / TestAct_RelaysWaitQuietMs_P18).
//
// El techo no se nombra por constante interna: se observa por el borde
// (60000 despacha 1, 60001 despacha 0 — guarda de no-vacuidad del audit §6).
package mcp

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// declaredWaitMaxCases: los 5 parámetros de D-2 con el mínimo de args
// requeridos de cada tool (los que TestCommandWire ya usa) más el parámetro
// bajo techo. paramPath indica dónde debe llegar el valor verbatim en el
// Command del MockHub: ("waitMs", top) = raíz de Params; ("waitMs", frame) /
// ("timeout", frame) = nested en Params["frame"].
var declaredWaitMaxCases = []struct {
	tool     string
	command  string // command wire esperado (toolsTable)
	param    string // <param> del mensaje D-2
	path     string // "top" o "frame"
	baseArgs func() map[string]any
}{
	{"vlp_act", "act", "waitMs", "top",
		func() map[string]any {
			return map[string]any{"tabId": float64(24), "ref": "main>button", "action": "click"}
		}},
	{"vlp_act", "act", "frame.waitMs", "frame",
		func() map[string]any {
			return map[string]any{"tabId": float64(24), "ref": "main>button", "action": "click", "frame": map[string]any{}}
		}},
	{"vlp_navigate", "navigate", "frame.waitMs", "frame",
		func() map[string]any {
			return map[string]any{"tabId": float64(24), "url": "http://x", "frame": map[string]any{}}
		}},
	{"vlp_getFrame", "getFrame", "waitMs", "top",
		func() map[string]any {
			return map[string]any{"tabId": float64(24), "page": float64(1)}
		}},
	{"vlp_waitForElement", "waitForElement", "timeout", "top",
		func() map[string]any {
			return map[string]any{"tabId": float64(24), "selector": "#a"}
		}},
}

// callDeclaredWait arme la llamada tools/call con el valor <v> en el
// parámetro bajo techo (en la raíz o en frame según path).
func callDeclaredWait(s *Server, tc struct {
	tool     string
	command  string
	param    string
	path     string
	baseArgs func() map[string]any
}, v float64) map[string]any {
	args := tc.baseArgs()
	val := v
	if tc.path == "frame" {
		args["frame"].(map[string]any)[strings.TrimPrefix(tc.param, "frame.")] = val
	} else {
		args[tc.param] = val
	}
	return callTool(s, tc.tool, args)
}

// wantDeclaredWaitText construye el texto EXACTO de D-2 para un caso.
// <tool> y <param> tal cual; <valor> con FormatFloat 'f' -1 (60001 → "60001").
func wantDeclaredWaitText(tc struct {
	tool     string
	command  string
	param    string
	path     string
	baseArgs func() map[string]any
}, v float64) string {
	return tc.tool + ": " + tc.param + " must be at most 60000 ms (got " + fmtFloatForContract(v) + "); nothing was dispatched"
}

// fmtFloatForContract: strconv.FormatFloat(v, 'f', -1, 64) — <valor> del D-2.
func fmtFloatForContract(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// --- P5 (RED): 60001 → tool error exacto + hub recibe 0 commands;
// — 60000 exacto → 1 command con el valor verbatim (guarda de no-vacuidad). ---

func TestFb024_P5_DeclaredWaitAboveMaxRejected(t *testing.T) {
	for _, tc := range declaredWaitMaxCases {
		tc := tc
		t.Run(tc.tool+"/"+tc.param, func(t *testing.T) {
			s, hub := newTools(t)

			// 60001 → tool error -32000 con el texto EXACTO de D-2 y NADA
			// despachado (el hub recibe 0 commands — I-4: ni recorte ni
			// despacho-antes-de-validar).
			resp := callDeclaredWait(s, tc, 60001)
			errVal, hasErr := resp["error"]
			if !hasErr {
				t.Fatalf("P5 %s %s: 60001 se despachó sin error (resp=%v), want tool error D-2 (hoy despacha: RED)", tc.tool, tc.param, resp)
			}
			errMap, ok := errVal.(map[string]any)
			if !ok {
				t.Fatalf("P5 %s %s: error no es mapa: %T (%v)", tc.tool, tc.param, errVal, errVal)
			}
			if codeOf(errMap) != -32000 {
				t.Fatalf("P5 %s %s: error code = %v, want -32000", tc.tool, tc.param, errMap)
			}
			msg, _ := errMap["message"].(string)
			want := wantDeclaredWaitText(tc, 60001)
			if msg != want {
				t.Fatalf("P5 %s %s: error message =\n  %q\nwant EXACTO (D-2):\n  %q", tc.tool, tc.param, msg, want)
			}
			if calls := hub.commandCalls(); len(calls) != 0 {
				t.Fatalf("P5 %s %s: el hub recibió %d commands con valor 60001, want 0 (nada se despacha): %v", tc.tool, tc.param, len(calls), calls)
			}

			// 60000 exacto → el techo NO aplica: se despacha 1 command y el
			// valor llega verbatim a Params (o Params.frame). SIN esta guarda,
			// una impl que rechazara desde 5000 pasaría el caso 60001 (verde
			// vacuo — audit §6-d).
			respOk := callDeclaredWait(s, tc, 60000)
			if _, hasErr := respOk["error"]; hasErr {
				t.Fatalf("P5 %s %s: 60000 (techo exacto) devolvió error %v, want despachar (I-4: el rechazo es solo > 60000)", tc.tool, tc.param, respOk["error"])
			}
			if calls := hub.commandCalls(); len(calls) != 1 {
				t.Fatalf("P5 %s %s: 60000 despachó %d commands, want exactamente 1: %v", tc.tool, tc.param, len(calls), calls)
			}
			_, cmd := hub.lastCall()
			var got any
			if tc.path == "frame" {
				fr, _ := cmd.Params["frame"].(map[string]any)
				got = fr[strings.TrimPrefix(tc.param, "frame.")]
			} else {
				got = cmd.Params[tc.param]
			}
			if got != float64(60000) {
				t.Fatalf("P5 %s %s: el valor verbatim no llegó a Params: got %v (%T), want 60000 (float64) — el rechazo NO puede mutar el relay", tc.tool, tc.param, got, got)
			}
		})
	}
}

// --- P6 (PIN): valores NO numéricos, ≤ 0 o ausentes se despachan como hoy
// — (relay verbatim: 1 command, valor sin mutar). ---

func TestFb024_P6_NonNumericAndLowValuesRelayVerbatim(t *testing.T) {
	values := []any{"abc", float64(0), float64(-5)}
	for _, tc := range declaredWaitMaxCases {
		tc := tc
		for _, v := range values {
			v := v
			name := tc.tool + "/" + tc.param
			switch val := v.(type) {
			case float64:
				name = fmt.Sprintf("%s con %.0f", name, val)
			case string:
				name = fmt.Sprintf("%s con %q", name, val)
			}
			t.Run(name, func(t *testing.T) {
				s, hub := newTools(t)
				args := tc.baseArgs()
				if tc.path == "frame" {
					args["frame"].(map[string]any)[strings.TrimPrefix(tc.param, "frame.")] = v
				} else {
					args[tc.param] = v
				}
				resp := callTool(s, tc.tool, args)
				if _, hasErr := resp["error"]; hasErr {
					t.Fatalf("P6 %s %s=%v: devolvió error %v, want despachar (los valores no numéricos/≤0 conservan el comportamiento actual, D-2)", tc.tool, tc.param, v, resp["error"])
				}
				if calls := hub.commandCalls(); len(calls) != 1 {
					t.Fatalf("P6 %s %s=%v: despachó %d commands, want 1: %v", tc.tool, tc.param, v, len(calls), calls)
				}
				_, cmd := hub.lastCall()
				var got any
				if tc.path == "frame" {
					fr, _ := cmd.Params["frame"]
					frMap, _ := fr.(map[string]any)
					got = frMap[strings.TrimPrefix(tc.param, "frame.")]
				} else {
					got = cmd.Params[tc.param]
				}
				if got != v {
					t.Fatalf("P6 %s (%s): valor relayado = %v (%T), want verbatim %v (%T)", tc.param, name, got, got, v, v)
				}
			})
		}
	}
}
