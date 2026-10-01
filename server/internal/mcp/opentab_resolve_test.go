// Package mcp — fb-024-opentab-id, stage 3 RED (opentab_resolve_test.go).
//
// Sources: docs/specs/fb-024-opentab-id/spec.md §3 (D-1, D-2, D-5 + Enmienda 1)
// y docs/specs/fb-024-opentab-id/test-audit.md §3/§4 (seeds y guardas P1–P4).
//
// Contrato bajo test: vlp_openTab(url) devuelve el id de la pestaña que
// efectivamente carga la URL, resuelto DESPUÉS del create con snapshots
// listTabs (before/post; id ∉ before) — nunca el id crudo de
// browser.tabs.create (Firefox real lo desfasa +1). Si la resolución no
// ocurre dentro de T ⇒ raw + idUnresolved:true (D-2: flag, jamás error, y
// jamás un id no verificado sin marcar — I-3).
//
// RED discipline (AP-13): un test por postcondition numerada del spec —
//   P1 TestOpenTabResolve_Exact
//   P2 TestOpenTabResolve_NewBeatsPreexistingURL  (caso 324/326 medido)
//   P3 TestOpenTabResolve_TimeoutUnresolved
//   P4 TestOpenTabResolve_SingleNewRedirect (+ espejo negativo |nuevos|==2
//      y desempate por menor id de la Enmienda 1 — desdoblamiento de D-5,
//      sub-tests en el mismo test según test-audit §3/§4)
//
// Todos los tests invocan la tool por la superficie MCP completa
// (tools/call "vlp_openTab"), así que GREEN debe cablear el resolver EN el
// handler, no solo definirlo. Hoy (RED) el handler devuelve el raw del
// openTab — por eso cada test falla por aserción contra el id crudo, no por
// compilación (el wire existe; la resolución no).
package mcp

import (
	"encoding/json"
	"reflect"
	"testing"
)

// fb024OpenTabFast inyecta el intervalo/plazo del resolver en tiempo de test
// (spec In/5, test-audit §3 transversal): intervalo 1 ms, plazo 15 ms ⇒ los
// timeouts de P3/P4 agotan en ≈15 polls × 1 ms — cero sleeps reales. Restaura
// los defaults de producción (150/5000, D-1/Q1) al salir.
func fb024OpenTabFast(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { openTabPollIntervalMs, openTabTimeoutMs = 150, 5000 })
	openTabPollIntervalMs = 1
	openTabTimeoutMs = 15
}

// fb024tab construye una fila de listTabs (shape wire del handler de la
// extensión, background.js:1273-1280): {id, url, ...}.
func fb024tab(id float64, url string) map[string]any {
	return map[string]any{"id": id, "url": url}
}

// fb024OpenTabResult llama tools/call vlp_openTab(url="http://x") contra s y
// devuelve el objeto JSON decodificado de content[0] (mismo oráculo que pina
// el golden). Un envelope MCP de error es por sí mismo un fallo de aserción:
// D-2 fija la degradación honesta como FLAG (idUnresolved:true), no error.
func fb024OpenTabResult(t *testing.T, s *Server) map[string]any {
	t.Helper()
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": "vlp_openTab", "arguments": map[string]any{"url": "http://x"}},
	}, "tok1")
	m, ok := resp.(map[string]any)
	if !ok {
		t.Fatalf("fb-024 opentab: respuesta inesperada %T — %v", resp, resp)
	}
	if errVal, hasErr := m["error"]; hasErr {
		t.Fatalf("fb-024 opentab: D-2 fija la degradación como flag (idUnresolved:true), no como error MCP — got %v", errVal)
	}
	res, ok := m["result"].(map[string]any)
	if !ok {
		t.Fatalf("fb-024 opentab: result no es objeto — %T", m["result"])
	}
	arr, ok := res["content"].([]any)
	if !ok || len(arr) == 0 {
		t.Fatalf("fb-024 opentab: content vacío — %v", res["content"])
	}
	part, ok := arr[0].(map[string]any)
	if !ok || part["type"] != "text" {
		t.Fatalf("fb-024 opentab: content[0] no es text part — %v", arr[0])
	}
	text, _ := part["text"].(string)
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("fb-024 opentab: content text no es JSON: %q (%v)", text, err)
	}
	return out
}

