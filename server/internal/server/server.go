// Package server — ensambla las piezas del server (hub, MCP, WS /extension)
// sobre UN http.Server: WS /extension (gorilla v1.5.3) y HTTP POST /mcp
// (JSON-RPC con header x-vlp-token, transporte Streamable HTTP).
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"vulpo/server/internal/hub"
	"vulpo/server/internal/mcp"
	"vulpo/server/internal/odooregistry"
)

const (
	mcpMaxBodyBytes = 1024 * 1024

	// Límites operacionales del transporte:
	// bound de streams SSE concurrentes (DoS) y de sesiones por token.
	maxConcurrentSSE    = 100
	maxSessionsPerToken = 5
	sessionIdleTimeout  = 30 * time.Minute // lazy cleanup en sessionValid
)

// Options: configuración de arranque.
type Options struct {
	Port     int    // 0 = efímero
	BindAddr string // interfaz de escucha; "" → "127.0.0.1" (loopback) por default
	Tokens   []string
	HelpFile string

	// AgentKitRevision: revisión del agent kit embebida en el build; vacía →
	// initialize no expone _meta["vulpo/agentKitRevision"].
	AgentKitRevision string
}

// Server: estado del servidor en marcha.
type Server struct {
	Port    int
	Hub     *hub.Hub
	httpSrv *http.Server
	ln      net.Listener
	up      websocket.Upgrader
	mcp     *mcp.Server
	tokens  map[string]bool
	// Sesiones Mcp-Session-Id (Streamable HTTP): mapa por token (tenant) →
	// ID de sesión (UUID) con timestamp de último uso. Se genera en initialize,
	// se exige en POST posteriores y en GET. El contrato observable es lo que
	// se testea.
	sessions  map[string]map[string]time.Time
	sessMu    sync.RWMutex
	sseSlots  chan struct{} // bound de streams SSE concurrentes (DoS)
	stopSweep func()
}

// StartServer: monta y arranca el server. Port == 0 → puerto efímero (el
// default 8765 lo aplica el CLI en main.go).
func StartServer(opts Options) (*Server, error) {
	if opts.BindAddr == "" {
		opts.BindAddr = "127.0.0.1"
	}

	h := hub.New()
	tokens := map[string]bool{}
	for _, t := range opts.Tokens {
		tokens[t] = true
	}
	h.SetAuthorizedTokens(tokens)

	// Adaptador mcp.Hub → hub.Hub (el mcp define su propio Command local).
	ms := mcp.New(&mcpHubAdapter{h: h})
	ms.SetAgentKitRevision(opts.AgentKitRevision)
	helpFile := opts.HelpFile
	if helpFile == "" {
		helpFile = os.Getenv("VLP_HELP_FILE")
	}
	mcp.RegisterAllTools(ms, &mcpHubAdapter{h: h}, helpFile, odooregistry.New())

	s := &Server{
		Hub:      h,
		mcp:      ms,
		tokens:   tokens,
		sessions: map[string]map[string]time.Time{},
		sseSlots: make(chan struct{}, maxConcurrentSSE),
		up: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true }, // la auth es por token
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/extension", s.handleWS)
	mux.HandleFunc("/mcp", s.handleMCP)

	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", opts.BindAddr, opts.Port))
	if err != nil {
		return nil, err
	}
	s.Port = ln.Addr().(*net.TCPAddr).Port
	s.ln = ln
	s.httpSrv = &http.Server{Handler: mux}

	go func() { _ = s.httpSrv.Serve(ln) }()
	return s, nil
}

// Close: graceful shutdown (hub → ws → http).
func (s *Server) Close() {
	if s.stopSweep != nil {
		s.stopSweep()
		s.stopSweep = nil
	}
	s.Hub.Close()
	if s.httpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.httpSrv.Shutdown(ctx)
	}
}

// mcpHubAdapter: traduce mcp.Command (paquete mcp) → hub.Command (paquete hub)
// para que las tools MCP despachen contra el hub real.
type mcpHubAdapter struct{ h *hub.Hub }

func (a *mcpHubAdapter) Command(profileID string, cmd mcp.Command) (any, error) {
	return a.h.Command(profileID, hub.Command{Command: cmd.Command, Params: cmd.Params, TabID: cmd.TabID})
}

// --- WS /extension ---

// wsConn: wrapper de gorilla.Conn con mutex de escritura (gorilla no es seguro
// para escrituras concurrentes) — implementa hub.WSConn.
type wsConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsConn) WriteMessage(messageType int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(messageType, data)
}

func (w *wsConn) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Close()
}

func (w *wsConn) CloseWithCode(code int, reason string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	msg := websocket.FormatCloseMessage(code, reason)
	if err := w.conn.WriteControl(websocket.CloseMessage, msg, time.Now().Add(time.Second)); err != nil {
		return err
	}
	return w.conn.Close()
}

// handleWS: conexión WS a /extension (reader goroutine → hub).
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	raw, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &wsConn{conn: raw}
	defer conn.Close()

	for {
		_, data, err := raw.ReadMessage()
		if err != nil {
			s.Hub.HandleDisconnect(conn)
			return
		}
		s.Hub.HandleMessage(conn, data)
	}
}

// --- HTTP /mcp (transporte Streamable HTTP, spec MCP 2025-03-26, fb-016-001) ---

