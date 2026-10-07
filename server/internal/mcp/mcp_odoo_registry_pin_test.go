// Package mcp tests — sub-fase RED, feature fb-027-004-odoo-registry-pin-aware.
//
// Verifica el contrato server-side (Go) del spec
// (docs/specs/fb-027-004-odoo-registry-pin-aware/spec.md, P1–P13) y el plan de
// RED del AUDIT (docs/specs/.../test-audit.md §4): 7 RED (P1,P2,P3,P5,P6,P7,P8)
// + 2 guards (P4,P11).
//
// El pin es estado de la EXTENSIÓN. Se simula (spec §2.4) sembrando el cache
// pre-pin vía seedDetect([...7,9]) y luego MUTANDO hub.detectByToken[token]=[7]
// SIN re-seedear el registry: el cache queda pre-pin y el próximo Detect
// pin-aware devuelve sólo la fijada — exactamente el filtro owned ∧ inPin.
//
// Condiciones del AUDIT (vinculantes):
//   - R-3: los fixtures de P6/P8 usan tabs en grupos (origin,db) DISTINTOS (con
//     profileTab7/9, que comparten origin/db, el resolver elige el menor tabId y
//     P6 quedaría verde-vacuo). P1/P3 usan metadata distinta por tab.
//   - E-1: helper de fixture ADITIVO pinTab(tabID, origin, db) (no toca los
//     fixtures existentes). El username se deriva del db para que la metadata
//     sea discriminante (R-3).
package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

// pinTab (E-1, fb-027-004, audit §6.2): fixture aditivo de una tab Odoo con
// (origin,db) distintos y username derivado del db, para que los tests de pin
// sean discriminantes (R-3). No reemplaza a fb006Tab/profileTabN.
func pinTab(tabID int, origin, db string) map[string]any {
	return map[string]any{
		"tabId": tabID, "url": origin, "db": db,
		"version": "18.0", "uid": tabID, "username": db + "-user",
		"is_superuser": false, "is_active": true,
	}
}

// pinProfileKeys: las 8 claves del shape congelado (paridad fb-013 — P2).
var pinProfileKeys = map[string]bool{
	"tabId": true, "url": true, "db": true, "version": true,
	"uid": true, "username": true, "is_superuser": true, "is_active": true,
}

// pinListHasTab: ¿la salida de list_available_profiles incluye la tab tabID?
func pinListHasTab(t *testing.T, list []any, tabID int) bool {
	t.Helper()
	for _, e := range list {
		if m, ok := e.(map[string]any); ok && m["tabId"] == float64(tabID) {
			return true
		}
	}
	return false
}

// pinJSONHas: ¿la representación JSON de v contiene el substring sub? (aserción
// negativa de fuga de metadata — P1/P3).
func pinJSONHas(t *testing.T, v any, sub string) bool {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("pinJSONHas: marshal: %v", err)
	}
	return strings.Contains(string(b), sub)
}

// --- P1 (RED): list_available_profiles expone SÓLO el conjunto activo; bajo un
//     pin, la metadata de la tab fuera del pin no es observable. ---

func TestOdooRegistryPin_P1_ListProfilesExcludesOutOfPin(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")

	pinned := pinTab(7, "https://a.example.com/odoo", "adb")
	outOfPin := pinTab(9, "https://b.example.com/odoo", "bdb")
	// Cache pre-pin: ambas activas.
	seedDetect(t, hub, reg, "profA", []map[string]any{pinned, outOfPin})
	// Simular el pin: la extensión ahora devuelve SÓLO la fijada (7). El cache
	// del registry queda pre-pin (no se re-seedea).
	hub.detectByToken["profA"] = []map[string]any{pinned}

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("P1: list_available_profiles error: %v", err)
	}
	var list []any
	resultJSON(t, res, &list)

	// La fijada SÍ está (evita un pase vacuo con salida vacía).
	if !pinListHasTab(t, list, 7) {
		t.Fatalf("P1: la salida no contiene la tab fijada 7: %v", list)
	}
	// La metadata de la tab fuera del pin NO es observable por el agente.
	for _, leak := range []string{"https://b.example.com", "bdb", "bdb-user"} {
		if pinJSONHas(t, list, leak) {
			t.Fatalf("P1: la salida expone metadata de la tab fuera del pin (%q): %v", leak, list)
		}
	}
}

