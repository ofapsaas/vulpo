// Package mcp tests — sub-fase RED, feature fb-019-002-paridad-superficie.
//
// Tests NUEVOS de paridad con mcp.odoo (spec §2, postcondiciones P2–P15+P17;
// P1 lo cubren los renames de las tablas en mcp_tools_test.go y
// mcp_odoo_tools_test.go; P8 vive reescrito en
// TestExportRecordsTool_RoutesOwnerToken... per test-audit §5; P16 es JS en
// session-probe.test.js §9.1bis-bis). Todos observan la superficie tools/call
// contra el Server MCP con MockHub — NINGUNA firma interna es contrato (§9).
//
//	 P2 — schema-parity: InputSchema exacto §2.1, format enum SOLO en las 4
//	      tools de lectura, profile AUSENTE, sufijo de plataforma en Description.
//	 P3 — tolerancia de entrada (superset I-4): string Y array en domain/
//	      fields/ids; `records` SIN alias → "requires rows".
//	 P4 — parser domain §2.4: fixtures válidos → array en el wire; sintaxis
//	      no soportada → error que nombra el problema + CERO commands (pre-ruteo).
//	 P5 — splits: " id , name " → ["id","name"]; "1,2,3" → [1,2,3].
//	 P6 — defaults explícitos: search_read 100/0; export 500/0 + domain:[]
//	      + fields:["id","name"]; execute_kw []/{}.
//	 P7 — envelope §2.2 fórmula viva: offset 4, 1 record, total 5 →
//	      has_more:false, next_offset:6 (next_offset > total PERMITIDO).
//	 P9 — atomicidad: fallo de count/read/export → error de la tool, sin
//	      success parcial.
//	P10 — formats §2.3: 5 variantes × 3 tipos de datos (records/models/
//	      fields-dict) — shapes pineadas vivo.
//	P11 — list_models: search → domain OR en wire; {success, models}; sin
//	      envelope; model_count en non-json.
//	P12 — list_fields: attributes → wire; sin attributes → wire SIN la clave
//	      (default vive en la extensión — D-9).
//	P15 — search_count (extra): parser + número crudo sin envelope +
//	      Description "Vulpo extension".
//	P17 — get_version relay SIN drop de keys (GUARD-PIN — patrón P8 de 001:
//	      el relay actual es passthrough puro, verificado en tools.go — el
//	      handler odooCmd de get_version retorna el resultado del hub sin
//	      transformar; el merge de server_version_info vive en la extensión
//	      (F-7 ruta a) y se verifica en campo P24).
package mcp

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// findToolByName: busca el descriptor registrado (para asserts de schema/
// description — P2/P15).
func findToolByName(t *testing.T, s *Server, name string) *Tool {
	t.Helper()
	for i := range s.ListTools() {
		tl := s.ListTools()[i]
		if tl.Name == name {
			return &tl
		}
	}
	t.Fatalf("tool %q no registrada en tools/list — RED de fb-019-002 (P1)", name)
	return nil
}

// seedComposition: siembra el MockHub para una composición count+read (P7) o
// count+read+export (P8) por command (F-MH) — el total REAL nunca se deriva de
// len(records) (I-5), así que el seeding es independiente para cada command.
func seedComposition(hub *MockHub, total float64, records any) {
	hub.byCommand = map[string]any{
		"odooSearchCount": total,
		"odooSearchRead":  records,
	}
}

// parityRecordFixture: 2 records simples para search_read/export (caso
// canónico de §2.3: enteros sin decimales, strings planos).
func parityRecordFixture() []any {
	return []any{
		map[string]any{"id": float64(3), "name": "Administrator"},
		map[string]any{"id": float64(31), "name": "Demo Buyer"},
	}
}

