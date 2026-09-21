// Package hub — puerta de entrada de la extensión: autentica por token y
// traduce el wire de la extensión (register/command/response/event/progress/
// ping/pong) al modelo de comandos pendientes. Una sesión (perfil) por token,
// persistente entre reconexiones.
//
// Wire: los mensajes de entrada y salida conservan nombres y payloads del
// legado. Close codes 4001 (auth/JSON inválido) y 4002 (superseded)
// preservados. Errores wire exactos:
// "Invalid token", "Unknown command", "No extension has tab <tabId>",
// "No extension connected for token", "superseded", "extension disconnected",
// "hub closed".
//
// Concurrencia: un WS por conexión (WSConn), un goroutine de lectura por
// conexión; las escrituras vienen de múltiples goroutines (routeCommand) →
// WSConn debe ser seguro para escritura concurrente (gorilla requiere mutex
// externo). El Hub mismo se protege con sync.RWMutex.
package hub

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
)

// WSConn: interfaz mínima del WebSocket consumida por el hub.
// gorilla/websocket.Conn la satisface.
type WSConn interface {
	WriteMessage(messageType int, data []byte) error
	Close() error
	CloseWithCode(code int, reason string) error
}

// Command: comando ruteado hacia la extensión del perfil. TabID se valida SOLO
// si no es "" (equivalente de undefined/null en Node): quién decide si un
// comando necesita tab es el tool handler, no este router.
type Command struct {
	Command string
	Params  map[string]any
	TabID   string
}

// Profile: perfil activo por token (un WS por perfil). Exponemos Tabs para
// tests/telemetría (los tests Node leen hub.profiles[*].tabs).
type Profile struct {
	WS    WSConn
	Tabs  map[string]any
	Token string
}

type pendingCmd struct {
	resolve   func(any)
	reject    func(error)
	profileID string
	// heartbeat: señal no bloqueante de cada `progress` de la extensión que
	// reinicia el plazo de inactividad (fb-020-007 §2.3).
	heartbeat chan struct{}
}

// Presupuesto de inactividad y latido (fb-020-007 §2.3).
const (
	defaultIdleBudget = 45 * time.Second
	heartbeatInterval = 15 * time.Second
	// idleBudgetEnv: override del server en milisegundos. Nunca se deriva de
	// VLP_TIMEOUT (timeout del cliente vlpmcp).
	idleBudgetEnv = "VLP_IDLE_BUDGET_MS"
)

// idleBudgetFromEnv: IDLE_BUDGET efectivo del server; un valor ausente o
// inválido deja el default.
func idleBudgetFromEnv() time.Duration {
	ms, err := strconv.Atoi(os.Getenv(idleBudgetEnv))
	if err != nil || ms <= 0 {
		return defaultIdleBudget
	}
	return time.Duration(ms) * time.Millisecond
}

// Hub: estado del hub (profiles/pending) + connections (estado por conexión:
// WS → perfil).
type Hub struct {
	mu       sync.RWMutex
	tokens   map[string]bool
	profiles map[string]*Profile
	pending  map[string]*pendingCmd
	conns    map[WSConn]*Profile
	// idleBudget: plazo sin respuesta ni latido tras el cual Command falla.
	idleBudget time.Duration
}

func New() *Hub {
	return &Hub{
		tokens:     map[string]bool{},
		profiles:   map[string]*Profile{},
		pending:    map[string]*pendingCmd{},
		conns:      map[WSConn]*Profile{},
		idleBudget: idleBudgetFromEnv(),
	}
}

// SetIdleBudget: inyecta IDLE_BUDGET (tests / configuración del server).
func (h *Hub) SetIdleBudget(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.idleBudget = d
}

// IdleBudget: IDLE_BUDGET efectivo.
func (h *Hub) IdleBudget() time.Duration {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.idleBudget
}

// HeartbeatInterval: cada cuánto la extensión envía `progress` de un comando pendiente.
func (h *Hub) HeartbeatInterval() time.Duration {
	return heartbeatInterval
}

// SetAuthorizedTokens: tokens autorizados (equivalente del Map `tokens` de Node,
// que index.mjs inyectaba al hub).
func (h *Hub) SetAuthorizedTokens(tokens map[string]bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tokens = tokens
}

