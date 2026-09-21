// Package mcp tests — fb-020-004 (sub-fase RED).
//
// Deriva de §2.1 y §3 (P1, P2, P3, P4, P14) del spec: `vlp_act` y
// `vlp_fill` rechazan argumentos que no están en las `properties` de su
// InputSchema (error de tool que nombra los desconocidos, sin enviar nada a la
// extensión), `act` type/select exige `value` string presente (`value:""` es
// válido, D-12) y las descripciones de tools/list documentan el contrato.
//
// Archivo NUEVO a propósito (AC-1): ningún test existente se modifica.
//
// "Error de tool": se acepta tanto el `error` JSON-RPC (convención actual de
// act: -32000) como un `result.isError:true`; el test no fija cuál ni la
// redacción, sólo los términos que el spec exige nombrar.
package mcp

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// fb004ToolError devuelve (texto del error, true) si la respuesta de
// tools/call es un error de tool (JSON-RPC `error` o `result.isError`).
func fb004ToolError(resp map[string]any) (string, bool) {
	if e, ok := resp["error"]; ok {
		if em, isMap := e.(map[string]any); isMap {
			return fmt.Sprintf("%v %v", em["message"], em["data"]), true
		}
		return fmt.Sprint(e), true
	}
	res, _ := resp["result"].(map[string]any)
	if isErr, _ := res["isError"].(bool); isErr {
		var b strings.Builder
		content, _ := res["content"].([]any)
		for _, c := range content {
			cm, _ := c.(map[string]any)
			if s, ok := cm["text"].(string); ok {
				b.WriteString(s)
				b.WriteString(" ")
			}
		}
		return b.String(), true
	}
	return "", false
}

