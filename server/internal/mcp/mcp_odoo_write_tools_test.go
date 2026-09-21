// Package mcp tests — sub-fase RED, feature fb-013-004-write-tools.
//
// Verifica las postcondiciones Go HARD del spec
// (docs/specs/fb-013-004-write-tools/spec.md, PC2-PC10) para las tools MCP
// odoo de ESCRITURA (create/write/unlink/import_records/export_records)
// + el wiring WRITE_TOOLS de la extensión. Mapeo completo en test-audit.md §5.
// fb-019-002 renombra las 12 tools (drop del prefijo fb_, hard cutover D-7),
// reescribe export_records a domain-based (P8: 3 commands + envelope) e
// import_records a rows (P13), y pinea el write-path wrapper {success} (P14/C-2).
package mcp

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// --- PC2: create rutea odooCreate con el TOKEN PROPIETARIO + relay del id
//           (P14/C-2: la respuesta transmite el id del registro creado; el
//           wrapper exacto se cierra en campo P22/P23 — VERIFICAR vivo). ---

func TestCreateTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "create")

	hub.result = map[string]any{"id": float64(42)}
	res, err := callOdooTool(t, s, "create", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"values":  map[string]any{"name": "alpha"},
	}, "profA")
	if err != nil {
		t.Fatalf("create error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("create profileID = %q, want propietario profA (no el token MCP tok1)", profileID)
	}
	if cmd.Command != "odooCreate" {
		t.Fatalf("create command = %q, want odooCreate", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("create TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("create Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "res.partner" {
		t.Fatalf("create Params.model = %v, want res.partner", cmd.Params["model"])
	}
	vals, ok := cmd.Params["values"].(map[string]any)
	if !ok || vals["name"] != "alpha" {
		t.Fatalf("create Params.values = %v, want {name: alpha}", cmd.Params["values"])
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["id"] != float64(42) {
		t.Fatalf("create relay = %v, want id 42", inner)
	}
}

// --- PC3: write rutea odooWrite + Params.{tabId, model, ids, values}.
//           P14 (C-2): ids "1,2" (comma-separated, canónico mcp.odoo) → wire
//           ARRAY; respuesta wrapper {success:true} (pin mínimo observable —
//           keys extra del render se agregan sin tocar la suite). ---

func TestWriteTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "write")

	hub.result = true
	res, err := callOdooTool(t, s, "write", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"ids":     "1,2",
		"values":  map[string]any{"phone": "+1234"},
	}, "profA")
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("write profileID = %q, want propietario profA", profileID)
	}
	if cmd.Command != "odooWrite" {
		t.Fatalf("write command = %q, want odooWrite", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("write TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("write Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "res.partner" {
		t.Fatalf("write Params.model = %v, want res.partner", cmd.Params["model"])
	}
	ids, ok := cmd.Params["ids"].([]any)
	if !ok || len(ids) != 2 || ids[0] != float64(1) || ids[1] != float64(2) {
		t.Fatalf("write Params.ids = %v, want array [1 2] (ids:\"1,2\" → array — P5/P14)", cmd.Params["ids"])
	}
	vals, ok := cmd.Params["values"].(map[string]any)
	if !ok || vals["phone"] != "+1234" {
		t.Fatalf("write Params.values = %v, want {phone: +1234}", cmd.Params["values"])
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["success"] != true {
		t.Fatalf("write relay = %v, want wrapper {success:true} (P14/C-2)", inner)
	}
}

// --- PC4: unlink rutea odooUnlink + Params.{tabId, model, ids}.
//           P14 (C-2): ids array (tolerado) + wrapper {success:true} (pin
//           mínimo; mcp.odoo documenta deleted_ids — VERIFICAR vivo). ---

func TestUnlinkTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "unlink")

	hub.result = true
	res, err := callOdooTool(t, s, "unlink", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"ids":     []any{float64(1), float64(2)},
	}, "profA")
	if err != nil {
		t.Fatalf("unlink error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("unlink profileID = %q, want propietario profA", profileID)
	}
	if cmd.Command != "odooUnlink" {
		t.Fatalf("unlink command = %q, want odooUnlink", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("unlink TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("unlink Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "res.partner" {
		t.Fatalf("unlink Params.model = %v, want res.partner", cmd.Params["model"])
	}
	ids, ok := cmd.Params["ids"].([]any)
	if !ok || len(ids) != 2 {
		t.Fatalf("unlink Params.ids = %v, want 2 elementos", cmd.Params["ids"])
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["success"] != true {
		t.Fatalf("unlink relay = %v, want wrapper {success:true} (P14/C-2)", inner)
	}
}

// --- PC5: import_records rutea odooImportRecords. P13 (fb-019-002): llamada
//           con `rows` (JSON array de dicts) + `fields` STRING comma-separated
//           → wire `records` = MATRIZ alineada con fields (el load nativo NO
//           mapea dicts — field verification fb-019-002: wire
//           load([fields], [[v1,v2],…]); valor ausente → nil) + `fields`
//           array (split); respuesta transform {success, created, updated} —
//           rows CON id (External ID) → updated, sin id → created (C-2: keys
//           exactas VERIFICAR vivo; el raw load {ids,…} lo clasifica el
//           server). ---

func TestImportRecordsTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "import_records")

	rows := []any{
		map[string]any{"id": "__export__.res_partner_10", "name": "alpha"},
		map[string]any{"name": "beta"},
	}
	hub.byCommand = map[string]any{
		"odooImportRecords": map[string]any{"ids": []any{float64(12)}},
	}
	res, err := callOdooTool(t, s, "import_records", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"fields":  "id,name",
		"rows":    rows,
	}, "profA")
	if err != nil {
		t.Fatalf("import_records error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("import_records profileID = %q, want propietario profA", profileID)
	}
	if cmd.Command != "odooImportRecords" {
		t.Fatalf("import_records command = %q, want odooImportRecords", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("import_records TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("import_records Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "res.partner" {
		t.Fatalf("import_records Params.model = %v, want res.partner", cmd.Params["model"])
	}
	fields, ok := cmd.Params["fields"].([]any)
	if !ok || len(fields) != 2 || fields[0] != "id" || fields[1] != "name" {
		t.Fatalf("import_records Params.fields = %v, want array [id name] (string \"id,name\" → array — P13)", cmd.Params["fields"])
	}
	// P13 (field verification fb-019-002): el load nativo NO mapea dicts —
	// el wire `records` es la MATRIZ alineada con fields (columna j ↔ fields[j];
	// id ausente en el dict → nil). La clasificación created/updated sigue
	// leyendo el id de los rows originales.
	wantMatrix := []any{
		[]any{"__export__.res_partner_10", "alpha"},
		[]any{nil, "beta"},
	}
	if !reflect.DeepEqual(cmd.Params["records"], wantMatrix) {
		t.Fatalf("import_records Params.records = %v, want matriz alineada %v (rows dicts → load([fields],[[v1,v2],…]) — P13)", cmd.Params["records"], wantMatrix)
	}
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["success"] != true {
		t.Fatalf("import_records relay = %v, want success:true (P13)", inner)
	}
	if !reflect.DeepEqual(inner["created"], []any{float64(12)}) {
		t.Fatalf("import_records created = %v, want [12] (rows sin id → created — P13)", inner["created"])
	}
	if !reflect.DeepEqual(inner["updated"], []any{"__export__.res_partner_10"}) {
		t.Fatalf("import_records updated = %v, want [__export__.res_partner_10] (rows con id → updated — P13)", inner["updated"])
	}
}

// --- PC6: export_records — P8 (fb-019-002): llamada domain-based
//           (domain/fields/limit/offset — ids GONE, breaking pineado) compone
//           EXACTAMENTE 3 commands wire: odooSearchCount (total real) +
//           odooSearchRead(fields:["id"]) para extraer los ids +
//           odooExportRecords(ids, fields) → envelope §2.2 con `records`
//           zip-eado del `datas` del export_data nativo (MATRIZ observada en
//           campo — field verification fb-019-002: el server convierte
//           datas→dicts con los fields exportados; el `id` External ID queda
//           intacto, primera columna ↔ primer field). ⚠️ Gated write en
//           vulpo. ---

func TestExportRecordsTool_RoutesWithOwnerToken(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "export_records")

	// Seed en la shape REAL del export_data nativo: MATRIZ {datas: [[v1,v2],…]}
	// (field verification fb-019-002 — NO dicts).
	exportDatas := []any{[]any{"base.partner_exento", "(AR) Exento"}}
	hub.byCommand = map[string]any{
		"odooSearchCount":   float64(2),
		"odooSearchRead":    []any{map[string]any{"id": float64(1)}, map[string]any{"id": float64(2)}},
		"odooExportRecords": map[string]any{"datas": exportDatas},
	}
	res, err := callOdooTool(t, s, "export_records", map[string]any{
		"profile": "7",
		"model":   "res.partner",
		"domain":  "[('name','ilike','a')]",
		"fields":  "id,name",
		"limit":   float64(500),
		"offset":  float64(0),
	}, "profA")
	if err != nil {
		t.Fatalf("export_records error: %v", err)
	}

	// P8: EXACTAMENTE 3 commands en orden count → read-ids → export.
	got := lastNCommands(hub, 3)
	if len(got) != 3 || got[0] != "odooSearchCount" || got[1] != "odooSearchRead" || got[2] != "odooExportRecords" {
		t.Fatalf("export_records commands = %v, want [odooSearchCount odooSearchRead odooExportRecords]", got)
	}
	readCmd := hub.calls[len(hub.calls)-2].cmd
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("export_records profileID = %q, want propietario profA", profileID)
	}
	if cmd.Command != "odooExportRecords" {
		t.Fatalf("export_records command = %q, want odooExportRecords", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("export_records TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("export_records Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if cmd.Params["model"] != "res.partner" {
		t.Fatalf("export_records Params.model = %v, want res.partner", cmd.Params["model"])
	}
	// el export recibe los ids EXTRAÍDOS del read-ids (no del request).
	ids, ok := cmd.Params["ids"].([]any)
	if !ok || len(ids) != 2 || ids[0] != float64(1) || ids[1] != float64(2) {
		t.Fatalf("export_records Params.ids = %v, want [1 2] (extraídos del odooSearchRead — P8/D-6)", cmd.Params["ids"])
	}
	fields, ok := cmd.Params["fields"].([]any)
	if !ok || len(fields) != 2 || fields[0] != "id" || fields[1] != "name" {
		t.Fatalf("export_records Params.fields = %v, want array [id name] (P13 split)", cmd.Params["fields"])
	}
	// el read-ids lleva fields ["id"] + los limit/offset pedidos (D-6).
	if f, ok := readCmd.Params["fields"].([]any); !ok || len(f) != 1 || f[0] != "id" {
		t.Fatalf("export_records read Params.fields = %v, want [id] (solo ids — D-6)", readCmd.Params["fields"])
	}
	if readCmd.Params["limit"] != float64(500) || readCmd.Params["offset"] != float64(0) {
		t.Fatalf("export_records read Params.limit/offset = %v/%v, want 500/0", readCmd.Params["limit"], readCmd.Params["offset"])
	}
	if _, hasIds := readCmd.Params["ids"]; hasIds {
		t.Fatalf("export_records read Params.ids presente — el read-ids NO lleva ids (domain-based — P8): %v", readCmd.Params)
	}

	// P8: envelope §2.2 + records zip-eados del datas (External ID intacto,
	// primera columna ↔ primer field — field verification fb-019-002).
	var inner map[string]any
	resultJSON(t, res, &inner)
	if inner["total"] != float64(2) || inner["limit"] != float64(500) || inner["offset"] != float64(0) {
		t.Fatalf("envelope total/limit/offset = %v/%v/%v, want 2/500/0", inner["total"], inner["limit"], inner["offset"])
	}
	// fórmula viva §2.2: has_more = offset+n < total → (0+1) < 2 = true
	// (el datas alineado trae 1 fila; el total viene del count, no de len).
	if inner["has_more"] != true || inner["next_offset"] != float64(500) {
		t.Fatalf("envelope has_more/next_offset = %v/%v, want true/500 (0+1<2=true; 0+500 — fórmula viva §2.2)", inner["has_more"], inner["next_offset"])
	}
	if inner["format"] != "json" {
		t.Fatalf("envelope format = %v, want json", inner["format"])
	}
	wantExportRecords := []any{map[string]any{"id": "base.partner_exento", "name": "(AR) Exento"}}
	if !reflect.DeepEqual(inner["records"], wantExportRecords) {
		t.Fatalf("envelope records = %v, want dicts zip-eados del datas %v (External ID intacto, columna↔field)", inner["records"], wantExportRecords)
	}
}

// --- PC7: sin profile → resuelve el PRIMER perfil activo. ---

func TestWriteTool_ResolvesFirstActiveProfile(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "write")

	hub.result = true
	if _, err := callOdooTool(t, s, "write", map[string]any{
		"model":  "res.partner",
		"ids":    []any{float64(1)},
		"values": map[string]any{"name": "x"},
	}, "profA"); err != nil {
		t.Fatalf("write sin profile error: %v", err)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("profileID = %q, want profA (token del llamador)", profileID)
	}
	if cmd.Command != "odooWrite" {
		t.Fatalf("command = %q, want odooWrite", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("TabID = %q, want 7 (primer perfil activo, no el 9 inactivo)", cmd.TabID)
	}
}

// --- PC8: sin perfil activo → error, sin ruteear. ---

func TestWriteTool_NoActiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{}) // sin tabs activos
	requireTool(t, s, "write")

	msg := callOdooToolError(t, s, "write", map[string]any{
		"model": "res.partner", "ids": []any{float64(1)}, "values": map[string]any{"name": "x"},
	}, "profA")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooWrite") {
		t.Fatal("no debe ruteear odooWrite sin perfil activo")
	}
}

// --- PC8: profile apunta a un tab inactivo → error, sin ruteear. ---

func TestWriteTool_InactiveProfile_ReturnsError(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7(), profileTab9()})
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()}) // tab9 → inactivo
	requireTool(t, s, "write")

	msg := callOdooToolError(t, s, "write", map[string]any{
		"profile": "9", "model": "res.partner", "ids": []any{float64(1)}, "values": map[string]any{"name": "x"},
	}, "tok1")
	if !strings.Contains(msg, "No Odoo tab detected") {
		t.Fatalf("error = %q, want 'No Odoo tab detected'", msg)
	}
	if hasCommandName(hub, "odooWrite") {
		t.Fatal("no debe ruteear odooWrite hacia un tab inactivo")
	}
}

// --- PC9: args requeridos validados en el handler. ---

func TestWriteTool_ArgValidations(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	requireTool(t, s, "create")
	requireTool(t, s, "write")
	requireTool(t, s, "unlink")
	requireTool(t, s, "import_records")

	cases := []struct {
		name string
		tool string
		args map[string]any
		want string
	}{
		{"create sin values", "create",
			map[string]any{"profile": "7", "model": "res.partner"},
			"requires values"},
		{"write sin ids", "write",
			map[string]any{"profile": "7", "model": "res.partner", "values": map[string]any{"name": "x"}},
			"requires ids"},
		{"unlink sin ids", "unlink",
			map[string]any{"profile": "7", "model": "res.partner"},
			"requires ids"},
		{"import_records sin fields", "import_records",
			map[string]any{"profile": "7", "model": "res.partner", "rows": []any{map[string]any{"id": "__export__.x"}}},
			"requires fields"},
		{"import_records sin rows", "import_records",
			map[string]any{"profile": "7", "model": "res.partner", "fields": "id"},
			"requires rows"},
		{"import_records con records (alias viejo) sin rows", "import_records",
			map[string]any{"profile": "7", "model": "res.partner", "fields": "id", "records": []any{map[string]any{"id": "__export__.x"}}},
			"requires rows"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			msg := callOdooToolError(t, s, c.tool, c.args, "tok1")
			if !strings.Contains(msg, c.want) {
				t.Fatalf("%s error = %q, want contener %q", c.tool, msg, c.want)
			}
		})
	}
	if hasCommandName(hub, "odooCreate") || hasCommandName(hub, "odooWrite") ||
		hasCommandName(hub, "odooUnlink") || hasCommandName(hub, "odooImportRecords") ||
		hasCommandName(hub, "odooExportRecords") {
		t.Fatal("validaciones de args no deben ruteear ningún command")
	}
}

// --- PC10: WRITE_TOOLS de background.js contiene los 5 commands write. ---

func TestWriteTools_BackgroundWiring(t *testing.T) {
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
	commands := []string{"odooCreate", "odooWrite", "odooUnlink", "odooImportRecords", "odooExportRecords"}
	for _, c := range commands {
		if !strings.Contains(content, c) {
			t.Fatalf("WRITE_TOOLS de background.js (%s) no contiene %q (PC10)", bgPath, c)
		}
	}
}