// requireJSONKeys: falla si el objeto tiene una key distinta de las queridas
// (pins "sin envelope" / "sin success" — key-set exacto).
func requireJSONKeys(t *testing.T, inner map[string]any, want ...string) {
	t.Helper()
	wantSet := map[string]bool{}
	for _, k := range want {
		wantSet[k] = true
	}
	for k := range inner {
		if !wantSet[k] {
			t.Fatalf("respuesta tiene key inesperada %q (keys=%v, want solo %v) — sin envelope/sin success", k, keysOf(inner), want)
		}
	}
	for _, k := range want {
		if _, ok := inner[k]; !ok {
			t.Fatalf("respuesta sin la key %q requerida (keys=%v)", k, keysOf(inner))
		}
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// --- P2: schema-parity de las 12 tools (spec §2.0/§2.1) ---

func TestParity_P2_SchemaParity(t *testing.T) {
	s, _, _ := newOdooTools(t)

	cases := []struct {
		name     string
		required []string
		props    []string // props que DEBEN existir (mínimo observable §2.1)
	}{
		{"search_read", []string{"model"}, []string{"model", "domain", "fields", "limit", "offset", "order", "format"}},
		{"search_count", []string{"model"}, []string{"model", "domain"}},
		{"write", []string{"model", "ids", "values"}, []string{"model", "ids", "values"}},
		{"unlink", []string{"model", "ids"}, []string{"model", "ids"}},
		{"create", []string{"model", "values"}, []string{"model", "values"}},
		{"export_records", []string{"model"}, []string{"model", "domain", "fields", "limit", "offset", "format"}},
		{"import_records", []string{"model", "fields", "rows"}, []string{"model", "fields", "rows"}},
		{"execute_kw", []string{"model", "method"}, []string{"model", "method", "args", "kwargs"}},
		{"list_models", nil, []string{"search", "format"}},
		{"list_fields", []string{"model"}, []string{"model", "attributes", "format"}},
		{"list_available_profiles", nil, nil},
		{"get_version", nil, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tl := findToolByName(t, s, tc.name)
			schema := tl.InputSchema
			if schema == nil || schema["type"] != "object" {
				t.Fatalf("P2: %s InputSchema sin type:object — %v", tc.name, schema)
			}
			props, ok := schema["properties"].(map[string]any)
			if !ok {
				t.Fatalf("P2: %s sin properties — %v", tc.name, schema)
			}
			// §2.0.1 — NINGUNA tool odoo acepta profile (resolución por token).
			if _, hasProfile := props["profile"]; hasProfile {
				t.Fatalf("P2: %s expone profile en properties — prohibido (§2.0.1, la resolución es por token)", tc.name)
			}
			// required EXACTO (orden §2.1; ausente/vacío cuando no hay).
			reqAny, hasReq := schema["required"]
			if len(tc.required) == 0 {
				if hasReq {
					if reqArr, ok := reqAny.([]any); ok && len(reqArr) > 0 {
						t.Fatalf("P2: %s required = %v, want ausente/vacío", tc.name, reqArr)
					}
				}
			} else {
				if !hasReq {
					t.Fatalf("P2: %s sin required, want %v", tc.name, tc.required)
				}
				reqArr, ok := reqAny.([]any)
				if !ok || len(reqArr) != len(tc.required) {
					t.Fatalf("P2: %s required = %v, want %v", tc.name, reqAny, tc.required)
				}
				for i, w := range tc.required {
					if reqArr[i] != w {
						t.Fatalf("P2: %s required[%d] = %v, want %q (orden §2.1)", tc.name, i, reqArr[i], w)
					}
				}
			}
			// props declaradas presentes.
			for _, p := range tc.props {
				if _, ok := props[p]; !ok {
					t.Fatalf("P2: %s sin la property %q (§2.1)", tc.name, p)
				}
			}
			// format enum SOLO en las 4 tools de lectura (D-5).
			formatProp, hasFormat := props["format"]
			readingTool := tc.name == "search_read" || tc.name == "export_records" || tc.name == "list_models" || tc.name == "list_fields"
			if readingTool {
				if !hasFormat {
					t.Fatalf("P2: %s (lectura) sin property format (§2.0.4)", tc.name)
				}
				fm, ok := formatProp.(map[string]any)
				if !ok {
					t.Fatalf("P2: %s format property no es object: %v", tc.name, formatProp)
				}
				enum, ok := fm["enum"].([]any)
				if !ok || len(enum) != 5 {
					t.Fatalf("P2: %s format enum = %v, want [json compact table html csv]", tc.name, fm["enum"])
				}
				wantEnum := []string{"json", "compact", "table", "html", "csv"}
				for i, w := range wantEnum {
					if enum[i] != w {
						t.Fatalf("P2: %s format enum[%d] = %v, want %q", tc.name, i, enum[i], w)
					}
				}
			} else if hasFormat {
				t.Fatalf("P2: %s expone format pero NO es tool de lectura (D-5: format solo en search_read/export_records/list_models/list_fields)", tc.name)
			}
			// Sufijo de plataforma pineado §2.0.2.
			if !strings.Contains(tl.Description, "Runs on the user's browser: Vulpo resolves the Odoo tab automatically") {
				t.Fatalf("P2: %s Description sin el sufijo de plataforma base (§2.0.2): %.120s", tc.name, tl.Description)
			}
			switch tc.name {
			case "create", "write", "unlink", "import_records", "export_records", "execute_kw":
				if !strings.Contains(tl.Description, "Respects the plan/build write gate") {
					t.Fatalf("P2: %s (gated) Description sin la nota del write gate (§2.0.2): %.160s", tc.name, tl.Description)
				}
			case "search_count":
				if !strings.Contains(tl.Description, "Vulpo extension") {
					t.Fatalf("P2: %s Description sin la nota 'Vulpo extension' (§2.0.2/§2.1 fila 2)", tc.name)
				}
			}
		})
	}
}

// --- P3: tolerancia de entrada — superset I-4 (string Y array) ---

func TestParity_P3_InputTolerance(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")
	requireTool(t, s, "write")
	requireTool(t, s, "import_records")
	seedComposition(hub, 1, []any{})
	hub.result = true

	// domain: string (canónico mcp.odoo) Y array (legacy vulpo) → wire array.
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[('name','ilike','x')]", "fields": "id,name",
	}, "profA"); err != nil {
		t.Fatalf("search_read (domain string) error: %v", err)
	}
	cmdStr := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdStr.Params["domain"], []any{[]any{"name", "ilike", "x"}}) {
		t.Fatalf("P3: domain string → wire %v, want array parseado", cmdStr.Params["domain"])
	}
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": []any{}, "fields": []any{"id", "name"},
	}, "profA"); err != nil {
		t.Fatalf("search_read (domain array) error: %v", err)
	}
	cmdArr := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdArr.Params["domain"], []any{}) {
		t.Fatalf("P3: domain array → wire %v, want passthrough []", cmdArr.Params["domain"])
	}

	// fields: string Y array → wire array (string canónico, array tolerado).
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[]", "fields": "id,name",
	}, "profA"); err != nil {
		t.Fatalf("search_read (fields string) error: %v", err)
	}
	cmdFields := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdFields.Params["fields"], []any{"id", "name"}) {
		t.Fatalf("P3: fields string → wire %v, want [id name]", cmdFields.Params["fields"])
	}

	// ids (write): comma-separated "1,2" (canónico) Y array → wire array.
	if _, err := callOdooTool(t, s, "write", map[string]any{
		"profile": "7", "model": "res.partner", "ids": "1,2", "values": map[string]any{"name": "x"},
	}, "profA"); err != nil {
		t.Fatalf("write (ids string) error: %v", err)
	}
	cmdIdsStr := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdIdsStr.Params["ids"], []any{float64(1), float64(2)}) {
		t.Fatalf("P3: write ids \"1,2\" → wire %v, want [1 2]", cmdIdsStr.Params["ids"])
	}
	if _, err := callOdooTool(t, s, "write", map[string]any{
		"profile": "7", "model": "res.partner", "ids": []any{float64(1), float64(2)}, "values": map[string]any{"name": "x"},
	}, "profA"); err != nil {
		t.Fatalf("write (ids array) error: %v", err)
	}
	cmdIdsArr := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdIdsArr.Params["ids"], []any{float64(1), float64(2)}) {
		t.Fatalf("P3: write ids array → wire %v, want passthrough [1 2]", cmdIdsArr.Params["ids"])
	}

	// rows SIN alias: `records` (viejo) → error "requires rows" (D-4), sin ruteo.
	nBefore := len(hub.commandCalls())
	msg := callOdooToolError(t, s, "import_records", map[string]any{
		"profile": "7", "model": "res.partner", "fields": "id",
		"records": []any{map[string]any{"id": "__export__.x"}},
	}, "profA")
	if !strings.Contains(msg, "requires rows") {
		t.Fatalf("P3: import_records con records (alias viejo) error = %q, want contener 'requires rows' (D-4: alias de NOMBRE ≠ tolerancia de TIPO)", msg)
	}
	if len(hub.commandCalls()) != nBefore {
		t.Fatalf("P3: el error 'requires rows' ruteó commands: %v", lastNCommands(hub, len(hub.commandCalls())-nBefore))
	}
}

