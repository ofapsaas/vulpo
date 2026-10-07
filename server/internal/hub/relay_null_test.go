// fb-027-005-relay-null-contract — sub-fase RED (Etapa 3.1).
//
// Spec aprobado: docs/specs/fb-027-005-relay-null-contract/spec.md
//   §2.2 P4 (distinción null-presente vs ausencia), P5 (negativa).
//   ## Clarificación post-audit: P4(b) PINADA — un frame `response` SIN la
//   clave `result` es MALFORMADO ⇒ el hub rechaza el pendiente con un error
//   (`Command` devuelve err != nil, Opción A); NO lo resuelve como null y NO
//   lo deja colgado hasta el timeout.
// AUDIT aprobado: docs/specs/fb-027-005-relay-null-contract/test-audit.md
//   §4.1 (el RED real es 1: P4(b)), §4.3 (los 6 tests), aprobación final.
//
// Clasificación RED: P4(a) y P5 son PIN/guard — VERDES hoy (el hub resuelve
// `msg["result"]` = nil tanto para null presente como para ausente, y hoy
// ambos dan (nil, nil)). P4(b) es el ÚNICO RED GENUINO: hoy el hub colapsa
// "ausencia de result" con "result:null" (hub.go:392 `entry.resolve(msg["result"])`).
//
// Harness (hub_test.go + hub_command_budget_test.go, mismo paquete): newTestHub/
// register/fakeWS + waitFirstType + HandleMessage para el wire crudo;
// fb007Command/fb007Await para correr Command en goroutine. Ningún helper
// nuevo (audit E-2). El frame se envía como STRING crudo para controlar la
// PRESENCIA de la clave `result` (un map re-marshalado no podría omitirla).
package hub

import (
	"strings"
	"testing"
	"time"
)

// relayNullHub: hub con la extensión fake registrada (tok1).
func relayNullHub(t *testing.T) (*testHub, *fakeWS) {
	t.Helper()
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	return th, ws
}

// relayNullDispatch: corre un Command tabless (listTabs — sin validación de
// tab, patrón TestPending_Reject), espera el wire `command` y responde con el
// frame `response` que devuelva raw(id). Devuelve el desenlace del Command.
func relayNullDispatch(t *testing.T, th *testHub, ws *fakeWS, raw func(id string) string) cmdResult {
	t.Helper()
	done := fb007Command(th, Command{Command: "listTabs"})
	cmd := waitFirstType(t, ws, "command")
	if cmd == nil {
		t.Fatalf("el hub no despachó el wire `command`: %v", ws.messages())
	}
	id, _ := cmd["id"].(string)
	if id == "" {
		t.Fatalf("wire `command` sin id: %v", cmd)
	}
	th.h.HandleMessage(ws, []byte(raw(id)))
	return fb007Await(t, done, 2*time.Second, "relay-null")
}

// P4(a) (PIN) — `{"type":"response","id":X,"result":null}` → resuelve null
// (Command → (nil, nil)), sin error.
func TestRelayNull_P4_HubNullPresentResolvesNil(t *testing.T) {
	th, ws := relayNullHub(t)
	r := relayNullDispatch(t, th, ws, func(id string) string {
		return `{"type":"response","id":"` + id + `","result":null}`
	})
	if r.err != nil {
		t.Fatalf("P4(a): response con result:null devolvió err = %v, want nil (null es un resultado, no error)", r.err)
	}
	if r.res != nil {
		t.Fatalf("P4(a): response con result:null resolvió res = %v (%T), want nil", r.res, r.res)
	}
}

// P4(b) — EL RED GENUINO. Un frame `response` SIN la clave `result` es
// MALFORMADO (un handler conforme, con P6, SIEMPRE manda `result`) ⇒ el hub
// debe RECHAZAR el pendiente con un error, NO colapsarlo con null.
func TestRelayNull_P4b_HubAbsentResultNotCollapsedToNull(t *testing.T) {
	th, ws := relayNullHub(t)
	r := relayNullDispatch(t, th, ws, func(id string) string {
		return `{"type":"response","id":"` + id + `"}` // SIN la clave `result`
	})
	if r.err == nil {
		t.Fatalf("P4(b): response SIN `result` resolvió res=%v con err=nil — el hub colapsó la AUSENCIA con null (hub.go:392); want rechazo con err != nil (Opción A)", r.res)
	}
	// Distingue Opción A (rechazo inmediato) de Opción B (ignorar el frame →
	// queda pendiente hasta el timeout): el error NO debe ser command_timeout.
	if strings.HasPrefix(r.err.Error(), "command_timeout:") {
		t.Fatalf("P4(b): response SIN `result` quedó colgado hasta el timeout (%v) — want rechazo inmediato (Opción A), no la Opción B (ignorar el frame)", r.err)
	}
}

// P5 (GUARD negativo) — un response con `"result":null` JAMÁS se trata como
// ausencia ni como error: resuelve (nil, nil) y el pendiente se consume.
func TestRelayNull_P5_NullNeverTreatedAsError(t *testing.T) {
	th, ws := relayNullHub(t)
	r := relayNullDispatch(t, th, ws, func(id string) string {
		return `{"type":"response","id":"` + id + `","result":null}`
	})
	if r.err != nil {
		t.Fatalf("P5: un response con result:null se trató como error: %v — null NUNCA es ausencia ni error", r.err)
	}
	if r.res != nil {
		t.Fatalf("P5: response con result:null resolvió res = %v (%T), want nil", r.res, r.res)
	}
	if n := len(th.h.pending); n != 0 {
		t.Fatalf("P5: quedan %d pendientes tras resolver result:null, want 0 (el null consumió el pendiente)", n)
	}
}