// --- P2 (RED): shape de 8 campos preservado; is_active siempre true (campo
//     vestigial); sin Odoo → []. ---

func TestOdooRegistryPin_P2_ProfileShapeActiveOnly(t *testing.T) {
	t.Run("shape de 8 campos, is_active true", func(t *testing.T) {
		s, hub, reg := newOdooTools(t)
		requireTool(t, s, "list_available_profiles")
		pinned := pinTab(7, "https://a.example.com/odoo", "adb")
		outOfPin := pinTab(9, "https://b.example.com/odoo", "bdb")
		seedDetect(t, hub, reg, "profA", []map[string]any{pinned, outOfPin})
		hub.detectByToken["profA"] = []map[string]any{pinned}

		res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
		if err != nil {
			t.Fatalf("P2: list_available_profiles error: %v", err)
		}
		var list []any
		resultJSON(t, res, &list)
		if len(list) == 0 {
			t.Fatal("P2: la salida está vacía (want la tab fijada)")
		}
		for i, e := range list {
			m, ok := e.(map[string]any)
			if !ok {
				t.Fatalf("P2: entrada %d no es objeto: %T", i, e)
			}
			if len(m) != len(pinProfileKeys) {
				t.Fatalf("P2: entrada %d tiene %d claves, want 8 (%v)", i, len(m), m)
			}
			for k := range m {
				if !pinProfileKeys[k] {
					t.Fatalf("P2: entrada %d tiene clave inesperada %q: %v", i, k, m)
				}
			}
			// is_active es vestigial: SIEMPRE true en la salida.
			if m["is_active"] != true {
				t.Fatalf("P2: entrada %d is_active = %v, want true (campo vestigial — Q3)", i, m["is_active"])
			}
		}
	})

	t.Run("sin Odoo → []", func(t *testing.T) {
		s, hub, reg := newOdooTools(t)
		requireTool(t, s, "list_available_profiles")
		seedDetect(t, hub, reg, "profA", []map[string]any{})
		res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
		if err != nil {
			t.Fatalf("P2: sin Odoo no debe fallar: %v", err)
		}
		var list []any
		resultJSON(t, res, &list)
		if len(list) != 0 {
			t.Fatalf("P2: sin Odoo devolvió %d, want 0", len(list))
		}
	})
}

// --- P3 (RED, negativa — el leak): con un cache activo+inactivo, la metadata
//     de la tab inactiva no es observable por el agente. ---

func TestOdooRegistryPin_P3_InactiveMetadataNotObservable(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")

	active := pinTab(7, "https://a.example.com/odoo", "adb")
	inactive := pinTab(9, "https://b.example.com/odoo", "bdb")
	// Cache con activas E inactivas tras el pin.
	seedDetect(t, hub, reg, "profA", []map[string]any{active, inactive})
	hub.detectByToken["profA"] = []map[string]any{active} // la 9 queda inactiva

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("P3: list_available_profiles error: %v", err)
	}
	var list []any
	resultJSON(t, res, &list)

	if len(list) != 1 {
		t.Fatalf("P3: la salida tiene %d entradas, want 1 (sólo la activa): %v", len(list), list)
	}
	if !pinListHasTab(t, list, 7) {
		t.Fatalf("P3: la salida no contiene la tab activa 7: %v", list)
	}
	for _, leak := range []string{"https://b.example.com", "bdb", "bdb-user"} {
		if pinJSONHas(t, list, leak) {
			t.Fatalf("P3: la metadata de la tab inactiva es observable (%q): %v", leak, list)
		}
	}
}

// --- P4 (guard): sin pin → list_available_profiles devuelve TODAS las tabs
//     Odoo activas detectadas (el único delta es excluir las inactivas). ---