// --- P4: parser de domain string → array (spec §2.4) vía wire ---

func TestParity_P4_DomainParser(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_count")
	hub.result = float64(3) // search_count → número crudo

	// Sintaxis NO soportada → error que nombra el problema + CERO commands
	// (la validación es PRE-ruteo — defensa en profundidad §2.4). Se verifica
	// primero: el hub está limpio (solo el odooDetectTabs del seeding).
	for _, bad := range []struct{ name, domain string }{
		{"dict", `{'a': 1}`},
		{"aritmetica", `1 + 2`},
		{"fstring", `f"[('name','=','x')]"`},
	} {
		msg := callOdooToolError(t, s, "search_count", map[string]any{
			"profile": "7", "model": "res.partner", "domain": bad.domain,
		}, "profA")
		if !strings.Contains(msg, "unsupported domain syntax") {
			t.Fatalf("P4: domain %s (%q) error = %q, want nombrar 'unsupported domain syntax'", bad.name, bad.domain, msg)
		}
	}
	if n := countCommand(hub, "odooSearchCount"); n != 0 {
		t.Fatalf("P4: sintaxis no soportada ruteó %d commands — la validación debe ser pre-ruteo (cero commands en el hub)", n)
	}

	// Fixtures válidos del spec §2.4 → domain array en el command wire.
	fixtures := []struct {
		name   string
		domain string
		want   any
	}{
		{"lista-simple", `[('name','ilike','John')]`,
			[]any{[]any{"name", "ilike", "John"}}},
		{"negativos-floats", `[('a','=',1),('b','!=',-2.5),('c','>',0)]`,
			[]any{[]any{"a", "=", float64(1)}, []any{"b", "!=", float64(-2.5)}, []any{"c", ">", float64(0)}}},
		{"escape-comilla-simple", `[('name','ilike','O\'Brien')]`,
			[]any{[]any{"name", "ilike", "O'Brien"}}},
		{"escape-tab", `[('name','=','tab\there')]`,
			[]any{[]any{"name", "=", "tab\there"}}},
		{"bools-none", `[('active','=',True),('x','=',False),('y','=',None)]`,
			[]any{[]any{"active", "=", true}, []any{"x", "=", false}, []any{"y", "=", nil}}},
		{"lista-anidada", `[('name','in',['a','b'])]`,
			[]any{[]any{"name", "in", []any{"a", "b"}}}},
		{"tupla-top-level", `('name','=','x')`,
			[]any{[]any{"name", "=", "x"}}},
	}
	for _, fx := range fixtures {
		t.Run(fx.name, func(t *testing.T) {
			if _, err := callOdooTool(t, s, "search_count", map[string]any{
				"profile": "7", "model": "res.partner", "domain": fx.domain,
			}, "profA"); err != nil {
				t.Fatalf("P4: domain %s error: %v", fx.name, err)
			}
			cmd := hub.calls[len(hub.calls)-1].cmd
			if cmd.Command != "odooSearchCount" {
				t.Fatalf("P4: command = %q, want odooSearchCount", cmd.Command)
			}
			if !reflect.DeepEqual(cmd.Params["domain"], fx.want) {
				t.Fatalf("P4: domain %s → wire %v, want %v", fx.name, cmd.Params["domain"], fx.want)
			}
		})
	}
}

// --- P5: splits de fields/ids (spec §2.4) — observados en cmd.Params ---

func TestParity_P5_Splits(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")
	requireTool(t, s, "write")
	seedComposition(hub, 1, []any{})
	hub.result = true

	// fields " id , name " → ["id","name"] (split + trim — §2.4).
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[]", "fields": " id , name ",
	}, "profA"); err != nil {
		t.Fatalf("search_read error: %v", err)
	}
	cmdRead := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdRead.Params["fields"], []any{"id", "name"}) {
		t.Fatalf("P5: fields \" id , name \" → wire %v, want [id name] (split+trim)", cmdRead.Params["fields"])
	}

	// ids "1,2,3" → [1,2,3] enteros (write — §2.4).
	if _, err := callOdooTool(t, s, "write", map[string]any{
		"profile": "7", "model": "res.partner", "ids": "1,2,3", "values": map[string]any{"name": "x"},
	}, "profA"); err != nil {
		t.Fatalf("write error: %v", err)
	}
	cmdWrite := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdWrite.Params["ids"], []any{float64(1), float64(2), float64(3)}) {
		t.Fatalf("P5: ids \"1,2,3\" → wire %v, want [1 2 3]", cmdWrite.Params["ids"])
	}
}

