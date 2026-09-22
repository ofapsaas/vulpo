// fb-020-007-orm-navigation-hang — sub-fase RED, categorización ORM del server
// (docs/specs/fb-020-007-orm-navigation-hang/spec.md v1.1 §2.4, P5–P6).
//
// MockHub hace de hub: errByCommand devuelve el error que el hub real produce
// al vencer el presupuesto (`command_timeout: ...`, §2.3) o el que la
// extensión produce cuando la pestaña navegó durante una escritura
// (`odoo_tab_unreachable: ... may have been dispatched ...`, §2.2).
package mcp

import (
	"errors"
	"strings"
	"testing"
)

const (
	fb007HubTimeoutSearchCount = "command_timeout: no answer or heartbeat from the extension for odooSearchCount on tab 23 within 45000 ms; the command may have been dispatched"
	fb007HubTimeoutCreate      = "command_timeout: no answer or heartbeat from the extension for odooCreate on tab 23 within 45000 ms; the command may have been dispatched"
	fb007TabNavigatedWrite     = "odoo_tab_unreachable: tab 23 navigated while the command was running; the command may have been dispatched — re-read before retrying"
)

func fb007Tools(t *testing.T) (*Server, *MockHub) {
	t.Helper()
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{fb006Tab(23, "http://odoo.local:8069/odoo/action-760", "salesdb")})
	return s, hub
}

func fb007ExpectContext(t *testing.T, p, msg string) {
	t.Helper()
	for _, w := range []string{"23", "http://odoo.local:8069", "salesdb"} {
		if !strings.Contains(msg, w) {
			t.Fatalf("%s: error = %q, want contener %q (tabId, origin, db)", p, msg, w)
		}
	}
}

// fb007ExpectRedetect: la siguiente llamada ORM del mismo token corre
// odooDetectTabs antes de enrutar (regla P11 de fb-020-006, vigente en §2.4).
func fb007ExpectRedetect(t *testing.T, p string, s *Server, hub *MockHub) {
	t.Helper()
	hub.errByCommand = nil
	hub.byCommand = map[string]any{"odooSearchCount": float64(2733)}
	n := fb006NCalls(hub)
	if _, err := callOdooTool(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA"); err != nil {
		t.Fatalf("%s: llamada siguiente error: %v", p, err)
	}
	cmds := fb006CallsSince(hub, n)
	names := fb006Names(cmds)
	if len(cmds) == 0 || cmds[0].Command != "odooDetectTabs" {
		t.Fatalf("%s: tras la falla, commands = %v, want odooDetectTabs antes de enrutar", p, names)
	}
}

// --- P5: command_timeout del hub en ORM → odoo_command_timeout categorizado ---

func TestFb007_P5_ReadCommandTimeoutCategorized(t *testing.T) {
	s, hub := fb007Tools(t)
	hub.errByCommand = map[string]error{"odooSearchCount": errors.New(fb007HubTimeoutSearchCount)}

	n := fb006NCalls(hub)
	msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
	if !strings.HasPrefix(msg, "odoo_command_timeout:") {
		t.Fatalf("P5: error = %q, want prefijo odoo_command_timeout:", msg)
	}
	fb007ExpectContext(t, "P5", msg)
	if !strings.Contains(msg, "safe to retry") {
		t.Fatalf("P5: error de lectura = %q, want contener \"safe to retry\"", msg)
	}
	if orm := fb006OrmOnly(fb006CallsSince(hub, n)); len(orm) != 1 {
		t.Fatalf("P5: el hub recibió %d comandos ORM, want exactamente 1: %v", len(orm), fb006Names(orm))
	}
	fb007ExpectRedetect(t, "P5", s, hub)
}

func TestFb007_P5_WriteCommandTimeoutAsksReRead(t *testing.T) {
	s, hub := fb007Tools(t)
	hub.errByCommand = map[string]error{"odooCreate": errors.New(fb007HubTimeoutCreate)}

	n := fb006NCalls(hub)
	msg := callOdooToolError(t, s, "create", map[string]any{"model": "res.partner", "values": map[string]any{"name": "x"}}, "profA")
	if !strings.HasPrefix(msg, "odoo_command_timeout:") {
		t.Fatalf("P5: error = %q, want prefijo odoo_command_timeout:", msg)
	}
	fb007ExpectContext(t, "P5", msg)
	if !strings.Contains(msg, "re-read before retrying") {
		t.Fatalf("P5: error de escritura = %q, want contener \"re-read before retrying\"", msg)
	}
	if strings.Contains(msg, "safe to retry") {
		t.Fatalf("P5: error de escritura = %q contiene \"safe to retry\" (I-3)", msg)
	}
	if orm := fb006OrmOnly(fb006CallsSince(hub, n)); len(orm) != 1 {
		t.Fatalf("P5: el hub recibió %d comandos ORM, want exactamente 1: %v", len(orm), fb006Names(orm))
	}
}

// --- P6 (v1.3): odoo_tab_unreachable "may have been dispatched" conserva el
//     texto del hub, agrega contexto y NO repite "re-read before retrying"
//     (enmienda v1.3, O-2: la cola del server no puede exigir la frase si el
//     texto del hub ya la trae). Sigue prohibido un "and retry" sin releer:
//     el criterio se evalúa por aparición, sobre la cola que agrega el server
//     (así el "re-read" del hub no satisface el chequeo por sí solo). ---

func TestFb007_P6_MayHaveBeenDispatchedKeepsReRead(t *testing.T) {
	s, hub := fb007Tools(t)
	hub.errByCommand = map[string]error{"odooCreate": errors.New(fb007TabNavigatedWrite)}

	msg := callOdooToolError(t, s, "create", map[string]any{"model": "res.partner", "values": map[string]any{"name": "x"}}, "profA")
	if !strings.Contains(msg, fb007TabNavigatedWrite) {
		t.Fatalf("P6: error = %q, want conservar el texto del hub %q", msg, fb007TabNavigatedWrite)
	}
	fb007ExpectContext(t, "P6", msg)
	// Lo que agrega el server (después del texto del hub) no invita a "and retry" a secas.
	tail := msg[strings.Index(msg, fb007TabNavigatedWrite)+len(fb007TabNavigatedWrite):]
	if strings.Contains(tail, "and retry") && !strings.Contains(tail, "re-read") {
		t.Fatalf("P6: sufijo del server = %q contiene \"and retry\" sin \"re-read\" (§2.4)", tail)
	}
	// La frase aparece una vez (la del hub) y no se duplica en la cola (O-2).
	if n := strings.Count(msg, "re-read before retrying"); n != 1 {
		t.Fatalf("P6: error = %q contiene %d veces \"re-read before retrying\", want exactamente 1 (v1.3, O-2)", msg, n)
	}
	fb007ExpectRedetect(t, "P6", s, hub)
}
