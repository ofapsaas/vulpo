// Tools MCP — port 1:1 de las 19 tools de src/server-node/index.mjs (241-530)
// (fb-007-005-mcp-server). Handlers contra hub.Command (003); vlp_help
// es server-only (no toca el hub). fb-013-001 agrega togglePlanMode (20);
// fb-013-003 agrega las tools odoo (26); fb-017-002 las 2 de frame (34);
// fb-019-002 renombra la familia odoo (drop del prefijo fb_ — paridad con
// mcp.odoo). fb-022 elimina togglePlanMode (plan/build user-only, popup de
// la extensión): total 33 = 21 vlp_* + 12 odoo_*.
package mcp

import (
	_ "embed"
	"fmt"
	"os"
	"sort"
	"strings"

	"vulpo/server/internal/odooregistry"
)

// helpEmbed: default del contenido de vlp_help (go:embed help.txt).
// Robusto e independiente del cwd — empaquetado en el binario (D2, PC4).
// Se usa cuando no hay helpFile ni VLP_HELP_FILE (D1 fix).
//
//go:embed help.txt
var helpEmbed string

// tabID: convierte el tabId del argumento JSON (number) a string (la clave de
// Tabs del hub 003 es string — los eventos de la extensión usan id string).
func tabID(params map[string]any) string {
	if v, ok := params["tabId"]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

// strArg: helper de lectura de argumentos string.
func strArg(params map[string]any, key string) string {
	if v, ok := params[key].(string); ok {
		return v
	}
	return ""
}

// rejectUnknownArgs (fb-020-004 §2.1): error que nombra los argumentos fuera
// de `properties` y lista los aceptados; nil si todos están declarados.
func rejectUnknownArgs(tool string, params map[string]any, properties map[string]any) error {
	var unknown []string
	for name := range params {
		if _, declared := properties[name]; !declared {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	accepted := make([]string, 0, len(properties))
	for name := range properties {
		accepted = append(accepted, name)
	}
	sort.Strings(unknown)
	sort.Strings(accepted)
	return fmt.Errorf("%s rejects unknown arguments: %s (accepted: %s)",
		tool, strings.Join(unknown, ", "), strings.Join(accepted, ", "))
}

// validateFrameKeys (fb-020-008 §2.1.3): valida las claves dentro de `frame`
// contra el vocabulario de §2.1.1 (8 claves). Devuelve error si hay una clave
// desconocida; nil si todas son válidas o si frame está ausente/no es objeto.
func validateFrameKeys(frameValue any) error {
	validKeys := map[string]bool{
		"page": true, "maxElementsPerPage": true, "include": true, "roles": true,
		"namedOnly": true, "settle": true, "waitMs": true, "quietMs": true,
	}
	// Type-assert a objeto; si no es objeto, no hay validación (se degrada a ausencia).
	frame, ok := frameValue.(map[string]any)
	if !ok {
		return nil
	}

	// Derive valid keys list from the vocabulary map (sorted) for the error message.
	validKeysList := make([]string, 0, len(validKeys))
	for k := range validKeys {
		validKeysList = append(validKeysList, k)
	}
	sort.Strings(validKeysList)

	for key := range frame {
		if !validKeys[key] {
			return fmt.Errorf("frame: unknown key %q (accepted: %s)", key, strings.Join(validKeysList, ", "))
		}
	}
	return nil
}

// RegisterAllTools: registra las 33 tools (19 vlp_* + 2 frame fb-017 +
// 12 odoo_* — fb-019-002, sin prefijo fb_) contra el hub. El registry
// odooregistry (fb-013-003) lo usan las tools odoo.
func RegisterAllTools(s *Server, hub Hub, helpFile string, odoo *odooregistry.Registry) {
	cmd := func(command string, params map[string]any, tab string) func(map[string]any, string) (any, error) {
		return func(_ map[string]any, token string) (any, error) {
			return hub.Command(token, Command{Command: command, Params: params, TabID: tab})
		}
	}

	s.RegisterTool(Tool{
		Name: "vlp_listTabs", Description: "List all browser tabs with their IDs, titles, and URLs.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Handler:     cmd("listTabs", map[string]any{}, ""),
	})

	s.RegisterTool(Tool{
		Name: "vlp_activateTab", Description: "Switch to a specific browser tab by tabId.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab to activate"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "activateTab", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_getDOM", Description: "Get the DOM content (outer HTML) of a browser tab or a specific element.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId":    map[string]any{"type": "number", "description": "ID of the tab"},
				"selector": map[string]any{"type": "string", "description": "CSS selector (optional, gets full page if omitted)"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "getDom", Params: map[string]any{"tabId": t, "selector": strArg(params, "selector")}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_eval", Description: "Execute JavaScript code in a browser tab's MAIN world context. It does not check for a pending native dialog (nativeDialog): do not use it to get around a vlp_act or vlp_fill rejection with nativeDialog.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
				"code":  map[string]any{"type": "string", "description": "JavaScript code to execute"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			code := strArg(params, "code")
			if strings.TrimSpace(code) == "" {
				return nil, fmt.Errorf("eval requires code")
			}
			t := tabID(params)
			return hub.Command(token, Command{Command: "eval", Params: map[string]any{"tabId": t, "code": code}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_navigate", Description: "Navigate a browser tab to a specified URL. Without frame, returns {success:true, tabId, url} as soon as the navigation is dispatched — that is all success:true asserts: the navigation was sent, not that the destination document exists or loaded. Optional frame (object, default absent): folds a vlp_getFrame read into this same call, so you get the destination map without a second MCP round trip. Presence is the opt-in switch; frame:{} requests the fold with defaults, no separate boolean exists. Accepted keys, same vocabulary and semantics as vlp_getFrame — page (default 1), maxElementsPerPage (default 200), include (\"sections\"/\"both\", default \"sections\"), roles, namedOnly, settle, waitMs (default 5000), quietMs (default 300); an unknown key inside frame is rejected with a tool error naming it, and nothing is dispatched. Unlike getFrame, settle defaults to true inside the fold — a folded map with no wait for quiescence would arrive mid-update and you would have to re-read anyway, defeating the point; pass frame:{settle:false} for an immediate, cheap read instead. roles/namedOnly are not a convenience trim: they are what makes page 1 of the destination map sufficient on a real form — without narrowing, the agent re-reads regardless and the fold saves nothing. With frame, success:true changes meaning: it means the destination document exists and was serialized (or, if the navigation commit did not land within its deadline, success:true with frame.invalidation.settled:false and frame.invalidation.navigating:true, and the map still travels). Without frame, success keeps its current despatch-only meaning; the change of meaning applies only when frame is present. Caveat: with frame the call also blocks while the map is read — worst case twice frame.waitMs (the second wait caps a navigation commit), default 10 s. Keep that total within your MCP client timeout budget.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
				"url":   map[string]any{"type": "string", "description": "URL to navigate to"},
				"frame": map[string]any{"type": "object", "description": "Optional object to fold the map read (getFrame) into the response; present keys are relayed verbatim to the extension (optional, default absent)"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			url := strArg(params, "url")
			if strings.TrimSpace(url) == "" {
				return nil, fmt.Errorf("navigate requires url")
			}
			t := tabID(params)
			navParams := map[string]any{"tabId": t, "url": url}
			// fb-020-008 §2.1.3 — frame: validar claves interiores y relayar
			// verbatim. Type-assert a objeto; si no es objeto, degrada a ausencia.
			if frameValue, ok := params["frame"]; ok {
				if err := validateFrameKeys(frameValue); err != nil {
					return nil, err
				}
				// Solo relayar si es objeto válido.
				if frameObj, isObject := frameValue.(map[string]any); isObject {
					navParams["frame"] = frameObj
				}
			}
			return hub.Command(token, Command{Command: "navigate", Params: navParams, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_click", Description: "Click on an element in a browser tab identified by CSS selector. It does not check for a pending native dialog (nativeDialog): do not use it to get around a vlp_act or vlp_fill rejection with nativeDialog.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId":         map[string]any{"type": "number", "description": "ID of the tab"},
				"selector":      map[string]any{"type": "string", "description": "CSS selector of the element to click"},
				"flashDuration": map[string]any{"type": "number", "description": "Duration of the pre-click visual indicator in ms", "default": 1200},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			sel := strArg(params, "selector")
			if strings.TrimSpace(sel) == "" {
				return nil, fmt.Errorf("click requires selector")
			}
			t := tabID(params)
			return hub.Command(token, Command{Command: "click", Params: map[string]any{"tabId": t, "selector": sel, "flashDuration": params["flashDuration"]}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_injectCSS", Description: "Inject custom CSS into a browser tab.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
				"css":   map[string]any{"type": "string", "description": "CSS to inject"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			css := strArg(params, "css")
			if strings.TrimSpace(css) == "" {
				return nil, fmt.Errorf("injectCSS requires css")
			}
			t := tabID(params)
			return hub.Command(token, Command{Command: "injectCSS", Params: map[string]any{"tabId": t, "css": css}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_highlight", Description: "Draw a visual attention marker around an element or at specific coordinates on the page.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId":    map[string]any{"type": "number", "description": "ID of the tab"},
				"selector": map[string]any{"type": "string", "description": "CSS selector of the element to highlight"},
				"duration": map[string]any{"type": "number", "description": "Auto-remove timeout in ms", "default": 5000},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "highlight", Params: map[string]any{"tabId": t, "selector": strArg(params, "selector"), "duration": params["duration"]}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_screenshot", Description: "Take a screenshot of a browser tab.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "screenshot", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_getCookies", Description: "Get all cookies from a browser tab's origin.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "getCookies", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_getCurrentTab", Description: "Get the currently active tab in the current window.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Handler:     cmd("getCurrentTab", map[string]any{}, ""),
	})

	s.RegisterTool(Tool{
		Name: "vlp_openTab", Description: "Open a new browser tab with the specified URL.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{"type": "string", "description": "URL to open"},
			},
			"required": []any{"url"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			return hub.Command(token, Command{Command: "openTab", Params: map[string]any{"url": strArg(params, "url")}})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_closeTab", Description: "Close a browser tab by its ID.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab to close"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "closeTab", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_goBack", Description: "Navigate back in the browser tab's history.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "goBack", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_goForward", Description: "Navigate forward in the browser tab's history.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "goForward", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	fillProperties := map[string]any{
		"tabId":    map[string]any{"type": "number", "description": "ID of the tab"},
		"selector": map[string]any{"type": "string", "description": "CSS selector of the input/textarea"},
		"value":    map[string]any{"type": "string", "description": "Value to fill"},
	}
	s.RegisterTool(Tool{
		Name: "vlp_fill", Description: "Fill a form field (input or textarea) in a browser tab with a value; unknown arguments (not declared in the input schema) are rejected with a tool error naming them. If no element matches the selector, nothing is written and it returns {success:false, notFound:true, error, selector}; if the selector is not valid CSS, it returns {success:false, invalidSelector:true, error, selector}. If the target control is disabled (HTML :disabled, including inside <fieldset disabled>) nothing is written and it returns {success:false, disabled:true, error, selector}. Before writing a number, determine the site's own numeric formatting convention (with the site's dedicated tool if one exists, or from the numbers the page already shows) and write the text in that convention. On success it returns {success:true, selector, value, settled, waitedMs}: after writing, it waits for the field to settle (same TEMPORAL, field-only verdict as vlp_act's type observation, covering only the written field, never derived values or the form's state) and adds value (the field's text when resolved) and waitedMs, or detached:true, settled:false without value if the element left the document during the wait; compare the number in value against the target value under that same convention. With a pending native dialog (a confirm/alert/prompt opened during a vlp_act click and still waiting for a human) it returns {success:false, nativeDialog, error, selector} without writing; a dialog opened by fill's own dispatch is not detected and may block the call.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": fillProperties,
			"required":   []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			if err := rejectUnknownArgs("fill", params, fillProperties); err != nil {
				return nil, err
			}
			sel := strArg(params, "selector")
			val := strArg(params, "value")
			if strings.TrimSpace(sel) == "" || strings.TrimSpace(val) == "" {
				return nil, fmt.Errorf("fill requires selector and value")
			}
			t := tabID(params)
			return hub.Command(token, Command{Command: "fill", Params: map[string]any{"tabId": t, "selector": sel, "value": val}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_waitForElement", Description: "Wait for an element to appear in the DOM of a browser tab.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId":    map[string]any{"type": "number", "description": "ID of the tab"},
				"selector": map[string]any{"type": "string", "description": "CSS selector to wait for"},
				"timeout":  map[string]any{"type": "number", "description": "Max wait time in ms", "default": 5000},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "waitForElement", Params: map[string]any{"tabId": t, "selector": strArg(params, "selector"), "timeout": params["timeout"]}, TabID: t})
		},
	})

	s.RegisterTool(Tool{
		Name: "vlp_axSnapshot", Description: "Get a simplified accessibility snapshot of interactive elements in a browser tab.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId": map[string]any{"type": "number", "description": "ID of the tab"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			return hub.Command(token, Command{Command: "axSnapshot", Params: map[string]any{"tabId": t}, TabID: t})
		},
	})

	// ---- fb-017-002 (frame-map-api): vlp_getFrame + vlp_act.
	// Cierran el loop "leer el mapa → actuar por ref" del contrato de driver
	// del epic fb-017 (D6: MCP tools, no REST). getFrame es read; act es write
	// (gated por WRITE_TOOLS en la extensión, D2).
	s.RegisterTool(Tool{
		Name: "vlp_getFrame", Description: "Serialize the interactive frame map (sections + read) of a browser tab as a paginated Frame contract; includes invalidation: {changedSinceLast} so agents can reuse a cached map when the DOM did not change. Optional include=\"both\" also returns the redundant do[] list of refs; roles/namedOnly narrow the map (never applied by default). With an open dialog, the response also includes a top-level dialog: {ref, role, name} field; dialog.modal:true is present only when a hit-test found the dialog actually covering the background — in that case, elements covered by it are marked inert: true and vlp_act rejects acting on them unless force:true is passed. A dialog without modal (e.g. a non-blocking popover) leaves the background fully actionable. Popup options (role menu/listbox/tree/grid or [popover]) opened from the active dialog are not inert. An input or button whose own aria-expanded is absent, but that sits inside an ancestor carrying aria-expanded, carries expands: true|false instead, taken from the nearest such ancestor; expands:false is emitted on purpose, not omitted — it is informative, meaning there is something to open, not that nothing is going on. expanded and expands never coexist on the same element and mean the same thing (this control opens something): expanded when the element declares it itself, expands when its wrapper does. Do not type into a field carrying either key: a single vlp_act click on it, with frame, folds the read into the same call and returns the map with the dropdown already open, its options surfaced as role:\"menuitem\" entries — seeing the options costs exactly one call. An element whose validation state is invalid (aria-invalid other than \"false\", or :user-invalid) carries invalid: true, and the frame carries a top-level invalidCount: N with the total number of invalid elements across all pages and filters (both present only when there is at least one invalid element). This standard path is unaffected by everything below and works the same on any site. Some sites additionally mark invalid fields with their own, non-standard convention instead of (or in addition to) aria-invalid/:user-invalid; Vulpo resolves those conventions through a registry of DOM-detected site profiles — the core serializer contains no site-specific literal, a profile is data matched against the live DOM. When a profile is detected, its findings are folded into the same invalid/invalidCount surface described above, so the caller never has to special-case a site. Beyond invalid/invalidCount, the frame also carries invalidElements: a top-level, present-only array of up to 20 invalid-element summaries, each shaped {ref, name, context?, field?, notInMap?}. invalidElements is computed over ALL candidates and markers, before roles/namedOnly filtering, before pagination, and before the maxPromotedCells/maxPromotedClickables caps — so an invalid element is guaranteed to be reachable through it even when a narrowed/paginated/capped sections array leaves it out entirely; this is what makes it safe to narrow a read and still not lose track of an invalid field. ref uses the same encoding as the rest of the map and is directly actionable — act with action:\"type\" (or \"click\") on it works without hunting for the element elsewhere in sections. name is always present (it can be \"\"), so the array never needs per-entry branching. context, when present, is the same [row, column-header]-shaped context the element carries in sections — typically absent for an <input> portador of an invalid cell in an editable row, since that context lives on the sibling promoted cell instead. field, when present, is the value of the site profile's declared field-name attribute read off the nearest marker that has it (present-only; absent when no profile applies or no marker carries the attribute). notInMap:true marks an entry whose marker contains no element of the map at all (a typical case: an empty required cell outside edit mode) — its ref still resolves and is still clickable, even though nothing else about that marker appears in sections. invalidElements is capped at 20 entries as a payload bound; invalidCount itself is NEVER capped, so invalidCount greater than the number of invalidElements entries tells you there is more than what you see. When at least one invalidElements entry came from a detected site profile (rather than the aria-invalid/:user-invalid path), the frame also carries a top-level invalidProfile: \"<id>\" naming which profile applied; it is absent when every invalid element came from the standard path, or when no profile matched at all — so its presence always tells you where the verdict came from. Optional settle:true (fb-018-006) waits for the content to stabilize before serializing and adds invalidation.settled + invalidation.waitedMs to the response. settled is a TEMPORAL verdict, not a semantic one: true affirms that the observable content had zero DOM mutations for a full quietMs window, that the map was serialized with zero concurrent mutations, and that no standard loading indicator ([aria-busy=\"true\"], role=progressbar, or a <progress> element) was present when quiet was declared; it does NOT affirm that your action took effect. Decision table (settled x changedSinceLast): true+true → new stable content, plan on it; true+false → no observable effect yet (the action may have failed or not landed), re-query after a wait or conclude; false → still changing, the frame is provisional, re-query; settled:true with 0 elements and an empty read list → genuinely empty page or a silent network interlude (ambiguous by design). waitMs (default 5000) caps the wait; on deadline the verdict is settled:false and the FULL frame still comes back (the map is never omitted). While a full-page navigation is in flight (fb-018-006 amendment), the response also carries invalidation.navigating: true (present-only, never false) and the map may be the previous document's; with settle:true the wait is delayed until the navigation commits — waitMs also caps that first wait, and if it expires the verdict is forced to settled:false with the frame still attached. Caveat: the call blocks until quiet or deadline — if waitMs exceeds your MCP client timeout the client may abort before the answer arrives; keep waitMs within your client timeout budget. With a pending native dialog (a confirm/alert/prompt opened during a vlp_act click and still waiting for a human), the response also includes a top-level nativeDialog:{type, message, pending:true} field; with settle:true the call does not wait for quiet in this case and the verdict is forced to settled:false.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tabId":              map[string]any{"type": "number", "description": "ID of the tab"},
				"page":               map[string]any{"type": "number", "description": "Page of elements to fetch (optional)"},
				"maxElementsPerPage": map[string]any{"type": "number", "description": "Elements per page (optional)"},
				"include":            map[string]any{"type": "string", "enum": []any{"sections", "both"}, "description": "\"sections\" (default) omits the redundant do[] list; \"both\" restores it (optional)"},
				"roles":              map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Keep only elements whose accessible role is in this list (optional, never applied by default)"},
				"namedOnly":          map[string]any{"type": "boolean", "description": "Keep only elements with a non-empty accessible name (optional, never applied by default)"},
				"settle":             map[string]any{"type": "boolean", "description": "Wait for the frame to stabilize (quiet window without DOM mutations, then serialize without concurrent mutations) and report the verdict as invalidation.settled/waitedMs (optional, never applied by default)"},
				"waitMs":             map[string]any{"type": "number", "description": "Max wait deadline in ms when settle is requested (optional; default 5000, enforced by the extension, not by this server)"},
				"quietMs":            map[string]any{"type": "number", "description": "Quiet window in ms with zero DOM mutations required to declare settled (optional; default 300, enforced by the extension, not by this server)"},
			},
			"required": []any{"tabId"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			t := tabID(params)
			if t == "" {
				return nil, fmt.Errorf("getFrame requires tabId")
			}
			// fb-018-001 §2.5 — forward verbatim. Los opcionales nuevos se
			// insertan SOLO si el request los trae: una clave presente en nil
			// haría que la extensión no pueda distinguir "no pedido" de
			// "pedido vacío".
			frameParams := map[string]any{"tabId": t, "page": params["page"], "maxElementsPerPage": params["maxElementsPerPage"]}
			for _, name := range []string{"include", "roles", "namedOnly"} {
				if v, ok := params[name]; ok {
					frameParams[name] = v
				}
			}
			// fb-018-006 §2.5 — settle/waitMs/quietMs: mismo patrón "solo si el
			// request los trae" (P16 dirección 2: ausentes ⇒ ausencia total en
			// Params, ni nil). `settle` se type-assertea a boolean (precedente
			// force P20b): un valor no booleano degrada a CLAVE AUSENTE — nunca
			// se relaya crudo (en JS `!!"false" === true` activaría la espera).
			// waitMs/quietMs se relayán verbatim sin type-assert: sus defaults
			// y su validación (no-número o ≤0 ⇒ default) viven en settle.js
			// (§2.1), no en este handler.
			for _, name := range []string{"waitMs", "quietMs"} {
				if v, ok := params[name]; ok {
					frameParams[name] = v
				}
			}
			if v, ok := params["settle"]; ok {
				if b, isBool := v.(bool); isBool {
					frameParams["settle"] = b
				}
			}
			return hub.Command(token, Command{Command: "getFrame", Params: frameParams, TabID: t})
		},
	})

	actProperties := map[string]any{
		"tabId":   map[string]any{"type": "number", "description": "ID of the tab"},
		"ref":     map[string]any{"type": "string", "description": "Ref of the element to act on"},
		"action":  map[string]any{"type": "string", "description": "Action to perform (click/type/focus/select)"},
		"value":   map[string]any{"type": "string", "description": "Text to write for type / option for select (required string for type/select; \"\" clears the field)"},
		"force":   map[string]any{"type": "boolean", "description": "Bypass the inert guard and act even on an element covered by an open modal dialog (optional, default false)"},
		"waitMs":  map[string]any{"type": "number", "description": "For action:\"type\" with ok:true, max wait deadline in ms while observing the written field settle (optional; default 5000, enforced by the extension, not by this server)"},
		"quietMs": map[string]any{"type": "number", "description": "For action:\"type\" with ok:true, quiet window in ms with zero DOM mutations and zero change to the written field's value required to declare settled (optional; default 300, enforced by the extension, not by this server)"},
		"frame":   map[string]any{"type": "object", "description": "Optional object to fold the map read (getFrame) into the response; present keys are relayed verbatim to the extension (optional, default absent)"},
	}
	s.RegisterTool(Tool{
		Name: "vlp_act", Description: "Execute an action (click/type/focus/select) on an element resolved by ref in a browser tab. For type and select the text parameter is value (a string, required; value:\"\" clears the field); unknown arguments (not declared in the input schema) (e.g. text instead of value) are rejected with a tool error naming them and nothing is dispatched. Returns {ok} plus, for action:\"type\" with ok:true, an observation of the written field: after a successful dispatch it waits for the field to settle (waitMs default 5000, quietMs default 300) and adds value (the field's text when resolved), settled (a TEMPORAL verdict — it does NOT affirm the site finished processing, and it covers only the field written, never derived values or the form's overall state), and waitedMs; if the element left the document during the wait, it returns detached:true with settled:false, without value. Before writing a number, determine the site's own numeric formatting convention (with the site's dedicated tool if one exists, or from the numbers the page already shows) and write the text in that convention; compare the number in value against the target value under that same convention. click/focus/select and every ok:false case (including type) are unaffected and, apart from the nativeDialog responses described below, return exactly {ok} or {ok:false, stale|error}, or, if the element is covered by an open modal dialog, {ok:false, inert:true, error}, or, if the target control is disabled (HTML :disabled, including inside <fieldset disabled>, nothing dispatched), {ok:false, disabled:true, error} — enable the control before retrying. force:true bypasses only the inert check, never disabled; forcing an action behind a real modal dialog can leave the app in an inconsistent state (use it only for dialogs misclassified as modal). While a full-page navigation is in flight (fb-018-006 amendment) the response also carries invalidation.navigating: true (present-only) and the action may land in the previous document. Caveat: with action:\"type\" the call may block until settled or waitMs elapses — keep waitMs within your MCP client timeout budget, as with getFrame's settle. nativeDialog:{type, message, pending:true} reports a native confirm/alert/prompt dialog opened by the page and waiting for a human. If a click opens one, the call returns early with ok:true and nativeDialog. If a native dialog is already pending in the tab, every action returns ok:false with nativeDialog and does not dispatch anything; force does not skip this check. Vulpo does not answer the dialog itself — tell the human, quoting message, and re-read with getFrame afterward. Only click detects a dialog: type, focus, and select whose own dispatch opens one may block the call instead. A dialog opened after the call has already returned is not detected. navigate and closeTab on that tab close a pending native dialog without a human answer (the page receives false/null); do not use them to get out of the question unless the human agrees. Optional frame (object, default absent): folds a vlp_getFrame read of the resulting map into this same call, so a caller who needs to see the screen after acting does not need a second MCP round trip. Presence is the opt-in switch — frame:{} requests the fold with defaults, there is no separate boolean. Accepted keys, same vocabulary and semantics as vlp_getFrame — page (default 1), maxElementsPerPage (default 200), include (\"sections\"/\"both\", default \"sections\"), roles, namedOnly, settle, waitMs (default 5000), quietMs (default 300); an unknown key inside frame is rejected with a tool error naming it, and nothing is dispatched. Unlike getFrame, settle defaults to true inside the fold — a folded map with no wait for quiescence would arrive mid-update and you would have to re-read anyway, defeating the point; pass frame:{settle:false} for an immediate, cheap read instead. roles/namedOnly are not a convenience trim: on a real form they are what makes page 1 of the folded map sufficient — without narrowing, you re-read regardless and the fold saves nothing. The fold only runs when the action itself succeeded (ok:true); with ok:false (stale/inert/disabled/a pending nativeDialog) the response is byte-identical to the unfolded one, with neither frame nor frameError, because nothing happened to read. On success the response gains exactly one of frame (the same payload vlp_getFrame would have returned for those parameters on that same DOM state) or frameError:{error} (the action completed but the map could not be read — re-read with getFrame, do not retry the action). That folded frame carries invalidElements/invalidCount/invalidProfile exactly as vlp_getFrame documents them: when action:\"click\" on a submit-like control returns ok:true and the site marks fields invalid as a consequence of the attempt, the invalid fields arrive already identified in this single response — no follow-up read is needed to locate them. If the control was disabled instead (ok:false, disabled:true), nothing was dispatched and there is no frame to fold: a separate vlp_getFrame call is still needed to read invalidElements in that case. With action:\"type\" and a fold, two independent settled verdicts coexist in the same response: the top-level settled still covers only the written field; frame.invalidation.settled is the document-wide temporal verdict — they can disagree (field settled, document still changing, or vice versa). Caveat: with frame the call also blocks while the map is read — worst case the action's own wait plus twice frame.waitMs (the second wait caps a navigation commit); for action:\"type\" that is act.waitMs + 2·frame.waitMs (defaults: 5000 + 10000 = 15 s), for click/focus/select it is 2·frame.waitMs (10 s default). Keep that total within your MCP client timeout budget.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": actProperties,
			"required":   []any{"tabId", "ref", "action"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			if err := rejectUnknownArgs("act", params, actProperties); err != nil {
				return nil, err
			}
			ref := strArg(params, "ref")
			if ref == "" {
				return nil, fmt.Errorf("act requires ref")
			}
			action := strArg(params, "action")
			if action == "" {
				return nil, fmt.Errorf("act requires action")
			}
			if _, isString := params["value"].(string); (action == "type" || action == "select") && !isString {
				return nil, fmt.Errorf("act %s requires value as a string (use value:\"\" to clear the field)", action)
			}
			t := tabID(params)
			if t == "" {
				return nil, fmt.Errorf("act requires tabId")
			}
			// §2.5 (enmienda post-review, P20b): `force` se type-assertea, no se
			// relaya crudo. callTool no valida params contra el InputSchema, y
			// background.js hace `!!force` (en JS `!!"false" === true`): un
			// "force":"false" relayado tal cual desactivaría el guard que existe
			// para evitar la pérdida de datos de §1. Un tipo incorrecto degrada al
			// default seguro `false`, nunca al valor crudo.
			force, _ := params["force"].(bool)
			// Relay directo del ActResponse: el resultado del hub (ok/stale/error)
			// se transmite tal cual al content JSON del result (PC4).
			actParams := map[string]any{"tabId": t, "ref": ref, "action": action, "value": params["value"], "force": force}
			// fb-020-002 §2.5/P18 — waitMs/quietMs: mismo patrón "solo si el
			// request los trae" que vlp_getFrame (~l.398-402); sin
			// type-assert, sus defaults y validación viven en la extensión.
			for _, name := range []string{"waitMs", "quietMs"} {
				if v, ok := params[name]; ok {
					actParams[name] = v
				}
			}
			// fb-020-008 §2.1.3 — frame: validar claves interiores y relayar
			// verbatim. Type-assert a objeto; si no es objeto, degrada a ausencia.
			if frameValue, ok := params["frame"]; ok {
				if err := validateFrameKeys(frameValue); err != nil {
					return nil, err
				}
				// Solo relayar si es objeto válido.
				if frameObj, isObject := frameValue.(map[string]any); isObject {
					actParams["frame"] = frameObj
				}
			}
			return hub.Command(token, Command{Command: "act", Params: actParams, TabID: t})
		},
	})

	// vlp_help: server-only — no toca el hub. Usa el contenido de
	// help.txt (go:embed default; VLP_HELP_FILE override) y resuelve
	// {{TOOLS}} de ListTools() en runtime (nunca hardcodeado — I3).
	// Fix D1/D2: sin helpFile ni VLP_HELP_FILE → default embed, no falla.
	s.RegisterTool(Tool{
		Name: "vlp_help", Description: "Guide to all available vulpo tools.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Handler: func(_ map[string]any, _ string) (any, error) {
			path := helpFile
			if path == "" {
				path = os.Getenv("VLP_HELP_FILE")
			}
			text := helpEmbed
			if path != "" {
				data, err := os.ReadFile(path)
				if err != nil {
					return nil, fmt.Errorf("no se pudo leer help file %s: %v", path, err)
				}
				text = string(data)
			}
			var names []string
			for _, tl := range s.ListTools() {
				names = append(names, tl.Name)
			}
			text = strings.ReplaceAll(text, "{{TOOLS}}", strings.Join(names, "\n"))
			return map[string]any{"help": text}, nil
		},
	})

	// ---- odoo_* (fb-013-003, renombrada por fb-019-002 — paridad de
	// superficie con mcp.odoo, drop del prefijo fb_ / hard cutover D-7): 12
	// tools que consumen el registry odooregistry y rutean a los commands
	// odoo* de la extensión. Contrato: spec §2.1 (tool-por-tool), §2.2
	// (envelope), §2.3 (formats), §2.4 (transforms), §2.5 (write-path).
	if odoo != nil {
		registerOdooTools(s, hub, odoo)
	}
}

// Sufijos de plataforma de las Descriptions — pineados (§2.0.2, verificados
// por P2). El texto funcional espeja el de mcp.odoo (snapshot congelado); las
// diferencias de plataforma viajan SOLO por estos sufijos, nunca como params.
const (
	odooDescBase = " Runs on the user's browser: Vulpo resolves the Odoo tab automatically for the requesting token (no profile parameter) and authenticates with the browser session."
	odooDescGate = " Respects the plan/build write gate."
	// odooDescTab (fb-020-006 §2.1–§2.3): selección de pestaña, reporte
	// odoo_tab y códigos de error — solo en las 11 tools ORM.
	odooDescTab = " Tab selection: pass tabId to use a specific Odoo tab. Without tabId, if all detected tabs share the same instance (origin and db) the lowest tabId is used; if they differ the call is ambiguous and fails with odoo_ambiguous_tab listing each candidate, so retry with tabId. On success a second content item reports the tab used as {\"odoo_tab\":{tabId, origin, db}}. Errors start with a stable code: odoo_no_tab, odoo_detection_failed, odoo_ambiguous_tab, odoo_tab_unreachable, odoo_command_failed, odoo_command_timeout."
)

// registerOdooTools: registra las 12 tools odoo (fb-019-002 — paridad
// mcp.odoo): 6 read/metadata + 5 write + 1 exec. Sin `profile` en ningún
// schema (§2.0.1 — la resolución del tab es por token); `format` enum SOLO en
// las 4 tools de lectura (D-5); defaults explícitos en los descriptions (§2.1).
func registerOdooTools(s *Server, hub Hub, odoo *odooregistry.Registry) {
	adapter := odooHubAdapter{h: hub}

	// tabs: resolución de la pestaña Odoo de las 11 tools ORM (fb-020-006 §2.1,
	// odoo_tab_select.go): `tabId` explícito (o el alias no documentado
	// `profile`), detección bajo demanda y agrupación por (origin, db). Solo
	// mira candidatos del token del request (aislamiento TokenTenant, I-2): un
	// tabId de otro token es indistinguible de uno inexistente (odoo_no_tab).
	tabs := newOdooTabResolver(odoo, hub)

	// odooTabIDProperty: selector opcional de pestaña de las 11 tools ORM.
	odooTabIDProperty := map[string]any{
		"type":        "integer",
		"description": "Browser tabId of the Odoo tab to use (a numeric string is also accepted; optional — see the tab selection rule in the description)",
	}

	// odooFormatEnum: enum compartido del parámetro format (§2.0.4 — solo en
	// las 4 tools de lectura, D-5).
	odooFormatEnum := map[string]any{
		"type":        "string",
		"enum":        []any{"json", "compact", "table", "html", "csv"},
		"description": "Response format (default json)",
	}

	// 1. search_read (§2.1 fila 1) — D-2: total REAL vía odooSearchCount (el
	// mismo model+domain) + odooSearchRead; envelope §2.2 compuesto server-side.
	s.RegisterTool(Tool{
		Name:        "search_read",
		Description: "Search and read records from an Odoo model." + odooDescBase + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"domain": map[string]any{"type": "string", "description": "Search domain as a Python-literal string (e.g. \"[('name','ilike','John')]\"); an array is also accepted (default \"[]\")"},
				"fields": map[string]any{"type": "string", "description": "Fields to return, comma-separated (e.g. \"id,name\"); an array is also accepted"},
				"limit":  map[string]any{"type": "number", "description": "Max records (default 100)"},
				"offset": map[string]any{"type": "number", "description": "Offset (default 0)"},
				"order":  map[string]any{"type": "string", "description": "Sort order (e.g. \"name asc, id desc\")"},
				"format": odooFormatEnum,
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("search_read requires model")
			}
			domain, err := parseOdooDomain(params["domain"])
			if err != nil {
				return nil, err
			}
			fields, _, err := strListArg(params, "fields")
			if err != nil {
				return nil, err
			}
			limit, err := numArg(params, "limit", 100)
			if err != nil {
				return nil, err
			}
			offset, err := numArg(params, "offset", 0)
			if err != nil {
				return nil, err
			}
			format, err := formatArg(params)
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			countRes, err := target.command(Command{
				Command: "odooSearchCount",
				Params:  map[string]any{"tabId": tab, "model": model, "domain": domain},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			readParams := map[string]any{"tabId": tab, "model": model, "domain": domain, "limit": limit, "offset": offset}
			if fields != nil {
				readParams["fields"] = fields
			}
			if order := strArg(params, "order"); order != "" {
				readParams["order"] = order
			}
			readRes, err := target.command(Command{Command: "odooSearchRead", Params: readParams, TabID: tab})
			if err != nil {
				return nil, err
			}
			records, err := unwrapOdooRecords(readRes)
			if err != nil {
				return nil, err
			}
			return target.withTab(odooPagedResponse(format, records, fields, odooCountTotal(countRes), limit, offset))
		},
	})

	// 2. search_count (§2.1 fila 2) — extra vulpo, fuera de la paridad:
	// número crudo sin envelope (relay del ORM).
	s.RegisterTool(Tool{
		Name: "search_count",
		Description: "Count records matching a domain in an Odoo model." + odooDescBase +
			" Vulpo extension: not part of mcp.odoo." + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"domain": map[string]any{"type": "string", "description": "Search domain as a Python-literal string; an array is also accepted (default \"[]\")"},
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("search_count requires model")
			}
			domain, err := parseOdooDomain(params["domain"])
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			return target.withTab(target.command(Command{
				Command: "odooSearchCount",
				Params:  map[string]any{"tabId": tab, "model": model, "domain": domain},
				TabID:   tab,
			}))
		},
	})

	// 3. write (§2.1 fila 3) — ids array o comma-separated (P5); wrapper
	// {success:true} mínimo observable (C-2/P14).
	s.RegisterTool(Tool{
		Name:        "write",
		Description: "Update records in an Odoo model." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"ids":    map[string]any{"type": "string", "description": "Record IDs to update, comma-separated (e.g. \"1,2,3\") or as a JSON array"},
				"values": map[string]any{"type": "object", "description": "Field values to set"},
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model", "ids", "values"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("write requires model")
			}
			if params["ids"] == nil {
				return nil, fmt.Errorf("write requires ids")
			}
			if params["values"] == nil {
				return nil, fmt.Errorf("write requires values")
			}
			ids, err := idsArg(params)
			if err != nil {
				return nil, err
			}
			values, ok := params["values"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("values must be an object")
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			res, err := target.command(Command{
				Command: "odooWrite",
				Params:  map[string]any{"tabId": tab, "model": model, "ids": ids, "values": values},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			return target.withTab(wrapSuccess(res), nil)
		},
	})

	// 4. unlink (§2.1 fila 4) — ídem write; mcp.odoo documenta deleted_ids
	// (VERIFICAR vivo, C-2).
	s.RegisterTool(Tool{
		Name:        "unlink",
		Description: "Delete records from an Odoo model." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model": map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"ids":   map[string]any{"type": "string", "description": "Record IDs to delete, comma-separated (e.g. \"1,2,3\") or as a JSON array"},
				"tabId": odooTabIDProperty,
			},
			"required": []any{"model", "ids"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("unlink requires model")
			}
			if params["ids"] == nil {
				return nil, fmt.Errorf("unlink requires ids")
			}
			ids, err := idsArg(params)
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			res, err := target.command(Command{
				Command: "odooUnlink",
				Params:  map[string]any{"tabId": tab, "model": model, "ids": ids},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			return target.withTab(wrapSuccess(res), nil)
		},
	})

	// 5. create (§2.1 fila 5) — respuesta: el id del registro creado (C-2:
	// wrapper exacto VERIFICAR vivo).
	s.RegisterTool(Tool{
		Name:        "create",
		Description: "Create a new record in an Odoo model." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"values": map[string]any{"type": "object", "description": "Field values for the new record"},
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model", "values"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("create requires model")
			}
			if params["values"] == nil {
				return nil, fmt.Errorf("create requires values")
			}
			values, ok := params["values"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("values must be an object")
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			res, err := target.command(Command{
				Command: "odooCreate",
				Params:  map[string]any{"tabId": tab, "model": model, "values": values},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			return target.withTab(odooCreateResult(res), nil)
		},
	})

	// 6. export_records (§2.1 fila 6) — D-6: domain-based (ids GONE); el
	// server compone 3 commands (count + read-ids + export_data nativo) y
	// entrega el envelope §2.2 con los records del export en passthrough (el
	// `id` External ID no se transforma). ⚠️ Gated write en vulpo.
	s.RegisterTool(Tool{
		Name:        "export_records",
		Description: "Export records from an Odoo model using native export_data." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"domain": map[string]any{"type": "string", "description": "Search domain as a Python-literal string; an array is also accepted (default \"[]\")"},
				"fields": map[string]any{"type": "string", "description": "Fields to export, comma-separated (e.g. \"id,name\"); an array is also accepted (default \"id,name\")"},
				"limit":  map[string]any{"type": "number", "description": "Max records (default 500)"},
				"offset": map[string]any{"type": "number", "description": "Offset (default 0)"},
				"format": odooFormatEnum,
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("export_records requires model")
			}
			domain, err := parseOdooDomain(params["domain"])
			if err != nil {
				return nil, err
			}
			fields, fieldsGiven, err := strListArg(params, "fields")
			if err != nil {
				return nil, err
			}
			if !fieldsGiven {
				fields = []any{"id", "name"} // default §2.1 fila 6
			}
			limit, err := numArg(params, "limit", 500)
			if err != nil {
				return nil, err
			}
			offset, err := numArg(params, "offset", 0)
			if err != nil {
				return nil, err
			}
			format, err := formatArg(params)
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			countRes, err := target.command(Command{
				Command: "odooSearchCount",
				Params:  map[string]any{"tabId": tab, "model": model, "domain": domain},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			// El read-ids lleva fields ["id"] cuando el caller pidió fields; si
			// no pidió, viaja con el default resuelto (P6 — defaults explícitos).
			readFields := []any{"id"}
			if !fieldsGiven {
				readFields = []any{"id", "name"}
			}
			readRes, err := target.command(Command{
				Command: "odooSearchRead",
				Params:  map[string]any{"tabId": tab, "model": model, "domain": domain, "fields": readFields, "limit": limit, "offset": offset},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			records, err := unwrapOdooRecords(readRes)
			if err != nil {
				return nil, err
			}
			ids := make([]any, 0, len(records))
			for _, r := range records {
				m, ok := r.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("export_records: unexpected extension response: record is %T, want object", r)
				}
				id, ok := m["id"]
				if !ok {
					return nil, fmt.Errorf("export_records: read-ids record without id (fields [\"id\"] not honored)")
				}
				ids = append(ids, id)
			}
			fieldList := make([]any, len(fields))
			for i, f := range fields {
				fieldList[i] = f
			}
			exportRes, err := target.command(Command{
				Command: "odooExportRecords",
				Params:  map[string]any{"tabId": tab, "model": model, "ids": ids, "fields": fieldList},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			exported, ok := exportRes.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("export_records: unexpected extension response: want object with datas, got %T", exportRes)
			}
			// El export_data nativo devuelve una MATRIZ {datas: [[v1,v2],…]}
			// (fb-019-002 field verification) — el server la zip-ea con los
			// fields exportados para entregar la lista de dicts del contrato.
			datas, ok := exported["datas"].([]any)
			if !ok {
				return nil, fmt.Errorf("export_records: unexpected extension response: missing datas matrix")
			}
			exportedRecords, err := odooDatasToRecords(datas, fields)
			if err != nil {
				return nil, err
			}
			return target.withTab(odooPagedResponse(format, exportedRecords, fields, odooCountTotal(countRes), limit, offset))
		},
	})

	// 7. import_records (§2.1 fila 7) — `rows` (JSON array de dicts) + fields
	// string comma-separated → wire `records`/fields array; respuesta
	// {success, created, updated} (P13/C-2). El alias viejo `records` NO
	// existe (D-4: alias de NOMBRE ≠ tolerancia de TIPO).
	s.RegisterTool(Tool{
		Name:        "import_records",
		Description: "Import records into an Odoo model using native load." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"fields": map[string]any{"type": "string", "description": "Field names in order, comma-separated (e.g. \"id,name\"); an array is also accepted"},
				"rows":   map[string]any{"type": "array", "description": "Rows to import as a JSON array of objects (a row with an External `id` updates; without it creates)"},
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model", "fields", "rows"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("import_records requires model")
			}
			if params["fields"] == nil {
				return nil, fmt.Errorf("import_records requires fields")
			}
			if params["rows"] == nil {
				return nil, fmt.Errorf("import_records requires rows")
			}
			fields, _, err := strListArg(params, "fields")
			if err != nil {
				return nil, err
			}
			rows, ok := params["rows"].([]any)
			if !ok {
				return nil, fmt.Errorf("rows must be a JSON array of objects")
			}
			// El load nativo NO mapea dicts (fb-019-002 field verification:
			// campos desplazados) — el wire lleva la MATRIZ alineada con fields
			// (load([fields], [[v1,v2],…])). La clasificación created/updated
			// sigue sobre los dicts originales (leen el id del row).
			matrix, err := odooRowsToMatrix(rows, fields)
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			res, err := target.command(Command{
				Command: "odooImportRecords",
				Params:  map[string]any{"tabId": tab, "model": model, "fields": fields, "records": matrix},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			return target.withTab(odooImportResult(rows, res), nil)
		},
	})

	// 8. execute_kw (§2.1 fila 8) — navaja suiza, gated por WRITE_TOOLS en la
	// extensión (plan L152-154). Passthrough crudo del método (igual a
	// mcp.odoo); sin whitelist por decisión de modelo (2026-08-27): token =
	// frontera de confianza. get_financial_report removida (caso de uso
	// específico externo, fuera del alcance de vulpo).
	s.RegisterTool(Tool{
		Name:        "execute_kw",
		Description: "Execute any method on an Odoo model." + odooDescBase + odooDescGate + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":  map[string]any{"type": "string", "description": "Model name (e.g. ir.model)"},
				"method": map[string]any{"type": "string", "description": "Method to call (e.g. search_count)"},
				"args":   map[string]any{"type": "array", "description": "Positional arguments (default [])"},
				"kwargs": map[string]any{"type": "object", "description": "Keyword arguments (default {})"},
				"tabId":  odooTabIDProperty,
			},
			"required": []any{"model", "method"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("execute_kw requires model")
			}
			method := strArg(params, "method")
			if method == "" {
				return nil, fmt.Errorf("execute_kw requires method")
			}
			args := []any{}
			if v, ok := params["args"]; ok && v != nil {
				a, ok := v.([]any)
				if !ok {
					return nil, fmt.Errorf("args must be a JSON array")
				}
				args = a
			}
			kwargs := map[string]any{}
			if v, ok := params["kwargs"]; ok && v != nil {
				k, ok := v.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("kwargs must be an object")
				}
				kwargs = k
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			return target.withTab(target.command(Command{
				Command: "odooExecuteKw",
				Params:  map[string]any{"tabId": tab, "model": model, "method": method, "args": args, "kwargs": kwargs},
				TabID:   tab,
			}))
		},
	})

	// 9. list_models (§2.1 fila 9) — P11: `search` → domain OR sobre
	// ir.model; json {success, models}; model_count en non-json; sin envelope.
	s.RegisterTool(Tool{
		Name:        "list_models",
		Description: "List available models in the Odoo instance." + odooDescBase + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"search": map[string]any{"type": "string", "description": "Filter models by name or model (case-insensitive substring; optional)"},
				"format": odooFormatEnum,
				"tabId":  odooTabIDProperty,
			},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			format, err := formatArg(params)
			if err != nil {
				return nil, err
			}
			domain := []any{}
			if search := strArg(params, "search"); search != "" {
				domain = []any{"|", []any{"name", "ilike", search}, []any{"model", "ilike", search}}
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			res, err := target.command(Command{
				Command: "odooSearchRead",
				Params:  map[string]any{"tabId": tab, "model": "ir.model", "domain": domain, "fields": []any{"id", "name", "model", "info"}},
				TabID:   tab,
			})
			if err != nil {
				return nil, err
			}
			models, err := unwrapOdooRecords(res)
			if err != nil {
				return nil, err
			}
			if format == "json" {
				return target.withTab(map[string]any{"success": true, "models": models}, nil)
			}
			headers, rows, err := odooTabular(models, []any{"id", "name", "model", "info"})
			if err != nil {
				return nil, err
			}
			data, err := odooNonJSON(format, headers, rows)
			if err != nil {
				return nil, err
			}
			data["format"] = format
			data["model_count"] = float64(len(models))
			return target.withTab(data, nil)
		},
	})

	// 10. list_fields (§2.1 fila 10) — P12/D-9: la clave `attributes` viaja en
	// el wire SOLO si el caller la pidió; el default (string/type/required/help)
	// lo agrega la extensión. json {success, fields}; field_count en non-json.
	s.RegisterTool(Tool{
		Name:        "list_fields",
		Description: "List all fields of an Odoo model." + odooDescBase + odooDescTab,
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"model":      map[string]any{"type": "string", "description": "Model name (e.g. res.partner)"},
				"attributes": map[string]any{"type": "string", "description": "Comma-separated attribute names to return (e.g. \"string,type\"); an array is also accepted. Omitted: the tab returns its default set (string/type/required + help when present)"},
				"format":     odooFormatEnum,
				"tabId":      odooTabIDProperty,
			},
			"required": []any{"model"},
		},
		Handler: func(params map[string]any, token string) (any, error) {
			model := strArg(params, "model")
			if model == "" {
				return nil, fmt.Errorf("list_fields requires model")
			}
			attributes, _, err := strListArg(params, "attributes")
			if err != nil {
				return nil, err
			}
			format, err := formatArg(params)
			if err != nil {
				return nil, err
			}
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			wire := map[string]any{"tabId": tab, "model": model}
			if attributes != nil {
				wire["attributes"] = attributes
			}
			res, err := target.command(Command{Command: "odooListFields", Params: wire, TabID: tab})
			if err != nil {
				return nil, err
			}
			fieldsDict, ok := res.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("list_fields: unexpected extension response: want object, got %T", res)
			}
			if format == "json" {
				return target.withTab(map[string]any{"success": true, "fields": fieldsDict}, nil)
			}
			headers, rows := odooFieldsTabular(fieldsDict)
			data, err := odooNonJSON(format, headers, rows)
			if err != nil {
				return nil, err
			}
			data["format"] = format
			data["field_count"] = float64(len(fieldsDict))
			return target.withTab(data, nil)
		},
	})

	// 11. list_available_profiles (§2.1 fila 11) — especial: Detect + List del
	// registry. Shape de 8 campos congelado fb-013; la diferencia con los
	// perfiles de conexión de mcp.odoo viaja en la Description (D-8).
	s.RegisterTool(Tool{
		Name: "list_available_profiles",
		Description: "List Odoo tabs/profiles detected with their session info." + odooDescBase +
			" Platform difference: mcp.odoo returns connection profiles {name, url, database, is_default}; Vulpo returns browser tab profiles {tabId, url, db, version, uid, username, is_superuser, is_active}.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Handler: func(params map[string]any, token string) (any, error) {
			if err := odoo.Detect(token, adapter); err != nil {
				return nil, err
			}
			return odoo.List(token), nil
		},
	})

	// 12. get_version (§2.1 fila 12) — relay puro (P17: guard sin drop de
	// keys); el merge de server_version/server_version_info vive en la
	// extensión (C-1 parity-plus, F-7 ruta a).
	s.RegisterTool(Tool{
		Name: "get_version",
		Description: "Get the Odoo server version information." + odooDescBase +
			" Platform difference: Vulpo returns {version, db, uid, username, is_superuser} plus the mcp.odoo keys server_version/server_version_info when the tab session provides them, plus lang, decimal_point, and thousands_sep when the session and its res.lang record can be read; these three keys are present only when available and are never returned as null." + odooDescTab,
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{"tabId": odooTabIDProperty}},
		Handler: func(params map[string]any, token string) (any, error) {
			target, err := tabs.resolve(params, token)
			if err != nil {
				return nil, err
			}
			tab := target.tab
			return target.withTab(target.command(Command{
				Command: "odooGetVersion",
				Params:  map[string]any{"tabId": tab},
				TabID:   tab,
			}))
		},
	})
}
