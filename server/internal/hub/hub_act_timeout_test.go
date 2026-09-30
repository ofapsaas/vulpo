// fb-024-act-timeout-techo — sub-fase RED (docs/specs/fb-024-act-timeout-techo/spec.md §3.2, P1–P4).
//
// Este archivo agrega casos sobre `act`/comandos de página al contrato de
// presupuesto del hub ya pinneado en hub_command_budget_test.go (fb-020-007).
// Nada de los tests existentes se modifica; las aserciones van sobre el borde
// observable (texto del error, tiempos, wire), nunca sobre estructura interna.
//
// Contrato (spec D-2/D-3/D-4, §3.1):
//   - D-3: el plazo informado es el que venció — `within <N> ms` con
//     N = idle + espera declarada del comando (act/fill/getFrame/
//     waitForElement/navigate declaran; el resto suma 0), y N = idle tras un
//     latido.
//   - D-4: los comandos de PÁGINA (TabID != "" y Command sin prefijo `odoo`)
//     terminan con el sufijo accionable del diálogo nativo; los comandos
//     `odoo*` conservan el texto byte-idéntico (I-2).
package hub

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

const (
	actPrefix       = "command_timeout:"
	actDispatchNote = "the command may have been dispatched"
)

// pageDialogHint es el sufijo exacto de D-4 (spec §3.1, l.76), con <T> ya
// resuelto a 24 (el ÚNICO tab de estos tests). Contrato textual literal.
const actTimeoutPageDialogHint = "; the page may be showing a native dialog (confirm/alert/prompt) waiting for a human in tab 24: ask the human to answer it, then re-read the page with vlp_getFrame before retrying (the action may have run); vlp_navigate and vlp_closeTab dismiss the dialog without an answer, use them only if the human agrees"

// ormLiteral es el literal byte-idéntico que P4 exige para los comandos
// odoo* (I-2): el error del hub para un ORM SIN espera declarada y SIN
// latidos es exactamente este string — sin pista de página, sin recorte.
func ormLiteral(cmd string) string {
	return fmt.Sprintf("%s no answer or heartbeat from the extension for %s on tab 24 within 100 ms; %s", actPrefix, cmd, actDispatchNote)
}

// actTimeoutMM ss es el `act` tipo `type` del caso original (spec P1): el
// plazo del hub es idle + waitMs(200) → devuelve error con prefijo
// command_timeout: dentro de [400, 700) ms; elapsed ≥ 400 ms (la espera
// declarada cuenta) es la guarda de no-vacuidad, y después NO queda pending
// (un response tardío con ese id se descarta sin efecto — I-6).
func TestFb024_P1_ActDeclaresWaitTimesOut(t *testing.T) {
	const (
		idle = 100 * time.Millisecond
		wait = 200 * time.Millisecond
		// margen de scheduling: el techo del error está en [idle+wait, idle+wait+margen)
		margin = 400 * time.Millisecond
	)
	th, ws := fb007Hub(t, idle)

	r := fb007Await(t, fb007Command(th, Command{
		Command: "act",
		Params: map[string]any{
			"action": "type",
			"waitMs": float64(200),
			"frame":  map[string]any{"waitMs": float64(50)},
		},
		TabID: "24",
	}), 2*time.Second, "P1")

	// Guarda de no-vacuidad: elapsed ≥ idle+wait (la espera declarada debe
	// contar; sin ella una impl que ignorara waitMs dejaría esta P en verde).
	if r.elapsed < idle+wait {
		t.Fatalf("P1: act declaró waitMs=200 y venció a %v (< %v): la espera declarada NO se suma al plazo (D-3)", r.elapsed, idle+wait)
	}
	if r.elapsed >= idle+wait+margin {
		t.Fatalf("P1: act tenía techo idle+waitMs=%v y venció a %v (≥ %v): el techo no es acotado", idle+wait, r.elapsed, idle+wait+margin)
	}
	if r.err == nil {
		t.Fatalf("P1: act sin respuesta ni latido devolvió res=%v sin error, want command_timeout", r.res)
	}
	msg := r.err.Error()
	if !strings.HasPrefix(msg, actPrefix) {
		t.Fatalf("P1: error = %q, want prefijo %q", msg, actPrefix)
	}

	// Después del vencimiento no queda pending: un latido y una respuesta
	// tardíos con ese id se descartan sin efecto (patrón P2 de fb-020-007).
	ids := fb007CommandIDs(ws)
	if len(ids) != 1 {
		t.Fatalf("P1: la extensión recibió %d commands, want exactamente 1: %v", len(ids), ws.messages())
	}
	time.Sleep(150 * time.Millisecond)
	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("P1: latido/respuesta tardíos produjeron panic: %v", p)
			}
		}()
		th.h.HandleMessage(ws, fb007Progress(ids[0], 300*time.Millisecond))
		th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+ids[0]+`","result":{"ok":true}}`))
	}()
	if n := len(th.h.pending); n != 0 {
		t.Fatalf("P1: quedan %d entradas pendientes tras el timeout, want 0", n)
	}
}

