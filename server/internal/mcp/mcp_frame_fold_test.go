// Package mcp tests — fb-020-008-act-frame-fold (sub-fase RED). P1–P5.
//
// Deriva de §2.1/§2.1.1/§2.1.3/§2.8/§2.9 y §3 (P1–P5) del spec
// docs/specs/fb-020-008-act-frame-fold/spec.md: `vlp_act` y
// `vlp_navigate` declaran el parámetro opcional `frame` (objeto), el
// handler valida las claves DENTRO de `frame` contra el vocabulario de §2.1.1
// (8 claves) y rechaza las desconocidas nombrándolas sin despachar nada,
// type-assertea `frame` a objeto (no-objeto ⇒ clave ausente) y relaya las
// claves presentes verbatim. Sin `frame`, el wire es idéntico al vigente.
//
// Archivo NUEVO a propósito: ningún test existente se modifica (§6 del spec,
// P4/P20, AC-5). Se REUSAN del package los helpers de tests vigentes:
// newTools/callTool/hub.lastCall/hub.commandCalls (mcp_tools_test.go,
// mcp_frame_api_test.go), fb004ToolError/fb004NamesWord (mcp_field_case_test.go)
// y schemaProps (mcp_frame_payload_test.go). El guardián de conteo de tools
// (want 34) no se toca; acá se re-afirma como precondición local para que el
// implementer no pueda satisfacer P1 registrando una tool nueva (patrón
// TestAct_InputSchemaHasForce / TestGetFrame_InputSchemaHasSettleParams).
//
// ── Estado esperado en RED (declarado, no descubierto) ──────────────────────
//   · P1 ROJO: hoy el InputSchema no declara `frame` y `rejectUnknownArgs`
//     rechaza el request entero.
//   · P2 ROJO por la razón correcta SOLO porque se assertea el nombre de la
//     clave INTERIOR: hoy el rechazo existe pero nombra `frame` (el nivel
//     superior), no `maxElements`. Un test que solo pidiera "es error y 0
//     comandos" sería VERDE VACUO hoy y no probaría nada del objetivo del
//     ciclo (§2.1.3: es el modo de falla que vuelve inútil a la feature).
//   · P3 ROJO: hoy un `frame:"x"` es argumento desconocido ⇒ error, en vez de
//     degradar a clave ausente y despachar igual.
//   · P5 ROJO por arrastre del schema: el relay verbatim en sí ya existe
//     (§2.9/PC4, sin enmienda), pero hoy el request `frame:{}` ni llega al hub
//     porque `act` lo rechaza. Cuando GREEN declare `frame`, este test pasa a
//     ser el guardián del relay aditivo de `frame`/`frameError`.
//   · P4 VERDE HOY, a propósito: es un GUARDIÁN DE NO-REGRESIÓN (AC-5, I-2 —
//     el camino sin `frame` no cambia un byte). Se declara verde acá con el
//     mismo criterio explícito que TestPostcondition14_Descriptions de
//     mcp_field_case_test.go ("hoy pasa de forma vacua… queda como guardián de
//     regresión"): no aporta al rojo, aporta a que GREEN no rompa el camino
//     vigente.
//
// Hallazgo medido en RED (no está en el spec): `vlp_navigate` NO pasa
// hoy por `rejectUnknownArgs` — acepta `frame` (y cualquier clave desconocida)
// en silencio y no lo relaya. Por eso P2 en navigate falla hoy como "no hubo
// error en absoluto" en vez de "el error no nombra la clave interior": el
// rechazo de §2.1.3 en `navigate` hay que construirlo, no extenderlo.
package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// fb008Tool devuelve (Description, InputSchema) de una tool por nombre.
// Helper propio (no colisiona con actTool/getFrameTool/fillTool vigentes)
// porque P1 exige verificar las DOS tools del pliegue con el mismo código.
func fb008Tool(t *testing.T, s *Server, name string) (string, map[string]any) {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == name {
			return tl.Description, tl.InputSchema
		}
	}
	t.Fatalf("falta la tool %s", name)
	return "", nil
}

