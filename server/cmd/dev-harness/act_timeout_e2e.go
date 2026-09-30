// fb-024-act-timeout-techo — P7 (T2): `act type` colgado por un confirm nativo
// abierto en el listener del propio campo.
//
// docs/specs/fb-024-act-timeout-techo/spec.md §3.2 P7 y test-audit.md C2. El
// escenario corre SOLO con VLP_ACTTIMEOUT=1 (patrón VLP_NAVHANG), sobre el boot
// de FRAME_E2E: `act type` sobre #i-confirm de /native-dialog?step=confirm-on-input
// no recibe respuesta (el confirm bloquea la inyección) y el hub lo corta.
//
// Contrato observable (borde, sin estructura interna):
//   - el error vence en [idle+waitMs, idle+waitMs+10 s), con idle leído de
//     VLP_IDLE_BUDGET_MS (el boot del server hereda el entorno del harness);
//   - el texto empieza por `command_timeout:`, contiene `for act on tab <T>
//     within <idle+waitMs> ms` y termina con la pista D-4;
//   - tras `vlp_navigate` a sin-dialogo, un getFrame responde en < 5 s.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	actTimeoutPrefix           = "command_timeout:"
	actTimeoutDefaultIdleMs    = 45000
	actTimeoutWaitMs           = 1000
	actTimeoutFixtureFieldName = "confirmar" // aria-label de #i-confirm
)

// actTimeoutIdleMs: IDLE_BUDGET efectivo del server del harness. El boot le
// pasa os.Environ() al binario (main.go: srvCmd.Env = append(os.Environ(), …)),
// así que el mismo VLP_IDLE_BUDGET_MS que lee el server está acá; ausente o
// inválido = default del server (45000).
func actTimeoutIdleMs() int {
	ms, err := strconv.Atoi(os.Getenv("VLP_IDLE_BUDGET_MS"))
	if err != nil || ms <= 0 {
		return actTimeoutDefaultIdleMs
	}
	return ms
}

// actTimeoutPageDialogHint: sufijo D-4 con <T> ya resuelto — contrato textual
// literal, espejo del que arma el hub.
func actTimeoutPageDialogHint(tabStr string) string {
	return "; the page may be showing a native dialog (confirm/alert/prompt) waiting for a human in tab " + tabStr +
		": ask the human to answer it, then re-read the page with vlp_getFrame before retrying (the action may have run); " +
		"vlp_navigate and vlp_closeTab dismiss the dialog without an answer, use them only if the human agrees"
}

// mcpCallErrorText: como mcpCallEnvelope, pero devuelve el MENSAJE del error
// (error.message del JSON-RPC, o content[0].text de un result.isError) en vez
// del envoltorio formateado — P7 aserta sobre el texto pelado del hub.
func mcpCallErrorText(port int, name string, args map[string]any, timeout time.Duration) (msg string, toolErr bool, answered bool) {
	if !ensureSession(port) {
		return "", false, false
	}
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Mcp-Session-Id", devSession)
	req.Header.Set("x-vlp-token", devToken)
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return err.Error(), false, false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return string(data), false, true
	}
	if e, hasErr := out["error"]; hasErr {
		if em, ok := e.(map[string]any); ok {
			if s, ok := em["message"].(string); ok {
				return s, true, true
			}
		}
		return fmt.Sprintf("%v", e), true, true
	}
	res, _ := out["result"].(map[string]any)
	content, _ := res["content"].([]any)
	if len(content) > 0 {
		first, _ := content[0].(map[string]any)
		msg, _ = first["text"].(string)
	}
	if isErr, _ := res["isError"].(bool); isErr {
		return msg, true, true
	}
	return msg, false, true
}

