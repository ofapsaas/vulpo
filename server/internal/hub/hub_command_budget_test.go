// fb-020-007-orm-navigation-hang — sub-fase RED, postcondiciones del hub
// (docs/specs/fb-020-007-orm-navigation-hang/spec.md v1.1 §2.3, P1–P4):
// latido `progress` de la extensión y presupuesto de INACTIVIDAD del hub.
//
// Interfaces esperadas (declaradas para el implementer). Se consultan por
// type assertion para que el paquete siga compilando en RED:
//
//	func (h *Hub) SetIdleBudget(d time.Duration)     // inyecta IDLE_BUDGET (tests / env del server)
//	func (h *Hub) IdleBudget() time.Duration         // IDLE_BUDGET efectivo tras New
//	func (h *Hub) HeartbeatInterval() time.Duration  // HEARTBEAT_MS que el hub espera de la extensión
//
// P4: New resuelve IDLE_BUDGET como lo hace el server (default + env del
// server), de modo que IdleBudget() tras New ES el default del server; la
// lectura de env no vive solo en cmd/ (si viviera ahí, P4 no la observaría).
//
// Wire del latido (extensión → hub): {"type":"progress","id":<id>,"tabId":<T>,"elapsedMs":<n>}.
// Error al vencer: "command_timeout: no answer or heartbeat from the extension
// for <command> on tab <T> within <N> ms; the command may have been dispatched".
package hub

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

type idleBudgetSetter interface{ SetIdleBudget(time.Duration) }
type idleBudgetGetter interface{ IdleBudget() time.Duration }
type heartbeatGetter interface{ HeartbeatInterval() time.Duration }

// fb007Hub: hub con extensión fake registrada (tok1) que tiene la pestaña 24
// e IDLE_BUDGET inyectado.
func fb007Hub(t *testing.T, idle time.Duration) (*testHub, *fakeWS) {
	t.Helper()
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":24,"url":"http://odoo.local/odoo/action-760"}}`))
	s, ok := any(th.h).(idleBudgetSetter)
	if !ok {
		t.Fatalf("fb-020-007: *Hub no expone SetIdleBudget(time.Duration) para inyectar IDLE_BUDGET")
	}
	s.SetIdleBudget(idle)
	return th, ws
}

type cmdResult struct {
	res     any
	err     error
	elapsed time.Duration
}

// fb007Command corre Command en una goroutine; el canal entrega el desenlace.
func fb007Command(th *testHub, cmd Command) <-chan cmdResult {
	out := make(chan cmdResult, 1)
	go func() {
		start := time.Now()
		r, err := th.h.Command("tok1", cmd)
		out <- cmdResult{r, err, time.Since(start)}
	}()
	return out
}

func fb007Await(t *testing.T, ch <-chan cmdResult, max time.Duration, what string) cmdResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(max):
		t.Fatalf("%s: Command no retornó dentro de %v (sin presupuesto de inactividad: cuelga)", what, max)
		return cmdResult{}
	}
}

func fb007CommandIDs(ws *fakeWS) []string {
	var ids []string
	for _, m := range ws.sentJSON() {
		if m["type"] == "command" {
			id, _ := m["id"].(string)
			ids = append(ids, id)
		}
	}
	return ids
}

