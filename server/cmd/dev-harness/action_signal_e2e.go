// action_signal_e2e.go — fb-024-senal-previa-accion: pasos T2 P9/P10/P11 del
// harness (Firefox real vía web-ext). Spec §3.2.
//
// ── Canal de lectura: DOM, no eval ─────────────────────────────────────────
// `vlp_eval` corre en el mundo AISLADO del content script y `eval` está
// bloqueado por la CSP de la extensión (`script-src 'self'`, manifest.json:30;
// ver main.go:348). Además el mundo aislado NO ve los globales de página
// (`window.__…`), sólo el DOM. Por eso la fixture expone TODO su estado en un
// nodo `#signal-state` colgado de `<html>` (fuera de `body`, invisible a
// `serializeFrame(body)`) y el harness lo lee con `vlp_getDOM`. El nodo lleva:
//   - `data-visibility`: `document.visibilityState` (al cargar y en cada
//     `visibilitychange`; en P9 además en cada tick del reloj).
//   - `data-now`: `performance.now()` de la página, refrescado cada ~16 ms SÓLO
//     en P9 (`?p9`), para tomar `t0` justo antes del act. Se detiene en el click.
//   - `data-click-perf`: `performance.now()` del click del botón.
//   - `data-clicks`: cantidad de clicks del botón.
//   - `data-records`: registros vistos por un `MutationObserver` de PÁGINA sobre
//     `documentElement` (subtree/childList/attributes/characterData), sin contar
//     las escrituras del propio nodo de estado (plomería de la fixture).
//
// La fixture se sirve SIN CSP restrictiva (no hace falta eval igual: el canal es
// el DOM). Los errores de la fixture se distinguen de los del producto con la
// precondición guardada de visibilidad (D-5).
//
// P9 (señal encendida): pestaña ACTIVA y visible (precondición guardada,
// leída del DOM), Δ ≥ 600 ms entre `t0` (reloj del fixture leído justo antes del
// act) y `clickPerf`; observer 0 a ≥ 1000 ms del click; getFrame posterior sin
// elementos nuevos y changedSinceLast:false.
//
// P10 (rechazo sin señal): documento recién cargado; act click sobre un botón
// disabled ⇒ {ok:false, disabled:true, error}; 0 hosts de señal y observer 0;
// guarda de no-vacuidad: un act aceptado SÍ deja el host (+1 en el conteo).
//
// P11 (preferencia apagada): se corre con el selector sólo-harness
// `VLP_HARNESS_SIGNAL=off` (documentado en la cabecera de main.go), que inyecta
// `harness-signal.js` en la COPIA (nunca en el repo/XPI) y apaga
// `vlp_action_signal`. El click despacha igual, con diferencia SIN cota
// inferior, y NO aparece ningún host de señal.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// actionSignalHostAttr: marcador del host de la señal en el DOM (signal.js
// HOST_ATTR). El conteo por `vlp_getDOM` de `<html>` acota la señal a un host.
const actionSignalHostAttr = "data-vulpo-action-signal"

