// fb-024-screenshot-imagen — P3 golden regression guard (stage 3 RED).
//
// Source: docs/specs/fb-024-screenshot-imagen/spec.md §3 P3, §4 I-3;
// docs/specs/fb-024-screenshot-imagen/test-audit.md §4 G-3 (GC-3 class-split).
//
// Class A (19 direct-command tools): strict oracle. The tools/call response
// is re-decoded semantically and must equal {content:[{type:"text",
// text:<marshalNoEscape of the hub result>}]} — same single text part,
// same payload, no extra parts, no image part, no base64 anywhere.
// Class B (12 registry tools + vlp_help): weak oracle — exactly one
// type:"text" content[0], non-empty, no image part, no base64/dataUrl
// substring (registry tools route through the odooregistry adapter and
// compose several hub commands, so the strict oracle does not apply).
//
// RED-neutral: expected green on the committed tree before implementation
// and to stay green through GREEN (regression guard for I-3).

package mcp

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"vulpo/server/internal/odooregistry"
)

// fb024GoldenHubPayload is the hub answer seeded for class-A direct tools:
// a payload whose raw marshaling contains plain text (no HTML escaping).
func fb024GoldenHubPayload() map[string]any {
	return map[string]any{"tabId": float64(7), "url": "https://x.example:8014/some/path", "title": "Some <Title> & \"Quotes\""}
}

