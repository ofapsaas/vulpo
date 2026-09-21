// Package hub tests — contrato observable del hub: auth, ruteo de comandos,
// tabs, supersession, presupuesto de inactividad.
//
// CONTRATO (hub.go):
//
//	type WSConn interface {
//	    WriteMessage(messageType int, data []byte) error
//	    Close() error
//	    CloseWithCode(code int, reason string) error
//	}
//	type Command struct { Command string; Params map[string]any; TabID string }
//	type Hub struct { /* opaque */ }
//	func New() *Hub
//	func (h *Hub) HandleMessage(ws WSConn, data []byte)   // pipeline: auth/route/forward
//	func (h *Hub) Command(profileID string, cmd Command) (any, error)
//	func (h *Hub) Close() error
//	// campos internos accesibles (tests en package hub):
//	// h.profiles map[string]*Profile{WS WSConn, Tabs map[string]any, Token string}
//	// h.pending map[string]*pendingCmd
//	// errores wire exactos: "Invalid token", "Unknown command",
//	// "No extension has tab <tabId>", "No extension connected for token",
//	// "superseded", "extension disconnected", "hub closed"
package hub

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- fakes ---

type fakeWS struct {
	mu        sync.Mutex
	sent      []string // mensajes JSON enviados, en orden
	closeCode int      // código del último CloseWithCode (0 = no cerrado)
	closed    bool
}

func (w *fakeWS) WriteMessage(_ int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.sent = append(w.sent, string(data))
	return nil
}

func (w *fakeWS) Close() error { w.mu.Lock(); defer w.mu.Unlock(); w.closed = true; return nil }

func (w *fakeWS) CloseWithCode(code int, _ string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	w.closeCode = code
	return nil
}

func (w *fakeWS) messages() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.sent...)
}

// sentJSON: mensajes enviados parseados a map (para asserts de tipo/payload).
func (w *fakeWS) sentJSON() []map[string]any {
	var out []map[string]any
	for _, m := range w.messages() {
		var v map[string]any
		if err := json.Unmarshal([]byte(m), &v); err == nil {
			out = append(out, v)
		}
	}
	return out
}

func (w *fakeWS) countType(t string) int {
	n := 0
	for _, m := range w.sentJSON() {
		if m["type"] == t {
			n++
		}
	}
	return n
}

func (w *fakeWS) firstType(t string) map[string]any {
	for _, m := range w.sentJSON() {
		if m["type"] == t {
			return m
		}
	}
	return nil
}

// --- helpers ---

type testHub struct {
	h      *Hub
	tokens map[string]bool // autorizados
}

func newTestHub(t *testing.T) *testHub {
	t.Helper()
	h := New()
	h.SetAuthorizedTokens(map[string]bool{"tok1": true, "tok2": true})
	return &testHub{h: h}
}

// register: simula el primer mensaje de una conexión.
func (th *testHub) register(t *testing.T, ws *fakeWS, token string) {
	t.Helper()
	msg := map[string]any{"type": "register", "role": "extension", "token": token}
	data, _ := json.Marshal(msg)
	th.h.HandleMessage(ws, data)
}

// --- Tests ---

// PC-01 — register válido → welcome + perfil.
func TestRegister_Valid(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	wel := ws.firstType("welcome")
	if wel == nil {
		t.Fatalf("no welcome; sent=%v", ws.messages())
	}
	if id, _ := wel["clientId"].(string); id == "" {
		t.Fatalf("clientId vacío: %v", wel)
	}
	if len(th.h.profiles) != 1 {
		t.Fatalf("profiles = %d, want 1", len(th.h.profiles))
	}
}

// PC-02 — token inválido/ausente → 'Invalid token' + 4001, sin perfil.
func TestRegister_InvalidToken(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "nope")

	if ws.closeCode != 4001 {
		t.Fatalf("closeCode = %d, want 4001", ws.closeCode)
	}
	err := ws.firstType("error")
	if err == nil || err["error"] != "Invalid token" {
		t.Fatalf("error = %v, want Invalid token", err)
	}
	if len(th.h.profiles) != 0 {
		t.Fatalf("profiles = %d, want 0", len(th.h.profiles))
	}
}

// PC-03 — JSON inválido → 'Invalid token' + 4001.
func TestHandle_InvalidJSON(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.h.HandleMessage(ws, []byte("not json at all {"))

	if ws.closeCode != 4001 {
		t.Fatalf("closeCode = %d, want 4001", ws.closeCode)
	}
	err := ws.firstType("error")
	if err == nil || err["error"] != "Invalid token" {
		t.Fatalf("error = %v, want Invalid token", err)
	}
}

