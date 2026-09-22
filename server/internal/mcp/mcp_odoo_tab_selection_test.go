// Package mcp tests — sub-fase RED, feature fb-020-006-orm-diagnostics-client-health.
//
// Postcondiciones del SERVER (docs/specs/fb-020-006-orm-diagnostics-client-health/spec.md
// §2.1–§2.3, §2.6): P1–P12 y P19. Todos observan la superficie MCP
// (tools/list, tools/call, initialize) contra MockHub, que hace de extensión
// fake por token (detectByToken, sembrado por seedDetect).
//
// Interfaces esperadas (declaradas para el implementer):
//   - Las 11 tools ORM declaran `tabId` en InputSchema.properties (no required).
//     El argumento acepta número JSON o string numérico.
//   - Errores ORM: `error.message` de tools/call = "<code>: <detalle>".
//   - Éxito ORM: result.content[1] = {type:"text", text:`{"odoo_tab":{...}}`}.
//   - P19: *Server expone `SetAgentKitRevision(rev string)`; con rev != "" el
//     resultado de initialize incluye `_meta["vulpo/agentKitRevision"]`.
//     (El build embebe la revisión por ldflags en una var y main llama al setter.)
package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// fb006OrmTools: las 11 tools ORM (todas las odoo salvo list_available_profiles)
// con args mínimos válidos.
func fb006OrmTools() []struct {
	name string
	args map[string]any
} {
	return []struct {
		name string
		args map[string]any
	}{
		{"get_version", map[string]any{}},
		{"search_read", map[string]any{"model": "res.partner"}},
		{"search_count", map[string]any{"model": "res.partner"}},
		{"list_models", map[string]any{}},
		{"list_fields", map[string]any{"model": "res.partner"}},
		{"create", map[string]any{"model": "res.partner", "values": map[string]any{"name": "x"}}},
		{"write", map[string]any{"model": "res.partner", "ids": []any{float64(1)}, "values": map[string]any{"name": "x"}}},
		{"unlink", map[string]any{"model": "res.partner", "ids": []any{float64(1)}}},
		{"import_records", map[string]any{"model": "res.partner", "fields": "name", "rows": []any{map[string]any{"name": "x"}}}},
		{"export_records", map[string]any{"model": "res.partner"}},
		{"execute_kw", map[string]any{"model": "res.partner", "method": "search_count", "args": []any{[]any{}}}},
	}
}

// fb006HubResults: resultados del hub por command wire para que las 11 tools
// tengan éxito.
func fb006HubResults() map[string]any {
	return map[string]any{
		"odooGetVersion":    map[string]any{"version": "18.0"},
		"odooSearchCount":   float64(1),
		"odooSearchRead":    []any{map[string]any{"id": float64(1), "name": "x"}},
		"odooListFields":    map[string]any{"name": map[string]any{"string": "Name", "type": "char"}},
		"odooCreate":        map[string]any{"id": float64(42)},
		"odooWrite":         true,
		"odooUnlink":        true,
		"odooImportRecords": map[string]any{"ids": []any{float64(12)}},
		"odooExportRecords": map[string]any{"datas": []any{}},
		"odooExecuteKw":     float64(0),
	}
}

func fb006Tab(tabID int, url, db string) map[string]any {
	return map[string]any{
		"tabId": tabID, "url": url, "db": db,
		"version": "18.0", "uid": 2, "username": "admin",
		"is_superuser": true, "is_active": true,
	}
}

func fb006WithArgs(base map[string]any, extra map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// fb006CallsSince: commands (con profileID) emitidos al hub desde el índice n.
func fb006CallsSince(hub *MockHub, n int) []Command {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	var out []Command
	for i := n; i < len(hub.calls); i++ {
		out = append(out, hub.calls[i].cmd)
	}
	return out
}

func fb006NCalls(hub *MockHub) int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return len(hub.calls)
}

