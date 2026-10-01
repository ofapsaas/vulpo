// onmessage_sender_e2e.go — fb-024-onmessage-sender: pasos T2 P2/P3 del
// harness (Firefox real vía web-ext). Spec §3.2.
//
// Corre SOLO con el selector sólo-harness `VLP_HARNESS_ONMSG=1` (patrón
// VLP_ACTTIMEOUT), sobre el boot de FRAME_E2E. El escenario manda, desde un
// script inyectado (`vlp_eval`, mundo aislado del content script), mensajes al
// canal interno `browser.runtime.onMessage` y verifica el EFECTO observable,
// nunca el texto de la respuesta.
//
// ── VERIFY V-1 (anti-vacuo) ─────────────────────────────────────────────────
// El arreglo del producto sólo es testeable si el `vlp_eval` de la fixture
// alcanza `browser.runtime.sendMessage`. Si NO lo alcanza (p. ej. el eval está
// bloqueado por la CSP de la extensión), el paso pasaría sin probar nada: la
// corrida pre-arreglo DEBE mostrar el flip/desconexión. Este módulo hace
// fail-closed con nombre (`ONMSG-V1`) cuando el vector no es alcanzable, en vez
// de acreditar P2/P3 en falso; la salida de la corrida es la evidencia.
//
// ── Mecanismo ───────────────────────────────────────────────────────────────
// La fixture de página deja en `#onmsg-code` el cuerpo a inyectar. El harness
// lo pasa a `vlp_eval`, que lo ejecuta en el mundo aislado del content script
// (mismo mundo donde correría el `vlp_eval` del agente). El cuerpo llama
// `browser.runtime.sendMessage(payload)` y escribe la respuesta (o el error) en
// `#onmsg-readback` del DOM; el harness lo lee con `vlp_getDOM` (canal de
// lectura: DOM, no eval — `vlp_eval` sólo retorna strings).
//
//	P2: `{type:'togglePlanMode', profileId:'<bridgeUrl>|<token>'}`; a ≥500 ms
//	`probeBuildMode` sigue en Build. La respuesta (éxito o `{error:'forbidden'}`)
//	NO decide: decide el efecto.
//	P3: `toggle` / `disconnectBridge` / `updateRules`; tras cada uno el perfil
//	sigue vivo (`probeBuildMode` en Build + `vlp_listTabs` devuelve la pestaña).
//	Control negativo: un evaluado que NO manda nada no altera el estado.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// onmsgFixtureHTML: página servida por el harness para P2/P3. Sin CSP
// restrictiva en la respuesta: lo que importa es la CSP de la EXTENSIÓN, que
// aplica al mundo aislado donde corre `vlp_eval`. Deja en `#onmsg-code` el
// cuerpo inyectado y en `#onmsg-readback` el resultado.
const onmsgFixtureHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-024 onmessage sender</title></head>
<body>
<h1>OnMessage sender fixture</h1>
<div id="onmsg-readback">idle</div>
<pre id="onmsg-code">__ONMSG_CODE__</pre>
</body>
</html>`

// onmsgProbeBody: cuerpo inyectado por la fixture. Manda `payload` por el canal
// interno y deja la respuesta en `#onmsg-readback`. El payload se sustituye en
// __ONMSG_PAYLOAD__ como literal JSON.
const onmsgProbeBody = `(function () {
  var done = function (v) {
    try { document.getElementById('onmsg-readback').textContent = v; } catch (e) {}
  };
  try {
    if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.sendMessage) {
      done('NO_RUNTIME');
      return 'NO_RUNTIME';
    }
    var p = __ONMSG_PAYLOAD__;
    if (!p || !p.message) { done('NO_PAYLOAD'); return 'NO_PAYLOAD'; }
    browser.runtime.sendMessage(p.message).then(
      function (r) { done('RESP:' + JSON.stringify(r)); },
      function (e) { done('ERR:' + (e && e.message ? e.message : String(e))); }
    );
    return 'DISPATCHED';
  } catch (e) {
    done('THROW:' + (e && e.message ? e.message : String(e)));
    return 'THROW';
  }
})()`

// onmsgControlBody: control negativo de P3 — un cuerpo que NO manda nada y sólo
// certifica que el mundo aislado es alcanzable. No debe alterar el estado.
const onmsgControlBody = `(function () {
  try {
    if (typeof browser === 'undefined' || !browser.runtime) return 'NO_RUNTIME';
    document.getElementById('onmsg-readback').textContent = 'CONTROL_OK';
    return 'CONTROL_OK';
  } catch (e) {
    return 'ERR:' + (e && e.message ? e.message : String(e));
  }
})()`