// --- P2 (RED parte 1 / PIN variante): el plazo que informa el error es el
// — que venció (idle + espera declarada), no el idle solo. ---

// P2-parte1 (RED hoy): con idle=100 y waitMs=200 el vencimiento ocurre a
// ~300 ms, pero el mensaje dice `within 100 ms` (sonda A del spec: informa
// idle, no el plazo vencido). El contrato D-3 exige `within 400 ms` (el
// texto espera que idle+wait=/400 ms/) y explícitamente NO `within 100 ms`.
func TestFb024_P2_ActTimeoutReportsElapsedDeadline(t *testing.T) {
	const (
		idle = 100 * time.Millisecond
		wait = 200 * time.Millisecond
	)
	th, _ := fb007Hub(t, idle)

	r := fb007Await(t, fb007Command(th, Command{
		Command: "act",
		Params: map[string]any{
			"action": "type",
			"waitMs": float64(200),
			"frame":  map[string]any{"waitMs": float64(50)},
		},
		TabID: "24",
	}), 2*time.Second, "P2")
	if r.err == nil {
		t.Fatalf("P2: act sin respuesta ni latido devolvió res=%v sin error, want command_timeout", r.res)
	}
	msg := r.err.Error()
	if !strings.Contains(msg, "for act on tab 24 within 400 ms") {
		t.Fatalf("P2: error = %q, want contener \"for act on tab 24 within 400 ms\" — el plazo informado debe ser idle+waitMs (D-3)", msg)
	}
	if strings.Contains(msg, "within 100 ms") {
		t.Fatalf("P2: error = %q, no debe decir \"within 100 ms\": ese es el plazo idle, NO el que venció (D-3)", msg)
	}
}

// P2-variante (PIN hoy): con UN latido (~50 ms) el plazo se reinicia a idle
// y el texto pasa a decir `within 100 ms`.
func TestFb024_P2_ActTimeoutAfterHeartbeatReportsIdle(t *testing.T) {
	const (
		idle   = 100 * time.Millisecond
		wait   = 200 * time.Millisecond
		eps    = 300 * time.Millisecond
		beatAt = 50 * time.Millisecond
	)
	th, ws := fb007Hub(t, idle)

	start := time.Now()
	done := fb007Command(th, Command{
		Command: "act",
		Params: map[string]any{
			"action": "type",
			"waitMs": float64(200),
		},
		TabID: "24",
	})
	ids := fb007WaitCommandN(t, ws, 1)
	// un solo latido del dueño, ~50 ms después del despacho
	for time.Since(start) < beatAt {
		time.Sleep(2 * time.Millisecond)
	}
	th.h.HandleMessage(ws, fb007Progress(ids[0], time.Since(start)))

	r := fb007Await(t, done, time.Second, "P2 variante latido")
	if r.err == nil || !strings.HasPrefix(r.err.Error(), actPrefix) {
		t.Fatalf("P2 variante: err = %v, want command_timeout", r.err)
	}
	// Venció ~idle después del latido: elapsed total ≥ beatAt+idle−algo (llega
	// a vencer recién después del latido) pero mucho menos que idle+wait.
	if got := time.Since(start); got < idle {
		t.Fatalf("P2 variante: venció a %v (< idle=%v): no llegó a vivir hasta el latido", got, idle)
	}
	if r.elapsed > beatAt+idle+eps {
		t.Fatalf("P2 variante: venció a %v, want ≤ latido(%v)+idle(%v)+ε=%v: el latido NO reinició el plazo (D-3: tras latido N=idle)", r.elapsed, beatAt, idle, beatAt+idle+eps)
	}
	msg := r.err.Error()
	if !strings.Contains(msg, "within 100 ms") {
		t.Fatalf("P2 variante: error = %q, want contener \"within 100 ms\" (tras latido el plazo informado es idle)", msg)
	}
}