func fb006OrmOnly(cmds []Command) []Command {
	var out []Command
	for _, c := range cmds {
		if c.Command != "odooDetectTabs" {
			out = append(out, c)
		}
	}
	return out
}

func fb006Names(cmds []Command) []string {
	var out []string
	for _, c := range cmds {
		out = append(out, c.Command)
	}
	return out
}

// --- P1: schema declara tabId; tabId explícito gana al candidato de menor tabId ---

func TestFb006_P1_SchemaDeclaresTabId(t *testing.T) {
	s, _, _ := newOdooTools(t)
	for _, tool := range fb006OrmTools() {
		t.Run(tool.name, func(t *testing.T) {
			tl := findToolByName(t, s, tool.name)
			props, _ := tl.InputSchema["properties"].(map[string]any)
			if _, ok := props["tabId"]; !ok {
				t.Fatalf("P1: %s InputSchema.properties sin tabId — %v", tool.name, tl.InputSchema)
			}
			if req, ok := tl.InputSchema["required"].([]any); ok {
				for _, r := range req {
					if r == "tabId" {
						t.Fatalf("P1: %s declara tabId como required (es selector opcional)", tool.name)
					}
				}
			}
		})
	}
}

func TestFb006_P1_ExplicitTabIdRoutesToThatTab(t *testing.T) {
	for _, tool := range fb006OrmTools() {
		for _, tabArg := range []any{float64(9), "9"} {
			t.Run(fmt.Sprintf("%s/tabId=%T", tool.name, tabArg), func(t *testing.T) {
				s, hub, reg := newOdooTools(t)
				seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
				hub.byCommand = fb006HubResults()
				n := fb006NCalls(hub)
				if _, err := callOdooTool(t, s, tool.name, fb006WithArgs(tool.args, map[string]any{"tabId": tabArg}), "profA"); err != nil {
					t.Fatalf("P1: %s {tabId:%v} error: %v", tool.name, tabArg, err)
				}
				orm := fb006OrmOnly(fb006CallsSince(hub, n))
				if len(orm) == 0 {
					t.Fatalf("P1: %s no envió ningún comando ORM", tool.name)
				}
				for _, c := range orm {
					if c.TabID != "9" {
						t.Fatalf("P1: %s command %s TabID = %q, want 9 (tabId explícito, aunque exista el 7)", tool.name, c.Command, c.TabID)
					}
				}
			})
		}
	}
}

// --- P2: registry vacío + extensión con 1 pestaña → search_read sin tabId OK,
//         odooDetectTabs antes del comando ORM ---

func TestFb006_P2_ColdCacheDetectsOnDemand(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	hub.detectByToken = map[string][]map[string]any{"profA": {profileTab7()}}
	hub.byCommand = fb006HubResults()

	if _, err := callOdooTool(t, s, "search_read", map[string]any{"model": "res.partner"}, "profA"); err != nil {
		t.Fatalf("P2: search_read con cache frío error: %v (commands=%v)", err, hub.commandCalls())
	}
	cmds := fb006CallsSince(hub, 0)
	if len(cmds) == 0 || cmds[0].Command != "odooDetectTabs" {
		t.Fatalf("P2: primer command = %v, want odooDetectTabs antes del ORM", fb006Names(cmds))
	}
	orm := fb006OrmOnly(cmds)
	if len(orm) == 0 {
		t.Fatalf("P2: no se envió comando ORM: %v", fb006Names(cmds))
	}
	for _, c := range orm {
		if c.TabID != "7" {
			t.Fatalf("P2: %s TabID = %q, want 7", c.Command, c.TabID)
		}
	}
}

// --- P3: registry vacío, search_count {tabId:"24"} con la 24 válida → éxito ---

