// Package mcp tests — sub-fase RED, feature fb-013-003-metadata-read-tools.
//
// Verifica las postcondiciones Go HARD del spec
// (docs/specs/fb-013-003-metadata-read-tools/spec.md, PC1-PC8 + PC11) para las
// tools MCP odoo de metadatos/lectura + el wiring al registry `odooregistry`
// (fb-013-002). Mapeo completo en test-audit.md §5. fb-019-002 renombra las 12
// tools (drop del prefijo fb_, hard cutover D-7 — paridad mcp.odoo) y reescribe
// el contrato de composición de search_read (P7: count+read → envelope).
//
// En RED estas tools NO existen aún y RegisterAllTools todavía tiene 3 params.
// El orquestador crea un stub GREEN (RegisterAllTools con 4 params + tools
// stub que devuelven "no implementado") para que estos tests compilen y fallen
// por AssertionError; GREEN después los hace pasar. Los tests describen el
// CONTRATO observable:
//
//	PC1  — 6 tools registradas con Name/Description/InputSchema; total 20→26.
//	PC2  — read tools rutean con el TOKEN PROPIETARIO (de registry.Lookup).
//	PC3  — sin profile → resuelve el PRIMER perfil activo.
//	PC4  — sin perfil activo → error "No Odoo tab detected...", sin ruteear.
//	PC5  — profile apunta a tab inactivo → mismo error, sin ruteear.
//	PC6  — list_available_profiles emite odooDetectTabs y devuelve la lista.
//	PC7  — error del hub se propaga (no lista vacía).
//	PC8  — un único registry compartido: detect → read tools rutean sin re-detect.
//	PC11 — sin Odoo → lista vacía, sin error.
package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"vulpo/server/internal/odooregistry"
)

// odooToolsTable: las 12 tools odoo registradas (PC1; fb-019-002: nombres
// EXACTOS de mcp.odoo — P1, sin prefijo fb_).
var odooToolsTable = []string{
	"list_available_profiles",
	"get_version",
	"search_read",
	"search_count",
	"list_models",
	"list_fields",
	"create",
	"write",
	"unlink",
	"import_records",
	"export_records",
	"execute_kw",
}

// requireTool: guard transversal de fb-019-002 (F-4, test-audit §3). Al inicio
// de cada test odoo renombrado/nuevo: falla con la razón honesta si la tool no
// está en tools/list (RED: "tool no registrada — P1" para TODOS; GREEN: no-op).
// Sin este guard, un test renombrado podría aprobar por la razón equivocada
// (p.ej. el cross-tenant aprueba el rechazo-por-tool-inexistente).
func requireTool(t *testing.T, s *Server, name string) {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == name {
			return
		}
	}
	t.Fatalf("tool %q no registrada en tools/list — RED de fb-019-002 (P1)", name)
}

// lastNCommands: los últimos n commands emitidos al hub (las composiciones de
// fb-019-002 emiten varios commands por llamada; el seedDetect emite
// odooDetectTabs antes — los asserts "EXACTAMENTE ..." miran solo la cola).
func lastNCommands(hub *MockHub, n int) []string {
	calls := hub.commandCalls()
	if len(calls) > n {
		calls = calls[len(calls)-n:]
	}
	return calls
}

// newOdooTools: Server MCP con las 22 vlp_* + las 12 tools odoo (003+004+005,
// renombradas por fb-019-002) y un único registry odooregistry compartido (PC8).
// NO siembra el registry: cada test controla el estado vía seedDetect o vía la
// tool list_available_profiles.
func newOdooTools(t *testing.T) (*Server, *MockHub, *odooregistry.Registry) {
	t.Helper()
	hub := &MockHub{}
	reg := odooregistry.New()
	s := New(hub)
	RegisterAllTools(s, hub, "", reg)
	return s, hub, reg
}

// seedDetect: puebla el registry con los perfiles dados bajo profileID, vía
// registry.Detect + un adaptador de test sobre MockHub.
func seedDetect(t *testing.T, hub *MockHub, reg *odooregistry.Registry, profileID string, profiles []map[string]any) {
	t.Helper()
	hub.result = profiles
	// fb-020-006 (R-1): la extensión fake recuerda las pestañas POR TOKEN, así
	// una detección bajo demanda (D-6) repite este mismo estado para profileID
	// y devuelve [] para cualquier otro token (I-2).
	if hub.detectByToken == nil {
		hub.detectByToken = map[string][]map[string]any{}
	}
	hub.detectByToken[profileID] = profiles
	if err := reg.Detect(profileID, testOdooHubAdapter{hub: hub}); err != nil {
		t.Fatalf("seedDetect(%s): %v", profileID, err)
	}
}

