// eval_main_world_e2e.go — fb-024-eval-main-world: pasos T2 P1/P2/P3a del
// harness (Firefox real vía web-ext). Spec §3.2.
//
// Corre SOLO con el selector sólo-harness `VLP_EVALMAIN=1` (patrón
// VLP_ACTTIMEOUT), sobre el boot de FRAME_E2E. Ejercita `vlp_eval` contra las
// fixtures del harness y verifica el EFECTO observable, nunca la estructura
// interna del handler.
//
// ── Por qué existe ──────────────────────────────────────────────────────────
// Hoy `handlers.eval` pasa el string por `executeScript` SIN `world`, así que
// el eval corre en el mundo aislado del content script, donde MV3 no admite
// `eval()`: la tool devuelve `call to eval() blocked by CSP` en TODA página
// (incluso en una sin CSP), no sólo en las estrictas. La feature (D-1:
// `world:'MAIN'`) mueve el eval al realm de la página: funciona donde la CSP de
// la página lo permite y falla honestamente (por la CSP de la página, sin
// ejecutar) donde no.
//
// ── Pasos (spec §3.2) ───────────────────────────────────────────────────────
//
//	P1  sobre `/` (fixture sin CSP): `vlp_eval {code:"1+1"}` devuelve "2".
//	    Antes de la feature: `{error:"call to eval() blocked by CSP"}` → RED.
//	P2  sobre `/native-dialog?step=sin-dialogo` (CSP estricta, sin unsafe-eval):
//	    `vlp_eval {code:"document.title='EVAL-RAN'"}` responde error que
//	    contiene `CSP` Y el título NO quedó en `EVAL-RAN`. ANTI-VACUO: no basta
//	    el texto del error, se prueba además el efecto AUSENTE (el DOM no mutó)
//	    y que el título leído es el de la fixture (la ausencia es significativa).
//	    Es un PIN de semántica: pasado y futuro devuelven el mismo texto, pero
//	    la causa pasa de "MV3 bloquea el eval del content script" a "la CSP de
//	    la página gobierna el eval".
//	P3a sobre `/` (fixture sin CSP): `vlp_eval {code:"typeof browser"}` devuelve
//	    "undefined" — el código del agente corre en el realm de la página, sin
//	    `browser.runtime`/`browser.storage`. Antes: bloqueado por CSP → RED.
//
// P3b (re-corrida del escenario `fb-024-onmessage-sender`) NO vive acá: usa su
// selector propio `VLP_HARNESS_ONMSG=1` y tras la feature el VACUO reporta
// `NO_RUNTIME` (no `blocked by CSP`); ver `onmessage_sender_e2e.go`.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"strings"
	"time"
)

// evalMainProbe: pasa `code` por `vlp_eval` sobre `tabID` y devuelve el mapa
// JSON decodificado del result (o el texto crudo si no parsea).
func evalMainProbe(port, tabID int, code string) (m map[string]any, ok bool, text string) {
	return toolMap(port, "vlp_eval", map[string]any{"tabId": tabID, "code": code})
}

// evalMainReadTitle: lee el contenido del elemento `<title>` del tab por el
// canal de LECTURA del harness (`vlp_getDOM`), nunca por `vlp_eval` (que es lo
// que se está midiendo).
func evalMainReadTitle(port, tabID int) (string, bool) {
	html, ok := fb024GetDOM(port, tabID, "title")
	if !ok {
		return "", false
	}
	return html, true
}

// runEvalMainWorldE2E: P1 + P2 + P3a de fb-024-eval-main-world. Devuelve true
// sólo con todos los pasos en verde.
func runEvalMainWorldE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-evalmain] vlp_eval en el mundo de la página (fb-024 P1/P2/P3a)")

	if !paso("EM-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}

	allOK := true

	// ── P1 + P3a: fixture SIN CSP (`/`), el tab del start-url. ──────────────
	tabID, tabOK := findTabByURL(port, pageURL, 15*time.Second)
	allOK = paso("EM-0: tab de la fixture sin CSP (`/`) abierto y detectado", tabOK,
		fmt.Sprintf(" (tabId %d, url %s)", tabID, pageURL)) && allOK
	if !tabOK {
		return false
	}

	// P1: el eval corre en la página y devuelve el valor stringificado.
	m1, ok1, text1 := evalMainProbe(port, tabID, "1+1")
	result1, _ := m1["result"].(string)
	allOK = paso("P1: vlp_eval {code:\"1+1\"} sobre una página sin CSP devuelve \"2\" (mundo de la página)",
		ok1 && result1 == "2",
		fmt.Sprintf(" (result=%q, text=%.200q)", result1, text1)) && allOK

	// P3a: el código del agente no tiene APIs de extensión en el realm de la
	// página — `browser` es undefined.
	m3, ok3, text3 := evalMainProbe(port, tabID, "typeof browser")
	result3, _ := m3["result"].(string)
	allOK = paso("P3a: vlp_eval {code:\"typeof browser\"} devuelve \"undefined\" (sin APIs de extensión)",
		ok3 && result3 == "undefined",
		fmt.Sprintf(" (result=%q, text=%.200q)", result3, text3)) && allOK

	// ── P2: fixture con CSP ESTRICTA (`/native-dialog?step=sin-dialogo`). ───
	strictURL := strings.TrimSuffix(pageURL, "/") + "/native-dialog?step=sin-dialogo"
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": strictURL})
	strictTab, strictTabOK := 0, false
	if openOK {
		strictTab, strictTabOK = findTabByURL(port, strictURL, 15*time.Second)
	}
	allOK = paso("P2-0: tab de la fixture con CSP estricta (sin-dialogo) abierto y detectado",
		openOK && strictTabOK, fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", openOK, strictTab, strictURL)) && allOK
	if strictTabOK {
		defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": strictTab})

		m2, ok2, text2 := evalMainProbe(port, strictTab, "document.title='EVAL-RAN'")
		errText, _ := m2["error"].(string)
		blocks := ok2 && strings.Contains(errText, "CSP")

		// ANTI-VACUO: el efecto ausente. Leer el título por getDOM (canal de
		// lectura) y comprobar que sigue siendo el de la fixture, no EVAL-RAN.
		titleHTML, titleOK := evalMainReadTitle(port, strictTab)
		isFixtureTitle := titleOK && strings.Contains(titleHTML, "native-dialog")
		mutated := strings.Contains(titleHTML, "EVAL-RAN")
		allOK = paso("P2: vlp_eval sobre CSP estricta devuelve error con CSP y NO ejecutó (título intacto)",
			blocks && isFixtureTitle && !mutated,
			fmt.Sprintf(" (error=%.160q; título=%.120q, leído=%v, mutado=%v, text=%.160q)",
				errText, titleHTML, titleOK, mutated, text2)) && allOK
	}

	return allOK
}