// --- P6: defaults explícitos (spec §2.1/§2.2) ---

func TestParity_P6_Defaults(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")
	requireTool(t, s, "export_records")
	requireTool(t, s, "execute_kw")

	// search_read sin limit/offset → wire limit:100, offset:0 (default vivo).
	seedComposition(hub, 1, []any{})
	if _, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[]", "fields": "id,name",
	}, "profA"); err != nil {
		t.Fatalf("search_read error: %v", err)
	}
	cmdRead := hub.calls[len(hub.calls)-1].cmd
	if cmdRead.Params["limit"] != float64(100) || cmdRead.Params["offset"] != float64(0) {
		t.Fatalf("P6: search_read wire limit/offset = %v/%v, want 100/0", cmdRead.Params["limit"], cmdRead.Params["offset"])
	}

	// export sin params (solo model) → domain:[], fields:["id","name"],
	// limit:500, offset:0 (P6). Seed del export en la shape REAL del
	// export_data nativo: MATRIZ {datas: […]} (field verification
	// fb-019-002) — datas vacío → records [].
	hub.byCommand = map[string]any{
		"odooSearchCount":   float64(1),
		"odooSearchRead":    []any{map[string]any{"id": float64(9)}},
		"odooExportRecords": map[string]any{"datas": []any{}},
	}
	if _, err := callOdooTool(t, s, "export_records", map[string]any{
		"profile": "7", "model": "res.partner",
	}, "profA"); err != nil {
		t.Fatalf("export_records error: %v", err)
	}
	countCmd := hub.calls[len(hub.calls)-3].cmd
	readCmd := hub.calls[len(hub.calls)-2].cmd
	if !reflect.DeepEqual(countCmd.Params["domain"], []any{}) {
		t.Fatalf("P6: export count wire domain = %v, want [] (default \"[]\")", countCmd.Params["domain"])
	}
	if !reflect.DeepEqual(readCmd.Params["domain"], []any{}) {
		t.Fatalf("P6: export read wire domain = %v, want []", readCmd.Params["domain"])
	}
	if !reflect.DeepEqual(readCmd.Params["fields"], []any{"id", "name"}) {
		t.Fatalf("P6: export read wire fields = %v, want [id name] (default §2.1 fila 6)", readCmd.Params["fields"])
	}
	if readCmd.Params["limit"] != float64(500) || readCmd.Params["offset"] != float64(0) {
		t.Fatalf("P6: export wire limit/offset = %v/%v, want 500/0", readCmd.Params["limit"], readCmd.Params["offset"])
	}

	// execute_kw sin args/kwargs → []/{} (§2.1 fila 8).
	hub.byCommand = nil
	hub.result = float64(0)
	if _, err := callOdooTool(t, s, "execute_kw", map[string]any{
		"profile": "7", "model": "ir.model", "method": "search_count",
	}, "profA"); err != nil {
		t.Fatalf("execute_kw error: %v", err)
	}
	cmdExec := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdExec.Params["args"], []any{}) {
		t.Fatalf("P6: execute_kw wire args = %v, want []", cmdExec.Params["args"])
	}
	if !reflect.DeepEqual(cmdExec.Params["kwargs"], map[string]any{}) {
		t.Fatalf("P6: execute_kw wire kwargs = %v, want {}", cmdExec.Params["kwargs"])
	}
}

// --- P7: envelope §2.2 — fórmula viva pineada (complemento del caso principal
//          que vive en TestSearchRead_RoutesOwnerToken_SameTenant) ---

func TestParity_P7_EnvelopeNextOffsetBeyondTotal(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")

	// Fórmula viva §2.2: offset=4, limit=2, total=5, 1 record →
	// has_more = (4+1) < 5 = false; next_offset = 4+2 = 6 — PUEDE exceder el
	// total (observado vivo: offset=4, limit=2, total=5 → next_offset:6).
	seedComposition(hub, 5, []any{map[string]any{"id": float64(5), "name": "e"}})
	res, err := callOdooTool(t, s, "search_read", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[]", "fields": "id,name",
		"limit": float64(2), "offset": float64(4),
	}, "profA")
	if err != nil {
		t.Fatalf("search_read error: %v", err)
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["total"] != float64(5) || inner["limit"] != float64(2) || inner["offset"] != float64(4) {
		t.Fatalf("P7: total/limit/offset = %v/%v/%v, want 5/2/4", inner["total"], inner["limit"], inner["offset"])
	}
	if inner["has_more"] != false {
		t.Fatalf("P7: has_more = %v, want false ((4+1) < 5 = false — fórmula viva)", inner["has_more"])
	}
	if inner["next_offset"] != float64(6) {
		t.Fatalf("P7: next_offset = %v, want 6 (offset+limit; > total PERMITIDO — pineado vivo §2.2)", inner["next_offset"])
	}
	if inner["format"] != "json" {
		t.Fatalf("P7: format = %v, want json", inner["format"])
	}
	recs, ok := inner["records"].([]any)
	if !ok || len(recs) != 1 {
		t.Fatalf("P7: records = %v, want 1 record", inner["records"])
	}
}

// --- P9: atomicidad de las composiciones (spec §2.2) — fallo de CUALQUIER
//          command → error de la tool (mensaje del hub propagado), jamás
//          success parcial ---

