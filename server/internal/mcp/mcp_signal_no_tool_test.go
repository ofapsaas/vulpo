// Package mcp tests — fb-024-senal-previa-accion (P8, PIN).
//
// Deriva de §3.2 P8 (y D-3/I-6) del spec: `vlp_act` y `vlp_fill` NO registran
// un parámetro de señal (`signalMs`, `signal`): el rechazo de argumentos
// desconocidos de fb-020-004 responde con un error de tool que lo nombra y no
// despacha nada al hub; y ninguna tool registrada expone en su nombre o en su
// schema (properties/required) una clave que cambie la preferencia
// `vlp_action_signal` — la señal se enciende y apaga sólo desde el popup (D-3),
// no es controlable por el agente.
//
// PIN: debe pasar YA en RED (el rechazo de argumentos desconocidos existe); es
// guardián de que el GREEN de la señal no agregue el parámetro a las tools (la
// orquestación queda en background.js, fuera del contrato de tools).
//
// Archivo NUEVO a propósito (AC-1, precedente mcp_field_case_test.go:9-11):
// ningún test existente se modifica. Helpers reutilizados del paquete:
// newTools (mcp_tools_test.go), callTool (mcp_frame_api_test.go) y
// fb004ToolError/fb004NamesWord (mcp_field_case_test.go).
package mcp

import (
	"strings"
	"testing"
)

// fb024SchemaKeys: claves declaradas por el schema (properties + required).
func fb024SchemaKeys(schema map[string]any) map[string]bool {
	keys := map[string]bool{}
	if props, ok := schema["properties"].(map[string]any); ok {
		for k := range props {
			keys[k] = true
		}
	}
	if req, ok := schema["required"].([]any); ok {
		for _, r := range req {
			if s, isStr := r.(string); isStr {
				keys[s] = true
			}
		}
	}
	return keys
}

// P8 (a): `vlp_act` y `vlp_fill` con `signalMs` o `signal` → error de tool que
// nombra el argumento y 0 comandos despachados al hub.
func TestPostcondition8_SignalArgsRejected(t *testing.T) {
	casos := []struct {
		tool string
		arg  string
		args map[string]any
	}{
		{"vlp_act", "signalMs", map[string]any{
			"tabId": float64(7), "ref": "main>input", "action": "type", "value": "x", "signalMs": float64(600),
		}},
		{"vlp_act", "signal", map[string]any{
			"tabId": float64(7), "ref": "main>input", "action": "type", "value": "x", "signal": true,
		}},
		{"vlp_fill", "signalMs", map[string]any{
			"tabId": float64(7), "selector": "#a", "value": "v", "signalMs": float64(600),
		}},
		{"vlp_fill", "signal", map[string]any{
			"tabId": float64(7), "selector": "#a", "value": "v", "signal": true,
		}},
	}
	for _, c := range casos {
		s, hub := newTools(t)
		resp := callTool(s, c.tool, c.args)
		msg, isErr := fb004ToolError(resp)
		if !isErr {
			t.Errorf("P8 (%s con %s): debe dar error de tool; got %v", c.tool, c.arg, resp)
			continue
		}
		if !fb004NamesWord(msg, c.arg) {
			t.Errorf("P8 (%s con %s): el error debe nombrar el argumento %q: %q", c.tool, c.arg, c.arg, msg)
		}
		if calls := hub.commandCalls(); len(calls) != 0 {
			t.Errorf("P8 (%s con %s): el hub NO debe recibir comandos; recibió %v", c.tool, c.arg, calls)
		}
	}
}

// P8 (b): barrido de las tools registradas — ningún nombre de tool y ninguna
// clave de schema declara la preferencia `vlp_action_signal` ni un parámetro
// de señal. (La Description no se pina: Q-6 recomienda no mencionar la señal
// en las tools, pero el postcondición testeable es nombre + schema.)
func TestPostcondition8_NoToolControlsPreference(t *testing.T) {
	s, _ := newTools(t)
	prohibidas := []string{
		"vlp_action_signal", "action_signal", "actionSignal",
		"signal", "signalMs", "signal_ms",
	}
	vistas := 0
	for _, tl := range s.ListTools() {
		vistas++
		nombreBajo := strings.ToLower(tl.Name)
		for _, p := range prohibidas {
			if strings.Contains(nombreBajo, strings.ToLower(p)) {
				t.Errorf("P8: la tool %q no debe nombrar la preferencia/parámetro de señal (%q) en su nombre", tl.Name, p)
			}
			for k := range fb024SchemaKeys(tl.InputSchema) {
				kBajo := strings.ToLower(k)
				if kBajo == strings.ToLower(p) {
					t.Errorf("P8: la tool %q no debe declarar la clave de schema %q (cambia la preferencia, I-6)", tl.Name, k)
				}
			}
		}
	}
	if vistas == 0 {
		t.Fatal("P8: precondición — hay tools registradas")
	}
}