// fb004NamesWord: el texto nombra `word` como palabra (no como sub-cadena de
// otra, p.ej. "text" dentro de "context").
func fb004NamesWord(text, word string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`).MatchString(text)
}

// P1 (§2.1): act type con `text` en vez de `value` → error de tool que nombra
// `text` y menciona `value`; el hub no recibe el comando.
func TestPostcondition1_ActUnknownArgTextRejected(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>input", "action": "type", "text": "x",
	})
	msg, isErr := fb004ToolError(resp)
	if !isErr {
		t.Fatalf("P1: act type con `text` (argumento desconocido) debe dar error de tool; got %v", resp)
	}
	if !fb004NamesWord(msg, "text") {
		t.Errorf("P1: el error debe nombrar el argumento desconocido `text`: %q", msg)
	}
	if !fb004NamesWord(msg, "value") {
		t.Errorf("P1: el error debe mencionar `value` (lista de aceptados): %q", msg)
	}
	if calls := hub.commandCalls(); len(calls) != 0 {
		t.Errorf("P1: el hub NO debe recibir el comando; recibió %v", calls)
	}
}

// P2 (§2.1): act type/select sin `value`, o con `value` no string → error que
// nombra `value`; el hub no recibe el comando.
func TestPostcondition2_ActTypeSelectRequireStringValue(t *testing.T) {
	type caso struct {
		nombre string
		args   map[string]any
	}
	var casos []caso
	for _, action := range []string{"type", "select"} {
		base := func() map[string]any {
			return map[string]any{"tabId": float64(7), "ref": "main>input", "action": action}
		}
		sin := base()
		casos = append(casos, caso{action + " sin value", sin})
		for _, v := range []struct {
			n string
			v any
		}{{"número", float64(1)}, {"bool", true}, {"null", nil}, {"objeto", map[string]any{"a": "b"}}} {
			a := base()
			a["value"] = v.v
			casos = append(casos, caso{action + " con value " + v.n, a})
		}
	}

	for _, c := range casos {
		s, hub := newTools(t)
		resp := callTool(s, "vlp_act", c.args)
		msg, isErr := fb004ToolError(resp)
		if !isErr {
			t.Errorf("P2 (%s): debe dar error de tool; got %v", c.nombre, resp)
			continue
		}
		if !fb004NamesWord(msg, "value") {
			t.Errorf("P2 (%s): el error debe nombrar `value`: %q", c.nombre, msg)
		}
		if calls := hub.commandCalls(); len(calls) != 0 {
			t.Errorf("P2 (%s): el hub NO debe recibir el comando; recibió %v", c.nombre, calls)
		}
	}
}

// P3 (§2.1, D-12 de fb-020-002): act type con `value:""` presente se relaya al
// hub con `value:""`. Guardián: la validación nueva no puede tratar "" como
// ausente.
func TestPostcondition3_ActTypeEmptyValueRelayed(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>input", "action": "type", "value": "",
	})
	if msg, isErr := fb004ToolError(resp); isErr {
		t.Fatalf("P3: act type con value:\"\" debe relayarse, no fallar: %q", msg)
	}
	_, cmd := hub.lastCall()
	if cmd.Command != "act" {
		t.Fatalf("P3: el hub debe recibir `act`; command=%q", cmd.Command)
	}
	raw, ok := cmd.Params["value"]
	if !ok {
		t.Fatalf("P3: Params sin `value`; debe relayarse value:\"\" (D-12)")
	}
	if v, isStr := raw.(string); !isStr || v != "" {
		t.Fatalf("P3: Params.value = %T %v, want string vacío", raw, raw)
	}
}

// P4 (§2.1): fill con un argumento desconocido → error que lo nombra; el hub
// no recibe el comando.
func TestPostcondition4_FillUnknownArgRejected(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_fill", map[string]any{
		"tabId": float64(7), "selector": "#a", "value": "v", "frobnicar": "x",
	})
	msg, isErr := fb004ToolError(resp)
	if !isErr {
		t.Fatalf("P4: fill con argumento desconocido `frobnicar` debe dar error de tool; got %v", resp)
	}
	if !fb004NamesWord(msg, "frobnicar") {
		t.Errorf("P4: el error debe nombrar el argumento desconocido `frobnicar`: %q", msg)
	}
	if calls := hub.commandCalls(); len(calls) != 0 {
		t.Errorf("P4: el hub NO debe recibir el comando; recibió %v", calls)
	}
}

// P14 (§3): descripciones de tools/list. Anclas: literales de wire
// (`value`, `invalid`, `invalidCount`, `notFound`, `invalidSelector`,
// case-sensitive) y, para "los desconocidos se rechazan", grupos de sinónimos
// ES/EN vía hasConcept.
func TestPostcondition14_Descriptions(t *testing.T) {
	s, _ := newTools(t)
	actDesc, _ := actTool(t, s)
	fillDesc, _ := fillTool(t, s)
	getFrameDesc, _ := getFrameTool(t, s)

	// Hoy pasa de forma vacua (la Description ya contiene "value", "type" y
	// "select" por la observación de type): no aporta al RED, queda como
	// guardián de regresión. La cláusula "value como parámetro de texto" la
	// fuerza de hecho P1 (el error lista `value` como aceptado).
	t.Run("act nombra value como parámetro de type/select", func(t *testing.T) {
		if !fb004NamesWord(actDesc, "value") {
			t.Errorf("P14: la Description de vlp_act no nombra `value`: %q", actDesc)
		}
		if !(fb004NamesWord(actDesc, "type") && fb004NamesWord(actDesc, "select")) {
			t.Errorf("P14: la Description de vlp_act debe ligar `value` a type/select: %q", actDesc)
		}
	})
	t.Run("act dice que los parámetros desconocidos se rechazan", func(t *testing.T) {
		if !hasConcept(actDesc,
			[]string{"unknown", "desconocid", "unrecognized", "not in the schema", "undeclared"},
			[]string{"reject", "rechaz", "error"}) {
			t.Errorf("P14: la Description de vlp_act no dice que los parámetros desconocidos se rechazan: %q", actDesc)
		}
	})
	t.Run("getFrame documenta invalid e invalidCount", func(t *testing.T) {
		if !fb004NamesWord(getFrameDesc, "invalid") {
			t.Errorf("P14: la Description de vlp_getFrame no documenta la clave `invalid`: %q", getFrameDesc)
		}
		if !strings.Contains(getFrameDesc, "invalidCount") {
			t.Errorf("P14: la Description de vlp_getFrame no documenta `invalidCount`: %q", getFrameDesc)
		}
	})
	t.Run("fill documenta notFound e invalidSelector", func(t *testing.T) {
		if !strings.Contains(fillDesc, "notFound") {
			t.Errorf("P14: la Description de vlp_fill no documenta `notFound`: %q", fillDesc)
		}
		if !strings.Contains(fillDesc, "invalidSelector") {
			t.Errorf("P14: la Description de vlp_fill no documenta `invalidSelector`: %q", fillDesc)
		}
	})
}