func TestParity_P9_CompositionAtomicity(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")
	requireTool(t, s, "export_records")

	t.Run("search_read: falla el count", func(t *testing.T) {
		seedComposition(hub, 5, []any{})
		hub.errByCommand = map[string]error{"odooSearchCount": errors.New("hub: count boom")}
		msg := callOdooToolError(t, s, "search_read", map[string]any{
			"profile": "7", "model": "res.partner", "domain": "[]",
		}, "profA")
		if !strings.Contains(msg, "count boom") {
			t.Fatalf("P9: error = %q, want propagar el mensaje del hub ('count boom')", msg)
		}
	})
	t.Run("search_read: falla el read", func(t *testing.T) {
		seedComposition(hub, 5, []any{})
		hub.errByCommand = map[string]error{"odooSearchRead": errors.New("hub: read boom")}
		msg := callOdooToolError(t, s, "search_read", map[string]any{
			"profile": "7", "model": "res.partner", "domain": "[]",
		}, "profA")
		if !strings.Contains(msg, "read boom") {
			t.Fatalf("P9: error = %q, want propagar el mensaje del hub ('read boom')", msg)
		}
	})
	t.Run("export_records: falla el export (composición de 3)", func(t *testing.T) {
		seedComposition(hub, 1, []any{map[string]any{"id": float64(9)}})
		hub.byCommand["odooExportRecords"] = map[string]any{"records": []any{}}
		hub.errByCommand = map[string]error{"odooExportRecords": errors.New("hub: export boom")}
		msg := callOdooToolError(t, s, "export_records", map[string]any{
			"profile": "7", "model": "res.partner", "domain": "[]", "fields": "id,name",
		}, "profA")
		if !strings.Contains(msg, "export boom") {
			t.Fatalf("P9: error = %q, want propagar el mensaje del hub ('export boom')", msg)
		}
	})
	// El mensaje de error ES la respuesta (callOdooToolError exige error):
	// jamás un success parcial con datos a medias (§2.2 — composición atómica
	// a nivel respuesta).
}

// --- P10: formats (spec §2.3 — shapes pineadas vivo). D-5: el renderer vive
//          en el server; aplica EXACTAMENTE a search_read/export_records/
//          list_models/list_fields. §2.2: las claves del envelope siguen
//          presentes en las 4 variantes non-json de las tools con paginación;
//          SIN success en non-json (vivo). ---

// P10 sobre records (search_read): las 5 variantes + fixtures de escape.
func TestParity_P10_Formats_Records(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_read")

	records := parityRecordFixture()
	call := func(t *testing.T, extra map[string]any, recs any, total float64) map[string]any {
		t.Helper()
		seedComposition(hub, total, recs)
		args := map[string]any{"profile": "7", "model": "res.partner", "domain": "[]", "fields": "id,name"}
		for k, v := range extra {
			args[k] = v
		}
		res, err := callOdooTool(t, s, "search_read", args, "profA")
		if err != nil {
			t.Fatalf("search_read error: %v", err)
		}
		var inner map[string]any
		resultJSON(t, res, &inner)
		return inner
	}

	t.Run("json crudo (default)", func(t *testing.T) {
		inner := call(t, nil, records, 2)
		want := map[string]any{
			"records": records, "total": float64(2), "limit": float64(100), "offset": float64(0),
			"has_more": false, "next_offset": float64(100), "format": "json",
		}
		if !reflect.DeepEqual(inner, want) {
			t.Fatalf("P10 json: respuesta = %v\nwant = %v", inner, want)
		}
	})
	t.Run("compact con fields", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "compact"}, records, 2)
		want := map[string]any{
			"headers": []any{"id", "name"},
			"rows":    []any{[]any{float64(3), "Administrator"}, []any{float64(31), "Demo Buyer"}},
			"total":   float64(2), "limit": float64(100), "offset": float64(0),
			"has_more": false, "next_offset": float64(100), "format": "compact",
		}
		if !reflect.DeepEqual(inner, want) {
			t.Fatalf("P10 compact: respuesta = %v\nwant = %v (headers = fields pedidos en orden; SIN success)", inner, want)
		}
	})
	t.Run("compact sin fields → claves del primer record", func(t *testing.T) {
		seedComposition(hub, 1, []any{map[string]any{"id": float64(3), "name": "Administrator"}})
		res, err := callOdooTool(t, s, "search_read", map[string]any{
			"profile": "7", "model": "res.partner", "domain": "[]", "format": "compact",
		}, "profA")
		if err != nil {
			t.Fatalf("search_read error: %v", err)
		}
		var inner map[string]any
		resultJSON(t, res, &inner)
		headers, ok := inner["headers"].([]any)
		if !ok || len(headers) != 2 {
			t.Fatalf("P10 compact sin fields: headers = %v, want las 2 claves del primer record", inner["headers"])
		}
		hasID, hasName := false, false
		for _, h := range headers {
			if h == "id" {
				hasID = true
			}
			if h == "name" {
				hasName = true
			}
		}
		if !hasID || !hasName {
			t.Fatalf("P10 compact sin fields: headers = %v, want claves {id,name} del primer record (§2.3 — vivo)", headers)
		}
		if _, hasSuccess := inner["success"]; hasSuccess {
			t.Fatalf("P10 compact sin fields: success presente — SIN success en non-json (vivo)")
		}
	})
	t.Run("table markdown", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "table"}, records, 2)
		want := "| id | name |\n| --- | --- |\n| 3 | Administrator |\n| 31 | Demo Buyer |"
		if inner["data"] != want {
			t.Fatalf("P10 table: data = %q\nwant = %q (header + separador --- por columna + valores stringificados)", inner["data"], want)
		}
		if inner["format"] != "table" || inner["total"] != float64(2) {
			t.Fatalf("P10 table: envelope keys presentes (format/total) = %v/%v", inner["format"], inner["total"])
		}
	})
	t.Run("html sin newlines", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "html"}, records, 2)
		want := "<table><thead><tr><th>id</th><th>name</th></tr></thead><tbody><tr><td>3</td><td>Administrator</td></tr><tr><td>31</td><td>Demo Buyer</td></tr></tbody></table>"
		if inner["data"] != want {
			t.Fatalf("P10 html: data = %q\nwant = %q (sin newlines ni atributos — vivo)", inner["data"], want)
		}
	})
	t.Run("html escapado", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "html"},
			[]any{map[string]any{"id": float64(7), "name": "A<b>&c"}}, 1)
		data, _ := inner["data"].(string)
		if !strings.Contains(data, "<td>A&lt;b&gt;&amp;c</td>") {
			t.Fatalf("P10 html: valor con <>& sin html-escape — data = %q (seguridad §2.3)", data)
		}
		if strings.Contains(data, "\n") {
			t.Fatalf("P10 html: data con newlines — %q", data)
		}
	})
	t.Run("csv RFC4180 sin quoting innecesario", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "csv"}, records, 2)
		want := "id,name\n3,Administrator\n31,Demo Buyer"
		if inner["data"] != want {
			t.Fatalf("P10 csv: data = %q\nwant = %q (sin quoting cuando no hace falta — vivo)", inner["data"], want)
		}
	})
	t.Run("csv quoting con coma/quote/newline", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "csv"},
			[]any{map[string]any{"id": float64(7), "name": `He said "hi", ok`}}, 1)
		data, _ := inner["data"].(string)
		if !strings.Contains(data, `"He said ""hi"", ok"`) {
			t.Fatalf("P10 csv: valor con coma+quote sin quoting/doblado — data = %q (RFC4180)", data)
		}
		inner2 := call(t, map[string]any{"format": "csv"},
			[]any{map[string]any{"id": float64(8), "name": "L1\nL2"}}, 1)
		data2, _ := inner2["data"].(string)
		if !strings.Contains(data2, "\"L1\nL2\"") {
			t.Fatalf("P10 csv: valor con newline sin quoting — data = %q (RFC4180)", data2)
		}
	})
}