// testOdooHubAdapter: doble de test que convierte mcp.Hub (MockHub) →
// odooregistry.Hub, SOLO para sembrar el registry en tests. El adaptador de
// PRODUCCIÓN lo provee GREEN.
type testOdooHubAdapter struct {
	hub *MockHub
}

func (a testOdooHubAdapter) Command(profileID string, cmd odooregistry.Command) (any, error) {
	return a.hub.Command(profileID, Command{Command: cmd.Command, Params: cmd.Params, TabID: cmd.TabID})
}

// profileTab7 / profileTab9: representación wire (map JSON) de un OdooTabProfile.
func profileTab7() map[string]any {
	return map[string]any{
		"tabId": 7, "url": "http://127.0.0.1:8078", "db": "demo",
		"version": "18.0", "uid": 2, "username": "admin",
		"is_superuser": true, "is_active": true,
	}
}

func profileTab9() map[string]any {
	return map[string]any{
		"tabId": 9, "url": "http://127.0.0.1:8078", "db": "demo",
		"version": "18.0", "uid": 3, "username": "demo",
		"is_superuser": false, "is_active": true,
	}
}

// --- helpers de invocación MCP (mismo patrón que mcp_tools_test.go) ---

func callOdooTool(t *testing.T, s *Server, name string, args map[string]any, token string) (map[string]any, error) {
	t.Helper()
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	}, token)
	m, ok := resp.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("resp inesperada %T", resp)
	}
	if errVal, hasErr := m["error"]; hasErr {
		return nil, fmt.Errorf("%v", errVal)
	}
	res, ok := m["result"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("result no es map: %T", m["result"])
	}
	return res, nil
}

func callOdooToolError(t *testing.T, s *Server, name string, args map[string]any, token string) string {
	t.Helper()
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	}, token)
	m := resp.(map[string]any)
	errVal, hasErr := m["error"]
	if !hasErr {
		t.Fatalf("tool %s no devolvió error esperado: %v", name, resp)
	}
	em := errVal.(map[string]any)
	msg, _ := em["message"].(string)
	return msg
}

func resultJSON(t *testing.T, res map[string]any, out any) {
	t.Helper()
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	if err := json.Unmarshal([]byte(text), out); err != nil {
		t.Fatalf("unmarshal result text: %v", err)
	}
}

func hasCommandName(hub *MockHub, name string) bool {
	for _, c := range hub.commandCalls() {
		if c == name {
			return true
		}
	}
	return false
}

func countCommand(hub *MockHub, name string) int {
	n := 0
	for _, c := range hub.commandCalls() {
		if c == name {
			n++
		}
	}
	return n
}

// --- PC1: las 12 tools odoo registradas; total 34 (fb-019-002: nombres sin prefijo). ---

func TestOdooTools_AllRegistered(t *testing.T) {
	s, _, _ := newOdooTools(t)
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
		t.Fatalf("tools registradas = %d, want 33 (21 vlp_* + 12 odoo renombradas fb-019-002)", len(names))
	}
	for _, name := range odooToolsTable {
		if !names[name] {
			t.Fatalf("falta la tool %s", name)
		}
	}
}

// --- PC2: read tools rutean con el TOKEN PROPIETARIO (de registry.Lookup) y
//          relayan el resultado; subtests para search_count/list_models/
//          list_fields/get_version. ---

func TestSearchRead_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")

	// PC1 — cross-tenant: tab 7 pertenece a profA, llamador es token "tok1".
	// Bajo el contrato TokenTenant (fb-016-003), un profile de OTRO tenant se
	// REECHAZA sin ruteear (anti-probing: mensaje no revela el perfil ajeno).
	errMsg := callOdooToolError(t, s, "search_read", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"domain":  []any{},
		"fields":  []any{"id", "name"},
	}, "tok1")
	if errMsg == "" {
		t.Fatal("search_read cross-tenant debería rechazar, no devolvió error")
	}
	if strings.Contains(errMsg, "profA") || strings.Contains(errMsg, "7") {
		t.Fatalf("search_read error revela el perfil ajeno (anti-probing): %q", errMsg)
	}
	if hasCommandName(hub, "odooSearchRead") {
		t.Fatalf("search_read cross-tenant NO debe ruteear la tool, commands = %v", hub.commandCalls())
	}
}