// fb024HubResults re-uses the fb-020-006 ORM seeding so registry tools
// succeed (their wire commands differ from the vlp fallback result).
func fb024HubResults() map[string]any {
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

// fb024GoldenArgs returns minimal valid args per tool (TestCommandWire loop
// for the vlp_* tools; the fb006OrmTools minimum for registry tools).
func fb024GoldenArgs(name string, requiresTab bool) map[string]any {
	args := map[string]any{}
	if requiresTab {
		args["tabId"] = float64(7)
	}
	switch name {
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
	// Registry minimums (fb006OrmTools arg shapes — mcp_odoo_tab_selection_test.go).
	case "search_read", "search_count", "list_fields":
		args["model"] = "res.partner"
	case "create":
		args["model"] = "res.partner"
		args["values"] = map[string]any{"name": "x"}
	case "write", "unlink":
		args["model"] = "res.partner"
		args["ids"] = []any{float64(1)}
		if name == "write" {
			args["values"] = map[string]any{"name": "x"}
		}
	case "import_records":
		args["model"] = "res.partner"
		args["fields"] = "name"
		args["rows"] = []any{map[string]any{"name": "x"}}
	case "export_records":
		args["model"] = "res.partner"
	case "execute_kw":
		args["model"] = "res.partner"
		args["method"] = "search_count"
		args["args"] = []any{[]any{}}
	}
	return args
}

// fb024TextPartsOf returns only the type:"text" parts of result.content.
func fb024TextPartsOf(t *testing.T, res map[string]any) []string {
	t.Helper()
	arr, ok := res["content"].([]any)
	if !ok {
		t.Fatalf("fb-024 P3: result.content missing — %v", res)
	}
	var out []string
	for i, it := range arr {
		part, ok := it.(map[string]any)
		if !ok {
			t.Fatalf("fb-024 P3: content[%d] not an object — %T", i, it)
		}
		if part["type"] != "text" {
			continue
		}
		text, _ := part["text"].(string)
		out = append(out, text)
	}
	return out
}

func TestOtherToolsGolden(t *testing.T) {
	for _, tt := range toolsTable {
		if tt.name == "vlp_screenshot" {
			continue // the tool whose wire shape this cycle changes — excluded from the golden
		}
		if tt.name == "vlp_openTab" {
			t.Skip("excluida del golden de reenvío tal cual — spec fb-024-opentab-id Enmienda 1 (D-1/D-2): el contrato deja de ser reenvío (resolución post-create); salida anclada en opentab_resolve_test.go P1–P4, precedente vlp_screenshot")
		}
		t.Run(tt.name, func(t *testing.T) {
			hub := &MockHub{}
			reg := odooregistry.New()
			s := New(hub)
			RegisterAllTools(s, hub, "", reg)

			// Seed: hub.result is the MockHub fallback used by direct-command
			// tools; byCommand seeds the ORM commands reached through the
			// registry adapter; detectByToken seeds the per-token extension
			// detection (mcp_tools_test.go MockHub contract, :25-64).
			payload := fb024GoldenHubPayload()
			hub.result = payload
			hub.byCommand = fb024HubResults()
			if tt.viaRegistry {
				seedDetect(t, hub, reg, "tok1", []map[string]any{profileTab7()})
			}

			args := fb024GoldenArgs(tt.name, tt.requiresTab)
			resp, _ := s.HandleRequest(map[string]any{
				"id": 1, "method": "tools/call",
				"params": map[string]any{"name": tt.name, "arguments": args},
			}, "tok1")
			m, ok := resp.(map[string]any)
			if !ok {
				t.Fatalf("fb-024 P3: %s unexpected response %T", tt.name, resp)
			}

			if tt.viaRegistry || tt.name == "vlp_help" {
				// Class B — weak oracle (GC-3): registry tools compose
				// several hub commands and emit {"odoo_tab":...} extra texts
				// (multiContentResult, P9 precedent); the oracle guards the
				// content CLASS, not a single-part count.
				if errVal, hasErr := m["error"]; hasErr {
					t.Fatalf("fb-024 P3 (weak): %s unexpected error: %v", tt.name, errVal)
				}
				res := m["result"].(map[string]any)
				var textParts []string
				if arr, ok := res["content"].([]any); ok {
					for _, it := range arr {
						part, _ := it.(map[string]any)
						if part != nil && part["type"] == "text" {
							textParts = append(textParts, part["text"].(string))
						}
					}
				}
				if len(textParts) == 0 || strings.TrimSpace(textParts[0]) == "" {
					t.Fatalf("fb-024 P3 (weak): %s text parts = %q, want at least one non-empty text part", tt.name, textParts)
				}
				for i, it := range res["content"].([]any) {
					part, _ := it.(map[string]any)
					if part != nil && part["type"] == "image" {
						t.Errorf("fb-024 P3 (weak): %s content[%d] is an image part; only vlp_screenshot may emit one", tt.name, i)
					}
					if part != nil {
						text, _ := part["text"].(string)
						if strings.Contains(text, "dataUrl") || strings.Contains(text, "base64,") {
							t.Errorf("fb-024 P3 (weak): %s content[%d] contains base64/dataUrl payload", tt.name, i)
						}
					}
				}
				return
			}

			// Class A — strict oracle: single text part == marshalNoEscape of hub result.
			if errVal, hasErr := m["error"]; hasErr {
				t.Fatalf("fb-024 P3 (strict): %s unexpected error: %v", tt.name, errVal)
			}
			res := m["result"].(map[string]any)
			arr, ok := res["content"].([]any)
			if !ok || len(arr) != 1 {
				t.Fatalf("fb-024 P3 (strict): %s content = %v, want exactly one part", tt.name, res["content"])
			}
			part, ok := arr[0].(map[string]any)
			if !ok {
				t.Fatalf("fb-024 P3 (strict): %s content[0] not an object — %T", tt.name, arr[0])
			}
			if part["type"] != "text" {
				t.Fatalf("fb-024 P3 (strict): %s content[0].type = %v, want text", tt.name, part["type"])
			}
			text, _ := part["text"].(string)
			var inner any
			if err := json.Unmarshal([]byte(text), &inner); err != nil {
				t.Fatalf("fb-024 P3 (strict): %s text is not JSON: %q (%v)", tt.name, text, err)
			}
			var want any
			wantRaw, _ := json.Marshal(fb024GoldenHubPayload())
			_ = json.Unmarshal(wantRaw, &want)
			if !reflect.DeepEqual(inner, want) {
				t.Fatalf("fb-024 P3 (strict): %s text decoded = %v, want marshalNoEscape-equivalent of %v", tt.name, inner, want)
			}
			textParts := fb024TextPartsOf(t, res)
			if len(textParts) != 1 {
				t.Fatalf("fb-024 P3 (strict): %s text parts = %d, want 1", tt.name, len(textParts))
			}
		})
	}
}