func TestFb006_P3_ColdCacheExplicitStringTabId(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	hub.detectByToken = map[string][]map[string]any{
		"profA": {fb006Tab(24, "https://erp.example.com/odoo/action-12", "erpdb")},
	}
	hub.byCommand = map[string]any{"odooSearchCount": float64(3)}

	if _, err := callOdooTool(t, s, "search_count", map[string]any{"model": "res.partner", "tabId": "24"}, "profA"); err != nil {
		t.Fatalf("P3: search_count {tabId:\"24\"} con cache frío error: %v (commands=%v)", err, hub.commandCalls())
	}
	cmds := fb006CallsSince(hub, 0)
	names := fb006Names(cmds)
	if len(cmds) != 2 || names[0] != "odooDetectTabs" || names[1] != "odooSearchCount" {
		t.Fatalf("P3: commands = %v, want [odooDetectTabs odooSearchCount]", names)
	}
	if cmds[1].TabID != "24" {
		t.Fatalf("P3: TabID = %q, want 24", cmds[1].TabID)
	}
}

// --- P4: Detect devuelve [] → odoo_no_tab + "No Odoo tab detected", sin ORM ---

func TestFb006_P4_DetectEmptyNoTab(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	hub.detectByToken = map[string][]map[string]any{"profA": {}}
	hub.byCommand = fb006HubResults()

	msg := callOdooToolError(t, s, "search_read", map[string]any{"model": "res.partner"}, "profA")
	if !strings.HasPrefix(msg, "odoo_no_tab:") {
		t.Fatalf("P4: error = %q, want prefijo odoo_no_tab:", msg)
	}
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("P4: error = %q, want contener 'No Odoo tab detected'", msg)
	}
	cmds := fb006CallsSince(hub, 0)
	if countCommand(hub, "odooDetectTabs") == 0 {
		t.Fatalf("P4: el server no corrió Detect con cache vacío: %v", fb006Names(cmds))
	}
	if orm := fb006OrmOnly(cmds); len(orm) != 0 {
		t.Fatalf("P4: se enviaron comandos ORM: %v", fb006Names(orm))
	}
}

// --- P5: tabId de otro token ≡ tabId inexistente (mismo mensaje odoo_no_tab), sin ruteo ---

func TestFb006_P5_ForeignAndMissingTabIdIndistinguishable(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "tokB", []map[string]any{fb006Tab(24, "https://b.example.com/odoo", "bdb")})
	seedDetect(t, hub, reg, "tokA", []map[string]any{fb006Tab(7, "https://a.example.com/odoo", "adb")})
	hub.byCommand = fb006HubResults()

	n := fb006NCalls(hub)
	msgForeign := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner", "tabId": float64(24)}, "tokA")
	msgMissing := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner", "tabId": float64(999)}, "tokA")

	if !strings.HasPrefix(msgForeign, "odoo_no_tab:") {
		t.Fatalf("P5: tabId de otro token → %q, want prefijo odoo_no_tab:", msgForeign)
	}
	if msgForeign != msgMissing {
		t.Fatalf("P5: mensajes distinguibles:\n  otro token  = %q\n  inexistente = %q", msgForeign, msgMissing)
	}
	if orm := fb006OrmOnly(fb006CallsSince(hub, n)); len(orm) != 0 {
		t.Fatalf("P5: se enrutaron comandos ORM: %v", fb006Names(orm))
	}
}

// --- P6: Detect falla con texto X → odoo_detection_failed, contiene X, sin "No Odoo tab detected" ---

func TestFb006_P6_DetectFailureClassified(t *testing.T) {
	s, hub, _ := newOdooTools(t)
	x := "Odoo detection failed for tab 24 (session expired: re-login)"
	hub.errByCommand = map[string]error{"odooDetectTabs": errors.New(x)}

	msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
	if !strings.HasPrefix(msg, "odoo_detection_failed:") {
		t.Fatalf("P6: error = %q, want prefijo odoo_detection_failed:", msg)
	}
	if !strings.Contains(msg, x) {
		t.Fatalf("P6: error = %q, want contener el texto clasificado %q", msg, x)
	}
	if strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("P6: error = %q contiene 'No Odoo tab detected' (reservado a odoo_no_tab — I-1)", msg)
	}
}