// fb008ArgsBase: los argumentos mínimos vigentes de cada tool del pliegue.
func fb008ArgsBase(tool string) map[string]any {
	switch tool {
	case "vlp_act":
		return map[string]any{"tabId": float64(7), "ref": "main>button", "action": "click"}
	case "vlp_navigate":
		return map[string]any{"tabId": float64(7), "url": "http://x"}
	}
	return map[string]any{}
}

var fb008Tools = []string{"vlp_act", "vlp_navigate"}

// fb008FrameCompleto: las 8 claves de §2.1.1 con los valores de P1.
func fb008FrameCompleto() map[string]any {
	return map[string]any{
		"page":               float64(2),
		"maxElementsPerPage": float64(50),
		"roles":              []any{"textbox"},
		"namedOnly":          true,
		"settle":             true,
		"waitMs":             float64(3000),
		"quietMs":            float64(200),
		"include":            "both",
	}
}

// P1 (§2.1/§2.8) — parte A: las dos tools declaran `frame` como objeto
// opcional en su InputSchema (sin declararlo, `rejectUnknownArgs` rechaza el
// request y no se despacha nada, §2.8), sin perder los parámetros vigentes y
// sin agregar tools (el conteo sigue en 34, §1.4 del precedente).
func TestPostcondition1_FrameDeclaredInSchemas(t *testing.T) {
	s, _ := newTools(t)

	// El conteo ANTES del schema: un fallo de schema no debe ocultar una tool
	// agregada de más (patrón P20 de fb-018-004).
	names := map[string]bool{}
	for _, tl := range s.ListTools() {
		names[tl.Name] = true
	}
	if len(names) != 33 {
		t.Fatalf("P1: el conteo de tools debe seguir en 33 (fb-022: 21 vlp_* + 12 odoo; el pliegue no agrega tools); got %d", len(names))
	}

	// Guarda de no-vacuidad por tool: los parámetros vigentes siguen declarados
	// (si el schema los perdiera, la aserción sobre `frame` no diría nada sobre
	// una extensión retrocompatible).
	previos := map[string][]string{
		"vlp_act":      {"tabId", "ref", "action"},
		"vlp_navigate": {"tabId", "url"},
	}
	for _, tool := range fb008Tools {
		_, schema := fb008Tool(t, s, tool)
		props := schemaProps(t, schema)
		for _, prev := range previos[tool] {
			if _, ok := props[prev]; !ok {
				t.Fatalf("precondición (%s): el InputSchema debe seguir declarando %q; properties=%v", tool, prev, props)
			}
		}
		raw, ok := props["frame"]
		if !ok {
			t.Fatalf("P1 (%s): el InputSchema no declara el parámetro `frame` (§2.1/§2.8); properties=%v", tool, props)
		}
		obj, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("P1 (%s): la propiedad `frame` no es un objeto de schema: %T (%v)", tool, raw, raw)
		}
		if obj["type"] != "object" {
			t.Fatalf("P1 (%s): `frame` debe declararse como object (§2.1: el objeto ES el switch del opt-in); type=%v", tool, obj["type"])
		}
		// `frame` es opcional (default ausente, §2.1). Comparación sobre la
		// forma stringificada a propósito: un type-assert a []string sería un
		// no-op silencioso si el schema usa []any.
		if rawReq, ok := schema["required"]; ok {
			if strings.Contains(fmt.Sprint(rawReq), "frame") {
				t.Fatalf("P1 (%s): `frame` es opcional (default ausente, §2.1), no puede figurar en required: %v", tool, rawReq)
			}
		}
	}
}

