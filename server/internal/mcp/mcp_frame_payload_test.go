// Package mcp tests — fb-018-001-frame-payload-efficiency (sub-fase RED).
//
// Deriva de §2.5 del spec: `vlp_getFrame` suma al InputSchema los tres
// parámetros opcionales nuevos (`include`, `roles`, `namedOnly`), el handler
// los reenvía verbatim a hub.Command como ya hace con page/maxElementsPerPage,
// y la Description deja de anunciar `do` como parte del payload por default.
//
// Archivo NUEVO a propósito: mcp_frame_api_test.go queda intacto (las
// ediciones de tests existentes autorizadas por §5.1 son solo las de la suite
// JS). El guardián de conteo de tools (mcp_tools_test.go:123, want 34) NO se
// toca ni se duplica acá: §2.5 dice explícitamente que el conteo no cambia.
package mcp

import (
	"fmt"
	"strings"
	"testing"
)

// getFrameTool devuelve la tool vlp_getFrame registrada.
func getFrameTool(t *testing.T, s *Server) (string, map[string]any) {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == "vlp_getFrame" {
			return tl.Description, tl.InputSchema
		}
	}
	t.Fatal("falta la tool vlp_getFrame")
	return "", nil
}

// schemaProps extrae el mapa de properties del InputSchema.
func schemaProps(t *testing.T, schema map[string]any) map[string]any {
	t.Helper()
	raw, ok := schema["properties"]
	if !ok {
		t.Fatalf("InputSchema de vlp_getFrame sin 'properties': %v", schema)
	}
	props, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("InputSchema.properties no es un objeto: %T", raw)
	}
	return props
}

// §2.5 — el InputSchema expone include / roles / namedOnly.
func TestGetFrame_InputSchemaHasPayloadParams(t *testing.T) {
	s, _ := newTools(t)
	_, schema := getFrameTool(t, s)
	props := schemaProps(t, schema)

	// Guarda de no-vacuidad: si el schema perdiera los params previos, la
	// aserción de abajo no diría nada sobre los nuevos.
	for _, prev := range []string{"tabId", "page", "maxElementsPerPage"} {
		if _, ok := props[prev]; !ok {
			t.Fatalf("precondición: el InputSchema debe seguir declarando %q; properties=%v", prev, props)
		}
	}

	for _, name := range []string{"include", "roles", "namedOnly"} {
		if _, ok := props[name]; !ok {
			t.Fatalf("InputSchema de vlp_getFrame sin el parámetro %q (§2.5); properties=%v", name, props)
		}
	}

	// `required` no debe incorporarlos: los tres son opcionales (§2.5).
	// Se compara sobre la forma stringificada a propósito: un type-assert a
	// []string sería un no-op silencioso si el schema usa []any.
	if rawReq, ok := schema["required"]; ok {
		req := fmt.Sprint(rawReq)
		for _, name := range []string{"include", "roles", "namedOnly"} {
			if strings.Contains(req, name) {
				t.Fatalf("%q es opcional (§2.5), no puede figurar en required: %s", name, req)
			}
		}
	}
}

// §2.5 — el handler reenvía include/roles/namedOnly verbatim al hub. Sin este
// forward los parámetros se pierden antes de llegar a serializeFrame.
func TestGetFrame_ForwardsPayloadParams(t *testing.T) {
	s, hub := newTools(t)
	resp := callTool(s, "vlp_getFrame", map[string]any{
		"tabId":     float64(7),
		"include":   "both",
		"roles":     []any{"button", "link"},
		"namedOnly": true,
	})
	if _, hasErr := resp["error"]; hasErr {
		t.Fatalf("getFrame → error inesperado: %v", resp)
	}
	_, cmd := hub.lastCall()
	if cmd.Command != "getFrame" {
		t.Fatalf("command = %q, want getFrame", cmd.Command)
	}
	for _, name := range []string{"include", "roles", "namedOnly"} {
		if _, ok := cmd.Params[name]; !ok {
			t.Fatalf("Params sin %q — getFrame debe forwardearlo al hub (§2.5); Params=%v", name, cmd.Params)
		}
	}

	// La presencia SOLA no alcanza: el handler actual inserta page/
	// maxElementsPerPage con valor nil aunque el request no los mande
	// (Params=map[maxElementsPerPage:<nil> page:<nil> tabId:7]). Si el
	// implementer replica ese patrón, los tres params quedarían presentes en
	// nil y §2.5 seguiría incumplida con el test en verde. El forward es
	// VERBATIM: se asserta el valor, no la clave.
	if got := fmt.Sprint(cmd.Params["include"]); got != "both" {
		t.Fatalf("Params.include = %q, want \"both\" (forward verbatim)", got)
	}
	if got := fmt.Sprint(cmd.Params["namedOnly"]); got != "true" {
		t.Fatalf("Params.namedOnly = %q, want \"true\" (forward verbatim)", got)
	}
	roles := fmt.Sprint(cmd.Params["roles"])
	for _, want := range []string{"button", "link"} {
		if !strings.Contains(roles, want) {
			t.Fatalf("Params.roles = %q, debe contener %q (forward verbatim)", roles, want)
		}
	}
}

// §2.5 — la Description ya no anuncia `do` como parte del payload por default.
// Se asserta solo la AUSENCIA del literal actual: la redacción nueva es del
// implementer, el test no se la dicta.
func TestGetFrame_DescriptionNoLongerAdvertisesDoByDefault(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_getFrame debe tener Description")
	}
	if strings.Contains(desc, "sections/read/do") {
		t.Fatalf("la Description sigue anunciando \"sections/read/do\"; `do` ya no viene por default (§2.5): %q", desc)
	}
}