// --- P7: sin tabId, ≥2 grupos (origin, db) → odoo_ambiguous_tab con cada candidato, sin ORM ---

func TestFb006_P7_AmbiguousGroups(t *testing.T) {
	cases := []struct {
		name  string
		tabs  []map[string]any
		wants []string
	}{
		{"origin distinto",
			[]map[string]any{
				fb006Tab(31, "http://127.0.0.1:8069/odoo/action-1", "alpha"),
				fb006Tab(45, "https://erp.example.com/web#id=3", "alpha"),
			},
			[]string{"31", "45", "http://127.0.0.1:8069", "https://erp.example.com", "alpha"}},
		{"mismo origin, db distinto",
			[]map[string]any{
				fb006Tab(31, "http://127.0.0.1:8069/odoo", "alpha"),
				fb006Tab(45, "http://127.0.0.1:8069/web", "betadb"),
			},
			[]string{"31", "45", "http://127.0.0.1:8069", "alpha", "betadb"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, hub, reg := newOdooTools(t)
			seedDetect(t, hub, reg, "profA", tc.tabs)
			hub.byCommand = fb006HubResults()
			n := fb006NCalls(hub)

			msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
			if !strings.HasPrefix(msg, "odoo_ambiguous_tab:") {
				t.Fatalf("P7: error = %q, want prefijo odoo_ambiguous_tab:", msg)
			}
			for _, w := range tc.wants {
				if !strings.Contains(msg, w) {
					t.Fatalf("P7: error = %q, want contener %q", msg, w)
				}
			}
			if orm := fb006OrmOnly(fb006CallsSince(hub, n)); len(orm) != 0 {
				t.Fatalf("P7: se envió comando ORM: %v", fb006Names(orm))
			}
		})
	}
}

// --- P8 (property: permutaciones): mismo (origin, db) → menor tabId, en cualquier orden ---

func TestFb006_P8_SameGroupLowestTabIdAnyOrder(t *testing.T) {
	tabs := []map[string]any{
		fb006Tab(12, "http://odoo.local:8069/odoo/contacts", "erpdb"),
		fb006Tab(5, "http://odoo.local:8069/web#action=1", "erpdb"),
		fb006Tab(40, "http://odoo.local:8069/odoo", "erpdb"),
	}
	perms := [][]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}}
	for _, p := range perms {
		t.Run(fmt.Sprint(p), func(t *testing.T) {
			s, hub, reg := newOdooTools(t)
			order := []map[string]any{tabs[p[0]], tabs[p[1]], tabs[p[2]]}
			seedDetect(t, hub, reg, "profA", order)
			hub.byCommand = fb006HubResults()
			n := fb006NCalls(hub)
			if _, err := callOdooTool(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA"); err != nil {
				t.Fatalf("P8: orden %v error: %v", p, err)
			}
			orm := fb006OrmOnly(fb006CallsSince(hub, n))
			if len(orm) != 1 || orm[0].TabID != "5" {
				t.Fatalf("P8: orden de detección %v → ORM %v (TabID=%v), want TabID 5 (menor tabId)", p, fb006Names(orm), orm)
			}
		})
	}
}

// --- P9: toda respuesta ORM exitosa trae content[1] = {"odoo_tab":{tabId,origin,db}}.
// (content[0] byte-idéntico: lo garantizan los tests de paridad existentes, que
// leen content[0] — mcp_odoo_parity_test.go P7/P10/P11/P12/P15/P17.) ---

