// Package mcp tests — sub-fase RED, feature fb-013-005-execute-financials.
//
// Verifica las postcondiciones Go HARD del spec
// (docs/specs/fb-013-005-execute-financials/spec.md, PC2-PC7) para la tool
// MCP odoo de EJECUCIÓN (`execute_kw`)
// + el wiring WRITE_TOOLS de la extensión. Mapeo completo en test-audit.md §5.
// fb-019-002 renombra la tool (drop del prefijo fb_ — hard cutover D-7).
// Nota: `fb_odoo_get_financial_report` fue removida (2026-08-27, decisión del
// operador: caso de uso externo, fuera del alcance de vulpo).
package mcp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// --- PC2: execute_kw rutea odooExecuteKw con el TOKEN PROPIETARIO + relay. ---

func TestExecuteKwTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "execute_kw")

	hub.result = float64(3) // search_count → número
	res, err := callOdooTool(t, s, "execute_kw", map[string]any{
		"profile": "7",
		"model":   "ir.model",
		"method":  "search_count",
		"args":    []any{[]any{}},
		"kwargs":  map[string]any{},
	}, "profA")
	if err != nil {
		t.Fatalf("execute_kw error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("execute_kw profileID = %q, want propietario profA (no el token MCP tok1)", profileID)
	}
	if cmd.Command != "odooExecuteKw" {
		t.Fatalf("execute_kw command = %q, want odooExecuteKw", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("execute_kw TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("execute_kw Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "ir.model" {
		t.Fatalf("execute_kw Params.model = %v, want ir.model", cmd.Params["model"])
	}
	if cmd.Params["method"] != "search_count" {
		t.Fatalf("execute_kw Params.method = %v, want search_count", cmd.Params["method"])
	}
	if cmd.Params["args"] == nil {
		t.Fatal("execute_kw Params.args nil")
	}
	if cmd.Params["kwargs"] == nil {
		t.Fatal("execute_kw Params.kwargs nil")
	}
	var count float64
	resultJSON(t, res, &count)
	if count != 3 {
		t.Fatalf("execute_kw relay = %v, want 3", count)
	}
}

// --- PC4: sin profile → resuelve el PRIMER perfil activo (shared resolve de 003). ---

func TestExecuteTool_ResolvesFirstActiveProfile(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "execute_kw")

	hub.result = float64(0)
	if _, err := callOdooTool(t, s, "execute_kw", map[string]any{
		"model": "ir.model", "method": "search_count", "args": []any{[]any{}},
	}, "profA"); err != nil {
		t.Fatalf("execute_kw sin profile error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("profileID = %q, want profA (token del llamador)", profileID)
	}
	if cmd.Command != "odooExecuteKw" {
		t.Fatalf("command = %q, want odooExecuteKw", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("TabID = %q, want 7 (primer perfil activo, no el 9 inactivo)", cmd.TabID)
	}
}

// --- PC5: sin perfil activo → error, sin ruteear. ---

func TestExecuteTool_NoActiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{}) // sin tabs activos
	requireTool(t, s, "execute_kw")

	msg := callOdooToolError(t, s, "execute_kw", map[string]any{
		"model": "ir.model", "method": "search_count", "args": []any{[]any{}},
	}, "profA")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooExecuteKw") {
		t.Fatal("no debe ruteear odooExecuteKw sin perfil activo")
	}
}

// --- PC5: profile apunta a un tab inactivo → error, sin ruteear. ---

func TestExecuteTool_InactiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "execute_kw")

	msg := callOdooToolError(t, s, "execute_kw", map[string]any{
		"profile": "9", "model": "ir.model", "method": "search_count", "args": []any{[]any{}},
	}, "tok1")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooExecuteKw") {
		t.Fatal("no debe ruteear odooExecuteKw hacia un tab inactivo")
	}
}

// --- PC6: args requeridos validados en el handler (method). ---

func TestExecuteTool_ArgValidations(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "execute_kw")

	cases := []struct {
		name string
		tool string
		args map[string]any
		want string
	}{
		{"execute_kw sin method", "execute_kw",
			map[string]any{"profile": "7", "model": "ir.model", "args": []any{[]any{}}},
			"requires method"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			msg := callOdooToolError(t, s, c.tool, c.args, "tok1")
			if !strings.Contains(msg, c.want) {
				t.Fatalf("%s error = %q, want contener %q", c.tool, msg, c.want)
			}
		})
	}
	if hasCommandName(hub, "odooExecuteKw") {
		t.Fatal("validaciones de args no deben ruteear ningún command")
	}
}

// --- PC7: WRITE_TOOLS de background.js contiene odooExecuteKw. ---

func TestExecuteTools_BackgroundWiring(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("no se pudo obtener la ruta del archivo de test")
	}
	dir := filepath.Dir(file)
	var bgPath string
	for {
		candidate := filepath.Join(dir, "extension", "background.js")
		if _, err := os.Stat(candidate); err == nil {
			bgPath = candidate
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if bgPath == "" {
		t.Fatal("no se encontró src/extension/background.js (walk-up desde el paquete mcp)")
	}

	data, err := os.ReadFile(bgPath)
	if err != nil {
		t.Fatalf("leer %s: %v", bgPath, err)
	}
	content := string(data)
	commands := []string{"odooExecuteKw"}
	for _, c := range commands {
		if !strings.Contains(content, c) {
			t.Fatalf("WRITE_TOOLS de background.js (%s) no contiene %q (PC7)", bgPath, c)
		}
	}
}