// P10 sobre models (list_models).
func TestParity_P10_Formats_ListModels(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "list_models")

	models := []any{
		map[string]any{"id": float64(1), "name": "Contacts", "model": "res.partner", "info": "Contactos"},
		map[string]any{"id": float64(2), "name": "Users", "model": "res.users", "info": "Usuarios"},
	}
	seed := func() { hub.byCommand = map[string]any{"odooSearchRead": models}; hub.errByCommand = nil }
	call := func(t *testing.T, args map[string]any) map[string]any {
		t.Helper()
		seed()
		res, err := callOdooTool(t, s, "list_models", args, "profA")
		if err != nil {
			t.Fatalf("list_models error: %v", err)
		}
		var inner map[string]any
		resultJSON(t, res, &inner)
		return inner
	}

	t.Run("json: {success, models}", func(t *testing.T) {
		inner := call(t, map[string]any{})
		want := map[string]any{"success": true, "models": models}
		if !reflect.DeepEqual(inner, want) {
			t.Fatalf("P10 models json: respuesta = %v\nwant = %v (vivo §2.1 fila 9)", inner, want)
		}
	})
	t.Run("compact: {headers, rows, format, model_count} sin success", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "compact"})
		want := map[string]any{
			"headers":     []any{"id", "name", "model", "info"},
			"rows":        []any{[]any{float64(1), "Contacts", "res.partner", "Contactos"}, []any{float64(2), "Users", "res.users", "Usuarios"}},
			"format":      "compact",
			"model_count": float64(2),
		}
		if !reflect.DeepEqual(inner, want) {
			t.Fatalf("P10 models compact: respuesta = %v\nwant = %v (vivo: model_count, sin envelope, sin success)", inner, want)
		}
	})
	t.Run("table: markdown de la lista models", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "table"})
		data, _ := inner["data"].(string)
		for _, want := range []string{"| id | name | model | info |", "| --- |", "| 1 | Contacts | res.partner | Contactos |"} {
			if !strings.Contains(data, want) {
				t.Fatalf("P10 models table: data = %q, want contener %q", data, want)
			}
		}
		if inner["format"] != "table" {
			t.Fatalf("P10 models table: format = %v", inner["format"])
		}
	})
	t.Run("html: thead de models, sin newlines", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "html"})
		data, _ := inner["data"].(string)
		for _, want := range []string{"<th>id</th><th>name</th><th>model</th><th>info</th>", "<td>Contacts</td>"} {
			if !strings.Contains(data, want) {
				t.Fatalf("P10 models html: data = %q, want contener %q", data, want)
			}
		}
		if strings.Contains(data, "\n") {
			t.Fatalf("P10 models html: data con newlines — %q", data)
		}
	})
	t.Run("csv: fila por model", func(t *testing.T) {
		inner := call(t, map[string]any{"format": "csv"})
		data, _ := inner["data"].(string)
		for _, want := range []string{"id,name,model,info", "1,Contacts,res.partner,Contactos"} {
			if !strings.Contains(data, want) {
				t.Fatalf("P10 models csv: data = %q, want contener %q", data, want)
			}
		}
	})
}

