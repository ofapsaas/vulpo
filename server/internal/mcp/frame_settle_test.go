// Package mcp tests — fb-018-006-readiness-signal (sub-fase RED). P16.
//
// Deriva de §2.5 y §3/P16 del spec: vlp_getFrame suma al InputSchema los
// tres parámetros opcionales nuevos (`settle` boolean, `waitMs` number,
// `quietMs` number), el handler los inserta SOLO SI el request los trae (mismo
// patrón include/roles/namedOnly de fb-018-001 §2.5), `settle` se type-assertea
// a boolean con caída segura a false, y el conteo total de tools sigue en 34
// (no se agrega ninguna tool, §1.4).
//
// Archivo NUEVO a propósito: mcp_frame_payload_test.go, mcp_frame_api_test.go
// y mcp_tools_test.go quedan intactos. Los helpers getFrameTool/schemaProps se
// REUSAN del package (mcp_frame_payload_test.go) y el guardián de conteo
// (mcp_tools_test.go, want 34) no se toca: acá se re-afirma como precondición
// local para que el implementer no pueda satisfacer P16 registrando una tool
// nueva (mismo patrón que TestAct_InputSchemaHasForce en mcp_dialogo_inerte_test.go).
//
// Cobertura de los gaps del audit (test-audit.md §5.3 y §5.5):
//   · Verde-vacuo del forward (§5.3): el forward se asserta en las DOS
//     direcciones — presentes en el request ⇒ verbatim; AUSENTES del request ⇒
//     ausencia total en Params (ni nil; el patrón page/maxElementsPerPage
//     insertadas en nil está documentado en TestGetFrame_ForwardsPayloadParams).
//   · I-2 wire (§5.5): la ausencia de invalidation.settled/waitedMs sin settle
//     se arma en background.js (no testeable en node) y se verifica E2E en
//     P10/P11 (fase posterior). El anclaje testeable en RED es esta frontera:
//     sin las claves, nada settle-ish cruza el hub. (I-C de los params nuevos
//     — el otro gap — vive en el test JS settle.test.js "I-C".)
//
// Naturaleza RED esperada: los TRES tests FALLAN hoy (el schema no declara
// settle/waitMs/quietMs y el handler no los forwardea). El test de type-assert
// lleva su control positivo (settle:true ⇒ bool true en el wire) en el MISMO
// test a propósito: sin él, un handler que nunca forwardea settle dejaría los
// casos de degradación en verde vacuo.
package mcp

import (
	"fmt"
	"strings"
	"testing"
)

// P16 (§2.5): el InputSchema declara settle/waitMs/quietMs con sus tipos, y
// ninguno figura en required — todos opcionales, jamás por default (§2.1).
// Parte 2 de P16: el conteo de tools sigue en 34.
func TestGetFrame_InputSchemaHasSettleParams(t *testing.T) {
	s, _ := newTools(t)

	// El conteo se verifica ANTES del schema: un fallo de schema no debe
	// ocultar una tool agregada de más (patrón P20 de fb-018-004).
	names := map[string]bool{}
	for _, tl := range s.ListTools() {
		names[tl.Name] = true
	}
	if len(names) != 33 {
		t.Fatalf("el conteo de tools debe seguir en 33 (fb-022: 21 vlp_* + 12 odoo; §1.4/§2.5: no se agrega ninguna tool); got %d", len(names))
	}

	_, schema := getFrameTool(t, s)
	props := schemaProps(t, schema)

	// Guarda de no-vacuidad: si el schema perdiera los params previos, las
	// aserciones de abajo no dirían nada sobre una extensión retrocompatible.
	for _, prev := range []string{"tabId", "page", "include", "roles", "namedOnly"} {
		if _, ok := props[prev]; !ok {
			t.Fatalf("precondición: el InputSchema debe seguir declarando %q; properties=%v", prev, props)
		}
	}

	// (a) Los tres nuevos, con el tipo declarado en §2.1.
	tipos := map[string]string{"settle": "boolean", "waitMs": "number", "quietMs": "number"}
	for name, want := range tipos {
		raw, ok := props[name]
		if !ok {
			t.Fatalf("InputSchema de vlp_getFrame sin el parámetro %q (§2.5/P16); properties=%v", name, props)
		}
		obj, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("la propiedad %q no es un objeto de schema: %T (%v)", name, raw, raw)
		}
		if obj["type"] != want {
			t.Fatalf("%q debe declararse como %s (§2.1); type=%v", name, want, obj["type"])
		}
	}

	// (a) Ninguno en required (los tres son opcionales, §2.1). Se compara sobre
	// la forma stringificada a propósito: un type-assert a []string sería un
	// no-op silencioso si el schema usa []any (patrón P20/payload-params).
	if rawReq, ok := schema["required"]; ok {
		req := fmt.Sprint(rawReq)
		for _, name := range []string{"settle", "waitMs", "quietMs"} {
			if strings.Contains(req, name) {
				t.Fatalf("%q es opcional (§2.1), no puede figurar en required: %s", name, req)
			}
		}
	}
}