// PC2 — mismo tenant: tab 7 pertenece al token del llamador (profA) → rutea.
// fb-019-002 P7: search_read compone EXACTAMENTE 2 commands wire
// (odooSearchCount con el mismo model+domain → total real, I-5/NUNCA len(records)
// + odooSearchRead) y la respuesta es el envelope §2.2 (fórmulas pineadas vivo:
// has_more = (offset+len) < total; next_offset = offset+limit).
func TestSearchRead_RoutesOwnerToken_SameTenant(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")

	readRecords := []any{
		map[string]any{"id": float64(1), "name": "alpha"},
		map[string]any{"id": float64(2), "name": "beta"},
	}
	hub.byCommand = map[string]any{
		"odooSearchCount": float64(5),
		"odooSearchRead":  readRecords,
	}
	res, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"domain":  "[('name','ilike','a')]",
		"fields":  "id,name",
		"limit":   float64(2),
		"offset":  float64(0),
	}, "profA")
	if err != nil {
		t.Fatalf("search_read error: %v", err)
	}

	// P7: EXACTAMENTE 2 commands — count primero (§9), read después; ambos con
	// el mismo model+domain parseado (§2.4).
	got := lastNCommands(hub, 2)
	if len(got) != 2 || got[0] != "odooSearchCount" || got[1] != "odooSearchRead" {
		t.Fatalf("search_read commands = %v, want [odooSearchCount odooSearchRead]", got)
	}
	countCmd := hub.calls[len(hub.calls)-2].cmd
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("search_read profileID = %q, want profA (token == owner)", profileID)
	}
	if cmd.TabID != "7" {
		t.Fatalf("search_read TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("search_read Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	wantDomain := []any{[]any{"name", "ilike", "a"}}
	if !reflect.DeepEqual(countCmd.Params["model"], "res.partner") || !reflect.DeepEqual(countCmd.Params["domain"], wantDomain) {
		t.Fatalf("odooSearchCount Params = %v, want model res.partner + domain %v (mismo model+domain que el read — P7)", countCmd.Params, wantDomain)
	}
	if !reflect.DeepEqual(cmd.Params["model"], "res.partner") || !reflect.DeepEqual(cmd.Params["domain"], wantDomain) {
		t.Fatalf("odooSearchRead Params model/domain = %v/%v, want res.partner/%v", cmd.Params["model"], cmd.Params["domain"], wantDomain)
	}

	// P7: envelope §2.2 con total real (5) — no derivado de len(records).
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["total"] != float64(5) {
		t.Fatalf("envelope total = %v, want 5 (total real del count — I-5)", inner["total"])
	}
	if inner["limit"] != float64(2) || inner["offset"] != float64(0) {
		t.Fatalf("envelope limit/offset = %v/%v, want 2/0", inner["limit"], inner["offset"])
	}
	if inner["has_more"] != true {
		t.Fatalf("envelope has_more = %v, want true (0+2 < 5)", inner["has_more"])
	}
	if inner["next_offset"] != float64(2) {
		t.Fatalf("envelope next_offset = %v, want 2 (offset+limit — fórmula viva §2.2)", inner["next_offset"])
	}
	if inner["format"] != "json" {
		t.Fatalf("envelope format = %v, want json", inner["format"])
	}
	recs, ok := inner["records"].([]any)
	if !ok || !reflect.DeepEqual(recs, readRecords) {
		t.Fatalf("envelope records = %v, want %v", inner["records"], readRecords)
	}

	subtests := []struct {
		name, tool, command string
		args                map[string]any
		result              any
	}{
		{"search_count", "search_count", "odooSearchCount",
			map[string]any{"profile": "7", "model": "res.partner", "domain": []any{}},
			float64(3)},
		{"list_models", "list_models", "odooSearchRead", // composición ir.model (P11) — el command cambia
			map[string]any{"profile": "7"},
			[]any{map[string]any{"id": float64(1), "name": "Contacts", "model": "res.partner", "info": "x"}}},
		{"list_fields", "list_fields", "odooListFields", // queda (P12: sin attributes → wire SIN la clave)
			map[string]any{"profile": "7", "model": "res.partner"},
			map[string]any{"name": map[string]any{"string": "Name", "type": "char", "required": false}}},
		{"get_version", "get_version", "odooGetVersion",
			map[string]any{"profile": "7"},
			map[string]any{"version": "18.0"}},
	}
	for _, tt := range subtests {
		t.Run(tt.name, func(t *testing.T) {
			requireTool(t, s, tt.tool)
			hub.byCommand = nil
			hub.errByCommand = nil
			hub.result = tt.result
			if _, err := callOdooTool(t, s, tt.tool, tt.args, "profA"); err != nil {
				t.Fatalf("%s error: %v", tt.tool, err)
			}
			profileID, cmd := hub.lastCall()
			if profileID != "profA" {
				t.Fatalf("%s profileID = %q, want propietario profA", tt.tool, profileID)
			}
			if cmd.Command != tt.command {
				t.Fatalf("%s command = %q, want %q", tt.tool, cmd.Command, tt.command)
			}
			if cmd.TabID != "7" {
				t.Fatalf("%s TabID = %q, want 7", tt.tool, cmd.TabID)
			}
			if tt.tool == "list_fields" {
				if _, hasAttrs := cmd.Params["attributes"]; hasAttrs {
					t.Fatalf("list_fields sin attributes → wire SIN la clave attributes (P12/D-9: el default vive en la extensión), Params = %v", cmd.Params)
				}
			}
		})
	}
}

// --- PC3: sin profile → resuelve el PRIMER perfil activo. ---

func TestReadTool_ResolvesFirstActiveProfile(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "search_read")

	hub.result = map[string]any{"records": []any{}}
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"model": "res.partner", "domain": []any{},
	}, "profA"); err != nil {
		t.Fatalf("search_read sin profile error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("profileID = %q, want profA (token del llamador)", profileID)
	}
	if cmd.Command != "odooSearchRead" {
		t.Fatalf("command = %q, want odooSearchRead", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("TabID = %q, want 7 (primer perfil activo, no el 9 inactivo)", cmd.TabID)
	}
}

// --- PC4: sin perfil activo y profile omitido → error "No Odoo tab detected...". ---

func TestReadTool_NoActiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{}) // sin tabs activos
	requireTool(t, s, "search_read")

	msg := callOdooToolError(t, s, "search_read", map[string]any{
		"model": "res.partner", "domain": []any{},
	}, "profA")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooSearchRead") {
		t.Fatal("no debe ruteear odooSearchRead sin perfil activo")
	}
}

