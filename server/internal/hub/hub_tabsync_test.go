// fb-024-hub-tab-registro — sub-fase RED (docs/specs/fb-024-hub-tab-registro/
// spec.md §3.2, P1–P7, y test-audit.md — condiciones 1–7, obligatorias).
//
// Plan: P1 (RED) + P2/P3/P4/P5/P7 (PIN de regresión). P6 queda FUERA (spec
// §8 Q2: sin single-flight).
//
// Condición 1 (audit) — inyección del presupuesto de sync: los tests NUNCA
// nombran `tabSyncBudgetMs` (referenciar un identificador inexistente rompería
// la compilación: build error, no AssertionError). La inyección va por
// interface opcional con type-assertion:
//
//	type tabSyncBudgetSetter interface{ SetTabSyncBudget(time.Duration) }
//
// El Fatalf del type-assertion (forma estricta, estilo fb007Hub de
// hub_command_budget_test.go) es el RED esperado de los tests inyectores
// cuando *Hub aún no expone el método. En ESTE archivo los PINs usan la forma
// tolerante (tabsyncSetBudget: ok-check silencioso) porque el RED esperado del
// mandato es «P1 falla; P2–P5/P7 quedan verdes»: un Fatalf de interface en un
// PIN ensuciaría ese RED. La inyectabilidad (D-2) queda guardada igualmente
// por comportamiento: si el setter falta o es inerte, la sync corre con el
// default de producción (2000 ms, spec §8 Q1) y P5 falla por su techo de
// elapsed (< 1 s con la inyección en ~1 ms).
//
// RED esperado: P1 falla contra el hub actual — rechaza la tab desconocida
// («No extension has tab 328») sin enviar ningún wire. P2–P5/P7 son
// verdes-vacíos HOY (no existe sync; condición 6 del audit): su valor es
// post-GREEN, como guardia de regresión de I-2/I-3/I-4/I-5/I-6.
//
// Condición 7 (audit/D-8): el gate de esta feature corre
// `go test -race -count=1 ./internal/hub/`; todos los helpers viven en la
// goroutine del test (poll 2 ms / deadline 2 s, house-style de waitFirstType)
// y el fakeWS es mutex-protegido — sin carreras nuevas.
package hub

import (
	"testing"
	"time"
)

const (
	// poll/deadline de los helpers de espera (house-style de waitFirstType).
	tabsyncPoll     = 2 * time.Millisecond
	tabsyncDeadline = 2 * time.Second

	// tabsyncBudget: presupuesto de sync INYECTADO en los tests (~1 ms,
	// condición 2 del audit) — presupuesto PROPIO de la sync (D-2), ajeno al
	// idleBudget (I-4).
	tabsyncBudget = 1 * time.Millisecond

	// tabsyncBudgetDefault: default de producción (spec §8 Q1) usado por los
	// t.Cleanup de restore, para no contaminar a los tests siguientes.
	tabsyncBudgetDefault = 2000 * time.Millisecond
)

// tabSyncBudgetSetter: interface opcional del presupuesto de sync (condición 1
// del audit). El implementador puede respaldarla con un var de paquete, un
// campo del Hub o lo que decida: la postcondición verificada es «presupuesto
// propio, acotado e inyectable» (D-2), no el almacenamiento.
type tabSyncBudgetSetter interface{ SetTabSyncBudget(time.Duration) }

// tabsyncSetBudget: inyección TOLERANTE del presupuesto de sync (ok-check
// silencioso). Ver header del archivo: los PINs deben quedar verdes en RED;
// si el setter falta, P5 lo detecta por comportamiento (techo de elapsed).
func tabsyncSetBudget(h *Hub, d time.Duration) {
	if s, ok := any(h).(tabSyncBudgetSetter); ok {
		s.SetTabSyncBudget(d)
	}
}

// --- helpers de espera (house-style de waitFirstType; todo en la goroutine
// del test, race-clean) ---

// tabsyncWaitCommand: espera (poll 2 ms / deadline 2 s) el primer wire
// command cuyo m["command"] == name. Devuelve nil si no llega; el test decide
// el Fatalf con contexto completo.
func tabsyncWaitCommand(t *testing.T, ws *fakeWS, name string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(tabsyncDeadline)
	for time.Now().Before(deadline) {
		for _, m := range ws.sentJSON() {
			if m["type"] == "command" && m["command"] == name {
				return m
			}
		}
		time.Sleep(tabsyncPoll)
	}
	return nil
}