// P16 (§2.5 + audit §5.3): el handler inserta settle/waitMs/quietMs en los
// params del hub SOLO SI el request los trae. Las DOS direcciones en el MISMO
// test: presentes ⇒ forward verbatim (valor Y tipo, no solo la clave — lección
// de TestGetFrame_ForwardsPayloadParams); ausentes ⇒ AUSENCIA total en Params.
// Los defaults (waitMs=5000/quietMs=300) viven en settle.js, NO acá (§2.1):
// por eso el forward es verbatim y no aplica defaults en el handler.
func TestGetFrame_SettleForwardOnlyIfPresent(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_getFrame", map[string]any{
		"tabId":   float64(7),
		"settle":  true,
		"waitMs":  float64(8000),
		"quietMs": float64(250),
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("getFrame → error inesperado: %v", resp)
	}
	_, cmd := hub.lastCall()
	if cmd.Command != "getFrame" {
		t.Fatalf("command = %q, want getFrame", cmd.Command)
	}

	// Dirección 1: presentes en el request ⇒ forward verbatim (bool/number sin
	// mutar; assert del valor, no de la clave).
	if b, ok := cmd.Params["settle"].(bool); !ok || !b {
		t.Fatalf("Params.settle = %v (%T), want bool true (forward verbatim)", cmd.Params["settle"], cmd.Params["settle"])
	}
	if n, ok := cmd.Params["waitMs"].(float64); !ok || n != 8000 {
		t.Fatalf("Params.waitMs = %v (%T), want number 8000 (forward verbatim)", cmd.Params["waitMs"], cmd.Params["waitMs"])
	}
	if n, ok := cmd.Params["quietMs"].(float64); !ok || n != 250 {
		t.Fatalf("Params.quietMs = %v (%T), want number 250 (forward verbatim)", cmd.Params["quietMs"], cmd.Params["quietMs"])
	}

	// Dirección 2 (audit §5.3, cierre del verde-vacuo presencia-only): request
	// SIN las claves ⇒ los tres AUSENTES de Params — no vale insertarlos en nil
	// (patrón page/maxElementsPerPage documentado en el payload-test) ni
	// relayar vacíos. Es además el anclaje MCP del gap I-2 wire (audit §5.5):
	// sin las claves, nada settle-ish cruza hacia la extensión.
	s2, hub2 := newTools(t)
	resp2 := callTool(s2, "vlp_getFrame", map[string]any{"tabId": float64(7)})
	if _, hasErr := resp2["error"]; hasErr {
		t.Fatalf("getFrame sin settle → error inesperado: %v", resp2)
	}
	_, cmd2 := hub2.lastCall()
	for _, name := range []string{"settle", "waitMs", "quietMs"} {
		if raw, ok := cmd2.Params[name]; ok {
			t.Fatalf("P16: el request NO trajo %q pero Params lo lleva (%T %v) — el forward es SOLO SI el request lo trae (§2.5); Params=%v",
				name, raw, raw, cmd2.Params)
		}
	}
}

// P16 (§2.1/§2.5, precedente force P20b): settle se type-assertea a boolean con
// caída segura a false — NUNCA se relaya crudo. callTool no valida params contra
// el InputSchema y background.js hace `!!settle`: un "false" string relayado
// crudo ACTIVARÍA la espera (y un "true" activaría sin querer). El control
// positivo (settle:true ⇒ bool true en el wire) vive en este MISMO test: sin él,
// un handler que nunca forwardea settle dejaría los casos de degradación en
// verde vacuo (es lo que hace que este test sea ROJO hoy por la razón correcta).
//
// waitMs/quietMs NO se type-assertean acá a propósito: §2.1 pone sus defaults y
// su validación (no-número o ≤0 ⇒ default) en settle.js, "no en el handler Go".
func TestGetFrame_SettleTypeAsserted(t *testing.T) {
	casos := []struct {
		nombre  string
		entrada any // valor de "settle" en los params de la tool call
		quiero  bool
	}{
		{"bool true (control positivo: se forwardea como bool true)", true, true},
		{"bool false", false, false},
		{"string \"false\" (el caso peligroso: !!\"false\" === true en JS)", "false", false},
		{"string \"true\" (tampoco habilita: no es un bool)", "true", false},
		{"número 1", float64(1), false},
		{"null", nil, false},
	}

	for _, c := range casos {
		s, hub := newTools(t)
		resp := callTool(s, "vlp_getFrame", map[string]any{
			"tabId": float64(7), "settle": c.entrada,
		})
		if _, hasErr := resp["error"]; hasErr {
			t.Fatalf("%s: getFrame → error inesperado: %v", c.nombre, resp)
		}
		_, cmd := hub.lastCall()

		// La ausencia de la clave equivale a false (el camino sin settle es el
		// camino vigente, §2.1): se acepta como forma válida del default seguro,
		// igual que el precedente `force` (P20b). Lo que NO se acepta es un valor
		// no-bool relayado crudo.
		raw, presente := cmd.Params["settle"]
		got := false
		if presente {
			b, esBool := raw.(bool)
			if !esBool {
				t.Fatalf("%s: `settle` se relayó CRUDO (%T %v) en vez de type-assertado a bool (§2.5/P16)", c.nombre, raw, raw)
			}
			got = b
		}
		if got != c.quiero {
			t.Fatalf("%s: settle en el wire = %v (presente=%v), want %v", c.nombre, got, presente, c.quiero)
		}
	}
}