func TestOdooRegistryPin_P4_NoPinAllActiveReturned(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	requireTool(t, s, "list_available_profiles")

	tab7 := pinTab(7, "https://a.example.com/odoo", "adb")
	tab9 := pinTab(9, "https://b.example.com/odoo", "bdb")
	seedDetect(t, hub, reg, "profA", []map[string]any{tab7, tab9}) // sin pin

	res, err := callOdooTool(t, s, "list_available_profiles", map[string]any{}, "profA")
	if err != nil {
		t.Fatalf("P4: list_available_profiles error: %v", err)
	}
	var list []any
	resultJSON(t, res, &list)
	if len(list) != 2 {
		t.Fatalf("P4: sin pin la salida tiene %d entradas, want 2 (ambas activas): %v", len(list), list)
	}
	if !pinListHasTab(t, list, 7) || !pinListHasTab(t, list, 9) {
		t.Fatalf("P4: sin pin deben estar las tabs 7 y 9: %v", list)
	}
	for i, e := range list {
		if m, ok := e.(map[string]any); ok && m["is_active"] != true {
			t.Fatalf("P4: entrada %d is_active = %v, want true", i, m["is_active"])
		}
	}
}

// --- P5 (RED): resolve corre EXACTAMENTE un Detect antes de resolver en TODA
//     llamada ORM (cache cálido incluido), y precede al comando ORM. ---

func TestOdooRegistryPin_P5_ResolveDetectsOncePerCall(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{pinTab(7, "https://a.example.com/odoo", "adb")})
	hub.byCommand = fb006HubResults() // cache cálido: sin re-detect hoy

	n := fb006NCalls(hub)
	if _, err := callOdooTool(t, s, "get_version", map[string]any{}, "profA"); err != nil {
		t.Fatalf("P5: get_version error: %v", err)
	}
	cmds := fb006CallsSince(hub, n)
	names := fb006Names(cmds)

	detects, detectIdx, ormIdx := 0, -1, -1
	for i, c := range cmds {
		if c.Command == "odooDetectTabs" {
			detects++
			if detectIdx < 0 {
				detectIdx = i
			}
		}
		if c.Command == "odooGetVersion" && ormIdx < 0 {
			ormIdx = i
		}
	}
	if detects != 1 {
		t.Fatalf("P5: la llamada emitió %d odooDetectTabs, want 1 (Detect incondicional por llamada): %v", detects, names)
	}
	if ormIdx < 0 {
		t.Fatalf("P5: no se envió el comando ORM odooGetVersion: %v", names)
	}
	if detectIdx > ormIdx {
		t.Fatalf("P5: odooDetectTabs no precede al comando ORM: %v", names)
	}
}

// --- P6 (RED, núcleo F1b): con un cache pre-pin {7,9 grupos distintos} y un
//     Detect que ahora devuelve sólo la fijada (7), get_version sin tabId
//     resuelve la 7 — nunca la 9. ---

func TestOdooRegistryPin_P6_StaleCacheResolvesPinnedTab(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	tab7 := pinTab(7, "https://a.example.com/odoo", "adb")
	tab9 := pinTab(9, "https://b.example.com/odoo", "bdb") // grupo distinto (R-3)
	seedDetect(t, hub, reg, "profA", []map[string]any{tab7, tab9})
	hub.detectByToken["profA"] = []map[string]any{tab7} // pin: la 9 queda fuera
	hub.byCommand = fb006HubResults()

	n := fb006NCalls(hub)
	if _, err := callOdooTool(t, s, "get_version", map[string]any{}, "profA"); err != nil {
		t.Fatalf("P6: get_version sin tabId (cache pre-pin + pin) error: %v (commands=%v)", err, fb006Names(fb006CallsSince(hub, n)))
	}
	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Fatalf("P6: profileID = %q, want profA", profileID)
	}
	if cmd.Command != "odooGetVersion" {
		t.Fatalf("P6: command = %q, want odooGetVersion", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("P6: TabID = %q, want 7 (la fijada, no la 9 stale)", cmd.TabID)
	}
}

// --- P7 (RED): con el mismo escenario y {tabId:9} (fuera del pin), resolve NO
//     usa la 9: error odoo_no_tab (o odoo_ambiguous_tab), sin comando ORM a la 9. ---