func (h *Hub) authorized(token string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.tokens[token]
}

func (h *Hub) currentWS(token string) WSConn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if p := h.profiles[token]; p != nil {
		return p.WS
	}
	return nil
}

func (h *Hub) send(ws WSConn, payload any) {
	if ws == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = ws.WriteMessage(1, data) // 1 = TextMessage (gorilla TextMessage)
}

// registerProfile: crea el perfil del token y le envía el welcome. Cada
// reconexión crea un perfil operativo FRESCO (Tabs vacío); el estado de tabs
// lo repobla la extensión al reconectar. El legacy reusaba la sesión de chat,
// no los tabs.
func (h *Hub) registerProfile(ws WSConn, token string) *Profile {
	clientID := "ext_" + newUUID()

	h.mu.Lock()
	p := &Profile{WS: ws, Tabs: map[string]any{}, Token: token}
	h.profiles[token] = p
	h.conns[ws] = p
	h.mu.Unlock()

	h.send(ws, map[string]any{"type": "welcome", "clientId": clientID})
	return p
}

// HandleMessage: pipeline auth → route → forward (equivalente de runPipeline de
// Node). El primer mensaje de una conexión es register (auth); los siguientes
// se despachan por tipo (forward). JSON inválido → 'Invalid token' + 4001.
func (h *Hub) HandleMessage(ws WSConn, data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		h.send(ws, map[string]any{"type": "error", "error": "Invalid token"})
		_ = ws.CloseWithCode(4001, "Invalid token")
		return
	}

	h.mu.RLock()
	profile := h.conns[ws]
	h.mu.RUnlock()
	if profile == nil {
		h.handleRegister(ws, msg)
		return
	}
	h.handleMessage(profile, msg)
}

// handleRegister: authStage — consume el primer mensaje (register). Token válido
// → perfil/sesión + welcome (con supersession si el token ya tiene perfil);
// inválido/ausente → error + cierre 4001.
func (h *Hub) handleRegister(ws WSConn, msg map[string]any) {
	token, _ := msg["token"].(string)
	if msg["type"] == "register" && token != "" && h.authorized(token) {
		h.mu.RLock()
		existing := h.profiles[token]
		h.mu.RUnlock()
		if existing != nil {
			// Supersession (fb-001-013): last-one-wins, el device viejo se desplaza.
			// 1) Aviso best-effort al viejo.
			h.send(existing.WS, map[string]any{"type": "superseded", "reason": "another device connected with this token"})
			// 2) Comandos pendientes del desplazado nunca serán respondidos: rechazar ahora.
			h.mu.Lock()
			var toReject []func(error)
			for id, entry := range h.pending {
				if entry.profileID == token {
					delete(h.pending, id)
					toReject = append(toReject, entry.reject)
				}
			}
			h.mu.Unlock()
			for _, r := range toReject {
				r(errors.New("superseded"))
			}
		}
		// 3) La conexión nueva toma la sesión compartida (misma instancia, seq preservado).
		h.registerProfile(ws, token)
		// 4) Cerrar el viejo DESPUÉS de que el nuevo sea el perfil activo: su close
		//    handler corre como ghost-close (HandleDisconnect) y NO toca la sesión
		//    compartida ni pending — el turno en vuelo continúa hacia el device nuevo.
		if existing != nil {
			_ = existing.WS.CloseWithCode(4002, "superseded")
		}
		return
	}
	h.send(ws, map[string]any{"type": "error", "error": "Invalid token"})
	_ = ws.CloseWithCode(4001, "Invalid token")
}

// tabIDString: normaliza el id de tab del wire (la extensión manda números de
// Firefox, los tests usan strings) a la clave string del mapa Tabs.
func tabIDString(v any) (string, bool) {
	switch id := v.(type) {
	case string:
		return id, id != ""
	case float64:
		return strconv.FormatFloat(id, 'f', -1, 64), true
	case json.Number:
		return id.String(), true
	}
	return "", false
}

