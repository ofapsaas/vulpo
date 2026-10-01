// pc2_diagnostico.go — fb-024-harness-pc2-diagnostico (GREEN).
//
// D-2: pc2NoRegistrationLine es el clasificador PURO del mensaje de PC2 cuando
// la extensión no registra. Separa dos estados que antes compartían una sola
// línea colapsada:
//   - configInjected == false (VLP_HARNESS_NOCONFIG=1) → la config fue omitida
//     POR CONSTRUCCIÓN; se nombra el selector (contrato D-4 de
//     bootstrap-solo-dev, que D-2 repite).
//   - configInjected == true → no se afirma una causa no observada: se nombra
//     el estado medido y las causas candidatas (MV3 vs harness-config.js
//     roto). El console del background NO es observable por el harness
//     (discovery §1.5), así que no se inventa precisión (I-7).
//
// D-1: waitForStartURLTab es la barrera observable del tab de la start-url.
// En FRAME_E2E, con la extensión ya registrada, sondea vlp_listTabs hasta que
// aparece el tab de la start-url (exact match y, si no, prefix — la MISMA
// semántica de findTabByURL, vía matchTab/pollTabByURL) con timeout propio. Al
// vencer devuelve (0, false) HONESTO: no cuelga ni pasa en vacío (I-4). Se
// invoca antes de la sonda de Build para que la carrera de asignación de URL
// no se reporte como "build probe error".
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// pc2StartURLTabTimeout: T de la barrera D-1 (spec Q2: 30 s, muy por encima
// del retardo medido de asignación de URL y por debajo de los 120 s de
// registro de PC2).
const pc2StartURLTabTimeout = 30 * time.Second

// pc2NoRegistrationLine devuelve la línea de fail-fast de PC2 para el estado
// de no-registro. Puro: sin navegador, sin side effects (testeable sin T2).
func pc2NoRegistrationLine(configInjected bool) string {
	if !configInjected {
		// (a): la config fue omitida por el selector; única (a) determinista.
		return "  [FAIL] precondition: extension not configured — VLP_HARNESS_NOCONFIG=1 omitted harness-config.js from the copy"
	}
	// (b): registró la premisa (config inyectada) pero no hubo registro; no se
	// afirma la causa (no observable): se nombran las candidatas.
	return "  [FAIL] precondition: extension did not register within the PC2 timeout — harness-config.js was injected and web-ext installed the add-on; likely the MV3 event page did not start (ADR-005, re-run is usually valid), otherwise harness-config.js failed (check the add-on console)."
}

// lastListTabs: último estado observado de vlp_listTabs por la barrera PC2
// (snapshot del último poll parseable). Lo lee la línea (c) al vencer para
// distinguir "0 tabs sostenidos" (clase NOTABS esperada) de "tabs presentes
// que no matchean la start-url" (posible filtro de producto roto — riesgo 1
// del spec: se escala a finding, no se re-corre).
var lastListTabs atomic.Value // []tabInfo

// waitForStartURLTab espera el tab de la start-url en vlp_listTabs. Devuelve
// (tabID, true) apenas aparece; (0, false) al vencer el timeout. Reusa el
// núcleo de findTabByURL (matchTab + poll, D-1: misma semántica exact→prefix,
// sin duplicar el loop). En una corrida verde imprime el valor observado (URL
// y nº de tabs) para que la barrera sea anti-vacua: un verde prueba que se
// ejerció, no que se salteó (P8). Al vencer guarda el último estado observado
// para la línea (c) (F-3).
func waitForStartURLTab(port int, pageURL string, timeout time.Duration) (int, bool) {
	t, ok, observed := pollTabByURL(port, pageURL, timeout)
	if !ok {
		lastListTabs.Store(observed)
		return 0, false
	}
	fmt.Printf("  [BARRIER] start-url tab in listTabs: %s (%d tabs, tabId=%d)\n", t.URL, len(observed), t.ID)
	return t.ID, true
}

// describeLastListTabs: último estado observado de listTabs (cantidad de tabs
// y URLs) para la línea (c) al vencer la barrera.
func describeLastListTabs() string {
	tabs, _ := lastListTabs.Load().([]tabInfo)
	urls := make([]string, 0, len(tabs))
	for _, t := range tabs {
		urls = append(urls, t.URL)
	}
	return fmt.Sprintf("last tabs observed: %d [%s]", len(tabs), strings.Join(urls, ", "))
}
