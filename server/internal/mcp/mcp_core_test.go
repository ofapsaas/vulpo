// Package mcp tests — port 1:1 de src/tests/mcp-core.test.mjs
// (fb-007-005-mcp-server, PC-01..PC-09). Core JSON-RPC 2.0 puro.
package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func newCore(t *testing.T) *Server {
	t.Helper()
	return New(&MockHub{})
}

type simpleErr struct{ s string }

func (e *simpleErr) Error() string { return e.s }

// codeOf: normaliza el code del error (int en el mapa interno, float64 si
// viniera de JSON).
func codeOf(err map[string]any) int {
	switch v := err["code"].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// PC-01 — initialize con serverInfo 0.5.0.
func TestInitialize(t *testing.T) {
	s := newCore(t)
	resp, ok := s.HandleRequest(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}, "tok1")
	if !ok {
		t.Fatal("initialize debe responder")
	}
	r := resp.(map[string]any)
	if r["id"] != 1 {
		t.Fatalf("id = %v, want 1", r["id"])
	}
	res := r["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion = %v", res["protocolVersion"])
	}
	si := res["serverInfo"].(map[string]any)
	if si["name"] != "vulpo" || si["version"] != "0.5.2" {
		t.Fatalf("serverInfo = %v, want vulpo 0.5.2", si)
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatal("capabilities.tools faltante")
	}
}

// PC-02 — ping.
func TestPing(t *testing.T) {
	s := newCore(t)
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "ping"}, "")
	r := resp.(map[string]any)
	if _, ok := r["result"]; !ok {
		t.Fatalf("ping sin result: %v", r)
	}
}

// PC-03 — tools/list devuelve copia (mutar no afecta el server).
func TestToolsList_Copy(t *testing.T) {
	s := newCore(t)
	s.RegisterTool(Tool{Name: "vlp_listTabs", Description: "d", InputSchema: map[string]any{"type": "object"}})
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "tools/list"}, "")
	tools := resp.(map[string]any)["result"].(map[string]any)["tools"].([]map[string]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %d, want 1", len(tools))
	}
	tools[0]["name"] = "mutado"
	resp2, _ := s.HandleRequest(map[string]any{"id": 2, "method": "tools/list"}, "")
	tools2 := resp2.(map[string]any)["result"].(map[string]any)["tools"].([]map[string]any)
	if tools2[0]["name"] != "vlp_listTabs" {
		t.Fatalf("tools/list debe devolver copia; got %s", tools2[0]["name"])
	}
}

// PC-04 — tools/call sin name.
func TestCallTool_NameRequired(t *testing.T) {
	s := newCore(t)
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{}}, "")
	err := resp.(map[string]any)["error"].(map[string]any)
	if codeOf(err) != -32602 || err["message"] != "Tool name is required" {
		t.Fatalf("error = %v, want -32602 Tool name is required", err)
	}
}

// PC-05 — tools/call tool desconocida.
func TestCallTool_Unknown(t *testing.T) {
	s := newCore(t)
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": "nope"}}, "")
	err := resp.(map[string]any)["error"].(map[string]any)
	if codeOf(err) != -32602 || err["message"] != "Unknown tool: nope" {
		t.Fatalf("error = %v, want -32602 Unknown tool: nope", err)
	}
}

// PC-06 — tools/call éxito (content JSON) y handler que lanza → -32000.
func TestCallTool_Handler(t *testing.T) {
	s := newCore(t)
	s.RegisterTool(Tool{
		Name: "ok_tool", Description: "d", InputSchema: map[string]any{},
		Handler: func(params map[string]any, token string) (any, error) {
			return map[string]any{"sent": true, "token": token}, nil
		},
	})
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": "ok_tool", "arguments": map[string]any{}}}, "tok9")
	res := resp.(map[string]any)["result"].(map[string]any)
	content := res["content"].([]any)[0].(map[string]any)
	if content["type"] != "text" {
		t.Fatalf("content type = %v", content["type"])
	}
	var inner map[string]any
	_ = json.Unmarshal([]byte(content["text"].(string)), &inner)
	if inner["sent"] != true || inner["token"] != "tok9" {
		t.Fatalf("result = %v, want {sent:true, token: tok9}", inner)
	}

	// handler que lanza → -32000
	s.RegisterTool(Tool{
		Name: "boom_tool", Description: "d", InputSchema: map[string]any{},
		Handler: func(params map[string]any, token string) (any, error) {
			return nil, &simpleErr{strings.NewReplacer().Replace("no extension connected")}
		},
	})
	resp2, _ := s.HandleRequest(map[string]any{"id": 2, "method": "tools/call", "params": map[string]any{"name": "boom_tool"}}, "")
	err := resp2.(map[string]any)["error"].(map[string]any)
	if codeOf(err) != -32000 {
		t.Fatalf("error code = %v, want -32000", err["code"])
	}
}

// PC-07 — method not found + notificación (sin id).
func TestMethodNotFound_Notification(t *testing.T) {
	s := newCore(t)
	resp, ok := s.HandleRequest(map[string]any{"id": 1, "method": "frobnicate"}, "")
	if !ok {
		t.Fatal("método desconocido con id debe responder")
	}
	err := resp.(map[string]any)["error"].(map[string]any)
	if codeOf(err) != -32601 {
		t.Fatalf("code = %v, want -32601", err["code"])
	}

	// notificación: sin id → sin respuesta (HTTP 202 en 007)
	_, ok2 := s.HandleRequest(map[string]any{"jsonrpc": "2.0", "method": "ping"}, "")
	if ok2 {
		t.Fatal("notificación sin id no debe responder")
	}
}

// PC-08 — error interno → -32603 (handler con panic interno).
func TestInternalError(t *testing.T) {
	s := newCore(t)
	s.RegisterTool(Tool{
		Name: "panic_tool", Description: "d", InputSchema: map[string]any{},
		Handler: func(params map[string]any, token string) (any, error) {
			panic("boom interno")
		},
	})
	resp, _ := s.HandleRequest(map[string]any{"id": 1, "method": "tools/call", "params": map[string]any{"name": "panic_tool"}}, "")
	if _, hasErr := resp.(map[string]any)["error"]; !hasErr {
		t.Fatal("esperaba error")
	}
}

// PC-09 — registerTool fail-fast.
func TestRegisterTool_FailFast(t *testing.T) {
	s := newCore(t)
	defer func() {
		if recover() == nil {
			t.Fatal("registerTool con name inválido debe paniquear (fail-fast)")
		}
	}()
	s.RegisterTool(Tool{Name: "", Description: "d"})
}