// handleMessage: forwardStage — despacha event/command/ping/response/error.
func (h *Hub) handleMessage(p *Profile, msg map[string]any) {
	switch msg["type"] {
	case "event":
		switch msg["event"] {
		case "tabCreated", "tabUpdated":
			if tab, ok := msg["tab"].(map[string]any); ok {
				if id, ok2 := tabIDString(tab["id"]); ok2 {
					p.Tabs[id] = tab
				}
			}
		case "tabRemoved":
			if id, ok := tabIDString(msg["tabId"]); ok {
				delete(p.Tabs, id)
			}
		}
	case "command":
		id, _ := msg["id"].(string)
		h.send(p.WS, map[string]any{"type": "error", "id": id, "error": "Unknown command"})
	case "ping":
		h.send(p.WS, map[string]any{"type": "pong"})
	case "progress":
		id, _ := msg["id"].(string)
		h.mu.RLock()
		entry := h.pending[id]
		h.mu.RUnlock()
		if entry == nil || entry.profileID != p.Token {
			return // latido tardío, de id desconocido o de otra extensión: se descarta (§9.7)
		}
		select {
		case entry.heartbeat <- struct{}{}:
		default: // ya hay un latido sin consumir: basta con uno
		}
	case "response", "error":
		id, _ := msg["id"].(string)
		h.mu.Lock()
		entry := h.pending[id]
		if entry != nil {
			delete(h.pending, id)
		}
		h.mu.Unlock()
		if entry == nil {
			return
		}
		if msg["type"] == "response" {
			entry.resolve(msg["result"])
		} else {
			entry.reject(errors.New(fmt.Sprintf("%v", msg["error"])))
		}
	}
}

// Command: routeCommand — rutea un comando hacia la extensión del perfil.
// El tabId se valida SOLO si el caller lo provee (TabID != ""). Resolución por
// pending[id] con response/error wire.
func (h *Hub) Command(profileID string, cmd Command) (any, error) {
	h.mu.RLock()
	p := h.profiles[profileID]
	h.mu.RUnlock()

	hasTab := cmd.TabID != ""
	if hasTab {
		if p == nil {
			return nil, fmt.Errorf("No extension has tab %s", cmd.TabID)
		}
		if _, ok := p.Tabs[cmd.TabID]; !ok {
			return nil, fmt.Errorf("No extension has tab %s", cmd.TabID)
		}
	} else if p == nil {
		return nil, errors.New("No extension connected for token")
	}

	resCh := make(chan any, 1)
	errCh := make(chan error, 1)
	id := newUUID()
	entry := &pendingCmd{
		resolve:   func(v any) { resCh <- v },
		reject:    func(e error) { errCh <- e },
		profileID: profileID,
		heartbeat: make(chan struct{}, 1),
	}
	h.mu.Lock()
	h.pending[id] = entry
	idle := h.idleBudget
	h.mu.Unlock()
	h.send(p.WS, map[string]any{"type": "command", "command": cmd.Command, "params": cmd.Params, "id": id})

	timer := time.NewTimer(idle + declaredWait(cmd))
	defer func() { timer.Stop() }()
	for {
		select {
		case v := <-resCh:
			return v, nil
		case e := <-errCh:
			return nil, e
		case <-entry.heartbeat:
			timer.Stop()
			timer = time.NewTimer(idle) // cada latido reinicia el plazo
		case <-timer.C:
			if !h.abandonPending(id) {
				// La respuesta ganó la carrera contra el vencimiento: ya está en camino.
				select {
				case v := <-resCh:
					return v, nil
				case e := <-errCh:
					return nil, e
				}
			}
			return nil, fmt.Errorf("command_timeout: no answer or heartbeat from the extension for %s on tab %s within %d ms; the command may have been dispatched",
				cmd.Command, cmd.TabID, idle.Milliseconds())
		}
	}
}

// abandonPending: borra pending[id] bajo el mutex; false si otro camino
// (respuesta, desconexión, cierre) ya lo había tomado.
func (h *Hub) abandonPending(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.pending[id]; !ok {
		return false
	}
	delete(h.pending, id)
	return true
}