// tabsyncRespondNext: atiende (una pasada, sin bloquear) el PRÓXIMO wire
// command no atendido (índice ≥ seen) delegando la respuesta al callback del
// test; devuelve el índice siguiente al atendido, o -1 si no hay comando
// nuevo. El poll (2 ms) y el deadline los pone el bucle del test.
func tabsyncRespondNext(ws *fakeWS, seen int, respond func(map[string]any)) int {
	msgs := ws.sentJSON()
	for i := seen; i < len(msgs); i++ {
		if m := msgs[i]; m["type"] == "command" {
			respond(m)
			return i + 1
		}
	}
	return -1
}

// tabsyncServe: atiende los wires command que el hub envíe mientras Command
// está en vuelo (poll 2 ms / deadline max), respondiendo según el callback,
// hasta que Command retorne (Fatalf si no retorna dentro de max).
func tabsyncServe(t *testing.T, res <-chan cmdResult, ws *fakeWS, max time.Duration, what string, respond func(map[string]any)) cmdResult {
	t.Helper()
	deadline := time.Now().Add(max)
	seen := 0
	for {
		select {
		case r := <-res:
			return r
		default:
		}
		if nx := tabsyncRespondNext(ws, seen, respond); nx >= 0 {
			seen = nx
			continue
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: Command no retornó dentro de %v; wires=%v", what, max, ws.messages())
			return cmdResult{}
		}
		time.Sleep(tabsyncPoll)
	}
}

// tabsyncCountCommand: condición 6 del audit — cuenta los wires command cuyo
// m["command"] == name (el comando OBJETIVO, no cualquier wire).
func tabsyncCountCommand(ws *fakeWS, name string) int {
	n := 0
	for _, m := range ws.sentJSON() {
		if m["type"] == "command" && m["command"] == name {
			n++
		}
	}
	return n
}

// --- P1 (RED): el hub sincroniza (listTabs) antes de rechazar, y el
// resultado de Command es el del objetivo. ---

func TestTabsync_P1_UnknownTabSyncsListTabsBeforeDispatch(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	// SIN tabCreated: la extensión conectada NO ha anunciado la tab 328 (P1).

	res := fb007Command(th, Command{Command: "getFrame", Params: map[string]any{}, TabID: "328"})

	// 1) el hub debe enviar listTabs (tabless) a la extensión del perfil
	//    ANTES de decidir (D-1). Hoy no existe sync: la espera vence y el
	//    Fatalf de abajo muestra el rechazo sin wires — el RED esperado.
	listCmd := tabsyncWaitCommand(t, ws, "listTabs")
	if listCmd == nil {
		r := fb007Await(t, res, tabsyncDeadline, "P1 contexto")
		t.Fatalf("P1 (RED esperado hoy): el hub rechazó la tab desconocida SIN enviar listTabs (Command devolvió res=%v, err=%v; wires=%v) — falta D-1", r.res, r.err, ws.messages())
	}
	listID, _ := listCmd["id"].(string)
	// La fila lleva id NUMÉRICO (328.0, float64 JSON): cubre la normalización
	// tabIDString (condición 3 del audit) — si el hub no la normaliza, 328 no
	// entra en p.Tabs y getFrame jamás se despacha (detectado abajo).
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+listID+`","result":[{"id":328.0,"url":"http://x/328","title":"T328"}]}`))

	// 2) con la fila 328 incorporada, el hub debe despachar el objetivo.
	frameCmd := tabsyncWaitCommand(t, ws, "getFrame")
	if frameCmd == nil {
		r := fb007Await(t, res, tabsyncDeadline, "P1 contexto 2")
		t.Fatalf("P1: tras listTabs con la fila 328 el hub debió despachar getFrame (Command devolvió res=%v, err=%v; wires=%v)", r.res, r.err, ws.messages())
	}
	// condición 3: el getFrame apunta a la tab pedida vía params (el wire no
	// lleva tabId top-level — el params es lo observable).
	fp, _ := frameCmd["params"].(map[string]any)
	if tab, _ := fp["tabId"].(string); tab != "328" {
		t.Fatalf("P1: getFrame sin params.tabId==\"328\" (condición 3): %v", frameCmd)
	}
	frameID, _ := frameCmd["id"].(string)
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+frameID+`","result":{"frame":"F328"}}`))

	r := fb007Await(t, res, tabsyncDeadline, "P1 getFrame")
	if r.err != nil {
		t.Fatalf("P1: Command err = %v, want el result de getFrame tras la sync (D-1)", r.err)
	}
	if m, _ := r.res.(map[string]any); m == nil || m["frame"] != "F328" {
		t.Fatalf("P1: result = %v, want {frame:F328} (el resultado de Command es el de getFrame)", r.res)
	}
	// condición 3: ORDEN de wires — primer listTabs ANTES que primer getFrame.
	firstList, firstFrame := -1, -1
	for i, m := range ws.sentJSON() {
		if m["type"] != "command" {
			continue
		}
		switch m["command"] {
		case "listTabs":
			if firstList < 0 {
				firstList = i
			}
		case "getFrame":
			if firstFrame < 0 {
				firstFrame = i
			}
		}
	}
	if firstList < 0 || firstFrame < 0 || firstList > firstFrame {
		t.Fatalf("P1: orden de wires inválido (primer listTabs=%d, primer getFrame=%d, condición 3): %v", firstList, firstFrame, ws.messages())
	}
}