// P1 — TestOpenTabResolve_Exact (spec D-1 exacto; test-audit §3 P1).
//
// Seed: before=[320 about:blank] (tab distinto de la URL pedida ⇒ el tab
// nuevo 326 DEBE pasar por la lógica id ∉ before); post=[320, 326(http://x)];
// openTab→{id:325} (id crudo NO confiable). RED hoy: el handler devuelve el
// raw 325 ⇒ aserción; una impl que devuelva ciegamente el último tab del
// poll caería en 320; una que ignore la resolución cae en 325.
func TestOpenTabResolve_Exact(t *testing.T) {
	fb024OpenTabFast(t)
	s, hub := newTools(t)
	hub.seqByCommand = map[string][]any{
		"listTabs": {
			[]any{fb024tab(320, "about:blank")},
			[]any{fb024tab(320, "about:blank"), fb024tab(326, "http://x")},
		},
		"openTab": {map[string]any{"id": float64(325)}},
	}
	res := fb024OpenTabResult(t, s)
	if res["id"] != float64(326) {
		t.Fatalf("fb-024 P1 (exact): vlp_openTab result = %v, want id==326 — el tab NUEVO (id ∉ before={320}) que carga http://x; hoy devuelto el id crudo 325 de openTab (desfasado +1 en Firefox real) — RED fb-024-opentab-id", res)
	}
	if res["url"] != "http://x" {
		t.Errorf("fb-024 P1 (exact): result.url = %v, want %q (el tab resuelto es el que sirve la URL)", res["url"], "http://x")
	}
}

// P2 — TestOpenTabResolve_NewBeatsPreexistingURL (spec D-1 `id ∉ before`;
// test-audit §3 P2, caso 324/326 medido en campo).
//
// Seed: before YA contiene 324 con http://x (la MISMA URL pedida); post =
// [324, 326]. Guarda del snapshot-before: una impl que ignore `before` y
// matchee por URL en cualquier poll devolvería 324 (verde-falso de
// "resolución"); la aserción pincha el triple: id==326 && id!=324 (y el raw
// 325 también cae). RED hoy: el handler devuelve 325.
func TestOpenTabResolve_NewBeatsPreexistingURL(t *testing.T) {
	fb024OpenTabFast(t)
	s, hub := newTools(t)
	hub.seqByCommand = map[string][]any{
		"listTabs": {
			[]any{fb024tab(324, "http://x")},
			[]any{fb024tab(324, "http://x"), fb024tab(326, "http://x")},
		},
		"openTab": {map[string]any{"id": float64(325)}},
	}
	res := fb024OpenTabResult(t, s)
	if res["id"] != float64(326) || res["id"] == float64(324) {
		t.Fatalf("fb-024 P2 (nuevo > preexistente): result = %v, want id==326 (el tab nuevo, id ∉ before) y explícitamente ≠324 (preexistente con la misma URL) y ≠325 (crudo) — RED fb-024-opentab-id", res)
	}
}

// P3 — TestOpenTabResolve_TimeoutUnresolved (spec D-2; I-3; test-audit §3 P3).
//
// Seed: before=[] y CADA poll devuelve [] (seq FIFO sticky), T inyectado
// vence; openTab→{id:325,url:"http://x"}. RED hoy: el handler devuelve el raw
// SIN marcar ⇒ la aserción del mapa exacto pincha. Guardas del flag honesto:
// idUnresolved==true && id==325 (el id crudo REAL — no 0, no nil, no el id de
// un poll) y que NO se haya sumado idUnresolved:false. D-2: flag, no error —
// un error MCP ya falla en el helper.
func TestOpenTabResolve_TimeoutUnresolved(t *testing.T) {
	fb024OpenTabFast(t)
	s, hub := newTools(t)
	hub.seqByCommand = map[string][]any{
		"listTabs": {[]any{}}, // sticky: before y todos los polls devuelven []
		"openTab":  {map[string]any{"id": float64(325), "url": "http://x"}},
	}
	res := fb024OpenTabResult(t, s)
	want := map[string]any{"id": float64(325), "url": "http://x", "idUnresolved": true}
	if !reflect.DeepEqual(res, want) {
		t.Fatalf("fb-024 P3 (timeout): result = %v, want EXACTAMENTE el raw %+v más idUnresolved:true (I-3: jamás un id no verificado sin marcar; ni id 0/nil ni idUnresolved:false) — RED fb-024-opentab-id", res, want)
	}
}

