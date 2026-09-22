// fb-020-007-orm-navigation-hang — sub-fase RED v1.2, sufijos del server para
// odoo_tab_unreachable (docs/specs/fb-020-007-orm-navigation-hang/spec.md
// §9.3 y §9.8 P23).
//
//   - Escrituras (create, write, unlink, import_records, execute_kw): todo
//     odoo_tab_unreachable que no contenga "NOT dispatched" lleva
//     "re-read before retrying" y nunca "and retry" sin "re-read".
//   - Lecturas: si el texto ya trae "safe to retry" o "NOT dispatched", el server
//     no agrega el sufijo genérico "activate or reload … and retry".
package mcp

import (
	"errors"
	"strings"
	"testing"
)

const (
	fb007NoResult        = "odoo_tab_unreachable: tab 7: no result from the injected script"
	fb007ReadSafeRetry   = "odoo_tab_unreachable: tab 7 navigated while the command was running; the command did not complete; it is safe to retry"
	fb007ReadNotDispatch = "odoo_tab_unreachable: tab 7 did not finish loading within 10000 ms; the command was NOT dispatched"
)

func fb007Tab7Tools(t *testing.T) (*Server, *MockHub) {
	t.Helper()
	s, hub, reg := newOdooTools(t)
	seedDetect(t, hub, reg, "profA", []map[string]any{profileTab7()})
	return s, hub
}

// --- P23: escrituras con "no result" → "re-read before retrying", sin "and retry" a secas ---

func TestFb007_P23_WriteToolsNoResultAskReRead(t *testing.T) {
	cases := []struct {
		tool, command string
		args          map[string]any
	}{
		{"create", "odooCreate", map[string]any{"model": "res.partner", "values": map[string]any{"name": "x"}}},
		{"write", "odooWrite", map[string]any{"model": "res.partner", "ids": []any{float64(1)}, "values": map[string]any{"name": "x"}}},
		{"unlink", "odooUnlink", map[string]any{"model": "res.partner", "ids": []any{float64(1)}}},
		{"import_records", "odooImportRecords", map[string]any{"model": "res.partner", "fields": "id,name", "rows": []any{map[string]any{"name": "beta"}}}},
		{"execute_kw", "odooExecuteKw", map[string]any{"model": "res.partner", "method": "action_archive", "args": []any{[]any{float64(1)}}}},
	}
	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			s, hub := fb007Tab7Tools(t)
			hub.errByCommand = map[string]error{tc.command: errors.New(fb007NoResult)}

			msg := callOdooToolError(t, s, tc.tool, tc.args, "profA")
			if !strings.Contains(msg, "odoo_tab_unreachable") {
				t.Fatalf("P23 %s: error = %q, want conservar odoo_tab_unreachable", tc.tool, msg)
			}
			if !strings.Contains(msg, "re-read before retrying") {
				t.Fatalf("P23 %s: error = %q, want contener \"re-read before retrying\" (§9.3)", tc.tool, msg)
			}
			// Criterio de P6, por ocurrencia: ningún "and retry" sin un "re-read" antes.
			for i, off := strings.Index(msg, "and retry"), 0; i >= 0; i = strings.Index(msg[off:], "and retry") {
				at := off + i
				if !strings.Contains(msg[:at], "re-read") {
					t.Fatalf("P23 %s: error = %q contiene \"and retry\" sin \"re-read\" antes (§9.3)", tc.tool, msg)
				}
				off = at + len("and retry")
			}
		})
	}
}

// --- P23: lecturas cuyo texto ya dice "safe to retry" / "NOT dispatched" → sin "activate or reload" ---

func TestFb007_P23_ReadWithDispatchVerdictNoGenericSuffix(t *testing.T) {
	for name, hubErr := range map[string]string{"safe_to_retry": fb007ReadSafeRetry, "NOT_dispatched": fb007ReadNotDispatch} {
		t.Run(name, func(t *testing.T) { fb007ExpectNoGenericSuffix(t, hubErr) })
	}
}

func fb007ExpectNoGenericSuffix(t *testing.T, hubErr string) {
	t.Helper()
	{
		s, hub := fb007Tab7Tools(t)
		hub.errByCommand = map[string]error{"odooSearchCount": errors.New(hubErr)}

		msg := callOdooToolError(t, s, "search_count", map[string]any{"model": "res.partner"}, "profA")
		if !strings.Contains(msg, hubErr) {
			t.Fatalf("P23 lectura: error = %q, want conservar el texto del hub %q", msg, hubErr)
		}
		if strings.Contains(msg, "activate or reload") {
			t.Fatalf("P23 lectura: error = %q contiene el sufijo genérico \"activate or reload\" (§9.3)", msg)
		}
	}
}