// --- P2 (PIN): la sync sin la tab pedida mantiene el rechazo EXACTO y el
// objetivo jamás se envía (anti-probing D-6/I-3). ---

func TestTabsync_P2_SyncMissKeepsExactRejectionNoTarget(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	res := fb007Command(th, Command{Command: "getFrame", Params: map[string]any{}, TabID: "328"})
	r := tabsyncServe(t, res, ws, 3*time.Second, "P2", func(cmd map[string]any) {
		if cmd["command"] != "listTabs" {
			t.Errorf("P2: wire command %q inesperado — el objetivo NO debió enviarse (condición 6/D-6)", cmd["command"])
			return
		}
		id, _ := cmd["id"].(string)
		// la sync devuelve filas SIN la tab pedida
		th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":[{"id":77.0,"url":"http://x/77","title":"T77"}]}`))
	})
	if r.err == nil || r.err.Error() != "No extension has tab 328" {
		t.Fatalf("P2: err = %v, want EXACTO \"No extension has tab 328\" (I-2/D-3)", r.err)
	}
	// condición 6: contar los wires del COMANDO OBJETIVO, no cualquier wire.
	if n := tabsyncCountCommand(ws, "getFrame"); n != 0 {
		t.Fatalf("P2: %d wires getFrame tras el rechazo (anti-probing D-6): %v", n, ws.messages())
	}
}

// --- P3 (PIN): fast-path — tab ya conocida por tabCreated ⇒ cero listTabs,
// despacho directo del objetivo (I-4). ---

func TestTabsync_P3_KnownTabSkipsSync(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"328","url":"http://x/328"}}`))

	res := fb007Command(th, Command{Command: "getFrame", Params: map[string]any{}, TabID: "328"})
	r := tabsyncServe(t, res, ws, tabsyncDeadline, "P3", func(cmd map[string]any) {
		if cmd["command"] != "getFrame" {
			t.Errorf("P3: wire command %q inesperado — el fast-path NO debió sincronizar (I-4)", cmd["command"])
			return
		}
		id, _ := cmd["id"].(string)
		th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":{"frame":"F328"}}`))
	})
	if r.err != nil {
		t.Fatalf("P3: Command err = %v, want despacho directo (fast-path)", r.err)
	}
	if n := tabsyncCountCommand(ws, "listTabs"); n != 0 {
		t.Fatalf("P3: %d wires listTabs con la tab ya conocida (I-4: cero round-trips extra): %v", n, ws.messages())
	}
}

// --- P4 (PIN): p == nil (sin extensión para el token pedido) ⇒ rechazo
// inmediato, SIN sync y cero escrituras al WS (I-5). Primera cobertura del
// branch p==nil con TabID no vacío (condición 4 del audit). ---