// runActTimeoutE2E: P7 completo (fixture confirm-on-input, act type colgado,
// texto del vencimiento y liberación del tab). Devuelve true sólo con todos los
// pasos en verde.
func runActTimeoutE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-act-timeout] act type colgado por confirm nativo (fb-024 P7)")
	if !paso("AT-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}

	idleMs := actTimeoutIdleMs()
	expectedMs := idleMs + actTimeoutWaitMs
	fmt.Printf("  [NOTE] AT: VLP_IDLE_BUDGET_MS=%d → plazo esperado idle+waitMs=%d ms\n", idleMs, expectedMs)

	tabID, fi, _, ready, why := openNativeDialogTab(port, pageURL, "confirm-on-input")
	if !paso("AT-setup: tab abierto en confirm-on-input (marcador listo:confirm-on-input)",
		ready, fmt.Sprintf(" (%s)", why)) {
		if tabID != 0 {
			mcpCallEnvelope(port, "vlp_closeTab", map[string]any{"tabId": tabID}, 3*time.Second)
		}
		return false
	}

	ref, okRef := fi.findRefByName(actTimeoutFixtureFieldName)
	allOK := paso("AT-setup: #i-confirm (aria-label "+actTimeoutFixtureFieldName+") presente en el mapa",
		okRef, fmt.Sprintf(" (ref=%q, elementos=%d)", ref, fi.frameElementCount()))
	if !okRef {
		navigateNativeDialogStep(port, tabID, pageURL, "sin-dialogo")
		mcpCallEnvelope(port, "vlp_closeTab", map[string]any{"tabId": tabID}, 3*time.Second)
		return false
	}

	// act type: el listener `input` de #i-confirm llama a confirm() y bloquea
	// la inyección; el hub vence en idle+waitMs. El cliente espera holgado.
	clientTimeout := time.Duration(expectedMs+10000) * time.Millisecond
	t0 := time.Now()
	msg, toolErr, answered := mcpCallErrorText(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": ref, "action": "type", "value": "x", "waitMs": float64(actTimeoutWaitMs)},
		clientTimeout)
	elapsed := time.Since(t0)

	tabStr := strconv.Itoa(tabID)
	hint := actTimeoutPageDialogHint(tabStr)
	wantWithin := fmt.Sprintf("for act on tab %s within %d ms", tabStr, expectedMs)

	// Guarda de fixture: si el act NO bloqueó, vuelve ok:true — es fallo de
	// fixture (D-11 no reproducido), no un RED por texto (spec §3.2 P7). Sólo
	// un tool error con el prefijo `command_timeout:` cuenta como bloqueo por
	// diálogo; cualquier otro tool error es fallo de fixture.
	if answered && toolErr && strings.HasPrefix(msg, actTimeoutPrefix) {
		allOK = paso("AT-fixture: act type bloqueado por el confirm (tool error, no ok:true)", true,
			fmt.Sprintf(" (%d ms)", elapsed.Milliseconds())) && allOK
	} else {
		allOK = paso("AT-fixture: act type bloqueado por el confirm (tool error, no ok:true)", false,
			fmt.Sprintf(" (respondió=%v, error de tool=%v, prefijo=%v, %d ms; msg=%.300q)",
				answered, toolErr, strings.HasPrefix(msg, actTimeoutPrefix), elapsed.Milliseconds(), msg)) && allOK
	}

	allOK = paso("AT-P7a: mensaje con prefijo command_timeout: y el plazo real idle+waitMs",
		strings.HasPrefix(msg, actTimeoutPrefix) && strings.Contains(msg, wantWithin),
		fmt.Sprintf(" (want %q; msg=%.400q)", wantWithin, msg)) && allOK

	allOK = paso("AT-P7a: mensaje termina con la pista D-4 (diálogo nativo en el tab)",
		strings.HasSuffix(msg, hint),
		fmt.Sprintf(" (want sufijo %.140q; msg=%.400q)", hint, msg)) && allOK

	allOK = paso("AT-P7a: vence dentro de [idle+waitMs, idle+waitMs+10 s)",
		elapsed >= time.Duration(expectedMs)*time.Millisecond && elapsed < time.Duration(expectedMs+10000)*time.Millisecond,
		fmt.Sprintf(" (%d ms, want [%d,%d))", elapsed.Milliseconds(), expectedMs, expectedMs+10000)) && allOK

	// P7b: navigate a sin-dialogo libera el tab; el getFrame posterior responde < 5 s.
	_, _, readySD, whySD := navigateNativeDialogStep(port, tabID, pageURL, "sin-dialogo")
	gStart := time.Now()
	_, gOK, _ := getFrameRaw(port, tabID)
	gElapsed := time.Since(gStart)
	allOK = paso("AT-P7b: navigate a sin-dialogo libera el tab y getFrame responde < 5 s",
		readySD && gOK && gElapsed < 5*time.Second,
		fmt.Sprintf(" (navigate listo=%v %s; getFrame ok=%v en %d ms)", readySD, whySD, gOK, gElapsed.Milliseconds())) && allOK

	mcpCallEnvelope(port, "vlp_closeTab", map[string]any{"tabId": tabID}, 3*time.Second)
	return allOK
}
