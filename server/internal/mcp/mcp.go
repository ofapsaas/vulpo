// Package mcp — port 1:1 de src/mcp/mcp-server.mjs (fb-007-005-mcp-server).
// Núcleo JSON-RPC 2.0 puro (hand-rolled, sin deps): implementa el subconjunto
// del contrato MCP (initialize, tools/list, tools/call, ping) sobre un
// registro de tools. NO toca HTTP: el entrypoint (007) autentica por header
// x-vlp-token y serializa.
//
// Wire-equivalente: métodos, códigos de error y mensajes idénticos al Node.
// Única diferencia deliberada: serverInfo.version = '0.5.2' (Go v3.1; el
// legacy Node queda 0.0.0 con drift documentado → cutover 009).
package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"
)

// marshalNoEscape: json.Marshal sin escape HTML (`<`, `>`, `&` literales).
// Complemento del mismo helper en internal/server (fb-019-qw TO-04): los refs
// del Frame llevan `>` y el escape default los volvía `\u003e` en el texto que
// el agente consume.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// MCPProtocolVersion: constante del pin.
const MCPProtocolVersion = "2025-06-18"

// Hub: interfaz mínima que las tools consumen (ruteo hacia la extensión).
// *hub.Hub (003) la satisface.
type Hub interface {
	Command(profileID string, cmd Command) (any, error)
}

// Command: comando ruteado (espejo del Command del hub 003 — definido local
// para no acoplar el paquete mcp al paquete hub).
type Command struct {
	Command string
	Params  map[string]any
	TabID   string
}

// Tool: descriptor de una tool (nombre, description, inputSchema, handler).
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Handler     func(params map[string]any, token string) (any, error)
}

// Server: estado del core MCP.
type Server struct {
	mu               sync.RWMutex
	registry         []Tool
	agentKitRevision string
}

// multiContentResult: resultado de handler con ítems de texto adicionales
// (fb-020-006 §2.2). content[0] se serializa desde primary igual que un
// resultado simple; extraTexts van como content[1..].
type multiContentResult struct {
	primary    any
	extraTexts []string
}

// SetAgentKitRevision: revisión del agent kit embebida en el build (fb-020-006
// §2.6). Vacía → initialize no expone la clave.
func (s *Server) SetAgentKitRevision(rev string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agentKitRevision = rev
}

// New: crea el core. (El helpFile de vlp_help se inyecta vía
// RegisterAllTools en tools.go; el core en sí no conoce el help.)
func New(_ Hub) *Server {
	return &Server{registry: []Tool{}}
}

// RegisterTool: registra una tool (fail-fast si name inválido — paridad Node).
func (s *Server) RegisterTool(tool Tool) {
	if tool.Name == "" {
		panic("registerTool: name debe ser un string no vacío")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registry = append(s.registry, tool)
}

// ListTools: devuelve una COPIA del registro (el llamador no puede mutar el
// interno — paridad Node).
func (s *Server) ListTools() []Tool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Tool, len(s.registry))
	copy(out, s.registry)
	return out
}

// listToolsWire: representación wire de las tools (name/description/inputSchema
// — SIN el Handler: Go no omite funcs en json.Marshal como JS, devolvería
// error). Espejo de lo que el Node serializaba (JSON.stringify omite funciones).
func (s *Server) listToolsWire() []map[string]any {
	tools := s.ListTools()
	out := make([]map[string]any, 0, len(tools))
	for _, tl := range tools {
		out = append(out, map[string]any{
			"name":        tl.Name,
			"description": tl.Description,
			"inputSchema": tl.InputSchema,
		})
	}
	return out
}

// findTool: busca por nombre (bajo lock).
func (s *Server) findTool(name string) *Tool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.registry {
		if s.registry[i].Name == name {
			return &s.registry[i]
		}
	}
	return nil
}

// HandleRequest: procesa un mensaje JSON-RPC y devuelve la respuesta wire, o
// (nil, false) para notificaciones (request sin id — el HTTP responde 202).
// Nunca lanza: las excepciones internas se mapean a -32603.
func (s *Server) HandleRequest(msg map[string]any, token string) (any, bool) {
	id, hasID := msg["id"]
	if !hasID || id == nil {
		return nil, false // notificación
	}
	method, _ := msg["method"].(string)
	if method == "" {
		return failure(id, -32601, "Method not found"), true
	}
	params, _ := msg["params"].(map[string]any)
	resp := s.dispatch(method, params, id, token)
	return resp, true
}

// dispatch: despacha por método. tools/call delega en el handler.
func (s *Server) dispatch(method string, params map[string]any, id any, token string) any {
	switch method {
	case "initialize":
		return success(id, s.initializeResult())
	case "tools/list":
		return success(id, map[string]any{"tools": s.listToolsWire()})
	case "tools/call":
		return s.callTool(id, params, token)
	case "ping":
		return success(id, map[string]any{})
	default:
		return failure(id, -32601, "Method not found")
	}
}

func (s *Server) initializeResult() map[string]any {
	result := map[string]any{
		"protocolVersion": MCPProtocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "vulpo", "version": "0.5.2"},
	}
	s.mu.RLock()
	rev := s.agentKitRevision
	s.mu.RUnlock()
	if rev != "" {
		result["_meta"] = map[string]any{"vulpo/agentKitRevision": rev}
	}
	return result
}

// callTool: valida el nombre, busca el descriptor y delega en su handler.
// El handler se ejecuta con recover (throw síncrono → -32000; panic → -32603).
func (s *Server) callTool(id any, params map[string]any, token string) any {
	name, _ := params["name"].(string)
	if name == "" {
		return failure(id, -32602, "Tool name is required")
	}
	tool := s.findTool(name)
	if tool == nil {
		return failure(id, -32602, fmt.Sprintf("Unknown tool: %s", name))
	}
	if tool.Handler == nil {
		return failure(id, -32602, fmt.Sprintf("Tool has no handler: %s", name))
	}

	result, err := runHandler(tool.Handler, params, token)
	if err != nil {
		return failure(id, -32000, err.Error())
	}
	// fb-019-qw TO-04: el Frame (y cualquier resultado con refs que llevan `>`)
	// se incrusta como STRING de texto acá — el json.Marshal default escapa
	// `>` como `\u003e` y los refs llegan ilegibles al agente. Sin escape HTML:
	// los refs quedan literales (`header>nav>a`), el JSON del envelope sigue
	// siendo válido (el frame ya es un string embebido, no un objeto anidado).
	multi, isMulti := result.(multiContentResult)
	if isMulti {
		result = multi.primary
	}
	text, _ := marshalNoEscape(result)
	content := []any{map[string]any{"type": "text", "text": string(text)}}
	for _, extra := range multi.extraTexts {
		content = append(content, map[string]any{"type": "text", "text": extra})
	}
	return success(id, map[string]any{"content": content})
}

// runHandler: ejecuta el handler con recover (panic → error interno).
func runHandler(h func(map[string]any, string) (any, error), params map[string]any, token string) (out any, err error) {
	defer func() {
		if r := recover(); r != nil {
			out = nil
			err = fmt.Errorf("internal error: %v", r)
		}
	}()
	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	return h(args, token)
}

func success(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func failure(id any, code int, message string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	}
}
