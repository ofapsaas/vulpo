// Package mcp tests — fb-017-002 frame-map-api (sub-fase RED).
// Verifica PC1–PC4: registro + wire de vlp_getFrame (getFrame) y
// vlp_act (act) sobre el contrato de driver del epic fb-017.
// No dependen de la implementación: solo del contrato observable (tools
// registradas, Command ruteado al hub, relay del ActResponse).
package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func callTool(s *Server, name string, args map[string]any) map[string]any {
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	}, "tok1")
	return resp.(map[string]any)
}

// PC1 — vlp_getFrame y vlp_act registradas con description e
// inputSchema no vacíos. El conteo total 34 se verifica en
// TestAllTools_Registered (mcp_tools_test.go), actualizado en esta feature.
func TestFrameAct_ToolsRegistered(t *testing.T) {
	s, _ := newTools(t)
	found := map[string]struct{}{}
	for _, tl := range s.ListTools() {
		if tl.Name == "vlp_getFrame" || tl.Name == "vlp_act" {
			if tl.Description == "" {
				t.Fatalf("tool %s sin description", tl.Name)
			}
			if tl.InputSchema == nil || len(tl.InputSchema) == 0 {
				t.Fatalf("tool %s sin inputSchema", tl.Name)
			}
			found[tl.Name] = struct{}{}
		}
	}
	for _, name := range []string{"vlp_getFrame", "vlp_act"} {
		if _, ok := found[name]; !ok {
			t.Fatalf("falta la tool %s", name)
		}
	}
}

// PC2 — wire de getFrame: Command{getFrame, Params{tabId, page,
// maxElementsPerPage}, TabID:"7"} con el token del request.
func TestGetFrame_Wire(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_getFrame", map[string]any{
		"tabId": float64(7), "page": float64(1), "maxElementsPerPage": float64(200),
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("getFrame → error inesperado: %v", resp)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "tok1" {
		t.Fatalf("profileID = %s, want tok1", profileID)
	}
	if cmd.Command != "getFrame" {
		t.Fatalf("command = %q, want getFrame", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["tabId"] != "7" {
		t.Fatalf("Params.tabId = %v, want 7", cmd.Params["tabId"])
	}
	if _, ok := cmd.Params["page"]; !ok {
		t.Fatal("Params sin page (getFrame debe forwardear page)")
	}
	if _, ok := cmd.Params["maxElementsPerPage"]; !ok {
		t.Fatal("Params sin maxElementsPerPage")
	}
}

// PC2 — sin tabId → error -32000 "getFrame requires tabId".
func TestGetFrame_RequiresTabId(t *testing.T) {
	s, _ := newTools(t)
	resp := callTool(s, "vlp_getFrame", map[string]any{})
	err, hasErr := resp["error"].(map[string]any)
	if !hasErr {
		t.Fatalf("getFrame sin tabId NO falló: %v", resp)
	}
	if codeOf(err) != -32000 || err["message"] != "getFrame requires tabId" {
		t.Fatalf("getFrame sin tabId error = %v, want -32000 'getFrame requires tabId'", err)
	}
}

// PC3 — wire de act: Command{act, Params{tabId, ref, action, value}, TabID:"7"}.
// value es opcional.
func TestAct_Wire(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>button", "action": "click", "value": "",
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("act → error inesperado: %v", resp)
	}
	profileID, cmd := hub.lastCall()
	if profileID != "tok1" {
		t.Fatalf("profileID = %s, want tok1", profileID)
	}
	if cmd.Command != "act" {
		t.Fatalf("command = %q, want act", cmd.Command)
	}
	if cmd.TabID != "7" {
		t.Fatalf("TabID = %q, want 7", cmd.TabID)
	}
	if cmd.Params["ref"] != "main>button" {
		t.Fatalf("Params.ref = %v, want main>button", cmd.Params["ref"])
	}
	if cmd.Params["action"] != "click" {
		t.Fatalf("Params.action = %v, want click", cmd.Params["action"])
	}
	if _, ok := cmd.Params["value"]; !ok {
		t.Fatal("Params sin value (act debe forwardear value, aun vacío)")
	}
}

// PC3 — sin ref → -32000 "act requires ref"; sin action → -32000
// "act requires action"; con ref+action y sin value (opcional) NO falla.
func TestAct_RequiresRefOrAction(t *testing.T) {
	s, _ := newTools(t)

	noRef := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(1), "action": "click",
	})
	err, hasErr := noRef["error"].(map[string]any)
	if !hasErr {
		t.Fatalf("act sin ref NO falló: %v", noRef)
	}
	if codeOf(err) != -32000 || err["message"] != "act requires ref" {
		t.Fatalf("act sin ref error = %v, want -32000 'act requires ref'", err)
	}

	noAction := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(1), "ref": "main>button",
	})
	err, hasErr = noAction["error"].(map[string]any)
	if !hasErr {
		t.Fatalf("act sin action NO falló: %v", noAction)
	}
	if codeOf(err) != -32000 || err["message"] != "act requires action" {
		t.Fatalf("act sin action error = %v, want -32000 'act requires action'", err)
	}

	// value opcional: ref+action sin value no es error.
	noValue := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(1), "ref": "main>button", "action": "click",
	})
	if _, hasErr := noValue["error"]; hasErr {
		t.Fatalf("act sin value (opcional) debió pasar: %v", noValue)
	}
}