// P1 (§2.1.3) — parte B: con las 8 claves de §2.1.1, el request NO es
// rechazado y el hub recibe el command vigente con `Params.frame` llevando las
// 8 claves VERBATIM (valor Y tipo, no solo la clave — lección de
// TestGetFrame_ForwardsPayloadParams). Los defaults viven en la extensión
// (§2.1.3), así que el handler no puede inventar ni normalizar nada.
func TestPostcondition1_FrameRelayedVerbatim(t *testing.T) {
	comandoDe := map[string]string{"vlp_act": "act", "vlp_navigate": "navigate"}

	for _, tool := range fb008Tools {
		s, hub := newTools(t)
		args := fb008ArgsBase(tool)
		args["frame"] = fb008FrameCompleto()
		resp := callTool(s, tool, args)
		if msg, isErr := fb004ToolError(resp); isErr {
			t.Fatalf("P1 (%s): el request con `frame` completo NO debe ser rechazado: %q", tool, msg)
		}
		_, cmd := hub.lastCall()
		if cmd.Command != comandoDe[tool] {
			t.Fatalf("P1 (%s): command = %q, want %q", tool, cmd.Command, comandoDe[tool])
		}
		raw, ok := cmd.Params["frame"]
		if !ok {
			t.Fatalf("P1 (%s): Params sin `frame` — las claves presentes se relayan verbatim (§2.1.3); Params=%v", tool, cmd.Params)
		}
		got, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("P1 (%s): Params.frame no es un objeto: %T %v", tool, raw, raw)
		}
		want := fb008FrameCompleto()
		if len(got) != len(want) {
			t.Fatalf("P1 (%s): Params.frame tiene %d claves, want las 8 de §2.1.1 verbatim; got=%v", tool, len(got), got)
		}
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		if string(gotJSON) != string(wantJSON) {
			t.Fatalf("P1 (%s): Params.frame no es verbatim (§2.1.3: ni defaults ni normalización en el server)\n got=%s\nwant=%s",
				tool, gotJSON, wantJSON)
		}
	}
}

// P2 (§2.1.3, §9.1) — LA postcondición que salva el objetivo del ciclo.
// `rejectUnknownArgs` solo mira el nivel superior: una clave desconocida
// DENTRO de `frame` (p.ej. `maxElements` por `maxElementsPerPage`) ignorada en
// silencio devolvería la página 1 SIN FILTRAR y la feature no entrega nada.
//
// Se assertea (a) que es error de tool, (b) que el error NOMBRA la clave
// interior desconocida, y (c) que el MockHub recibió 0 comandos (nada
// despachado). La aserción (b) es la que hace este test rojo por la razón
// correcta: hoy el rechazo existe pero nombra `frame`, no la clave interior.
//
// `omitIfUnchanged` está incluida a propósito: fue RETIRADA del contrato
// (§9.1/D-6), así que el contrato tiene que rechazarla explícitamente en vez
// de ignorarla en silencio.
func TestPostcondition2_UnknownKeyInsideFrameRejected(t *testing.T) {
	casos := []struct {
		nombre      string
		frame       map[string]any
		desconocida string
	}{
		{
			nombre:      "maxElements sola (typo de maxElementsPerPage)",
			frame:       map[string]any{"maxElements": float64(50)},
			desconocida: "maxElements",
		},
		{
			nombre: "maxElements junto a claves válidas",
			frame: map[string]any{
				"maxElements": float64(50), "roles": []any{"textbox"},
				"namedOnly": true, "settle": true,
			},
			desconocida: "maxElements",
		},
		{
			nombre:      "omitIfUnchanged (retirada del contrato, §9.1)",
			frame:       map[string]any{"omitIfUnchanged": true},
			desconocida: "omitIfUnchanged",
		},
		{
			nombre: "omitIfUnchanged junto al vocabulario completo válido",
			frame: func() map[string]any {
				f := fb008FrameCompleto()
				f["omitIfUnchanged"] = true
				return f
			}(),
			desconocida: "omitIfUnchanged",
		},
		{
			nombre:      "frobnicar (clave arbitraria)",
			frame:       map[string]any{"frobnicar": "x"},
			desconocida: "frobnicar",
		},
	}

	for _, tool := range fb008Tools {
		for _, c := range casos {
			s, hub := newTools(t)
			args := fb008ArgsBase(tool)
			args["frame"] = c.frame
			resp := callTool(s, tool, args)

			msg, isErr := fb004ToolError(resp)
			if !isErr {
				t.Errorf("P2 (%s / %s): una clave desconocida dentro de `frame` debe dar error de tool; got %v", tool, c.nombre, resp)
				continue
			}
			if !fb004NamesWord(msg, c.desconocida) {
				t.Errorf("P2 (%s / %s): el error debe NOMBRAR la clave interior desconocida %q "+
					"(nombrar solo `frame` deja al agente sin saber qué corregir, y un ignorado en silencio "+
					"devolvería la página 1 sin filtrar — §2.1.3): %q", tool, c.nombre, c.desconocida, msg)
			}
			if calls := hub.commandCalls(); len(calls) != 0 {
				t.Errorf("P2 (%s / %s): el hub NO debe recibir NINGÚN comando (rechazo antes del despacho, §2.1.3); recibió %v",
					tool, c.nombre, calls)
			}
		}
	}
}