// PC-06 — command desconocido → 'Unknown command'.
func TestCommand_Unknown(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	msg := map[string]any{"type": "command", "command": "frobnicate", "params": map[string]any{}, "id": "c9"}
	data, _ := json.Marshal(msg)
	th.h.HandleMessage(ws, data)

	err := ws.firstType("error")
	if err == nil || err["error"] != "Unknown command" || err["id"] != "c9" {
		t.Fatalf("error = %v, want Unknown command + id c9", err)
	}
}

// PC-07 — ping → pong.
func TestPing_Pong(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"ping"}`))
	if pong := ws.firstType("pong"); pong == nil {
		t.Fatalf("no pong; sent=%v", ws.messages())
	}
}

// PC-08 — eventos de tabs mutan el perfil.
func TestTabs_Events(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"t1","url":"http://a"}}`))
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabUpdated","tab":{"id":"t1","url":"http://b"}}`))
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabRemoved","tabId":"t1"}`))

	p := th.h.profiles["tok1"]
	if p == nil {
		t.Fatal("perfil no existe")
	}
	if len(p.Tabs) != 0 {
		t.Fatalf("tabs = %v, want 0 tras created+updated+removed", p.Tabs)
	}
	// created+removed de otro tab
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"t2","url":"http://c"}}`))
	if len(p.Tabs) != 1 {
		t.Fatalf("tabs = %v, want 1 (t2)", p.Tabs)
	}
}

// PC-08b — eventos de tabs con ids NUMÉRICOS (Firefox real) se normalizan a string.
// Bug real: la extensión manda tab.id como number; el hub esperaba string y
// descartaba el evento → registro vacío → "No extension has tab N".
func TestTabs_NumericIDs(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":9,"url":"http://a","title":"T9"}}`))
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabUpdated","tab":{"id":10.0,"url":"http://b","title":"T10"}}`))

	p := th.h.profiles["tok1"]
	if p == nil {
		t.Fatal("perfil no existe")
	}
	if len(p.Tabs) != 2 {
		t.Fatalf("tabs = %v, want 2 (9 y 10 registrados)", p.Tabs)
	}
	if _, ok := p.Tabs["9"]; !ok {
		t.Fatalf("tabs = %v, want key \"9\"", p.Tabs)
	}
	if _, ok := p.Tabs["10"]; !ok {
		t.Fatalf("tabs = %v, want key \"10\"", p.Tabs)
	}

	// Command con tabId NO registrado → error rápido sin bloqueo (path negativo)
	_, err := th.h.Command("tok1", Command{Command: "screenshot", Params: map[string]any{}, TabID: "999"})
	if err == nil || !strings.Contains(err.Error(), "No extension has tab") {
		t.Fatalf("Command tabId \"999\" = %v, want /No extension has tab/", err)
	}

	// tabRemoved con id numérico también
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabRemoved","tabId":9}`))
	if _, ok := p.Tabs["9"]; ok {
		t.Fatalf("tabs = %v, want \"9\" eliminado", p.Tabs)
	}
}

// PC-13 — Command con tabId válido → command wire + response resuelve.
func TestCommand_TabValid(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"tabA","url":"http://x"}}`))

	done := make(chan struct{})
	var got any
	go func() {
		defer close(done)
		r, err := th.h.Command("tok1", Command{Command: "getDOM", Params: map[string]any{}, TabID: "tabA"})
		if err != nil {
			t.Errorf("Command err = %v", err)
			return
		}
		got = r
	}()

	// esperar el command wire y responder
	cmd := waitFirstType(t, ws, "command")
	id, _ := cmd["id"].(string)
	if id == "" {
		t.Fatalf("command sin id: %v", cmd)
	}
	th.h.HandleMessage(ws, []byte(`{"type":"response","id":"`+id+`","result":{"html":"<p>hi</p>"}}`))

	<-done
	res, _ := got.(map[string]any)
	if res["html"] != "<p>hi</p>" {
		t.Fatalf("result = %v, want html <p>hi</p>", got)
	}
}

// PC-14 — Command con tabId ajeno → rechazo /No extension has tab/ sin enviar.
func TestCommand_TabForeign(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")
	th.h.HandleMessage(ws, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"tabA","url":"http://x"}}`))

	_, err := th.h.Command("tok1", Command{Command: "getDOM", Params: map[string]any{}, TabID: "other"})
	if err == nil || !strings.Contains(err.Error(), "No extension has tab") {
		t.Fatalf("err = %v, want /No extension has tab/", err)
	}
	if ws.countType("command") != 0 {
		t.Fatalf("command wire enviado pese al rechazo: %v", ws.messages())
	}
}

// PC-15 — Command sin tabId y sin perfil → 'No extension connected for token'.
func TestCommand_NoProfile(t *testing.T) {
	th := newTestHub(t)
	_, err := th.h.Command("ghost", Command{Command: "listTabs"})
	if err == nil || err.Error() != "No extension connected for token" {
		t.Fatalf("err = %v, want No extension connected for token", err)
	}
}