// registerOnmsgRoutes: sirve la fixture de fb-024 en /onmsg-sender.
func registerOnmsgRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/onmsg-sender", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, onmsgFixtureHTML)
	})
}

// stripOneTag: contenido interno de un elemento serializado como outerHTML.
func stripOneTag(s string) string {
	lt := strings.Index(s, ">")
	gt := strings.LastIndex(s, "<")
	if lt < 0 || gt <= lt {
		return s
	}
	return s[lt+1 : gt]
}

// onmsgReadback: lee el nodo #onmsg-readback del DOM del tab (canal de lectura
// de la fixture). Devuelve el texto y si la lectura fue posible.
func onmsgReadback(port, tabID int) (string, bool) {
	html, ok := fb024GetDOM(port, tabID, "#onmsg-readback")
	if !ok {
		return "", false
	}
	return strings.TrimSpace(stripOneTag(html)), true
}

// onmsgOpenFixtureTab: abre la fixture en un tab propio.
func onmsgOpenFixtureTab(port int, pageURL, stepName string) (int, bool) {
	target := strings.TrimSuffix(pageURL, "/") + "/onmsg-sender"
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": target})
	tabID, tabOK := 0, false
	if openOK {
		tabID, tabOK = findTabByURL(port, target, 15*time.Second)
	}
	if !paso(stepName+"-0: tab de la fixture onmsg-sender abierto y detectado", openOK && tabOK,
		fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", openOK, tabID, target)) {
		return 0, false
	}
	return tabID, true
}

// onmsgEval: pasa `code` por `vlp_eval`. Devuelve el texto de la respuesta,
// toolErr y answered.
func onmsgEval(port, tabID int, code string) (text string, toolErr, answered bool) {
	return mcpCallEnvelope(port, "vlp_eval",
		map[string]any{"tabId": tabID, "code": code}, 30*time.Second)
}