func TestFb006_P9_OdooTabReportedInContent1(t *testing.T) {
	want := map[string]any{"odoo_tab": map[string]any{
		"tabId": float64(24), "origin": "https://erp.example.com:8443", "db": "erpdb",
	}}
	for _, tool := range fb006OrmTools() {
		t.Run(tool.name, func(t *testing.T) {
			s, hub, reg := newOdooTools(t)
			seedDetect(t, hub, reg, "profA", []map[string]any{
				fb006Tab(24, "https://erp.example.com:8443/odoo/action-123?debug=1", "erpdb"),
			})
			hub.byCommand = fb006HubResults()
			res, err := callOdooTool(t, s, tool.name, tool.args, "profA")
			if err != nil {
				t.Fatalf("P9: %s error: %v", tool.name, err)
			}
			content, _ := res["content"].([]any)
			if len(content) < 2 {
				t.Fatalf("P9: %s content tiene %d ítems, want ≥2 (content[1] = odoo_tab) — %v", tool.name, len(content), content)
			}
			item, _ := content[1].(map[string]any)
			if item["type"] != "text" {
				t.Fatalf("P9: %s content[1].type = %v, want text", tool.name, item["type"])
			}
			text, _ := item["text"].(string)
			var got map[string]any
			if err := json.Unmarshal([]byte(text), &got); err != nil {
				t.Fatalf("P9: %s content[1].text no es JSON: %q (%v)", tool.name, text, err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("P9: %s content[1] = %v, want %v", tool.name, got, want)
			}
		})
	}
}

// --- P10: error del hub E tras resolver T → odoo_command_failed (u odoo_tab_unreachable
//          si E ya empieza así), contiene E sin cambios + tabId, origin y db de T ---

func TestFb006_P10_HubErrorAfterResolveCategorized(t *testing.T) {
	cases := []struct {
		name, e, prefix string
	}{
		{"error RPC de Odoo", "Odoo Server Error: You are not allowed to access Contact", "odoo_command_failed:"},
		{"extensión no pudo inyectar", "odoo_tab_unreachable: tab 23: An unexpected error occurred", "odoo_tab_unreachable:"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, hub, reg := newOdooTools(t)
			seedDetect(t, hub, reg, "profA", []map[string]any{fb006Tab(23, "http://odoo.local:8069/odoo/sales", "salesdb")})
			hub.errByCommand = map[string]error{"odooSearchCount": errors.New(tc.e)}

			msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
			if !strings.HasPrefix(msg, tc.prefix) {
				t.Fatalf("P10: error = %q, want prefijo %s", msg, tc.prefix)
			}
			for _, w := range []string{tc.e, "23", "http://odoo.local:8069", "salesdb"} {
				if !strings.Contains(msg, w) {
					t.Fatalf("P10: error = %q, want contener %q", msg, w)
				}
			}
		})
	}
}

// --- P11: tras una falla P10 contra T, la siguiente llamada del mismo token corre
//          odooDetectTabs antes de enrutar; un comando ORM por llamada ---

func TestFb006_P11_RedetectAfterCommandFailure(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{fb006Tab(23, "http://odoo.local:8069/odoo", "salesdb")})

	hub.errByCommand = map[string]error{"odooSearchCount": errors.New("odoo_tab_unreachable: tab 23: An unexpected error occurred")}
	n1 := fb006NCalls(hub)
	_ = callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
	first := fb006CallsSince(hub, n1)
	if orm := fb006OrmOnly(first); len(orm) != 1 {
		t.Fatalf("P11: llamada fallida envió %d comandos ORM, want exactamente 1 (sin reintento — I-4): %v", len(orm), fb006Names(first))
	}

	hub.errByCommand = nil
	hub.byCommand = map[string]any{"odooSearchCount": float64(4)}
	n2 := fb006NCalls(hub)
	if _, err := callOdooTool(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA"); err != nil {
		t.Fatalf("P11: segunda llamada error: %v", err)
	}
	second := fb006CallsSince(hub, n2)
	names := fb006Names(second)
	if orm := fb006OrmOnly(second); len(orm) != 1 {
		t.Fatalf("P11: segunda llamada envió %d comandos ORM, want exactamente 1: %v", len(orm), names)
	}
	detectIdx, ormIdx := -1, -1
	for i, c := range second {
		if c.Command == "odooDetectTabs" && detectIdx < 0 {
			detectIdx = i
		}
		if c.Command == "odooSearchCount" && ormIdx < 0 {
			ormIdx = i
		}
	}
	if detectIdx < 0 || detectIdx > ormIdx {
		t.Fatalf("P11: tras la falla, commands = %v, want odooDetectTabs antes de odooSearchCount", names)
	}
}