// P10 sobre fields-dict (list_fields). El json canónico vive acá; el
// attributes-contrast (P12) en TestParity_P12_ListFieldsAttributes.
func TestParity_P10_Formats_ListFields(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "list_fields")

	fieldsDict := map[string]any{
		"name":   map[string]any{"string": "Name", "type": "char", "required": false},
		"active": map[string]any{"string": "Active", "type": "boolean", "required": true},
	}
	seed := func() {
		hub.byCommand = map[string]any{"odooListFields": fieldsDict}
		hub.errByCommand = nil
	}
	call := func(t *testing.T, args map[string]any) map[string]any {
		t.Helper()
		seed()
		res, err := callOdooTool(t, s, "list_fields", args, "profA")
		if err != nil {
			t.Fatalf("list_fields error: %v", err)
		}
		var inner map[string]any
		resultJSON(t, res, &inner)
		return inner
	}

	t.Run("json: {success, fields}", func(t *testing.T) {
		inner := call(t, map[string]any{"model": "res.partner"})
		want := map[string]any{"success": true, "fields": fieldsDict}
		if !reflect.DeepEqual(inner, want) {
			t.Fatalf("P10 fields json: respuesta = %v\nwant = %v (vivo §2.1 fila 10)", inner, want)
		}
	})
	t.Run("compact: columna field primera + rows ordenadas + field_count", func(t *testing.T) {
		inner := call(t, map[string]any{"model": "res.partner", "format": "compact"})
		requireJSONKeys(t, inner, "headers", "rows", "format", "field_count") // sin success, sin envelope
		headers, ok := inner["headers"].([]any)
		if !ok || len(headers) == 0 || headers[0] != "field" {
			t.Fatalf("P10 fields compact: headers = %v, want primera columna 'field' (vivo)", inner["headers"])
		}
		rows, ok := inner["rows"].([]any)
		if !ok || len(rows) != 2 {
			t.Fatalf("P10 fields compact: rows = %v, want 2 (una por campo del dict)", inner["rows"])
		}
		// rows ordenadas por nombre de campo (vivo §2.1 fila 10).
		if r0, _ := rows[0].([]any); len(r0) == 0 || r0[0] != "active" {
			t.Fatalf("P10 fields compact: rows[0] = %v, want empezando por 'active' (orden alfabético de campos)", rows[0])
		}
		if r1, _ := rows[1].([]any); len(r1) == 0 || r1[0] != "name" {
			t.Fatalf("P10 fields compact: rows[1] = %v, want 'name'", rows[1])
		}
		if inner["field_count"] != float64(2) {
			t.Fatalf("P10 fields compact: field_count = %v, want 2", inner["field_count"])
		}
		if inner["format"] != "compact" {
			t.Fatalf("P10 fields compact: format = %v", inner["format"])
		}
	})
	t.Run("table: markdown del dict aplanado", func(t *testing.T) {
		inner := call(t, map[string]any{"model": "res.partner", "format": "table"})
		data, _ := inner["data"].(string)
		for _, want := range []string{"| field |", "| active |", "| name |"} {
			if !strings.Contains(data, want) {
				t.Fatalf("P10 fields table: data = %q, want contener %q", data, want)
			}
		}
		if inner["format"] != "table" {
			t.Fatalf("P10 fields table: format = %v", inner["format"])
		}
	})
	t.Run("html: th field + td por campo", func(t *testing.T) {
		inner := call(t, map[string]any{"model": "res.partner", "format": "html"})
		data, _ := inner["data"].(string)
		for _, want := range []string{"<th>field</th>", "<td>active</td>", "<td>name</td>"} {
			if !strings.Contains(data, want) {
				t.Fatalf("P10 fields html: data = %q, want contener %q", data, want)
			}
		}
		if strings.Contains(data, "\n") {
			t.Fatalf("P10 fields html: data con newlines — %q", data)
		}
	})
	t.Run("csv: field primera columna", func(t *testing.T) {
		inner := call(t, map[string]any{"model": "res.partner", "format": "csv"})
		data, _ := inner["data"].(string)
		if !strings.HasPrefix(data, "field,") {
			t.Fatalf("P10 fields csv: data = %q, want empezar con 'field,'", data)
		}
		if !strings.Contains(data, "\nactive,") || !strings.Contains(data, "\nname,") {
			t.Fatalf("P10 fields csv: data = %q, want filas por campo (active, name)", data)
		}
	})
}

// --- P11: list_models — search → domain OR en wire; {success, models} json;
//          sin envelope; model_count en non-json (spec §2.1 fila 9) ---

func TestParity_P11_ListModels(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "list_models")

	models := []any{map[string]any{"id": float64(1), "name": "Contacts", "model": "res.partner", "info": "Contactos"}}
	hub.byCommand = map[string]any{"odooSearchRead": models}

	// search="partner" → odooSearchRead sobre ir.model con domain OR (P11).
	res, err := callOdooTool(t, s, "list_models", map[string]any{"search": "partner"}, "profA")
	if err != nil {
		t.Fatalf("list_models error: %v", err)
	}
	cmd := hub.calls[len(hub.calls)-1].cmd
	if cmd.Command != "odooSearchRead" {
		t.Fatalf("P11: command = %q, want odooSearchRead (composición ir.model)", cmd.Command)
	}
	if cmd.Params["model"] != "ir.model" {
		t.Fatalf("P11: wire model = %v, want ir.model", cmd.Params["model"])
	}
	wantDomain := []any{"|", []any{"name", "ilike", "partner"}, []any{"model", "ilike", "partner"}}
	if !reflect.DeepEqual(cmd.Params["domain"], wantDomain) {
		t.Fatalf("P11: wire domain = %v, want %v (['|', ilike name, ilike model])", cmd.Params["domain"], wantDomain)
	}
	if !reflect.DeepEqual(cmd.Params["fields"], []any{"id", "name", "model", "info"}) {
		t.Fatalf("P11: wire fields = %v, want [id name model info]", cmd.Params["fields"])
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if !reflect.DeepEqual(inner, map[string]any{"success": true, "models": models}) {
		t.Fatalf("P11: respuesta = %v, want {success:true, models:[…]} (vivo)", inner)
	}
	if _, hasTotal := inner["total"]; hasTotal {
		t.Fatalf("P11: respuesta con 'total' — list_models NO lleva envelope de paginación (§2.1 fila 9)")
	}

	// sin search → domain [] vacío (§2.1: "o []").
	if _, err := callOdooTool(t, s, "list_models", map[string]any{}, "profA"); err != nil {
		t.Fatalf("list_models sin search error: %v", err)
	}
	cmdEmpty := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmdEmpty.Params["domain"], []any{}) {
		t.Fatalf("P11: wire domain sin search = %v, want []", cmdEmpty.Params["domain"])
	}

	// model_count en non-json (compact).
	if _, err := callOdooTool(t, s, "list_models", map[string]any{"format": "compact"}, "profA"); err != nil {
		t.Fatalf("list_models compact error: %v", err)
	}
	res2, _ := callOdooTool(t, s, "list_models", map[string]any{"format": "compact"}, "profA")
	var inner2 map[string]any
	resultJSON(t, res2, &inner2)
	if inner2["model_count"] != float64(1) {
		t.Fatalf("P11: model_count = %v, want 1 (non-json — vivo)", inner2["model_count"])
	}
}