// --- PC5: profile apunta a un tab inactivo → error, sin ruteear. ---

func TestReadTool_InactiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "search_read")

	msg := callOdooToolError(t, s, "search_read", map[string]any{
		"profile": "9", "model": "res.partner", "domain": []any{},
	}, "tok1")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooSearchRead") {
		t.Fatal("no debe ruteear odooSearchRead hacia un tab inactivo")
	}
}

// --- PC6: list_available_profiles emite odooDetectTabs y devuelve la lista. ---

func TestListAvailableProfiles_DetectThenList(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")
	hub.result = []map[string]any{profileTab7()}

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("list_available_profiles error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("profileID = %q, want profA", profileID)
	}
	if cmd.Command != "odooDetectTabs" {
		t.Fatalf("command = %q, want odooDetectTabs", cmd.Command)
	}
	var list []any
	resultJSON(t, res, &list)
	if len(list) != 1 {
		t.Fatalf("list_available_profiles devolvió %d perfiles, want 1", len(list))
	}
}

// --- PC6 (_Empty): mock devuelve [] → lista vacía, sin error. ---

func TestListAvailableProfiles_Empty(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")
	hub.result = []map[string]any{}

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("list_available_profiles (empty) error: %v", err)
	}
	var list []any
	resultJSON(t, res, &list)
	if len(list) != 0 {
		t.Fatalf("list_available_profiles devolvió %d perfiles, want 0", len(list))
	}
}

// --- PC7: error del hub (extensión no conectada) → se PROPAGA. ---

func TestListAvailableProfiles_PropagatesHubError(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")
	hub.err = errors.New("extension not connected")

	msg := callOdooToolError(t, s, "list_available_profiles", map[string]any{}, "profA")
	if !strings.Contains(msg, "extension not connected") {
		t.Fatalf("error = %q, want que propague 'extension not connected'", msg)
	}
}

// --- PC8: un único registry compartido — un tab detectado queda routable sin
//          re-detect (odooDetectTabs emitido exactamente 1 vez). ---

func TestSharedRegistry_SingleDetectRoutable(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")
	requireTool(t, s, "search_read")

	hub.result = []map[string]any{profileTab7()}
	if _, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA"); err != nil {
		t.Fatalf("list_available_profiles error: %v", err)
	}

	hub.result = map[string]any{"records": []any{map[string]any{"id": 1}}}
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"model": "res.partner", "domain": []any{},
	}, "profA"); err != nil {
		t.Fatalf("search_read (shared registry) error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if cmd.Command != "odooSearchRead" {
		t.Fatalf("command = %q, want odooSearchRead (rutea via registry compartido)", cmd.Command)
	}
	if profileID != "profA" {
		t.Fatalf("profileID = %q, want profA", profileID)
	}
	if n := countCommand(hub, "odooDetectTabs"); n != 1 {
		t.Fatalf("odooDetectTabs emitido %d veces, want 1 (sin re-detect)", n)
	}
}

// --- PC11: sin Odoo → lista vacía (no error). ---

func TestListAvailableProfiles_NoOdoo_ReturnsEmpty(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")
	hub.result = []map[string]any{}

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("list_available_profiles (no Odoo) error: %v", err)
	}
	var list []any
	resultJSON(t, res, &list)
	if len(list) != 0 {
		t.Fatalf("list_available_profiles (no Odoo) devolvió %d, want 0", len(list))
	}
}