// declaredWait: espera que el propio comando declara en sus params y que se
// suma al plazo inicial (`timeout` de waitForElement, `waitMs` de getFrame/act).
// fb-020-008 §2.3.2: con el pliegue del mapa (`frame`), la espera declarada es
// la SUMA de los techos — el de la acción MÁS 2·frame.waitMs (el segundo techo
// acota el commit de una navegación, §2.3.1). Sin esta suma, un frame.waitMs
// alto se come un command_timeout mientras el pliegue esperaba legítimamente.
func declaredWait(cmd Command) time.Duration {
	total := declaredActionWait(cmd) + declaredFoldWait(cmd)
	if total <= 0 {
		return 0
	}
	return total
}

// declaredActionWait: el techo del propio comando (vigente).
func declaredActionWait(cmd Command) time.Duration {
	key := map[string]string{"waitForElement": "timeout", "getFrame": "waitMs", "act": "waitMs"}[cmd.Command]
	if key == "" {
		return 0
	}
	ms, ok := cmd.Params[key].(float64)
	if !ok || ms <= 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

// declaredFoldWait: 2·frame.waitMs cuando `act`/`navigate` piden el pliegue
// (§2.3.1). `frame` ausente o no-objeto ⇒ 0: sin pliegue no hay espera extra
// (I-2). El hub no conoce la acción, así que para click/focus/select declara
// también el techo del campo escrito que esos no usan: sobre-declarar sólo
// alarga el plazo inicial, y es deliberado — el modo de falla a evitar es el
// contrario (declarar de menos y cortar un pliegue legítimo).
func declaredFoldWait(cmd Command) time.Duration {
	if cmd.Command != "act" && cmd.Command != "navigate" {
		return 0
	}
	frame, ok := cmd.Params["frame"].(map[string]any)
	if !ok {
		return 0
	}
	waitMs := 5000.0 // default de frame.waitMs (§2.1.1)
	if ms, ok := frame["waitMs"].(float64); ok && ms > 0 {
		waitMs = ms
	}
	return 2 * time.Duration(waitMs) * time.Millisecond
}

// HandleDisconnect: close handler de una conexión. Cleanup solo si ESTA conexión
// sigue siendo el perfil activo (profiles[token] == perfil de la conexión). Un
// ghost-close (conexión desplazada por supersession) NO toca pending —
// el turno en vuelo continúa hacia el device nuevo.
func (h *Hub) HandleDisconnect(ws WSConn) {
	h.mu.Lock()
	profile := h.conns[ws]
	if profile == nil {
		h.mu.Unlock()
		return
	}
	if h.profiles[profile.Token] != profile {
		// ghost-close: no-op.
		h.mu.Unlock()
		return
	}
	delete(h.profiles, profile.Token)
	delete(h.conns, ws)
	var toReject []func(error)
	for id, entry := range h.pending {
		if entry.profileID == profile.Token {
			delete(h.pending, id)
			toReject = append(toReject, entry.reject)
		}
	}
	h.mu.Unlock()

	for _, r := range toReject {
		r(errors.New("extension disconnected"))
	}
}

// Close: rechaza todo pending con 'hub closed', cierra ws, limpia profiles.
func (h *Hub) Close() error {
	h.mu.Lock()
	var toReject []func(error)
	for _, entry := range h.pending {
		toReject = append(toReject, entry.reject)
	}
	h.pending = map[string]*pendingCmd{}
	profiles := make([]*Profile, 0, len(h.profiles))
	for _, p := range h.profiles {
		profiles = append(profiles, p)
	}
	h.profiles = map[string]*Profile{}
	h.conns = map[WSConn]*Profile{}
	h.mu.Unlock()

	for _, r := range toReject {
		r(errors.New("hub closed"))
	}
	for _, p := range profiles {
		_ = p.WS.Close()
	}
	return nil
}

// newUUID: UUID v4 con crypto/rand, formato canónico 8-4-4-4-12 (equivalente de
// randomUUID() de Node; precedente: newUUID de 002 / newSessionID de agentbridge).
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback determinístico (no debería pasar en Linux).
		return fmt.Sprintf("ext-%d-%d", time.Now().UnixNano(), len(b))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // versión 4
	b[8] = (b[8] & 0x3f) | 0x80 // variante 10
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