// PC-16 — error wire rechaza pending.
func TestPending_Reject(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	done := make(chan error, 1)
	go func() {
		_, err := th.h.Command("tok1", Command{Command: "listTabs"})
		done <- err
	}()
	cmd := waitFirstType(t, ws, "command")
	id, _ := cmd["id"].(string)
	th.h.HandleMessage(ws, []byte(`{"type":"error","id":"`+id+`","error":"boom"}`))

	err := <-done
	if err == nil || err.Error() != "boom" {
		t.Fatalf("err = %v, want boom", err)
	}
}

// PC-17 — close del perfil activo → limpieza, pending 'extension disconnected'.
func TestClose_ActiveProfile(t *testing.T) {
	th := newTestHub(t)
	ws := &fakeWS{}
	th.register(t, ws, "tok1")

	th.h.HandleDisconnect(ws) // close del WS del perfil activo

	if len(th.h.profiles) != 0 {
		t.Fatalf("profiles = %d, want 0 tras close", len(th.h.profiles))
	}
}

// PC-18 — hub.Close → pending 'hub closed', ws cerrados, profiles vacío.
func TestHubClose(t *testing.T) {
	th := newTestHub(t)
	ws1 := &fakeWS{}
	ws2 := &fakeWS{}
	th.register(t, ws1, "tok1")
	th.register(t, ws2, "tok2")

	err := th.h.Close()
	if err != nil {
		t.Fatalf("Close err = %v", err)
	}
	if !ws1.closed || !ws2.closed {
		t.Fatal("ws no cerrados")
	}
	if len(th.h.profiles) != 0 {
		t.Fatalf("profiles = %d, want 0", len(th.h.profiles))
	}
}

// PC-19 — supersession: viejo superseded+4002, nuevo welcome.
func TestSupersession(t *testing.T) {
	th := newTestHub(t)
	wsOld := &fakeWS{}
	wsNew := &fakeWS{}
	th.register(t, wsOld, "tok1")

	th.register(t, wsNew, "tok1") // segundo register → supersession

	if sup := wsOld.firstType("superseded"); sup == nil {
		t.Fatalf("viejo no recibió superseded; sent=%v", wsOld.messages())
	}
	if wsOld.closeCode != 4002 {
		t.Fatalf("viejo closeCode = %d, want 4002", wsOld.closeCode)
	}
	if wel := wsNew.firstType("welcome"); wel == nil {
		t.Fatalf("nuevo no recibió welcome; sent=%v", wsNew.messages())
	}
}

// PC-20 — ghost-close: pending del viejo pasa al device nuevo (rechazo con
// superseded al viejo, el nuevo sigue operativo).
func TestGhostClose(t *testing.T) {
	th := newTestHub(t)
	wsOld := &fakeWS{}
	wsNew := &fakeWS{}
	th.register(t, wsOld, "tok1")

	th.register(t, wsNew, "tok1") // supersession: el viejo pasa a ghost
	th.h.HandleDisconnect(wsOld)  // close del WS viejo (ghost-close)

	if len(th.h.profiles) != 1 {
		t.Fatalf("profiles = %d, want 1 (el nuevo)", len(th.h.profiles))
	}
	if wsNew.closed {
		t.Fatal("ghost-close no debe cerrar la conexión nueva")
	}
}

// PC-21 — reconexión reusa el MISMO token de perfil (perfil operativo fresco;
// el estado de tabs lo repobla la extensión al reconectar).
func TestReconnect_SameProfile(t *testing.T) {
	th := newTestHub(t)
	ws1 := &fakeWS{}
	th.register(t, ws1, "tok1")
	th.h.HandleMessage(ws1, []byte(`{"type":"event","event":"tabCreated","tab":{"id":"t1","url":"http://a"}}`))
	th.h.HandleDisconnect(ws1) // close normal

	ws2 := &fakeWS{}
	th.register(t, ws2, "tok1")

	p := th.h.profiles["tok1"]
	if p == nil {
		t.Fatal("perfil no existe tras reconexión")
	}
	if ws2.closed {
		t.Fatal("la conexión reemplazante no debe cerrarse")
	}
}

// helpers de espera

// waitFirstType: espera (con deadline real) a que el WS reciba el primer
// mensaje del tipo. El hub procesa síncrono en la goroutine del test, pero la
// goroutine de Command (TestCommand_TabValid/TestPending_Reject) puede tardar
// en programarse bajo carga — un poll sin sleep se agota en microsegundos.
func waitFirstType(t *testing.T, ws *fakeWS, typ string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m := ws.firstType(typ); m != nil {
			return m
		}
		time.Sleep(2 * time.Millisecond)
	}
	return nil
}