// P4 — TestOpenTabResolve_SingleNewRedirect (spec D-1/D-5 fallback
// "un solo tab nuevo"; test-audit §3 P4).
//
// Tres sub-tests (desdoblamiento de D-5 — Enmienda 1; test-audit):
//   1. redirect real: el ÚNICO tab nuevo tiene URL distinta (la pedida ya no
//      matchea por exacto ni prefijo) ⇒ se devuelve ese.
//   2. espejo negativo (I-3): DOS tabs nuevos sin match ⇒ idUnresolved:true
//      con el raw — NO se elige arbitrariamente ("el primer nuevo" violaría
//      D-5: |nuevos|==1 es condición necesaria, no suficiente).
//   3. desempate de la Enmienda 1: dos tabs nuevos AMBOS con match exacto ⇒
//      el de MENOR id, determinista (sembrados en orden inverso para
//      distinguir menor-id de primero-en-orden).
func TestOpenTabResolve_SingleNewRedirect(t *testing.T) {
	fb024OpenTabFast(t)

	t.Run("redirect: unico tab nuevo con URL distinta", func(t *testing.T) {
		s, hub := newTools(t)
		hub.seqByCommand = map[string][]any{
			"listTabs": {
				[]any{},
				[]any{fb024tab(329, "https://odoo.example/login")}, // redirect real: ≠ asked, sin prefijo
			},
			"openTab": {map[string]any{"id": float64(325)}},
		}
		res := fb024OpenTabResult(t, s)
		if res["id"] != float64(329) {
			t.Fatalf("fb-024 P4 (redirect): result = %v, want id==329 — |nuevos|==1 y su URL (https://odoo.example/login) no matchea http://x por exacto ni prefijo ⇒ fallback redirect devuelve ESE tab, no el crudo 325 — RED fb-024-opentab-id", res)
		}
	})

	t.Run("espejo negativo: dos nuevos sin match -> idUnresolved (I-3/D-5)", func(t *testing.T) {
		s, hub := newTools(t)
		hub.seqByCommand = map[string][]any{
			"listTabs": {
				[]any{},
				[]any{fb024tab(329, "https://odoo.example/login"), fb024tab(330, "https://other.example/")},
			},
			"openTab": {map[string]any{"id": float64(325), "url": "http://x"}},
		}
		res := fb024OpenTabResult(t, s)
		if res["id"] == float64(329) || res["id"] == float64(330) {
			t.Fatalf("fb-024 P4 (espejo negativo): result = %v — elección arbitraria de un tab nuevo sin match de URL con |nuevos|==2 (D-5 exige |nuevos|==1), want raw 325 + idUnresolved:true — RED fb-024-opentab-id", res)
		}
		want := map[string]any{"id": float64(325), "url": "http://x", "idUnresolved": true}
		if !reflect.DeepEqual(res, want) {
			t.Fatalf("fb-024 P4 (espejo negativo): result = %v, want EXACTAMENTE raw + idUnresolved:true (I-3) — RED", res)
		}
	})

	t.Run("Enmienda 1: empate de dos nuevos con match exacto -> menor id", func(t *testing.T) {
		s, hub := newTools(t)
		hub.seqByCommand = map[string][]any{
			"listTabs": {
				[]any{fb024tab(320, "about:blank")},
				// en orden inverso a propósito: descarta "primero en el orden"
				[]any{fb024tab(331, "http://x"), fb024tab(330, "http://x")},
			},
			"openTab": {map[string]any{"id": float64(325)}},
		}
		res := fb024OpenTabResult(t, s)
		if res["id"] != float64(330) {
			t.Fatalf("fb-024 P4 (Enmienda 1, D-5): result = %v, want id==330 — dos tabs nuevos con match exacto de http://x ⇒ desempate determinista por MENOR id (no primero-en-orden ni crudo 325) — RED fb-024-opentab-id", res)
		}
	})
}