// P3 (§2.1.3, precedentes `force` P20b y `settle` de fb-018-006): `frame` que
// no es objeto (string, número, array, null, bool) degrada a CLAVE AUSENTE —
// nunca se relaya crudo, nunca activa el pliegue — y el comando se despacha
// igual (la acción no se pierde por un parámetro mal tipeado).
func TestPostcondition3_NonObjectFrameDegradesToAbsent(t *testing.T) {
	entradas := []struct {
		nombre string
		valor  any
	}{
		{"string", "x"},
		{"número", float64(7)},
		{"array", []any{}},
		{"null", nil},
		{"bool true", true},
	}
	comandoDe := map[string]string{"vlp_act": "act", "vlp_navigate": "navigate"}

	for _, tool := range fb008Tools {
		for _, e := range entradas {
			s, hub := newTools(t)
			args := fb008ArgsBase(tool)
			args["frame"] = e.valor
			resp := callTool(s, tool, args)
			if msg, isErr := fb004ToolError(resp); isErr {
				t.Errorf("P3 (%s / frame %s): un `frame` no-objeto degrada a clave ausente, NO es error de tool (§2.1.3): %q",
					tool, e.nombre, msg)
				continue
			}
			calls := hub.commandCalls()
			if len(calls) != 1 || calls[0] != comandoDe[tool] {
				t.Errorf("P3 (%s / frame %s): el comando debe despacharse igual (sin pliegue); comandos=%v",
					tool, e.nombre, calls)
				continue
			}
			_, cmd := hub.lastCall()
			if raw, ok := cmd.Params["frame"]; ok {
				t.Errorf("P3 (%s / frame %s): Params lleva `frame` = %T %v — debe estar AUSENTE, ni en nil "+
					"(nunca se relaya crudo, nunca activa el pliegue, §2.1.3); Params=%v", tool, e.nombre, raw, raw, cmd.Params)
			}
		}
	}
}

// P4 (§2.1, I-2 — GUARDIÁN DE NO-REGRESIÓN, verde hoy y declarado como tal):
// sin `frame` en el request, los Params de las dos tools son los vigentes y no
// aparece ninguna clave `frame` (ni en nil). Es la mitad wire de "ningún agente
// existente ve un solo byte distinto" (AC-5).
func TestPostcondition4_NoFrameNoKeyInParams(t *testing.T) {
	comandoDe := map[string]string{"vlp_act": "act", "vlp_navigate": "navigate"}
	esperados := map[string][]string{
		"vlp_act":      {"ref", "action"},
		"vlp_navigate": {"url"},
	}

	for _, tool := range fb008Tools {
		s, hub := newTools(t)
		resp := callTool(s, tool, fb008ArgsBase(tool))
		if msg, isErr := fb004ToolError(resp); isErr {
			t.Fatalf("P4 (%s): el request vigente sin `frame` no puede fallar: %q", tool, msg)
		}
		_, cmd := hub.lastCall()
		if cmd.Command != comandoDe[tool] {
			t.Fatalf("P4 (%s): command = %q, want %q", tool, cmd.Command, comandoDe[tool])
		}
		if cmd.TabID != "7" {
			t.Fatalf("P4 (%s): TabID = %q, want 7", tool, cmd.TabID)
		}
		// Guarda de no-vacuidad: los params vigentes siguen viajando (si no, la
		// ausencia de `frame` no probaría retrocompatibilidad).
		for _, k := range esperados[tool] {
			if _, ok := cmd.Params[k]; !ok {
				t.Fatalf("precondición (%s): Params debe seguir llevando %q; Params=%v", tool, k, cmd.Params)
			}
		}
		if raw, ok := cmd.Params["frame"]; ok {
			t.Fatalf("P4 (%s): el request NO trajo `frame` pero Params lo lleva (%T %v) — ausente ⇒ ausencia TOTAL "+
				"(patrón P16 de fb-018-001/fb-018-006); Params=%v", tool, raw, raw, cmd.Params)
		}
	}
}

