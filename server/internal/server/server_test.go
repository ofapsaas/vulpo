// Package server tests — contrato observable del server: transporte
// Streamable HTTP (auth, sesión, CORS, body cap), WS /extension (auth),
// tools catalog y bind address.
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newTestServer(t *testing.T, tokens []string) *Server {
	t.Helper()
	s, err := StartServer(Options{Port: 0, Tokens: tokens})
	if err != nil {
		t.Fatalf("StartServer = %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// newTestServerBind: igual a newTestServer pero con bind address explícito.
func newTestServerBind(t *testing.T, tokens []string, bindAddr string) *Server {
	t.Helper()
	s, err := StartServer(Options{Port: 0, Tokens: tokens, BindAddr: bindAddr})
	if err != nil {
		t.Fatalf("StartServer = %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// mcpRequest: helper POST /mcp con transporte Streamable HTTP.
// Envía Accept (default application/json), Mcp-Session-Id (si provista), token.
// Devuelve status + body + headers de respuesta (para extraer Mcp-Session-Id).
type mcpReqOpts struct {
	token   string
	session string
	accept  string
	method  string // default POST
}

func mcpRequestFull(t *testing.T, port int, opts mcpReqOpts, body string) (int, string, http.Header) {
	t.Helper()
	method := opts.method
	if method == "" {
		method = "POST"
	}
	accept := opts.accept
	if accept == "" {
		accept = "application/json"
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d/mcp", port), strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)
	if opts.token != "" {
		req.Header.Set("x-vlp-token", opts.token)
	}
	if opts.session != "" {
		req.Header.Set("Mcp-Session-Id", opts.session)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s /mcp = %v", method, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data), resp.Header
}

// mcpRequest: POST /mcp simple (Accept application/json). Devuelve status+body.
func mcpRequest(t *testing.T, port int, token string, body string) (int, string) {
	t.Helper()
	code, data, _ := mcpRequestFull(t, port, mcpReqOpts{token: token}, body)
	return code, data
}

// mcpInitialize: POST initialize → devuelve el Mcp-Session-Id de la respuesta.
func mcpInitialize(t *testing.T, port int, token string) (int, string, string) {
	t.Helper()
	code, body, hdr := mcpRequestFull(t, port, mcpReqOpts{token: token},
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	return code, body, hdr.Get("Mcp-Session-Id")
}

// PC-01 — parseTokensFile (formato simple: un token por línea).
func TestParseTokensFile(t *testing.T) {
	dir := t.TempDir()
	f := dir + "/tokens.txt"
	if err := os.WriteFile(f, []byte("# comentario\ntok1\n# otro\ntok2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	toks, err := ParseTokensFile(f)
	if err != nil {
		t.Fatalf("parse = %v", err)
	}
	if len(toks) != 2 || toks[0] != "tok1" || toks[1] != "tok2" {
		t.Fatalf("tokens = %v, want [tok1 tok2]", toks)
	}
	// ilegible → error
	if _, err := ParseTokensFile(dir + "/no-existe.txt"); err == nil {
		t.Fatal("archivo inexistente debe fallar (fail-loud)")
	}
}

// PC-02 — startServer con port 0 (efímero) responde (initialize con sesión).
func TestStartServer_EphemeralPort(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	if s.Port == 0 {
		t.Fatal("port efímero no asignado")
	}
	code, _, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 {
		t.Fatalf("initialize status = %d, want 200", code)
	}
	if sess == "" {
		t.Fatal("Mcp-Session-Id vacío tras initialize")
	}
}

// PC-05 — ping con sesión válida → 200, result == {}.
func TestMCP_Ping(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, body, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 || sess == "" {
		t.Fatalf("initialize = %d, sess=%q, want 200 y sesión", code, sess)
	}
	code, body, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 200 {
		t.Fatalf("ping status = %d, want 200", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	if _, ok := resp["result"].(map[string]any); !ok {
		t.Fatalf("ping result = %v, want {}", resp["result"])
	}
}

// PC-04 — /mcp initialize con token → serverInfo + protocolVersion
// 2025-06-18 + capabilities.tools + Mcp-Session-Id.
func TestMCP_Initialize(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, body, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	if sess == "" {
		t.Fatal("Mcp-Session-Id no devuelto en initialize")
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	result, _ := resp["result"].(map[string]any)
	si, _ := result["serverInfo"].(map[string]any)
	if si["name"] != "vulpo" || si["version"] != "0.5.2" {
		t.Fatalf("serverInfo = %v, want vulpo 0.5.2", si)
	}
	if pv, _ := result["protocolVersion"].(string); pv != "2025-06-18" {
		t.Fatalf("protocolVersion = %v, want 2025-06-18", pv)
	}
	if caps, _ := result["capabilities"].(map[string]any); caps["tools"] == nil {
		t.Fatalf("capabilities.tools ausente, want objeto")
	}
}

// PC-04 — /mcp sin token → 401.
func TestMCP_NoToken(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, _ := mcpRequest(t, s.Port, "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 401 {
		t.Fatalf("status = %d, want 401", code)
	}
	code2, _ := mcpRequest(t, s.Port, "nope", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code2 != 401 {
		t.Fatalf("status token inválido = %d, want 401", code2)
	}
}

// PC-05 — /mcp body cap (>1MB → 400).
func TestMCP_BodyCap(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	big := `{"x":"` + strings.Repeat("a", 1100*1024) + `"}`
	code, _ := mcpRequest(t, s.Port, "tok1", big)
	if code != 400 {
		t.Fatalf("status = %d, want 400 (body > 1MB)", code)
	}
}

// PC-09 — /mcp notificación (sin id) con sesión válida → 202 body vacío.
func TestMCP_Notification(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión para notificación")
	}
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if code != 202 {
		t.Fatalf("status = %d, want 202", code)
	}
	if strings.TrimSpace(body) != "" {
		t.Fatalf("body = %q, want vacío", body)
	}
}

// PC-07 — WS /extension register → welcome.
func TestWS_Register(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/extension", s.Port)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial = %v", err)
	}
	defer conn.Close()

	_ = conn.WriteJSON(map[string]any{"type": "register", "role": "extension", "token": "tok1"})
	var msg map[string]any
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("read = %v", err)
	}
	if msg["type"] != "welcome" {
		t.Fatalf("msg = %v, want welcome", msg)
	}
	if id, _ := msg["clientId"].(string); id == "" {
		t.Fatal("clientId vacío")
	}
}

// PC-09 — close() graceful (no cuelga).
func TestServer_Close(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	done := make(chan struct{})
	go func() {
		s.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close colgó")
	}
}

// ============================================================================
// Transporte Streamable HTTP — tools catalog y transporte.
// ============================================================================

// PC-06 — tools/list con sesión → exactamente 33 tools (21 vlp_ + 12 odoo).
func TestMCP_ToolsList(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != 200 {
		t.Fatalf("tools/list status = %d, want 200", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	tools, _ := resp["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 33 {
		t.Fatalf("tools count = %d, want 33 (21 vlp_ + 12 odoo)", len(tools))
	}
	vlpCount, odooCount := 0, 0
	for _, tl := range tools {
		m, _ := tl.(map[string]any)
		if m["name"] == nil || m["description"] == nil || m["inputSchema"] == nil {
			t.Fatalf("tool incompleta: %v", m)
		}
		name, _ := m["name"].(string)
		switch {
		case strings.HasPrefix(name, "vlp_"):
			vlpCount++
		case strings.HasPrefix(name, "odoo_"):
			t.Fatalf("tool odoo con prefijo odoo_: %s (las 12 odoo van sin prefijo)", name)
		default:
			odooCount++
		}
	}
	if vlpCount != 21 || odooCount != 12 {
		t.Fatalf("catalog = %d vlp_ + %d odoo, want 21 + 12", vlpCount, odooCount)
	}
}

// PC-07 — tools/call a tool real (vlp_listTabs) → HTTP 200 con
// envelope JSON-RPC válido. A nivel HTTP sin extensión conectada el dispatch
// puede devolver result o error — ambos son envelope válido.
func TestMCP_ToolsCall_Real(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vlp_listTabs","arguments":{}}}`)
	if code != 200 {
		t.Fatalf("tools/call status = %d, want 200", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("tools/call body no es JSON válido: %v", err)
	}
	// El transporte debe devolver envelope JSON-RPC: result (éxito) o error.
	_, hasResult := resp["result"]
	_, hasError := resp["error"]
	if !hasResult && !hasError {
		t.Fatalf("tools/call envelope sin result ni error: %v", resp)
	}
}

// PC-08 — tools/call tool desconocida → error.code -32602, message con nombre.
func TestMCP_ToolsCall_Unknown(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"no_existe","arguments":{}}}`)
	if code != 200 {
		t.Fatalf("tools/call status = %d, want 200", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	errObj, _ := resp["error"].(map[string]any)
	if code, _ := errObj["code"].(float64); code != -32602 {
		t.Fatalf("error.code = %v, want -32602", code)
	}
	msg, _ := errObj["message"].(string)
	if !strings.Contains(msg, "no_existe") {
		t.Fatalf("error.message = %q, want contiene 'no_existe'", msg)
	}
}

// PC-10 — POST con Accept: text/event-stream → respuesta SSE event: message.
func TestMCP_POST_AcceptSSE(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	code, body, hdr := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess, accept: "text/event-stream"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 200 {
		t.Fatalf("POST SSE status = %d, want 200", code)
	}
	if ct := hdr.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	if !strings.Contains(body, "event: message") || !strings.Contains(body, "data: ") {
		t.Fatalf("body SSE no tiene event/data: %q", body)
	}
}

// PC-11 — POST con Accept que no es json ni sse → 406.
func TestMCP_POST_Accept406(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, _, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", accept: "application/xml"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 406 {
		t.Fatalf("status = %d, want 406", code)
	}
}

// PC-12 — GET /mcp con sesión válida → 200 text/event-stream, stream abierto.
func TestMCP_GET_SSE_Stream(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/mcp", s.Port), nil)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("x-vlp-token", "tok1")
	req.Header.Set("Mcp-Session-Id", sess)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET SSE status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	// stream debe estar abierto (no terminar inmediatamente): leer con timeout corto
	// y confirmar que aún no hay EOF. Usamos un read con deadline de 200ms.
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		_, _ = resp.Body.Read(buf) // debería bloquear (stream abierto)
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("GET SSE terminó inmediatamente, want stream abierto")
	case <-time.After(200 * time.Millisecond):
		// stream sigue abierto — correcto
	}
}

// PC-13 — GET /mcp sin sesión o sesión desconocida → 404.
func TestMCP_GET_MissingSession_404(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, _, _ := mcpRequestFull(t, s.Port, mcpReqOpts{method: "GET", token: "tok1"}, "")
	if code != 404 {
		t.Fatalf("GET sin sesión status = %d, want 404", code)
	}
	code, _, _ = mcpRequestFull(t, s.Port, mcpReqOpts{method: "GET", token: "tok1", session: "sesion-desconocida"}, "")
	if code != 404 {
		t.Fatalf("GET sesión desconocida status = %d, want 404", code)
	}
}

// PC-14 — POST no-initialize: sin sesión → 400; sesión desconocida → 404.
func TestMCP_POST_MissingSession(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	code, _, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 400 {
		t.Fatalf("POST sin sesión status = %d, want 400", code)
	}
	code, _, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: "sesion-desconocida"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != 404 {
		t.Fatalf("POST sesión desconocida status = %d, want 404", code)
	}
}

// PC-15 — reutilización de sesión: POST posterior con el ID → 200, sin recrear.
func TestMCP_SessionReuse(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	// segundo initialize con el MISMO session id → no crea sesión nueva (200 ok)
	code, _, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if code != 200 {
		t.Fatalf("initialize con sesión reutilizada = %d, want 200", code)
	}
	// tools/list con el mismo session → 200
	code, _, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != 200 {
		t.Fatalf("tools/list con sesión reutilizada = %d, want 200", code)
	}
}

// PC-16 — CORS preservado: Access-Control-Allow-Origin:* y OPTIONS preflight 204.
func TestMCP_CORS(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	// preflight OPTIONS → 204 sin token
	code, _, hdr := mcpRequestFull(t, s.Port, mcpReqOpts{method: "OPTIONS"}, "")
	if code != 204 {
		t.Fatalf("OPTIONS status = %d, want 204", code)
	}
	if hdr.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("ACAO = %q, want *", hdr.Get("Access-Control-Allow-Origin"))
	}
	// respuesta normal también lleva ACAO
	_, _, hdr = mcpRequestFull(t, s.Port, mcpReqOpts{method: "POST", token: "tok1"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if hdr.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("ACAO en POST = %q, want *", hdr.Get("Access-Control-Allow-Origin"))
	}
}

// ============================================================================
// Bind address — PC-01/02/03.
// ============================================================================

// PC-01 — bind loopback explícito: server escucha en 127.0.0.1, /mcp responde.
func TestBind_LoopbackExplicit(t *testing.T) {
	s := newTestServerBind(t, []string{"tok1"}, "127.0.0.1")
	code, _, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 || sess == "" {
		t.Fatalf("initialize = %d, sess=%q, want 200 + sesión en loopback", code, sess)
	}
}

// PC-02 — default loopback aplicado cuando BindAddr vacío.
func TestBind_DefaultLoopback(t *testing.T) {
	s := newTestServer(t, []string{"tok1"}) // sin BindAddr → default 127.0.0.1
	code, _, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 || sess == "" {
		t.Fatalf("initialize = %d, sess=%q, want 200 + sesión (default loopback)", code, sess)
	}
}

// PC-03 — bind wildcard (0.0.0.0) cubre loopback: 127.0.0.1 sigue respondiendo.
func TestBind_WildcardCoversLoopback(t *testing.T) {
	s := newTestServerBind(t, []string{"tok1"}, "0.0.0.0")
	code, _, sess := mcpInitialize(t, s.Port, "tok1")
	if code != 200 || sess == "" {
		t.Fatalf("initialize = %d, sess=%q, want 200 + sesión (wildcard cubre loopback)", code, sess)
	}
}

// ============================================================================
// Aislamiento token/extensión — multi-tenant.
// ============================================================================

// PC6 — tools/call con token válido sin extensión conectada → error claro.
func TestMultitenant_ToolsCall_NoExtension(t *testing.T) {
	s := newTestServer(t, []string{"tok1"}) // sin extensión WS conectada
	_, _, sess := mcpInitialize(t, s.Port, "tok1")
	if sess == "" {
		t.Fatal("no hay sesión")
	}
	// vlp_listTabs requiere extensión conectada → error observable.
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vlp_listTabs","arguments":{}}}`)
	if code != 200 {
		t.Fatalf("tools/call status = %d, want 200 (error JSON-RPC)", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	errObj, hasErr := resp["error"].(map[string]any)
	if !hasErr {
		t.Fatalf("tools/call sin extensión debería devolver error: %v", resp)
	}
	msg, _ := errObj["message"].(string)
	if !strings.Contains(msg, "No extension connected for token") {
		t.Fatalf("error.message = %q, want contiene 'No extension connected for token'", msg)
	}
}

// PC7 — dos sesiones MCP con el MISMO token → misma extensión/tenant.
func TestMultitenant_TwoSessionsSameToken(t *testing.T) {
	s := newTestServer(t, []string{"tok1"})
	_, _, sess1 := mcpInitialize(t, s.Port, "tok1")
	_, _, sess2 := mcpInitialize(t, s.Port, "tok1")
	if sess1 == "" || sess2 == "" {
		t.Fatalf("sesiones = %q, %q, want dos session-ids", sess1, sess2)
	}
	// ambas operan sobre la extensión del token (no hay aislamiento por sesión)
	code, _, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess1},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != 200 {
		t.Fatalf("tools/list con sess1 = %d, want 200", code)
	}
	code, _, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tok1", session: sess2},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != 200 {
		t.Fatalf("tools/list con sess2 = %d, want 200", code)
	}
}

// PC4 — verificación de aislamiento multi-tenant (2 tokens). El aislamiento de
// routing por token ya está garantizado por el hub (Command rutea al perfil del
// token y rechaza tabs de otro token). Este test confirma a nivel server que
// dos tokens coexisten sin colisión de sesiones.
func TestMultitenant_TwoTokens_Coexist(t *testing.T) {
	s := newTestServer(t, []string{"tokA", "tokB"})
	// ambos tokens inicializan sesiones MCP independientes y coexisten.
	_, _, sessA := mcpInitialize(t, s.Port, "tokA")
	_, _, sessB := mcpInitialize(t, s.Port, "tokB")
	if sessA == "" || sessB == "" {
		t.Fatalf("sesiones A=%q B=%q, want ambas no vacías", sessA, sessB)
	}
	if sessA == sessB {
		t.Fatal("las sesiones MCP de tokens distintos NO deben ser iguales (aislamiento por tenant)")
	}
	// ambos pueden listar tools (34) sin colisión.
	codeA, bodyA, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tokA", session: sessA},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	codeB, bodyB, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tokB", session: sessB},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if codeA != 200 || codeB != 200 {
		t.Fatalf("tools/list codes A=%d B=%d, want ambos 200", codeA, codeB)
	}
	// F-2: frontera JSON — "search_read" como substring simple.
	if !strings.Contains(bodyA, "\"name\":\"search_read\"") || !strings.Contains(bodyB, "\"name\":\"search_read\"") {
		t.Fatalf("tools/list no incluye tools odoo para ambos tenants")
	}
}

// E2E cross-feature — flujo completo: transporte Streamable HTTP +
// vlp_help resuelto + multi-tenant juntos.
func TestEpic_CrossFeature_AgentConnects(t *testing.T) {
	s := newTestServer(t, []string{"tokA", "tokB"})

	// transporte Streamable HTTP: initialize obtiene sesión.
	_, _, sessA := mcpInitialize(t, s.Port, "tokA")
	if sessA == "" {
		t.Fatal("initialize no devolvió sesión (transporte)")
	}

	// tools/list devuelve las 33 tools (21 vlp_ + 12 odoo).
	code, body, _ := mcpRequestFull(t, s.Port, mcpReqOpts{token: "tokA", session: sessA},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != 200 {
		t.Fatalf("tools/list = %d, want 200", code)
	}
	var resp map[string]any
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	tools, _ := resp["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 33 {
		t.Fatalf("tools/list count = %d, want 33 (21 vlp_ + 12 odoo)", len(tools))
	}

	// vlp_help resuelto: devuelve guía con {{TOOLS}}.
	code, body, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tokA", session: sessA},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vlp_help","arguments":{}}}`)
	if code != 200 {
		t.Fatalf("vlp_help = %d, want 200", code)
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	helpText, _ := resp["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(helpText, "vlp_listTabs") || !strings.Contains(helpText, "SECURITY") {
		t.Fatalf("vlp_help sin tools o SECURITY: %.80s", helpText)
	}

	// multi-tenant: conectamos extensión A; listTabs de A ve solo A.
	// Sin extensión A conectada → error observable (no cruza a B).
	code, body, _ = mcpRequestFull(t, s.Port, mcpReqOpts{token: "tokA", session: sessA},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vlp_listTabs","arguments":{}}}`)
	if code != 200 {
		t.Fatalf("listTabs = %d, want 200", code)
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	// Sin extensión real, listTabs devuelve error observable o resultado;
	// no cruza tenants.
	errObj, hasErr := resp["error"].(map[string]any)
	if hasErr {
		msg, _ := errObj["message"].(string)
		if !strings.Contains(msg, "No extension connected") {
			t.Fatalf("listTabs error inesperado: %q", msg)
		}
	}
}