// handleMCP: dispatch del transporte Streamable HTTP en /mcp. Reutiliza el
// núcleo s.mcp.HandleRequest(msg, token) intacto (D5). CORS en toda respuesta;
// preflight OPTIONS → 204 sin token; GET → SSE server→client; POST → JSON-RPC
// negociado por Accept; otros métodos (DELETE) → 405.
// marshalNoEscape: json.Marshal sin escape HTML (`<`, `>`, `&` quedan
// literales). Los refs del Frame usan `>` como separador (`header>nav>a`) —
// el escape default los emitía como `\u003e` (TO-04, reporte de cliente
// 2026-09-09), ilegibles al redactar un `vlp_act` a mano. El payload
// sigue siendo JSON válido — solo cambia la representación de strings.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encode agrega un \n final — el marshalling directo no lo llevaba.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	// CORS en todas las respuestas (clientes cross-origin).
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// Preflight CORS → 204 sin requerir token. Declara métodos y headers
	// permitidos (incluye x-vlp-token: request no-simple cross-origin).
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "x-vlp-token, Mcp-Session-Id, Content-Type, Accept")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Auth por header x-vlp-token (GET y POST) → 401 sin procesar.
	token := r.Header.Get("x-vlp-token")
	if !s.tokens[token] {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, "invalid token")
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleMCPSSE(w, r, token)
	case http.MethodPost:
		s.handleMCPPost(w, r, token)
	default:
		// DELETE (fuera de scope 001) y otros → 405.
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleMCPPost: POST /mcp — request JSON-RPC del cliente. Negocia por Accept
// (application/json → respuesta única; text/event-stream → respuesta SSE;
// ninguno → 406). Exige Mcp-Session-Id salvo en initialize (que la establece).
func (s *Server) handleMCPPost(w http.ResponseWriter, r *http.Request, token string) {
	// Cliente que no acepta ni json ni sse → 406 (antes de tocar el body).
	if !acceptsJSON(r) && !acceptsSSE(r) {
		w.WriteHeader(http.StatusNotAcceptable)
		return
	}

	// Body cap 1 MiB → 400.
	body, err := io.ReadAll(io.LimitReader(r.Body, mcpMaxBodyBytes+1))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if len(body) > mcpMaxBodyBytes {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	var msg map[string]any
	if err := json.Unmarshal(body, &msg); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	method, _ := msg["method"].(string)

	// Sesión: initialize la establece (reutiliza si ya existe); el resto la exige.
	if method != "initialize" {
		sess := r.Header.Get("Mcp-Session-Id")
		if sess == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !s.sessionValid(token, sess) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
	} else {
		sess := r.Header.Get("Mcp-Session-Id")
		if sess == "" || !s.sessionValid(token, sess) {
			sess = s.newSession(token)
		}
		w.Header().Set("Mcp-Session-Id", sess)
	}

	resp, ok := s.mcp.HandleRequest(msg, token)
	if !ok {
		w.WriteHeader(http.StatusAccepted) // notificación (request sin id) → 202
		return
	}
	// fb-019-qw TO-04: los refs del Frame usan `>` como separador — el escape
	// HTML default del encoding/json (`\u003e`) los vuelve ilegibles para el
	// agente/humano que redacta un act a mano. El payload sigue siendo JSON
	// válido (SetEscapeHTML solo afecta <>& en strings).
	data, _ := marshalNoEscape(resp)
	if acceptsSSE(r) && !acceptsJSON(r) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// handleMCPSSE: GET /mcp — stream SSE server→client. Requiere sesión válida
// (404 si ausente/desconocida). El stream solo se abre (keep-alive) y se
// mantiene abierto hasta desconectar.
func (s *Server) handleMCPSSE(w http.ResponseWriter, r *http.Request, token string) {
	sess := r.Header.Get("Mcp-Session-Id")
	if sess == "" || !s.sessionValid(token, sess) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	// Bound de streams SSE concurrentes (DoS): slot ocupado sin slot libre →
	// 503 (Fail Loud, Law 4). No spawnea goroutine que bloquee sin límite.
	select {
	case s.sseSlots <- struct{}{}:
		defer func() { <-s.sseSlots }()
	default:
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	// Stream abierto: queda a la espera hasta que el cliente se desconecta.
	<-r.Context().Done()
}

// acceptsJSON: el header Accept lista application/json.
func acceptsJSON(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "application/json")
}

// acceptsSSE: el header Accept lista text/event-stream.
func acceptsSSE(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

// newSession: genera una sesión Mcp-Session-Id (UUID v4) para el token y la
// registra server-side. Evicta la sesión más vieja del token si se supera el
// máximo por token (B3 — límite contra memory leak).
func (s *Server) newSession(token string) string {
	id := newUUID()
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	m := s.sessions[token]
	if m == nil {
		m = map[string]time.Time{}
		s.sessions[token] = m
	}
	if len(m) >= maxSessionsPerToken {
		var oldest string
		var oldestAt time.Time
		for sid, at := range m {
			if oldest == "" || at.Before(oldestAt) {
				oldest, oldestAt = sid, at
			}
		}
		delete(m, oldest)
	}
	m[id] = time.Now()
	return id
}

// sessionValid: la sesión existe y pertenece al token (tenant). Aplica lazy
// cleanup: una sesión no usada en sessionIdleTimeout se remueve (B3). Touchea
// el timestamp de último uso (renueva el TTL).
func (s *Server) sessionValid(token, id string) bool {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	m := s.sessions[token]
	if m == nil {
		return false
	}
	last, ok := m[id]
	if !ok {
		return false
	}
	if time.Since(last) > sessionIdleTimeout {
		delete(m, id)
		return false
	}
	m[id] = time.Now()
	return true
}

// newUUID: UUID v4 (RFC 4122) para Mcp-Session-Id.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // versión 4
	b[8] = (b[8] & 0x3f) | 0x80 // variante RFC 4122
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ParseTokensFile: un token por línea, comentarios `#`, sin vacíos.
// Ilegible → error (fail-loud en el CLI).
func ParseTokensFile(filePath string) ([]string, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	var tokens []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		tokens = append(tokens, line)
	}
	return tokens, nil
}