// actionSignalPageHTML: fixture de P9/P10/P11 (fb-024). Estado expuesto por DOM.
const actionSignalPageHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-024 action signal</title></head>
<body>
<h1>Action signal fixture</h1>
<button id="signal-btn">senal-boton</button>
<button id="signal-btn2">senal-boton-2</button>
<button id="signal-disabled" disabled>senal-deshabilitado</button>
<input id="signal-input" aria-label="senal-campo">
<script>
(function () {
  // Nodo de estado fuera de body: no entra en serializeFrame(body) (I-3) y el
  // harness lo lee por vlp_getDOM (eval está bloqueado por la CSP, main.go:348).
  var st = document.createElement('div');
  st.id = 'signal-state';
  st.setAttribute('data-visibility', document.visibilityState || '');
  st.setAttribute('data-now', '');
  st.setAttribute('data-click-perf', '');
  st.setAttribute('data-clicks', '0');
  st.setAttribute('data-records', '0');
  document.documentElement.appendChild(st);
  // La escritura de plomería del nodo de estado no cuenta como mutación de la
  // página (el observer mide el contrato de la señal, no el reloj).
  function esPlomeria(r) { return r.target === st && r.type === 'attributes'; }
  var clicks = 0;
  document.addEventListener('visibilitychange', function () {
    st.setAttribute('data-visibility', document.visibilityState || '');
  });
  // El observer se arma al terminar el parseo: armado durante la ejecución del
  // <script> inline, el parser todavía inserta nodos de cierre en <body> y los
  // cuenta como mutaciones de página (falso positivo de P10).
  var observer = null;
  function armarObserver() {
    if (observer) return;
    observer = new MutationObserver(function (recs) {
      var real = 0;
      for (var i = 0; i < recs.length; i++) {
        if (!esPlomeria(recs[i])) real++;
      }
      if (real > 0) {
        var cur = parseInt(st.getAttribute('data-records') || '0', 10) || 0;
        st.setAttribute('data-records', String(cur + real));
      }
    });
    observer.observe(document.documentElement,
      { subtree: true, childList: true, attributes: true, characterData: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', armarObserver);
  } else {
    armarObserver();
  }

  var timer = null;
  function tick() {
    st.setAttribute('data-now', String(performance.now()));
    st.setAttribute('data-visibility', document.visibilityState || '');
  }
  // SÓLO P9 emite el reloj continuo: P10/P11 deben quedar quietos para que el
  // observer de P10 mida 0.
  if (location.search.indexOf('p9') !== -1) {
    tick();
    timer = setInterval(tick, 16);
  }
  function stopClock() { if (timer !== null) { clearInterval(timer); timer = null; } }

  function onClick(perf) {
    clicks += 1;
    st.setAttribute('data-clicks', String(clicks));
    st.setAttribute('data-click-perf', String(perf));
    stopClock();
    // Rearme en el click: descarta todo lo acumulado (la inserción del host de
    // la señal ocurre ANTES del despacho y no debe contar) y vuelve el contador
    // a 0; sólo las mutaciones POSTERIORES al click cuentan (I-4).
    if (observer) {
      observer.takeRecords();
      st.setAttribute('data-records', '0');
      observer.takeRecords();
    }
  }
  document.getElementById('signal-btn').addEventListener('click', function () { onClick(performance.now()); });
  document.getElementById('signal-btn2').addEventListener('click', function () { onClick(performance.now()); });
})();
</script>
</body>
</html>`

// registerActionSignalRoutes: sirve la fixture de fb-024 en /action-signal.
func registerActionSignalRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/action-signal", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, actionSignalPageHTML)
	})
}

// fb024GetDOM: `vlp_getDOM` y extracción del `html`. selector "" = página
// completa (documentElement).
func fb024GetDOM(port, tabID int, selector string) (string, bool) {
	args := map[string]any{"tabId": tabID}
	if selector != "" {
		args["selector"] = selector
	}
	m, ok, _ := toolMap(port, "vlp_getDOM", args)
	if !ok {
		return "", false
	}
	html, _ := m["html"].(string)
	return html, html != ""
}

// fb024AttrRe: `data-<clave>="<valor>"` del outerHTML del nodo de estado.
var fb024AttrRe = regexp.MustCompile(`data-([a-z-]+)="([^"]*)"`)

// fb024State: atributos `data-*` del nodo `#signal-state` (el canal de lectura
// de la fixture; ver la cabecera del archivo).
func fb024State(port, tabID int) (map[string]string, bool) {
	html, ok := fb024GetDOM(port, tabID, "#signal-state")
	if !ok {
		return nil, false
	}
	attrs := map[string]string{}
	for _, m := range fb024AttrRe.FindAllStringSubmatch(html, -1) {
		attrs[m[1]] = m[2]
	}
	return attrs, true
}