// PC4 — relay del ActResponse: el resultado del hub se transmite tal cual en
// el content JSON del result ({ok:false, stale:true} → "ok":false y "stale":true).
func TestAct_RelaysActResponse(t *testing.T) {
	s, hub := newTools(t)
	hub.result = map[string]any{"ok": false, "stale": true}
	resp := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>button", "action": "click",
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("act → error inesperado: %v", resp)
	}
	res := resp["result"].(map[string]any)
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	var inner map[string]any
	if err := json.Unmarshal([]byte(text), &inner); err != nil {
		t.Fatalf("content no es JSON: %v — %q", err, text)
	}
	if inner["ok"] != false {
		t.Fatalf("relayed ok = %v, want false", inner["ok"])
	}
	if inner["stale"] != true {
		t.Fatalf("relayed stale = %v, want true", inner["stale"])
	}
	if strings.Contains(text, "error") && inner["error"] != nil {
		t.Fatalf("relay NO debe inventar campo error (stale ya presente): %q", text)
	}
}

// P18 — vlp_act con waitMs/quietMs en la llamada los relaya en Params
// con el valor recibido, sin type-assert (spec §2.1, §3.4). Sin ellos, las
// claves no aparecen en Params.
func TestAct_RelaysWaitQuietMs_P18(t *testing.T) {
	s, hub := newTools(t)

	// Con waitMs/quietMs de tipos distintos (número y string): deben relayarse
	// tal cual, sin validar ni type-assert.
	resp := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>button", "action": "click",
		"waitMs": float64(1234), "quietMs": "x",
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("act con waitMs/quietMs → error inesperado: %v", resp)
	}
	_, cmd := hub.lastCall()
	if cmd.Params["waitMs"] != float64(1234) {
		t.Fatalf("P18: Params.waitMs = %v (%T), want 1234 (float64) — vlp_act debe relayar waitMs sin type-assert", cmd.Params["waitMs"], cmd.Params["waitMs"])
	}
	if cmd.Params["quietMs"] != "x" {
		t.Fatalf("P18: Params.quietMs = %v (%T), want \"x\" — vlp_act debe relayar quietMs sin type-assert", cmd.Params["quietMs"], cmd.Params["quietMs"])
	}

	// Sin waitMs/quietMs: las claves no deben aparecer en Params.
	respSin := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>button", "action": "click",
	})
	if _, hasErr := respSin["error"]; hasErr {
		t.Fatalf("act sin waitMs/quietMs → error inesperado: %v", respSin)
	}
	_, cmdSin := hub.lastCall()
	if _, ok := cmdSin.Params["waitMs"]; ok {
		t.Fatalf("P18: Params trae waitMs=%v sin haberlo enviado; la clave no debe aparecer si no viene en la llamada", cmdSin.Params["waitMs"])
	}
	if _, ok := cmdSin.Params["quietMs"]; ok {
		t.Fatalf("P18: Params trae quietMs=%v sin haberlo enviado; la clave no debe aparecer si no viene en la llamada", cmdSin.Params["quietMs"])
	}
}