// --- P3 (RED): pista del diálogo nativo en TODA página comandada
// (act/fill/click/getFrame/waitForElement/navigate), inclusive con espera 0. ---

// actTimeoutParams arma los Params mínimos de cada comando de página. Los
// parámetros de espera son OPCIONALES: navigate y fill SIN espera declarada
// cierran el verde vacuo de una impl que condicionara el sufijo de D-4 a
// `declaredWait > 0` (sidestep del audit §6-c).
func actTimeoutParams(cmd string) map[string]any {
	switch cmd {
	case "act":
		return map[string]any{"action": "click"}
	case "fill":
		return map[string]any{"selector": "#a", "value": "v"}
	case "click":
		return map[string]any{"selector": "#a"}
	case "getFrame":
		return map[string]any{"page": float64(1)}
	case "waitForElement":
		return map[string]any{"selector": "#a"}
	case "navigate":
		return map[string]any{"url": "http://x"} // sin frame: espera declarada 0
	}
	return map[string]any{}
}

func TestFb024_P3_PageCommandsGetDialogHint(t *testing.T) {
	const idle = 100 * time.Millisecond
	for _, cmd := range []string{"act", "fill", "click", "getFrame", "waitForElement", "navigate"} {
		cmd := cmd
		t.Run(cmd, func(t *testing.T) {
			th, _ := fb007Hub(t, idle)
			r := fb007Await(t, fb007Command(th, Command{Command: cmd, Params: actTimeoutParams(cmd), TabID: "24"}), 2*time.Second, "P3 "+cmd)
			if r.err == nil {
				t.Fatalf("P3 %s: sin respuesta ni latido devolvió res=%v sin error, want command_timeout", cmd, r.res)
			}
			msg := r.err.Error()
			if !strings.HasPrefix(msg, actPrefix) {
				t.Fatalf("P3 %s: error = %q, want prefijo %q (guarda del audit: la pista no reemplaza al prefijo)", cmd, msg, actPrefix)
			}
			if !strings.Contains(msg, actDispatchNote) {
				t.Fatalf("P3 %s: error = %q, want contener %q (I-1)", cmd, msg, actDispatchNote)
			}
			// HasSuffix, NO Contains: la pista va AL FINAL (engaña si la impl
			// la pone en medio o detrás del texto ORM). Doble guard: aparece
			// UNA sola vez (no duplicada con el texto de odoo_tab_select).
			if !strings.HasSuffix(msg, actTimeoutPageDialogHint) {
				t.Fatalf("P3 %s: error = %q, want terminar EXACTAMENTE con el sufijo D-4 (tab 24): pista del diálogo nativo", cmd, msg)
			}
			if n := strings.Count(msg, actTimeoutPageDialogHint); n != 1 {
				t.Fatalf("P3 %s: el sufijo D-4 aparece %d veces, want exactamente 1: %q", cmd, n, msg)
			}
		})
	}
}

// --- P4 (PIN): los comandos odoo* conservan el texto byte-idéntico (I-2):
// — sin pista de página, sin recorte de plazo. ---

func TestFb024_P4_OdooCommandTextByteIdentical(t *testing.T) {
	const idle = 100 * time.Millisecond
	for _, cmd := range []string{"odooSearchCount", "odooCreate"} {
		cmd := cmd
		t.Run(cmd, func(t *testing.T) {
			th, _ := fb007Hub(t, idle)
			// TabID "24" ADREDE: hasta con tab de página, un odoo* NO lleva la
			// pista (la categorización del consejo la hace odoo_tab_select).
			r := fb007Await(t, fb007Command(th, Command{Command: cmd, Params: map[string]any{}, TabID: "24"}), 2*time.Second, "P4 "+cmd)
			if r.err == nil {
				t.Fatalf("P4 %s: sin respuesta ni latido devolvió res=%v sin error, want command_timeout", cmd, r.res)
			}
			want := ormLiteral(cmd)
			if got := r.err.Error(); got != want {
				t.Fatalf("P4 %s: error =\n  %q\nwant EXACTO (I-2, byte-idéntico):\n  %q", cmd, got, want)
			}
		})
	}
}