// fb024Num: atributo numérico de `fb024State`.
func fb024Num(attrs map[string]string, key string) (float64, bool) {
	v, ok := attrs[key]
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// fb024HostCount: cantidad de hosts de señal en el documento (documentElement
// serializado con `vlp_getDOM`). 0 = la señal no insertó nada.
func fb024HostCount(port, tabID int) (int, bool) {
	html, ok := fb024GetDOM(port, tabID, "html")
	if !ok {
		return 0, false
	}
	return strings.Count(html, actionSignalHostAttr), true
}

// fb024OpenSignalTab: build + openTab de /action-signal?<q> + activate, y la
// precondición guardada de P9/P11: pestaña ACTIVA y `visibilityState ==
// 'visible'` (leído del DOM; ver cabecera). Devuelve el tabID y si la
// precondición se cumple.
func fb024OpenSignalTab(port int, pageURL, q, stepName string) (int, bool) {
	target := strings.TrimSuffix(pageURL, "/") + "/action-signal" + q
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": target})
	tabID, tabOK := 0, false
	if openOK {
		tabID, tabOK = findTabByURL(port, target, 15*time.Second)
	}
	if !paso(stepName+"-0: tab de la fixture action-signal abierto y detectado", openOK && tabOK,
		fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", openOK, tabID, target)) {
		return 0, false
	}
	mcpCall(port, "vlp_activateTab", map[string]any{"tabId": tabID})
	time.Sleep(400 * time.Millisecond)
	attrs, stOK := fb024State(port, tabID)
	vis := attrs["visibility"]
	if !paso(stepName+"-pre: pestaña ACTIVA y visible (visibilityState=='visible')", stOK && vis == "visible",
		fmt.Sprintf(" (activateTab ok, visibilityState=%q)", vis)) {
		// FAIL de fixture: sin visibilidad la señal se omite (D-5) y el paso
		// pasaría sin probar nada.
		return tabID, false
	}
	return tabID, true
}

// runSignalOnCase: P9.
func runSignalOnCase(port int, pageURL string) bool {
	fmt.Println("\n[E2E-signal] P9 — señal encendida (por defecto)")
	allOK := true
	tabID, preOK := fb024OpenSignalTab(port, pageURL, "?p9", "P9")
	if !preOK {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	// getFrame inicial: baseline de elementos (también fija lastFrameByTab).
	fi, fiOK, raw := getFrameRaw(port, tabID)
	ref, refOK := fi.findRefByName("senal-boton")

	// t0: reloj del fixture (performance.now de la página) leído JUSTO antes
	// del act.
	attrs0, st0OK := fb024State(port, tabID)
	t0, t0OK := fb024Num(attrs0, "now")

	actM, actOK, actRaw := toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": ref, "action": "click"})
	actOk, _ := actM["ok"].(bool)

	attrs1, st1OK := fb024State(port, tabID)
	clickPerf, cpOK := fb024Num(attrs1, "click-perf")
	delta := clickPerf - t0

	allOK = paso("P9-1: vlp_act click con señal encendida ⇒ click a ≥600 ms de t0 (t0/reloj del fixture → performance.now del click)",
		fiOK && refOK && st0OK && t0OK && actOK && actOk && st1OK && cpOK && delta >= 600,
		fmt.Sprintf(" (Δ=%.1f ms, ref encontrado=%v, act ok=%v; raw %.200s)", delta, refOK && fiOK, actOk, actRaw)) && allOK

	// Cota inferior: lectura a ≥1000 ms del click.
	time.Sleep(1100 * time.Millisecond)
	attrs2, st2OK := fb024State(port, tabID)
	records, recOK := fb024Num(attrs2, "records")
	allOK = paso("P9-2: observer de la página registra 0 a ≥1000 ms del despacho",
		st2OK && recOK && records == 0, fmt.Sprintf(" (registros=%.0f)", records)) && allOK

	f2, f2OK := getFrame(port, tabID)
	allOK = paso("P9-3: getFrame posterior sin elementos nuevos y changedSinceLast=false",
		fiOK && f2OK && f2.frameElementCount() == fi.frameElementCount() && !f2.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (elems %d→%d, changed=%v)", fi.frameElementCount(), f2.frameElementCount(), f2.Invalidation.ChangedSinceLast)) && allOK
	_ = raw
	return allOK
}

// runSignalRejectCase: P10.
func runSignalRejectCase(port int, pageURL string) bool {
	fmt.Println("\n[E2E-signal] P10 — rechazo sin señal en documento recién cargado")
	allOK := true
	tabID, preOK := fb024OpenSignalTab(port, pageURL, "?p10", "P10")
	if !preOK {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	fi, fiOK, _ := getFrameRaw(port, tabID)
	refDisabled, rdOK := fi.findRefByName("senal-deshabilitado")
	refEnabled, reOK := fi.findRefByName("senal-boton-2")

	beforeHosts, bhOK := fb024HostCount(port, tabID)
	attrs0, st0OK := fb024State(port, tabID)
	beforeRecords, brOK := fb024Num(attrs0, "records")

	m, actOK, actRaw := toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": refDisabled, "action": "click"})
	okv, _ := m["ok"].(bool)
	disabledv, _ := m["disabled"].(bool)
	errv, _ := m["error"].(string)

	afterHosts, ahOK := fb024HostCount(port, tabID)
	attrs1, st1OK := fb024State(port, tabID)
	afterRecords, arOK := fb024Num(attrs1, "records")

	allOK = paso("P10-1: act click sobre disabled ⇒ {ok:false, disabled:true, error}",
		fiOK && rdOK && actOK && !okv && disabledv && errv != "",
		fmt.Sprintf(" (ref encontrado=%v, ok=%v, disabled=%v, error no vacío=%v; raw %.200s)", rdOK, okv, disabledv, errv != "", actRaw)) && allOK

	allOK = paso("P10-2: rechazo sin señal ⇒ 0 hosts y observer 0 (documento recién cargado)",
		bhOK && ahOK && beforeHosts == 0 && afterHosts == 0 && st0OK && brOK && st1OK && arOK && beforeRecords == 0 && afterRecords == 0,
		fmt.Sprintf(" (hosts %d→%d, registros %.0f→%.0f)", beforeHosts, afterHosts, beforeRecords, afterRecords)) && allOK

	// Guarda de no-vacuidad: un act aceptado en el MISMO documento SÍ deja el
	// host (un host más en documentElement).
	beforeHosts2, b2OK := fb024HostCount(port, tabID)
	m2, act2OK, _ := toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": refEnabled, "action": "click"})
	ok2, _ := m2["ok"].(bool)
	afterHosts2, a2OK := fb024HostCount(port, tabID)

	allOK = paso("P10-guarda: tras un act aceptado SÍ aparece el host (+1 host de documentElement)",
		reOK && b2OK && act2OK && ok2 && a2OK && beforeHosts2 == 0 && afterHosts2 == 1,
		fmt.Sprintf(" (ref encontrado=%v, ok=%v, hosts %d→%d)", reOK, ok2, beforeHosts2, afterHosts2)) && allOK
	return allOK
}

// runSignalOffCase: P11 (corrido con VLP_HARNESS_SIGNAL=off).
func runSignalOffCase(port int, pageURL string) bool {
	fmt.Println("\n[E2E-signal] P11 — preferencia apagada (selector harness-only VLP_HARNESS_SIGNAL=off)")
	allOK := true
	tabID, preOK := fb024OpenSignalTab(port, pageURL, "?p11", "P11")
	if !preOK {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	fi, fiOK, _ := getFrameRaw(port, tabID)
	ref, refOK := fi.findRefByName("senal-boton")

	beforeHosts, bhOK := fb024HostCount(port, tabID)
	m, actOK, _ := toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": ref, "action": "click"})
	okv, _ := m["ok"].(bool)
	afterHosts, ahOK := fb024HostCount(port, tabID)

	attrs1, st1OK := fb024State(port, tabID)
	clickPerf, cpOK := fb024Num(attrs1, "click-perf")
	clicks, clkOK := fb024Num(attrs1, "clicks")
	_ = clickPerf

	// "Diferencia sin cota inferior": se aserta que hubo click (estructura),
	// NO un techo ni un piso de tiempo.
	allOK = paso("P11-1: sin señal, el click despacha igual (diferencia sin cota inferior)",
		fiOK && refOK && actOK && okv && st1OK && cpOK && clkOK && clicks >= 1,
		fmt.Sprintf(" (clicks=%.0f, ok=%v)", clicks, okv)) && allOK

	allOK = paso("P11-2: ningún host de señal en documentElement a lo largo del paso",
		bhOK && ahOK && beforeHosts == 0 && afterHosts == 0,
		fmt.Sprintf(" (hosts %d→%d)", beforeHosts, afterHosts)) && allOK
	return allOK
}

// runActionSignalE2E: dispatcher de P9/P10 (señal encendida) o P11 (apagada).
func runActionSignalE2E(port int, pageURL string, signalOff bool) bool {
	if !paso("SIG-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	if signalOff {
		return runSignalOffCase(port, pageURL)
	}
	allOK := true
	allOK = runSignalOnCase(port, pageURL) && allOK
	allOK = runSignalRejectCase(port, pageURL) && allOK
	return allOK
}
