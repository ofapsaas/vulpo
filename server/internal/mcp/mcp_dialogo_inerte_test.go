// Package mcp tests — fb-018-004-dialogo-y-fondo-inerte (sub-fase RED). P20.
//
// Deriva de §2.7 y §3/P20 del spec: `vlp_act` suma al InputSchema la
// propiedad opcional `force` (boolean), y el conteo total de tools sigue en 34
// (no se agrega ninguna tool).
//
// Archivo NUEVO a propósito: mcp_tools_test.go y mcp_frame_api_test.go quedan
// intactos — §6.1 del spec NO autoriza editar ningún test existente. El
// guardián de conteo (mcp_tools_test.go, want 34) no se toca; acá se re-afirma
// como precondición local para que el implementer no pueda satisfacer P20
// registrando una tool nueva.
package mcp

import (
	"fmt"
	"strings"
	"testing"
)

// actTool devuelve la Description y el InputSchema de vlp_act.
func actTool(t *testing.T, s *Server) (string, map[string]any) {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == "vlp_act" {
			return tl.Description, tl.InputSchema
		}
	}
	t.Fatal("falta la tool vlp_act")
	return "", nil
}

// P20 (§2.7): `vlp_act` declara `force` (boolean, no requerido) y el
// conteo de tools sigue siendo 34.
func TestAct_InputSchemaHasForce(t *testing.T) {
	s, _ := newTools(t)

	// Parte 2 de P20: el conteo no cambia. Se verifica ANTES para que un
	// fallo de schema no oculte una tool agregada de más.
	names := map[string]bool{}
	for _, tl := range s.ListTools() {
		names[tl.Name] = true
	}
	if len(names) != 33 {
		t.Fatalf("el conteo de tools debe seguir en 33 (fb-022: 21 vlp_* + 12 odoo; §2.7: no se agrega ninguna tool); got %d", len(names))
	}

	_, schema := actTool(t, s)
	raw, ok := schema["properties"]
	if !ok {
		t.Fatalf("InputSchema de vlp_act sin 'properties': %v", schema)
	}
	props, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("InputSchema.properties no es un objeto: %T", raw)
	}

	// Guarda de no-vacuidad: si el schema perdiera los params previos, la
	// aserción sobre `force` no diría nada sobre una extensión retrocompatible.
	for _, prev := range []string{"tabId", "ref", "action"} {
		if _, ok := props[prev]; !ok {
			t.Fatalf("precondición: el InputSchema de vlp_act debe seguir declarando %q; properties=%v", prev, props)
		}
	}

	force, ok := props["force"]
	if !ok {
		t.Fatalf("InputSchema de vlp_act sin el parámetro `force` (§2.7/P20); properties=%v", props)
	}
	forceObj, ok := force.(map[string]any)
	if !ok {
		t.Fatalf("la propiedad `force` no es un objeto de schema: %T (%v)", force, force)
	}
	if forceObj["type"] != "boolean" {
		t.Fatalf("`force` debe declararse como booleano (HITL 2, se descartó el string mágico); type=%v", forceObj["type"])
	}

	// `force` es opcional (default false, §2.5). Se compara sobre la forma
	// stringificada a propósito: un type-assert a []string sería un no-op
	// silencioso si el schema usa []any.
	if rawReq, ok := schema["required"]; ok {
		if strings.Contains(fmt.Sprint(rawReq), "force") {
			t.Fatalf("`force` es opcional (§2.5), no puede figurar en required: %v", rawReq)
		}
	}
}

// P20b (§2.5, hallazgo de review): `force` se type-assertea en tools.go
// (`force, _ := params["force"].(bool)`), NO se relaya crudo.
//
// callTool no valida params contra el InputSchema, y background.js hace
// `!!force`: en JS `!!"false" === true`, así que un `"force": "false"` relayado
// crudo DESACTIVA el guard que existe para evitar la pérdida de datos de §1.
// Un tipo incorrecto tiene que degradar al default seguro `false` (bool),
// nunca al valor crudo. El wire se inspecciona en hub.lastCall(), igual que
// TestAct_Wire (mcp_frame_api_test.go:92).
func TestAct_ForceTypeAsserted(t *testing.T) {
	casos := []struct {
		nombre  string
		entrada any // valor de "force" en los params de la tool call
		quiero  bool
	}{
		{"bool true (único que habilita el override)", true, true},
		{"bool false", false, false},
		{"string \"false\" (el caso peligroso: !!\"false\" === true en JS)", "false", false},
		{"string \"true\" (tampoco habilita: no es un bool)", "true", false},
		{"número 1", float64(1), false},
		{"null", nil, false},
	}

	for _, c := range casos {
		s, hub := newTools(t)
		resp := callTool(s, "vlp_act", map[string]any{
			"tabId": float64(7), "ref": "main>button", "action": "click", "force": c.entrada,
		})
		if _, hasErr := resp["error"]; hasErr {
			t.Fatalf("%s: act → error inesperado: %v", c.nombre, resp)
		}
		_, cmd := hub.lastCall()

		// La ausencia de la clave equivale a false (background.js hace `!!force`
		// y `!!undefined === false`): se acepta como forma válida del default
		// seguro. Lo que NO se acepta es un valor no-bool relayado crudo.
		raw, presente := cmd.Params["force"]
		got := false
		if presente {
			b, esBool := raw.(bool)
			if !esBool {
				t.Fatalf("%s: `force` se relayó CRUDO (%T %v) en vez de type-assertado a bool (§2.5)", c.nombre, raw, raw)
			}
			got = b
		}
		if got != c.quiero {
			t.Fatalf("%s: force en el wire = %v (presente=%v), want %v", c.nombre, got, presente, c.quiero)
		}
	}

	// Sin la clave: el default seguro es false, nunca ausencia ambigua ni true.
	s, hub := newTools(t)
	if _, hasErr := callTool(s, "vlp_act", map[string]any{
		"tabId": float64(7), "ref": "main>button", "action": "click",
	})["error"]; hasErr {
		t.Fatal("act sin force → error inesperado")
	}
	_, cmd := hub.lastCall()
	if raw, ok := cmd.Params["force"]; ok {
		if got, esBool := raw.(bool); !esBool || got {
			t.Fatalf("sin `force` el wire debe llevar el bool false (default seguro), no %T %v", raw, raw)
		}
	}
}