// fb007WaitCommandN espera a que la extensión fake haya recibido n commands.
func fb007WaitCommandN(t *testing.T, ws *fakeWS, n int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ids := fb007CommandIDs(ws); len(ids) >= n {
			return ids
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("la extensión fake no recibió %d commands: %v", n, ws.messages())
	return nil
}

func fb007Progress(id string, elapsed time.Duration) []byte {
	return []byte(fmt.Sprintf(`{"type":"progress","id":%q,"tabId":24,"elapsedMs":%d}`, id, elapsed.Milliseconds()))
}

// --- P1: WS que nunca responde ni late + IDLE 50 ms → command_timeout antes de 500 ms, sin pending ---

func TestFb007_P1_CommandTimesOutWithoutAnswerOrHeartbeat(t *testing.T) {
	th, _ := fb007Hub(t, 50*time.Millisecond)

	r := fb007Await(t, fb007Command(th, Command{Command: "odooSearchCount", Params: map[string]any{}, TabID: "24"}), 2*time.Second, "P1")
	if r.elapsed >= 500*time.Millisecond {
		t.Fatalf("P1: Command tardó %v, want < 500ms con IDLE_BUDGET 50ms", r.elapsed)
	}
	if r.err == nil {
		t.Fatalf("P1: Command sin error (res=%v), want command_timeout", r.res)
	}
	msg := r.err.Error()
	if !strings.HasPrefix(msg, "command_timeout:") {
		t.Fatalf("P1: error = %q, want prefijo command_timeout:", msg)
	}
	for _, w := range []string{"odooSearchCount", "24", "may have been dispatched"} {
		if !strings.Contains(msg, w) {
			t.Fatalf("P1: error = %q, want contener %q", msg, w)
		}
	}
	// Command ya retornó y no hay otra goroutine del test activa.
	if n := len(th.h.pending); n != 0 {
		t.Fatalf("P1: quedan %d entradas pendientes tras el timeout, want 0", n)
	}
}

// --- P2: un solo command enviado; respuesta/latido tardíos inocuos; comando posterior OK ---

func TestFb007_P2_SingleSendLateAnswerAndHeartbeatIgnored(t *testing.T) {
	th, ws := fb007Hub(t, 50*time.Millisecond)

	r := fb007Await(t, fb007Command(th, Command{Command: "odooSearchCount", Params: map[string]any{}, TabID: "24"}), 2*time.Second, "P2")
	if r.err == nil || !strings.HasPrefix(r.err.Error(), "command_timeout:") {
		t.Fatalf("P2: err = %v, want command_timeout", r.err)
	}
	time.Sleep(150 * time.Millisecond) // ventana para detectar reenvíos
	ids := fb007CommandIDs(ws)
	if len(ids) != 1 {
		t.Fatalf("P2: la extensión recibió %d mensajes command, want exactamente 1: %v", len(ids), ws.messages())
	}

	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("P2: latido/respuesta tardíos produjeron panic: %v", p)
			}
		}()
		th.h.HandleMessage(ws, fb007Progress(ids[0], 200*time.Millisecond))
		th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+ids[0]+`","result":2733}`))
	}()

	done := fb007Command(th, Command{Command: "odooSearchCount", Params: map[string]any{}, TabID: "24"})
	ids = fb007WaitCommandN(t, ws, 2)
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+ids[1]+`","result":{"n":2733}}`))
	r2 := fb007Await(t, done, 2*time.Second, "P2 posterior")
	if r2.err != nil {
		t.Fatalf("P2: comando posterior err = %v, want éxito", r2.err)
	}
	if m, _ := r2.res.(map[string]any); m == nil || m["n"] != float64(2733) {
		t.Fatalf("P2: comando posterior result = %v, want {n:2733} (no el de la respuesta tardía)", r2.res)
	}
}

// --- P3: los latidos reinician el plazo; sin latidos vence; espera declarada suma ---

func TestFb007_P3_HeartbeatsKeepCommandAlive(t *testing.T) {
	const idle = 300 * time.Millisecond
	th, ws := fb007Hub(t, idle)

	start := time.Now()
	done := fb007Command(th, Command{Command: "odooExecuteKw", Params: map[string]any{}, TabID: "24"})
	id := fb007WaitCommandN(t, ws, 1)[0]
	for time.Since(start) < 4*idle {
		time.Sleep(idle / 3)
		select {
		case r := <-done:
			t.Fatalf("P3: con latidos cada B/3 el comando terminó a %v con err=%v, want seguir vivo hasta 4·B", r.elapsed, r.err)
		default:
		}
		th.h.HandleMessage(ws, fb007Progress(id, time.Since(start)))
	}
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":{"done":"largo"}}`))
	r := fb007Await(t, done, 2*time.Second, "P3 latidos")
	if r.err != nil {
		t.Fatalf("P3: con latidos durante 4·B err = %v, want éxito (sin tope total)", r.err)
	}
	if m, _ := r.res.(map[string]any); m == nil || m["done"] != "largo" {
		t.Fatalf("P3: result = %v, want {done:largo}", r.res)
	}
}

func TestFb007_P3_HeartbeatsStopThenTimeout(t *testing.T) {
	const (
		idle = 300 * time.Millisecond
		eps  = 250 * time.Millisecond
	)
	th, ws := fb007Hub(t, idle)

	start := time.Now()
	done := fb007Command(th, Command{Command: "odooExecuteKw", Params: map[string]any{}, TabID: "24"})
	id := fb007WaitCommandN(t, ws, 1)[0]
	var last time.Duration
	for i := 0; i < 2; i++ {
		time.Sleep(idle / 3)
		last = time.Since(start)
		th.h.HandleMessage(ws, fb007Progress(id, last))
	}
	r := fb007Await(t, done, 3*time.Second, "P3 latidos cortados")
	if r.err == nil || !strings.HasPrefix(r.err.Error(), "command_timeout:") {
		t.Fatalf("P3: tras dejar de latir err = %v, want command_timeout", r.err)
	}
	if r.elapsed < idle || r.elapsed > idle+last+eps {
		t.Fatalf("P3: venció a %v, want entre B=%v y B+último latido+ε=%v", r.elapsed, idle, idle+last+eps)
	}
}