func TestTabsync_P4_NoProfileImmediateRejectionNoWrites(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1") // la ÚNICA extensión; el comando va a tok2 (p==nil)

	before := len(ws.messages())
	done := make(chan cmdResult, 1)
	go func() {
		r, err := th.h.Command("tok2", Command{Command: "getFrame", Params: map[string]any{}, TabID: "328"})
		done <- cmdResult{res: r, err: err}
	}()
	r := fb007Await(t, done, tabsyncDeadline, "P4")

	if r.err == nil || r.err.Error() != "No extension has tab 328" {
		t.Fatalf("P4: err = %v, want EXACTO \"No extension has tab 328\" (p==nil, I-5)", r.err)
	}
	if after := len(ws.messages()); after != before {
		t.Fatalf("P4: %d escrituras al WS con p==nil (I-5: rechazo inmediato, sin sync): %v", after-before, ws.messages()[before:])
	}
}

// --- P5 (PIN): extensión muda ante listTabs ⇒ el presupuesto PROPIO de la
// sync (inyectado ~1 ms, D-2) vence y Command devuelve el error ORIGINAL
// byte-idéntico, sin enviar el objetivo (D-3/I-2). Idle ALTO (10 s, condición
// 2 del audit): una impl equivocada que espere idleBudget cuelga > techo y
// tabsyncServe la mata; una correcta devuelve en ~ms. ---

func TestTabsync_P5_SyncTimeoutReturnsOriginalError(t *testing.T) {
	const idle = 10 * time.Second
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	s, ok := any(th.h).(idleBudgetSetter)
	if !ok {
		t.Fatalf("P5: *Hub no expone SetIdleBudget(time.Duration)")
	}
	s.SetIdleBudget(idle)

	// Inyección del presupuesto de sync (condición 1): interface-assertion,
	// nunca se nombra tabSyncBudgetMs. Forma tolerante (ver header): si el
	// setter falta post-GREEN, la sync corre con el default 2000 ms y el
	// techo de elapsed de abajo (<1 s) falla — D-2 queda guardado.
	tabsyncSetBudget(th.h, tabsyncBudget)
	t.Cleanup(func() { tabsyncSetBudget(th.h, tabsyncBudgetDefault) })

	start := time.Now()
	res := fb007Command(th, Command{Command: "getFrame", Params: map[string]any{}, TabID: "328"})
	r := tabsyncServe(t, res, ws, 3*time.Second, "P5", func(map[string]any) {
		// extensión MUDA: no responde a listTabs (ni a nada)
	})
	if elapsed := time.Since(start); elapsed >= time.Second {
		t.Fatalf("P5: Command venció a %v (≥1 s) con la sync inyectada en ~1ms: el presupuesto de sync no está acotado/inyectado (D-2)", elapsed)
	}
	if r.err == nil || r.err.Error() != "No extension has tab 328" {
		t.Fatalf("P5: err = %v, want EXACTO \"No extension has tab 328\" (error ORIGINAL, no el de la sync — D-3/I-2)", r.err)
	}
	// condición 6: cero wires del comando objetivo.
	if n := tabsyncCountCommand(ws, "getFrame"); n != 0 {
		t.Fatalf("P5: %d wires getFrame tras el timeout de sync (D-3): %v", n, ws.messages())
	}
}

// --- P7 (PIN): merge, no replace (D-5/I-6) — la sync disparada por la tab
// desconocida B devuelve un snapshot parcial (sólo B) y p.Tabs CONSERVA la
// tab A conocida por tabCreated. Hoy verde-vacío (no existe sync); su valor
// es post-GREEN: una impl que REEMPLACE el mapa dejaría A afuera y fallaría. ---

func TestTabsync_P7_SyncMergesNotReplaces(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"A","url":"http://x/a"}}`))

	res := fb007Command(th, Command{Command: "getFrame", Params: map[string]any{}, TabID: "B"})
	tabsyncServe(t, res, ws, tabsyncDeadline, "P7", func(cmd map[string]any) {
		id, _ := cmd["id"].(string)
		switch cmd["command"] {
		case "listTabs":
			// snapshot parcial: la sync devuelve SÓLO la fila de B
			th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":[{"id":"B","url":"http://x/b","title":"TB"}]}`))
		case "getFrame":
			th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":{"frame":"FB"}}`))
		default:
			t.Errorf("P7: wire command inesperado %q", cmd["command"])
		}
	})
	p := th.h.profiles["tok1"]
	if p == nil {
		t.Fatal("P7: perfil no existe")
	}
	if _, ok := p.Tabs["A"]; !ok {
		t.Fatalf("P7: tabs = %v — la sync (snapshot parcial con sólo B) NO debe borrar la tab A (merge, D-5/I-6)", p.Tabs)
	}
}
