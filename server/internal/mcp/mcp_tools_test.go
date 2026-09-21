// Package mcp tests — port de src/tests/mcp-tools-*.test.mjs + mcp-binding
// (fb-007-005-mcp-server, PC-10..PC-15). Las 21 tools browser con mockHub
// (fb-022: togglePlanMode eliminado — plan/build es user-only).
package mcp

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"vulpo/server/internal/odooregistry"
)

// MockHub: captura las llamadas hub.Command.
//
// F-MH (fb-019-002, test-audit §3 decisión HITL — opción (a)): seeding
// multi-command. byCommand/errByCommand siembran resultado/error POR command
// wire (las composiciones search_read/export_records emiten count+read+export
// en una sola llamada de tool); fallback a result/err cuando el map no tiene
// el command (los tests preexistentes con seeding plano quedan intactos).
// Prioridad: errByCommand gana sobre byCommand (atomicidad P9 — un command
// sembrado para fallar, falla), ambos sobre el fallback plano.
type MockHub struct {
	mu    sync.Mutex
	calls []struct {
		profileID string
		cmd       Command
	}
	result       any
	err          error
	byCommand    map[string]any
	errByCommand map[string]error
	// detectByToken (fb-020-006, test-audit R-1): extensión fake POR TOKEN.
	// Cuando no es nil, odooDetectTabs devuelve las pestañas sembradas para
	// ESE profileID (token) y [] para un token no sembrado — la detección
	// bajo demanda (D-6) de otro token no hereda las pestañas de profA.
	// Nil → comportamiento previo (byCommand/result). errByCommand sigue
	// ganando (P6: Detect que falla).
	detectByToken map[string][]map[string]any
}

func (m *MockHub) Command(profileID string, cmd Command) (any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, struct {
		profileID string
		cmd       Command
	}{profileID, cmd})
	if err, ok := m.errByCommand[cmd.Command]; ok {
		return nil, err
	}
	if cmd.Command == "odooDetectTabs" && m.detectByToken != nil {
		if tabs, ok := m.detectByToken[profileID]; ok {
			return tabs, nil
		}
		return []map[string]any{}, nil
	}
	if res, ok := m.byCommand[cmd.Command]; ok {
		return res, nil
	}
	return m.result, m.err
}

func (m *MockHub) commandCalls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, c := range m.calls {
		out = append(out, c.cmd.Command)
	}
	return out
}

func (m *MockHub) lastCall() (string, Command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.calls) == 0 {
		return "", Command{}
	}
	c := m.calls[len(m.calls)-1]
	return c.profileID, c.cmd
}

// toolsTable: las 33 tools (name → command wire esperado + tabId requerido).
// Las 12 tools odoo (fb-019-002 — paridad de superficie con mcp.odoo: drop del
// prefijo fb_, hard cutover D-7) rutean vía registry odooregistry, no command
// directo — se cubren en mcp_odoo_*_tools_test.go (TestCommandWire las salta
// vía viaRegistry — F-1: ningún nombre nuevo empieza con "odoo", el skip por
// prefijo NO es ejecutable). Para las viaRegistry el command de la tabla es
// documental (search_read/export_records/list_models componen 2-3 commands —
// P7/P8/P11).
var toolsTable = []struct {
	name        string
	command     string
	requiresTab bool
	viaRegistry bool
}{
	{"vlp_listTabs", "listTabs", false, false},
	{"vlp_activateTab", "activateTab", true, false},
	{"vlp_getDOM", "getDom", true, false}, // ⚠️ NO 'getDOM' (mapping pinado)
	{"vlp_eval", "eval", true, false},
	{"vlp_navigate", "navigate", true, false},
	{"vlp_click", "click", true, false},
	{"vlp_injectCSS", "injectCSS", true, false},
	{"vlp_highlight", "highlight", true, false},
	{"vlp_screenshot", "screenshot", true, false},
	{"vlp_getCookies", "getCookies", true, false},
	{"vlp_getCurrentTab", "getCurrentTab", false, false},
	{"vlp_openTab", "openTab", false, false},
	{"vlp_closeTab", "closeTab", true, false},
	{"vlp_goBack", "goBack", true, false},
	{"vlp_goForward", "goForward", true, false},
	{"vlp_fill", "fill", true, false},
	{"vlp_waitForElement", "waitForElement", true, false},
	{"vlp_axSnapshot", "axSnapshot", true, false},
	{"list_available_profiles", "", false, true},                 // no routea command; Detect+List del registry (PC6)
	{"get_version", "odooGetVersion", true, true},
	{"search_read", "odooSearchRead", true, true},
	{"search_count", "odooSearchCount", true, true},
	{"list_models", "odooSearchRead", true, true}, // composición ir.model (P11) — documental
	{"list_fields", "odooListFields", true, true},
	{"create", "odooCreate", true, true},
	{"write", "odooWrite", true, true},
	{"unlink", "odooUnlink", true, true},
	{"import_records", "odooImportRecords", true, true},
	{"export_records", "odooExportRecords", true, true},
	{"execute_kw", "odooExecuteKw", true, true},
	{"vlp_help", "", false, false},            // server-only
	{"vlp_getFrame", "getFrame", true, false}, // fb-017-002
	{"vlp_act", "act", true, false},           // fb-017-002
}