func TestFb007_P3_DeclaredWaitExtendsInitialBudget(t *testing.T) {
	const (
		idle = 200 * time.Millisecond
		wait = 600 * time.Millisecond
		// δ: la respuesta llega a B+W−δ (400ms después de B, 200ms antes de B+W)
		delta = 200 * time.Millisecond
	)
	cases := []struct {
		name   string
		cmd    string
		params map[string]any
	}{
		{"waitForElement.timeout", "waitForElement", map[string]any{"selector": "#x", "timeout": float64(wait / time.Millisecond)}},
		{"getFrame.waitMs", "getFrame", map[string]any{"waitMs": float64(wait / time.Millisecond)}},
		{"act.waitMs", "act", map[string]any{"waitMs": float64(wait / time.Millisecond)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			th, ws := fb007Hub(t, idle)
			done := fb007Command(th, Command{Command: tc.cmd, Params: tc.params, TabID: "24"})
			id := fb007WaitCommandN(t, ws, 1)[0]
			time.Sleep(idle + wait - delta)
			th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":{"ok":true}}`))
			r := fb007Await(t, done, 2*time.Second, "P3 espera declarada")
			if r.err != nil {
				t.Fatalf("P3: %s sin latidos, respuesta a B+W−δ err = %v, want éxito (plazo inicial = IDLE + espera)", tc.cmd, r.err)
			}
		})
	}
}

// --- P4: defaults 45 s / 15 s, independientes de VLP_TIMEOUT; progress de id desconocido ignorado ---

func TestFb007_P4_DefaultsIgnoreVLPTIMEOUT(t *testing.T) {
	defaults := func() (time.Duration, time.Duration) {
		h := New()
		g, ok := any(h).(idleBudgetGetter)
		if !ok {
			t.Fatalf("P4: *Hub no expone IdleBudget() time.Duration")
		}
		hb, ok := any(h).(heartbeatGetter)
		if !ok {
			t.Fatalf("P4: *Hub no expone HeartbeatInterval() time.Duration")
		}
		return g.IdleBudget(), hb.HeartbeatInterval()
	}

	if old, had := os.LookupEnv("VLP_TIMEOUT"); had {
		os.Unsetenv("VLP_TIMEOUT")
		t.Cleanup(func() { os.Setenv("VLP_TIMEOUT", old) })
	}
	idle, hb := defaults()
	if idle != 45*time.Second {
		t.Fatalf("P4: IDLE_BUDGET por defecto = %v, want 45s", idle)
	}
	if hb != 15*time.Second || hb >= idle/2 {
		t.Fatalf("P4: HEARTBEAT_MS por defecto = %v, want 15s (< IDLE/2 = %v)", hb, idle/2)
	}
	for _, v := range []string{"1", "1800"} {
		t.Setenv("VLP_TIMEOUT", v)
		if gi, gh := defaults(); gi != idle || gh != hb {
			t.Fatalf("P4: con VLP_TIMEOUT=%s idle=%v heartbeat=%v, want %v/%v (no dependen de VLP_TIMEOUT)", v, gi, gh, idle, hb)
		}
	}
}

func TestFb007_P4_UnknownProgressIgnored(t *testing.T) {
	th, ws := fb007Hub(t, 45*time.Second)

	done := fb007Command(th, Command{Command: "odooSearchCount", Params: map[string]any{}, TabID: "24"})
	id := fb007WaitCommandN(t, ws, 1)[0]
	before := len(ws.messages())
	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("P4: progress de id desconocido produjo panic: %v", p)
			}
		}()
		th.h.HandleMessage(ws, fb007Progress("no-such-id", time.Second))
	}()
	if after := ws.messages(); len(after) != before {
		t.Fatalf("P4: progress de id desconocido generó mensajes hacia la extensión: %v", after[before:])
	}
	select {
	case r := <-done:
		t.Fatalf("P4: progress de id desconocido afectó al comando pendiente (err=%v)", r.err)
	default:
	}
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":7}`))
	if r := fb007Await(t, done, 2*time.Second, "P4"); r.err != nil || r.res != float64(7) {
		t.Fatalf("P4: comando pendiente tras progress desconocido = (%v, %v), want (7, nil)", r.res, r.err)
	}
}