// onmsgDispatch: corre `body` (con el payload ya sustituido) por `vlp_eval` y
// espera el readback. Devuelve el readback y si el vector fue alcanzable.
func onmsgDispatch(port, tabID int, message map[string]any) (readback string, reachable bool, detail string) {
	payload := map[string]any{"message": message, "result": ""}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", false, "payload marshal: " + err.Error()
	}
	code := strings.Replace(onmsgProbeBody, "__ONMSG_PAYLOAD__", string(body), 1)
	text, toolErr, answered := onmsgEval(port, tabID, code)
	switch {
	case !answered:
		return "", false, "vlp_eval sin respuesta: " + truncate(text, 200)
	case toolErr:
		return "", false, "vlp_eval error de tool: " + truncate(text, 200)
	case strings.Contains(text, "blocked by CSP"):
		return "", false, "vlp_eval bloqueado por CSP: " + truncate(text, 200)
	case !strings.Contains(text, "DISPATCHED"):
		return "", false, "vlp_eval no despachó: " + truncate(text, 200)
	}
	// Espera el readback (la respuesta del mensaje).
	deadline := time.Now().Add(5 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		if v, ok := onmsgReadback(port, tabID); ok {
			last = v
			if v != "" && v != "idle" {
				return v, true, truncate(text, 120)
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return last, true, truncate(text, 120)
}

// onmsgProfileID: id real del perfil (`<bridgeUrl>|<token>`) que el harness
// deja en la regla. Mismo formato que background.js: `${bridgeUrl}|${token}`.
func onmsgProfileID(port int) string {
	return fmt.Sprintf("ws://127.0.0.1:%d|%s", port, devToken)
}

// onmsgListTabsCount: cantidad de pestañas vivas (para P3: la sesión sigue viva).
func onmsgListTabsCount(port int) (int, bool) {
	text, ok := mcpCall(port, "vlp_listTabs", map[string]any{})
	if !ok {
		return 0, false
	}
	var tabs []any
	if err := json.Unmarshal([]byte(text), &tabs); err != nil {
		return 0, false
	}
	return len(tabs), true
}

// onmsgProfileAlive: el perfil sigue en Build y la sesión sigue viva.
func onmsgProfileAlive(port int) (bool, string) {
	kind, detail := probeBuildMode(port)
	if kind != buildProbeBuild {
		return false, "probeBuildMode=" + detail
	}
	n, ok := onmsgListTabsCount(port)
	if !ok {
		return false, "vlp_listTabs falló"
	}
	return true, fmt.Sprintf("Build + %d tabs", n)
}

// onmsgOutcome: desenlace del escenario P2/P3 para el selector sólo-harness.
type onmsgOutcome int

const (
	onmsgPass  onmsgOutcome = iota // vector alcanzable y todos los pasos verdes
	onmsgFail                      // vector alcanzable pero algún paso rojo
	onmsgVacuo                     // V-1: vector NO alcanzable (test vacuo) — se documenta, no se acredita
)

// runOnmsgSenderE2E: P2 (togglePlanMode) + P3 (toggle/disconnectBridge/
// updateRules) + control negativo. Devuelve el desenlace.
//
// V-1 (anti-vacuo): si el `vlp_eval` de la fixture no alcanza
// `browser.runtime.sendMessage` (p. ej. el eval está bloqueado por la CSP de la
// extensión), el escenario NO puede mostrar el flip/desconexión pre-arreglo y
// el test sería vacuo: devuelve onmsgVacuo con la evidencia, sin acreditar P2/P3
// ni forzar la corrida. La evidencia RED del flip pre-arreglo sólo es posible
// cuando el vector es alcanzable.
func runOnmsgSenderE2E(port int, pageURL string) onmsgOutcome {
	fmt.Println("\n[E2E-onmsg] mensajes internos sólo desde páginas de la extensión (fb-024 P2/P3)")

	if !paso("ONMSG-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return onmsgFail
	}

	tabID, preOK := onmsgOpenFixtureTab(port, pageURL, "ONMSG")
	if !preOK {
		return onmsgFail
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	// V-1: la primera corrida con el payload de togglePlanMode certifica que el
	// vector es alcanzable desde vlp_eval. Si no lo es, el test es vacuo: se
	// documenta la causa y NO se acredita el paso en falso.
	profileID := onmsgProfileID(port)
	rb, reachable, detail := onmsgDispatch(port, tabID,
		map[string]any{"type": "togglePlanMode", "profileId": profileID})
	if !reachable {
		fmt.Printf("  [VACUO] ONMSG-V1: el vector NO es alcanzable desde vlp_eval — P2/P3 quedan escritos pero el flip pre-arreglo no se puede observar\n")
		fmt.Printf("  [VACUO] V-1 evidencia: %s\n", detail)
		fmt.Printf("  [VACUO] Consecuencia: el gate de sender (D-4/D-5) cierra el canal, pero hoy ningun script de pagina alcanza runtime.sendMessage (vlp_eval muerto por CSP). Deuda: fb-024-eval-main-world.\n")
		return onmsgVacuo
	}
	fmt.Printf("  [NOTE] ONMSG-V1: vector alcanzable; respuesta del mensaje = %q (%s)\n", rb, detail)

	allOK := true

	// P2: tras el despacho, a ≥500 ms el perfil sigue en Build (el gate rechazó
	// el cambio de modo). Sin el arreglo, el mismo paso deja el perfil en Plan.
	time.Sleep(600 * time.Millisecond)
	kind2, detail2 := probeBuildMode(port)
	allOK = paso("P2: tras togglePlanMode desde una página, el perfil SIGUE en Build (el gate rechazó el cambio)",
		kind2 == buildProbeBuild,
		fmt.Sprintf(" (respuesta=%q; probeBuildMode=%s)", rb, detail2)) && allOK

	// P3: toggle / disconnectBridge / updateRules no matan la sesión.
	p3Cases := []struct {
		name    string
		message map[string]any
	}{
		{"toggle", map[string]any{"type": "toggle"}},
		{"disconnectBridge", map[string]any{"type": "disconnectBridge", "profileId": profileID}},
		{"updateRules", map[string]any{"type": "updateRules", "rules": "* None"}},
	}
	for _, c := range p3Cases {
		rbC, reachC, detailC := onmsgDispatch(port, tabID, c.message)
		alive, aliveDetail := onmsgProfileAlive(port)
		allOK = paso("P3-"+c.name+": la sesión del perfil sigue viva tras el mensaje desde una página",
			reachC && alive,
			fmt.Sprintf(" (respuesta=%q, alcanzable=%v, %s; %s)", rbC, reachC, aliveDetail, detailC)) && allOK
	}

	// Control negativo: un evaluado que NO manda nada no altera el estado.
	text, toolErr, answered := onmsgEval(port, tabID, onmsgControlBody)
	ctrlReach := answered && !toolErr && !strings.Contains(text, "blocked by CSP") && strings.Contains(text, "CONTROL_OK")
	ctrlRead, _ := onmsgReadback(port, tabID)
	aliveCtrl, aliveCtrlDetail := onmsgProfileAlive(port)
	allOK = paso("P3-control: un vlp_eval que NO manda mensaje no altera el estado (sesión viva)",
		ctrlReach && aliveCtrl && strings.TrimSpace(ctrlRead) == "CONTROL_OK",
		fmt.Sprintf(" (eval=%q readback=%q alcanzable=%v; %s)", text, ctrlRead, ctrlReach, aliveCtrlDetail)) && allOK

	if allOK {
		return onmsgPass
	}
	return onmsgFail
}

// truncate: recorta para los mensajes de evidencia.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