func TestOdooRegistryPin_P7_OutOfPinTabIdNoTab(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	tab7 := pinTab(7, "https://a.example.com/odoo", "adb")
	tab9 := pinTab(9, "https://b.example.com/odoo", "bdb")
	seedDetect(t, hub, reg, "profA", []map[string]any{tab7, tab9})
	hub.detectByToken["profA"] = []map[string]any{tab7} // pin: la 9 queda fuera
	hub.byCommand = fb006HubResults()

	n := fb006NCalls(hub)
	msg := callOdooToolError(t, s, "get_version", map[string]any{"tabId": float64(9)}, "profA")
	if !strings.HasPrefix(msg, "odoo_no_tab:") && !strings.HasPrefix(msg, "odoo_ambiguous_tab:") {
		t.Fatalf("P7: error = %q, want prefijo odoo_no_tab: (o odoo_ambiguous_tab:)", msg)
	}
	for _, c := range fb006CallsSince(hub, n) {
		if c.Command != "odooDetectTabs" && c.TabID == "9" {
			t.Fatalf("P7: se envió el comando ORM %s a la tab 9 (fuera del pin): %v", c.Command, fb006Names(fb006CallsSince(hub, n)))
		}
	}
}

// --- P8 (RED): odoo_ambiguous_tab lista/nombra SÓLO candidatos activos del
//     último Detect; nunca {tabId,origin,db} de tabs fuera del pin. ---

func TestOdooRegistryPin_P8_AmbiguousListsOnlyActive(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	tab7 := pinTab(7, "https://a.example.com/odoo", "adb")
	tab9 := pinTab(9, "https://b.example.com/odoo", "bdb")
	tab11 := pinTab(11, "https://c.example.com/odoo", "cdb")
	// Cache pre-pin: 3 grupos distintos.
	seedDetect(t, hub, reg, "profA", []map[string]any{tab7, tab9, tab11})
	// Pin: la extensión devuelve 7 y 9 (ambigüedad dentro del pin); la 11 queda fuera.
	hub.detectByToken["profA"] = []map[string]any{tab7, tab9}
	hub.byCommand = fb006HubResults()

	n := fb006NCalls(hub)
	msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
	if !strings.HasPrefix(msg, "odoo_ambiguous_tab:") {
		t.Fatalf("P8: error = %q, want prefijo odoo_ambiguous_tab:", msg)
	}
	// Nombra a los candidatos activos del último Detect.
	for _, w := range []string{"7", "9", "adb", "bdb"} {
		if !strings.Contains(msg, w) {
			t.Fatalf("P8: error = %q, want contener el candidato activo %q", msg, w)
		}
	}
	// Nunca la tab fuera del pin.
	for _, leak := range []string{"11", "cdb", "c.example.com"} {
		if strings.Contains(msg, leak) {
			t.Fatalf("P8: el error nombra la tab fuera del pin (%q): %q", leak, msg)
		}
	}
	if orm := fb006OrmOnly(fb006CallsSince(hub, n)); len(orm) != 0 {
		t.Fatalf("P8: se envió comando ORM pese a la ambigüedad: %v", fb006Names(orm))
	}
}

// --- P11 (guard): cada llamada de una tool ORM envía EXACTAMENTE un comando
//     ORM; la repetición permitida sigue siendo sólo odooDetectTabs. ---

func TestOdooRegistryPin_P11_OneOrmCommandPerCall(t *testing.T) {
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{pinTab(7, "https://a.example.com/odoo", "adb")})
	hub.byCommand = fb006HubResults()

	cases := []struct {
		name string
		args map[string]any
	}{
		{"get_version", map[string]any{}},
		{"search_count", map[string]any{"model": "res.partner"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			n := fb006NCalls(hub)
			if _, err := callOdooTool(t, s, tc.name, tc.args, "profA"); err != nil {
				t.Fatalf("P11: %s error: %v", tc.name, err)
			}
			orm := fb006OrmOnly(fb006CallsSince(hub, n))
			if len(orm) != 1 {
				t.Fatalf("P11: %s envió %d comandos ORM, want exactamente 1: %v", tc.name, len(orm), fb006Names(orm))
			}
		})
	}
}