// P5 (§2.2/§2.9, PC4 de fb-017-002 — GUARDIÁN DE NO-REGRESIÓN, verde hoy y
// declarado como tal): el resultado del hub se relaya tal cual en el content
// JSON del result, incluidas las claves ADITIVAS `frame` y `frameError` que
// produce la extensión. El pliegue vive en la extensión; el server solo relaya.
func TestPostcondition5_RelaysFoldedFrameAndFrameError(t *testing.T) {
	frameResult := map[string]any{
		"ok": true,
		"frame": map[string]any{
			"sections": []any{map[string]any{"elements": []any{map[string]any{"ref": "main>button"}}}},
			"invalidation": map[string]any{
				"changedSinceLast": true, "settled": true, "waitedMs": float64(120),
			},
		},
	}
	errResult := map[string]any{
		"ok": true,
		"frameError": map[string]any{
			"error": "frame fold: serialization failed — the action completed; re-read with getFrame",
		},
	}

	relayado := func(t *testing.T, tool string, hubResult map[string]any) map[string]any {
		t.Helper()
		s, hub := newTools(t)
		hub.result = hubResult
		args := fb008ArgsBase(tool)
		args["frame"] = map[string]any{}
		resp := callTool(s, tool, args)
		if msg, isErr := fb004ToolError(resp); isErr {
			t.Fatalf("P5 (%s): relay → error inesperado: %q", tool, msg)
		}
		res := resp["result"].(map[string]any)
		text := res["content"].([]any)[0].(map[string]any)["text"].(string)
		var inner map[string]any
		if err := json.Unmarshal([]byte(text), &inner); err != nil {
			t.Fatalf("P5 (%s): el content no es JSON: %v — %q", tool, err, text)
		}
		return inner
	}

	for _, tool := range fb008Tools {
		inner := relayado(t, tool, frameResult)
		if inner["ok"] != true {
			t.Errorf("P5 (%s): la clave vigente `ok` debe relayarse; got %v", tool, inner["ok"])
		}
		frame, ok := inner["frame"].(map[string]any)
		if !ok {
			t.Fatalf("P5 (%s): el result debe relayar `frame` tal cual (PC4, §2.9); got %v", tool, inner["frame"])
		}
		inv, ok := frame["invalidation"].(map[string]any)
		if !ok {
			t.Fatalf("P5 (%s): `frame.invalidation` debe viajar tal cual; got %v", tool, frame["invalidation"])
		}
		if inv["changedSinceLast"] != true || inv["settled"] != true || inv["waitedMs"] != float64(120) {
			t.Errorf("P5 (%s): `frame.invalidation` relayado = %v, want {changedSinceLast:true, settled:true, waitedMs:120} verbatim", tool, inv)
		}
		if _, hay := frame["sections"]; !hay {
			t.Errorf("P5 (%s): `frame.sections` debe viajar tal cual; frame=%v", tool, frame)
		}

		innerErr := relayado(t, tool, errResult)
		fe, ok := innerErr["frameError"].(map[string]any)
		if !ok {
			t.Fatalf("P5 (%s): el result debe relayar `frameError` tal cual (§2.7); got %v", tool, innerErr["frameError"])
		}
		msg, _ := fe["error"].(string)
		if !strings.Contains(msg, "the action completed") || !strings.Contains(msg, "re-read with getFrame") {
			t.Errorf("P5 (%s): `frameError.error` relayado = %q, want el mensaje del hub verbatim", tool, msg)
		}
		if _, hay := innerErr["frame"]; hay {
			t.Errorf("P5 (%s): con `frameError` el result no puede inventar `frame` (I-3: exactamente una de las dos); got %v", tool, innerErr)
		}
	}
}