// --- P12: list_fields — attributes string → wire array + respuesta
//          {success, fields}; sin attributes → wire SIN la clave (el default
//          vive en la extensión — D-9; el compact-contrast vive en
//          TestParity_P10_Formats_ListFields) ---

func TestParity_P12_ListFieldsAttributes(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "list_fields")

	// (a) attributes:"string" → wire attributes ["string"]; respuesta
	//     {success:true, fields:{…}} con solo-string por campo (vivo).
	fieldsSoloString := map[string]any{"name": map[string]any{"string": "Name"}}
	hub.byCommand = map[string]any{"odooListFields": fieldsSoloString}
	res, err := callOdooTool(t, s, "list_fields", map[string]any{
		"profile": "7", "model": "res.partner", "attributes": "string",
	}, "profA")
	if err != nil {
		t.Fatalf("list_fields error: %v", err)
	}
	cmd := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmd.Params["attributes"], []any{"string"}) {
		t.Fatalf("P12: wire attributes = %v, want [\"string\"]", cmd.Params["attributes"])
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if !reflect.DeepEqual(inner, map[string]any{"success": true, "fields": fieldsSoloString}) {
		t.Fatalf("P12: respuesta = %v, want {success:true, fields:{…}} (solo-string — vivo)", inner)
	}

	// (b) sin attributes → wire SIN la clave (el default string/type/required
	//     +help lo agrega la extensión — D-9; server viejo + extensión nueva OK).
	hub.byCommand = map[string]any{"odooListFields": fieldsSoloString}
	if _, err := callOdooTool(t, s, "list_fields", map[string]any{
		"profile": "7", "model": "res.partner",
	}, "profA"); err != nil {
		t.Fatalf("list_fields sin attributes error: %v", err)
	}
	cmdNoAttrs := hub.calls[len(hub.calls)-1].cmd
	if _, hasAttrs := cmdNoAttrs.Params["attributes"]; hasAttrs {
		t.Fatalf("P12: wire SIN attributes debe omitir la clave (default en la extensión — D-9), Params = %v", cmdNoAttrs.Params)
	}
}

// --- P15: search_count (extra vulpo) — domain-string vía parser, número
//          crudo SIN envelope, Description con "Vulpo extension" ---

func TestParity_P15_SearchCountExtra(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "search_count")
	hub.result = float64(7)

	res, err := callOdooTool(t, s, "search_count", map[string]any{
		"profile": "7", "model": "res.partner", "domain": "[('active','=',True)]",
	}, "profA")
	if err != nil {
		t.Fatalf("search_count error: %v", err)
	}
	// domain string parseado por el server (§2.4) antes del ruteo.
	cmd := hub.calls[len(hub.calls)-1].cmd
	if !reflect.DeepEqual(cmd.Params["domain"], []any{[]any{"active", "=", true}}) {
		t.Fatalf("P15: wire domain = %v, want [[active = true]] (parser)", cmd.Params["domain"])
	}
	// Número crudo sin envelope (extra fuera de paridad — §2.1 fila 2).
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	var raw any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		t.Fatalf("P15: respuesta no es un número JSON: %q (%v)", text, err)
	}
	if raw != float64(7) {
		t.Fatalf("P15: respuesta = %v, want número crudo 7", raw)
	}
	if _, ok := raw.(map[string]any); ok {
		t.Fatalf("P15: search_count NO lleva envelope (§2.1 fila 2) — respuesta = %v", raw)
	}
	// Description con la nota de extensión (P15/§2.0.2).
	tl := findToolByName(t, s, "search_count")
	if !strings.Contains(tl.Description, "Vulpo extension") {
		t.Fatalf("P15: Description sin 'Vulpo extension': %.120s", tl.Description)
	}
}

// --- P17: get_version — GUARD-PIN (patrón P8 de fb-019-001): el relay del
//          server NO droppea keys. El handler actual es passthrough puro
//          (odooCmd retorna el resultado del hub sin transformar — verificado
//          tools.go en RED), así que esta aserción pasa sin trabajo del
//          implementer en GREEN; el merge REAL de server_version/
//          server_version_info vive en el handler odooGetVersion de
//          background.js (F-7 ruta a — C-1 parity-plus) y se verifica en
//          campo (P24). En RED este test falla SOLO por el requireTool
//          superficial (comparte el modo de fallo de todos los renames). ---

func TestParity_P17_GetVersionRelayPreservesKeys(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "get_version")

	hub.result = map[string]any{
		"version": "19.0", "db": "demo", "uid": float64(2), "username": "admin", "is_superuser": true,
		"server_version":      "19.0",
		"server_version_info": []any{float64(19), float64(0), float64(0), "final", float64(0)},
	}
	res, err := callOdooTool(t, s, "get_version", map[string]any{"profile": "7"}, "profA")
	if err != nil {
		t.Fatalf("get_version error: %v", err)
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	want := map[string]any{
		"version": "19.0", "db": "demo", "uid": float64(2), "username": "admin", "is_superuser": true,
		"server_version":      "19.0",
		"server_version_info": []any{float64(19), float64(0), float64(0), "final", float64(0)},
	}
	if !reflect.DeepEqual(inner, want) {
		t.Fatalf("P17 (guard-PIN): el relay de get_version DROPPEÓ o alteró keys —\ngot  = %v\nwant = %v (relay sin drop — C-1: 4 keys mcp.odoo + 4 vulpo)", inner, want)
	}
}