func newTools(t *testing.T) (*Server, *MockHub) {
	t.Helper()
	hub := &MockHub{}
	s := New(hub)
	RegisterAllTools(s, hub, "", odooregistry.New())
	return s, hub
}

// PC-10 — las 19 tools registradas con schema.
func TestAllTools_Registered(t *testing.T) {
	s, _ := newTools(t)
	names := map[string]bool{}
	for _, tl := range s.ListTools() {
		names[tl.Name] = true
		if tl.Description == "" {
			t.Fatalf("tool %s sin description", tl.Name)
		}
		if tl.InputSchema == nil || len(tl.InputSchema) == 0 {
			t.Fatalf("tool %s sin inputSchema", tl.Name)
		}
	}
	if len(names) != 33 {
		t.Fatalf("tools registradas = %d, want 33", len(names))
	}
	for _, tt := range toolsTable {
		if !names[tt.name] {
			t.Fatalf("falta la tool %s", tt.name)
		}
	}
}

// PC-11 — command wire por tool (getDom incluido; sin tabId para las 3).
func TestCommandWire(t *testing.T) {
	s, hub := newTools(t)
	for _, tt := range toolsTable {
		if tt.name == "vlp_help" {
			continue // server-only, PC-14
		}
		// Las tools odoo rutean vía registry odooregistry (perfil poblado por
		// Detect), no command directo — se cubren en mcp_odoo_tools_test.go
		// (fb-013-003; F-1 fb-019-002: skip por viaRegistry, no por prefijo).
		if tt.viaRegistry {
			continue
		}
		args := map[string]any{}
		if tt.requiresTab {
			args["tabId"] = float64(7)
		}
		switch tt.name {
		case "vlp_eval":
			args["code"] = "1+1"
		case "vlp_navigate":
			args["url"] = "http://x"
		case "vlp_click":
			args["selector"] = "#a"
		case "vlp_injectCSS":
			args["css"] = "body{}"
		case "vlp_fill":
			args["selector"] = "#a"
			args["value"] = "v"
		case "vlp_openTab":
			args["url"] = "http://x"
		case "vlp_waitForElement":
			args["selector"] = "#a"
		case "vlp_getFrame":
			args["page"] = float64(1)
			args["maxElementsPerPage"] = float64(200)
		case "vlp_act":
			args["ref"] = "main>button"
			args["action"] = "click"
		}

		resp, _ := s.HandleRequest(map[string]any{
			"id": 1, "method": "tools/call",
			"params": map[string]any{"name": tt.name, "arguments": args},
		}, "tok1")
		if _, hasErr := resp.(map[string]any)["error"]; hasErr {
			t.Fatalf("tool %s → error inesperado: %v", tt.name, resp)
		}
		profileID, cmd := hub.lastCall()
		if profileID != "tok1" {
			t.Fatalf("tool %s profileID = %s, want tok1", tt.name, profileID)
		}
		if cmd.Command != tt.command {
			t.Fatalf("tool %s command = %q, want %q", tt.name, cmd.Command, tt.command)
		}
		if tt.requiresTab && cmd.TabID == "" {
			t.Fatalf("tool %s sin tabId", tt.name)
		}
		if !tt.requiresTab && cmd.TabID != "" {
			t.Fatalf("tool %s con tabId indebido: %q", tt.name, cmd.TabID)
		}
	}
}