// --- P12: descripciones de las tools ORM mencionan tabId, la regla de ambigüedad y odoo_tab ---

func TestFb006_P12_DescriptionsDocumentSelection(t *testing.T) {
	s, _, _ := newOdooTools(t)
	odooTabWord := regexp.MustCompile(`\bodoo_tab\b`)
	for _, tool := range fb006OrmTools() {
		t.Run(tool.name, func(t *testing.T) {
			d := findToolByName(t, s, tool.name).Description
			if !strings.Contains(d, "tabId") {
				t.Fatalf("P12: %s Description no menciona tabId: %.200s", tool.name, d)
			}
			if !strings.Contains(strings.ToLower(d), "ambiguous") {
				t.Fatalf("P12: %s Description no menciona la regla de ambigüedad (ambiguous / odoo_ambiguous_tab): %.200s", tool.name, d)
			}
			if !odooTabWord.MatchString(d) {
				t.Fatalf("P12: %s Description no menciona odoo_tab: %.200s", tool.name, d)
			}
		})
	}
}

// --- P19: initialize._meta["vulpo/agentKitRevision"] con revisión configurada ---

type fb006KitRevisionSetter interface {
	SetAgentKitRevision(rev string)
}

func fb006Initialize(t *testing.T, s *Server) map[string]any {
	t.Helper()
	resp, ok := s.HandleRequest(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}, "tok1")
	if !ok {
		t.Fatal("initialize debe responder")
	}
	res, _ := resp.(map[string]any)["result"].(map[string]any)
	si, _ := res["serverInfo"].(map[string]any)
	if si["name"] != "vulpo" || si["version"] != "0.5.2" {
		t.Fatalf("P19: serverInfo = %v, want vulpo 0.5.2 sin cambios", si)
	}
	return res
}

func TestFb006_P19_InitializeExposesAgentKitRevision(t *testing.T) {
	t.Run("con revisión", func(t *testing.T) {
		s := New(&MockHub{})
		setter, ok := any(s).(fb006KitRevisionSetter)
		if !ok {
			t.Fatal("P19: *Server no expone SetAgentKitRevision(rev string) — interfaz esperada de fb-020-006")
		}
		setter.SetAgentKitRevision("234202f")
		res := fb006Initialize(t, s)
		meta, _ := res["_meta"].(map[string]any)
		if meta["vulpo/agentKitRevision"] != "234202f" {
			t.Fatalf("P19: initialize._meta = %v, want vulpo/agentKitRevision = 234202f", res["_meta"])
		}
	})
	t.Run("sin revisión", func(t *testing.T) {
		for name, configure := range map[string]func(*Server){
			"nunca configurada": func(*Server) {},
			"revisión vacía": func(s *Server) {
				if setter, ok := any(s).(fb006KitRevisionSetter); ok {
					setter.SetAgentKitRevision("")
				}
			},
		} {
			s := New(&MockHub{})
			configure(s)
			res := fb006Initialize(t, s)
			if meta, ok := res["_meta"].(map[string]any); ok {
				if _, has := meta["vulpo/agentKitRevision"]; has {
					t.Fatalf("P19 (%s): la clave vulpo/agentKitRevision no debe existir: %v", name, meta)
				}
			}
		}
	})
}
