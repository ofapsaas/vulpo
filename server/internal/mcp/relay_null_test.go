// fb-027-005-relay-null-contract — sub-fase RED (Etapa 3.1).
//
// Spec aprobado: docs/specs/fb-027-005-relay-null-contract/spec.md
//   §2.1 regla normativa: `null` es un RESULTADO, no una ausencia.
//   §2.2 P1/P2 (pins), P3 (guard negativo).
// AUDIT aprobado: docs/specs/fb-027-005-relay-null-contract/test-audit.md §4.3.
//
// Contrato: el relay es un pasamanos (paridad fb-013-005) — no interpreta el
// resultado. Un `null` legítimo se entrega como tools/call EXITOSO cuyo
// content[0].text es el literal JSON `null`; nunca como error, nunca como
// content vacío. Un vacío se relaya verbatim.
//
// Clasificación RED (audit §4.1): P1/P2/P3 son PINs/guards — VERDES hoy (el
// envelope ya emite el literal JSON). El único RED genuino del feature es
// P4(b), en el paquete `hub` (relay_null_test.go de hub). Estos tests fijan
// el contrato contra regresión.
//
// Harness (mcp_tools_test.go:25-85): MockHub `result==nil, err==nil` ejercita
// el camino nil del relay; s.HandleRequest + content[0].text leen el envelope.
// Ningún helper nuevo (audit E-2).
package mcp

import (
	"encoding/json"
	"testing"
)

// relayNullContent: invoca una tool y devuelve result.content, fallando si el
// relay devolvió un error JSON-RPC o un content ausente. Es el oráculo
// compartido de P1–P3.
func relayNullContent(t *testing.T, resp any) []any {
	t.Helper()
	m, ok := resp.(map[string]any)
	if !ok {
		t.Fatalf("respuesta inesperada %T: %v", resp, resp)
	}
	if errVal, hasErr := m["error"]; hasErr {
		t.Fatalf("tools/call devolvió error inesperado: %v", errVal)
	}
	res, ok := m["result"].(map[string]any)
	if !ok {
		t.Fatalf("result no es map: %T (%v)", m["result"], m["result"])
	}
	arr, ok := res["content"].([]any)
	if !ok {
		t.Fatalf("result.content ausente o no-array: %v", res["content"])
	}
	return arr
}

// relayNullCall: emite tools/call con el token "tok1" (MockHub fallback).
func relayNullCall(t *testing.T, s *Server, name string, args map[string]any) any {
	t.Helper()
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	}, "tok1")
	return resp
}

// P1 (PIN) — `vlp_getCurrentTab` con resultado null de la extensión →
// tools/call EXITOSA, content[0].text == "null", sin error y sin content vacío.
func TestRelayNull_P1_NilResultRelaysAsNull(t *testing.T) {
	s, hub := newTools(t)
	hub.result = nil // MockHub default: Command → (nil, nil) ⇒ camino nil del relay

	arr := relayNullContent(t, relayNullCall(t, s, "vlp_getCurrentTab", map[string]any{}))
	if len(arr) == 0 {
		t.Fatalf("P1: content vacío para un resultado null — el relay NO debe sustituir null por 'sin contenido'")
	}
	part, ok := arr[0].(map[string]any)
	if !ok {
		t.Fatalf("P1: content[0] no es objeto — %T", arr[0])
	}
	if part["type"] != "text" {
		t.Fatalf("P1: content[0].type = %v, want text", part["type"])
	}
	text, _ := part["text"].(string)
	if text != "null" {
		t.Fatalf("P1: content[0].text = %q, want el literal JSON %q (null es un resultado exitoso, no error ni vacío)", text, "null")
	}
}

// P2 (PIN) — un resultado vacío se relaya VERBATIM: [] → "[]", {} → "{}",
// 0 → "0". Ningún resultado no-error pierde su parte de texto.
func TestRelayNull_P2_EmptyResultsRelayedVerbatim(t *testing.T) {
	cases := []struct {
		name string
		seed any
		want string
	}{
		{"array_vacio", []any{}, "[]"},
		{"objeto_vacio", map[string]any{}, "{}"},
		{"cero", float64(0), "0"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			s, hub := newTools(t)
			hub.result = tc.seed
			arr := relayNullContent(t, relayNullCall(t, s, "vlp_listTabs", map[string]any{}))
			if len(arr) == 0 {
				t.Fatalf("P2: content vacío para %v", tc.seed)
			}
			part, ok := arr[0].(map[string]any)
			if !ok {
				t.Fatalf("P2: content[0] no es objeto — %T", arr[0])
			}
			if part["type"] != "text" {
				t.Fatalf("P2: content[0].type = %v, want text", part["type"])
			}
			if got, _ := part["text"].(string); got != tc.want {
				t.Fatalf("P2: content[0].text = %q, want %q (relay verbatim del resultado)", got, tc.want)
			}
		})
	}
}

// P3 (GUARD negativo) — para TODO resultado no-error, result.content tiene
// ≥1 parte type:"text" con el JSON del resultado. Barrido de valores que
// cubren los bordes del marshaling (nil, vacíos, cero, string, bool).
func TestRelayNull_P3_EveryNonErrorResultHasTextPart(t *testing.T) {
	seeds := []struct {
		name string
		seed any
	}{
		{"nil", nil},
		{"array_vacio", []any{}},
		{"objeto_vacio", map[string]any{}},
		{"cero", float64(0)},
		{"string", "x"},
		{"bool", true},
	}
	for _, sd := range seeds {
		sd := sd
		t.Run(sd.name, func(t *testing.T) {
			s, hub := newTools(t)
			hub.result = sd.seed
			arr := relayNullContent(t, relayNullCall(t, s, "vlp_getCurrentTab", map[string]any{}))
			if len(arr) < 1 {
				t.Fatalf("P3: content = %v, want ≥1 parte de texto (ningún resultado no-error pierde su texto)", arr)
			}
			foundText := false
			for i, it := range arr {
				part, ok := it.(map[string]any)
				if !ok {
					t.Fatalf("P3: content[%d] no es objeto — %T", i, it)
				}
				if part["type"] != "text" {
					continue
				}
				text, _ := part["text"].(string)
				var inner any
				if err := json.Unmarshal([]byte(text), &inner); err != nil {
					t.Fatalf("P3: content[%d].text no es JSON: %q (%v)", i, text, err)
				}
				foundText = true
			}
			if !foundText {
				t.Fatalf("P3: ninguna parte type:text en content = %v", arr)
			}
		})
	}
}