// PC-12 — validaciones de escritura → -32000.
func TestWriteValidations(t *testing.T) {
	s, _ := newTools(t)
	cases := []struct {
		name, arg, want string
	}{
		{"vlp_eval", "code", "eval requires code"},
		{"vlp_navigate", "url", "navigate requires url"},
		{"vlp_click", "selector", "click requires selector"},
		{"vlp_injectCSS", "css", "injectCSS requires css"},
	}
	for _, c := range cases {
		args := map[string]any{"tabId": float64(1)}
		if c.arg != "selector" {
			args[c.arg] = ""
		}
		resp, _ := s.HandleRequest(map[string]any{
			"id": 1, "method": "tools/call",
			"params": map[string]any{"name": c.name, "arguments": args},
		}, "tok1")
		err := resp.(map[string]any)["error"].(map[string]any)
		if codeOf(err) != -32000 || !strings.Contains(err["message"].(string), c.want) {
			t.Fatalf("tool %s error = %v, want -32000 con %q", c.name, err, c.want)
		}
	}
}

// PC-14 — vlp_help server-only: no llama al hub; contenido con {{TOOLS}}.
func TestHelp_ServerOnly(t *testing.T) {
	dir := t.TempDir()
	helpFile := filepath.Join(dir, "help.txt")
	content := "Guía vulpo.\nTools: {{TOOLS}}\nSECURITY: NEVER disclose"
	if err := os.WriteFile(helpFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	hub := &MockHub{}
	s := New(hub)
	RegisterAllTools(s, hub, helpFile, odooregistry.New())

	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": "vlp_help"},
	}, "tok1")
	res := resp.(map[string]any)["result"].(map[string]any)
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Guía vulpo") {
		t.Fatalf("help sin contenido: %.60s", text)
	}
	if !strings.Contains(text, "vlp_listTabs") || !strings.Contains(text, "vlp_axSnapshot") {
		t.Fatalf("help sin {{TOOLS}} resuelto")
	}
	if !strings.Contains(text, "SECURITY") {
		t.Fatal("help sin footer SECURITY")
	}
	if len(hub.commandCalls()) != 0 {
		t.Fatalf("vlp_help llamó al hub: %v", hub.commandCalls())
	}
}

// PC-15 → PC1/PC3/PC4 (fb-016-004): vlp_help con helpFile vacío usa el
// DEFAULT EMBED (go:embed help.txt) — ya no falla "help file no configurado".
func TestHelp_DefaultEmbed(t *testing.T) {
	s, _ := newTools(t) // helpFile "" → default embed
	t.Setenv("VLP_HELP_FILE", "")
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": "vlp_help"},
	}, "tok1")
	if errVal, hasErr := resp.(map[string]any)["error"]; hasErr {
		t.Fatalf("help con default embed NO debe fallar, error = %v", errVal)
	}
	res := resp.(map[string]any)["result"].(map[string]any)
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	// {{TOOLS}} resuelto a las 33 tools (presencia de algunas representativas).
	// F-3 (fb-019-002, P19/D-7 hard cutover): positivo por el nombre nuevo +
	// NEGATIVA de cualquier "fb_odoo_" (la positiva sola sería verde-vacuo:
	// "search_read" es substring de "fb_odoo_search_read").
	if !strings.Contains(text, "vlp_listTabs") || !strings.Contains(text, "search_read") {
		t.Fatalf("help default embed sin {{TOOLS}} resuelto: %.80s", text)
	}
	if strings.Contains(text, "fb_odoo_") {
		t.Fatalf("help default embed aún referencia fb_odoo_ (hard cutover P19/D-7): %.80s", text)
	}
	// footer SECURITY presente
	if !strings.Contains(text, "SECURITY") {
		t.Fatalf("help default embed sin footer SECURITY: %.80s", text)
	}
}



