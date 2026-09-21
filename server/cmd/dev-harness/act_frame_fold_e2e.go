// fb-020-008 — pliegue del mapa en act/navigate: P23-live, P24, P25, P26, P28
// (docs/specs/fb-020-008-act-frame-fold/harness-design.md, spec fb-020-008).
//
// Este E2E existe porque la feature pasó los 21 unit tests estando rota
// (`VulpoFrame.getFrame(...)` inexistente en el API del frame, y `act`
// con `click` volvía antes del bloque del pliegue). La Regla FE (§2 del
// diseño) hace que cualquier paso que pida `frame` y reciba `frameError`
// sea FAIL, sin excepción — salvo `FOLD-pre-artefacto`, la única guarda de
// validez del E2E, que mide si el parámetro existe, no si el pliegue funciona.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ---- 3.1: fixture /fold-act ----

// foldActPageHTML: el ruido va PRIMERO en el orden de documento (§3.1 del
// diseño) — si roles/namedOnly no llegan al serializer, un tope de página
// sin filtrar devuelve justamente el ruido, y P25 lo caza. Sin timers, sin
// poll a /mutate-cmd (un segundo poller robaría los comandos one-shot de la
// página principal), sin mutaciones asincrónicas.
func foldActPageHTML() string {
	var b strings.Builder
	b.WriteString(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-020-008 fold fixture</title></head>
<body>
<button id="fold-marker">fold-fixture-listo</button>
`)
	for i := 1; i <= 6; i++ {
		fmt.Fprintf(&b, "<button>fold-ruido-btn-%d</button>\n", i)
	}
	for i := 1; i <= 6; i++ {
		fmt.Fprintf(&b, "<input id=\"fold-anon-%d\">\n", i)
	}
	for i := 1; i <= 12; i++ {
		fmt.Fprintf(&b, "<input aria-label=\"fold-campo-%02d\">\n", i)
	}
	b.WriteString(`<a href="#">fold-ruido-link</a>
<button id="fold-adder">fold-agregar</button>
<button id="fold-nav-btn" onclick="location.href='/slow?ms=2000&amp;n=10'">fold-navega-lento</button>
<script>
var foldClicks = 0;
document.getElementById('fold-adder').addEventListener('click', function () {
  foldClicks += 1;
  for (var i = 1; i <= 3; i++) {
    var b = document.createElement('button');
    b.textContent = 'fold-nuevo-' + foldClicks + '-' + i;
    document.body.appendChild(b);
  }
});
</script>
</body>
</html>`)
	return b.String()
}

// registerFoldRoutes: /fold-act, servido sin CSP (igual que testPageHTML),
// sin poll y sin timers (§3.1 del diseño). El destino de navegación de P26/P28
// reusa /slow?ms=2000&n=<id> (ya registrado por startTestPage); no se agrega
// ruta destino.
func registerFoldRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/fold-act", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, foldActPageHTML())
	})
}

// ---- 1.1: helpers nuevos (los vigentes asumen el mapa en el nivel superior) ----

func foldFrameOf(m map[string]any) map[string]any {
	fr, _ := m["frame"].(map[string]any)
	return fr
}

func foldErrOf(m map[string]any) (string, bool) {
	fe, _ := m["frameError"].(map[string]any)
	if fe == nil {
		return "", false
	}
	s, ok := fe["error"].(string)
	return s, ok
}

func countElementsRaw(m map[string]any) int {
	n := 0
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		n += len(elems)
	}
	return n
}

func elementNamesRaw(m map[string]any) []string {
	var names []string
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		for _, e := range elems {
			el, _ := e.(map[string]any)
			if n, ok := el["name"].(string); ok {
				names = append(names, n)
			}
		}
	}
	return names
}

func elementRefsRaw(m map[string]any) map[string]bool {
	refs := map[string]bool{}
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		for _, e := range elems {
			el, _ := e.(map[string]any)
			if r, ok := el["ref"].(string); ok && r != "" {
				refs[r] = true
			}
		}
	}
	return refs
}

func hasElements(m map[string]any) bool {
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		if len(elems) > 0 {
			return true
		}
	}
	return false
}

// foldShape: Regla FE (§2 del diseño) — frameError ausente, frame presente y
// mapa, con al menos un elemento. El detalle siempre imprime elapsed ms,
// conteo de elementos y los primeros ~300 chars del raw.
func foldShape(m map[string]any, elapsed time.Duration, raw string) (ok bool, detail string) {
	errStr, hasErr := foldErrOf(m)
	frame := foldFrameOf(m)
	_, hasFrameKey := m["frame"]
	elemN := countElementsRaw(frame)
	has := hasElements(frame)
	ok = !hasErr && hasFrameKey && frame != nil && has
	detail = fmt.Sprintf(" (%dms, frameError presente=%v %q, frame mapa presente=%v elementos=%d hasElements=%v; raw %.300s)",
		elapsed.Milliseconds(), hasErr, errStr, frame != nil, elemN, has, raw)
	return ok, detail
}

func hasExcludedNoise(names []string) bool {
	for _, n := range names {
		if strings.HasPrefix(n, "fold-ruido-btn-") || n == "fold-ruido-link" ||
			n == "fold-agregar" || n == "fold-fixture-listo" || strings.HasPrefix(n, "fold-nuevo-") {
			return true
		}
	}
	return false
}

func allNamesHavePrefix(names []string, prefix string) bool {
	if len(names) == 0 {
		return false
	}
	for _, n := range names {
		if n == "" || !strings.HasPrefix(n, prefix) {
			return false
		}
	}
	return true
}

func refsDisjoint(a, b map[string]bool) bool {
	for r := range a {
		if b[r] {
			return false
		}
	}
	return true
}

// printRoleKeyDiagnostic: §9.9 del diseño — diagnóstico impreso, no aserción:
// la clave de rol de cada elemento devuelto en FOLD-25c, y totalElements/
// totalPages si están presentes.
func printRoleKeyDiagnostic(frame map[string]any) {
	secs, _ := frame["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		for _, e := range elems {
			el, _ := e.(map[string]any)
			name, _ := el["name"].(string)
			fmt.Printf("  [NOTE] FOLD-25 diagnostic: element name=%q keys=%v\n", name, el)
		}
	}
	fmt.Printf("  [NOTE] FOLD-25 diagnostic: totalElements=%v totalPages=%v\n", frame["totalElements"], frame["totalPages"])
}

// waitFoldFixtureReady: polea getFrame hasta que el raw contenga el marker
// de documento fresco fold-fixture-listo (patrón waitTypeObserveStep).
func waitFoldFixtureReady(port, tabID int, timeout time.Duration) (frameInfo, bool, string) {
	deadline := time.Now().Add(timeout)
	var fi frameInfo
	var raw string
	for time.Now().Before(deadline) {
		var ok bool
		fi, ok, raw = getFrameRaw(port, tabID)
		if ok && strings.Contains(raw, "fold-fixture-listo") {
			return fi, true, raw
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fi, false, raw
}

// waitFoldRawContains: polea getFrame hasta que el raw contenga substr
// (drenaje de FOLD-26 antes de cerrar el tab).
func waitFoldRawContains(port, tabID int, substr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, ok, raw := getFrameMap(port, map[string]any{"tabId": tabID})
		if ok && strings.Contains(raw, substr) {
			return true
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

// openFoldTab: build mode + openTab + findTabByURL + documento fresco por
// marker (patrón loadTypeObserveStep/openNativeDialogTab).
func openFoldTab(port int, pageURL string) (tabID int, fi frameInfo, raw string, ok bool, detail string) {
	if !ensureBuildMode(port) {
		return 0, fi, "", false, "build mode no disponible"
	}
	target := strings.TrimSuffix(pageURL, "/") + "/fold-act"
	if _, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": target}); !openOK {
		return 0, fi, "", false, "openTab falló"
	}
	var tabOK bool
	tabID, tabOK = findTabByURL(port, target, 15*time.Second)
	if !tabOK {
		return tabID, fi, "", false, "tab no detectado"
	}
	fi, fresh, raw := waitFoldFixtureReady(port, tabID, 15*time.Second)
	if !fresh {
		return tabID, fi, raw, false, "documento fresco no observado"
	}
	return tabID, fi, raw, true, ""
}

// ---- 5.0: FOLD-pre-artefacto ----

// foldPreArtifact: distingue "XPI viejo" de "pliegue roto" (§5.0 del diseño).
// Único paso donde frameError NO es FAIL: acá se mide si el parámetro existe.
func foldPreArtifact(port int, pageURL string) bool {
	tabID, fi, raw, ready, why := openFoldTab(port, pageURL)
	if !paso("FOLD-pre-artefacto-0: tab de /fold-act abierto, documento fresco (fold-fixture-listo)", ready,
		fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	ref, refOK := refByName(fi, raw, "fold-campo-01")
	if !paso("FOLD-pre-artefacto-1: ref de fold-campo-01 resuelto", refOK, "") {
		return false
	}

	m, toolErr, answered, text := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": ref, "action": "focus", "frame": map[string]any{}}, 20*time.Second)
	_, hasFrame := m["frame"]
	_, hasFrameError := m["frameError"]
	ok := answered && !toolErr && (hasFrame || hasFrameError)
	prefix := ""
	if answered && !toolErr && !hasFrame && !hasFrameError {
		prefix = "artefacto viejo: el server/XPI no trae el pliegue — reconstruir/reinstalar antes de leer el resto. "
	}
	return paso("FOLD-pre-artefacto: act focus con frame:{} responde y trae frame o frameError", ok,
		fmt.Sprintf(" %s(respondió=%v, error de tool=%v, frame=%v, frameError=%v; raw %.300s)",
			prefix, answered, toolErr, hasFrame, hasFrameError, text))
}

// ---- 5.1/5.2: FOLD-24 (pliegue en act click) + FOLD-25 (acotamiento) ----
// Mismo tab (§5.2: "el mismo tab de §5.1, después del click de P24").

func foldTabAct(port int, pageURL string) bool {
	allOK := true
	tabID, fi, raw, ready, why := openFoldTab(port, pageURL)
	if !paso("FOLD-24-0: tab de /fold-act abierto, documento fresco", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	refAdder, adderOK := refByName(fi, raw, "fold-agregar")
	refCampo01, campoOK := refByName(fi, raw, "fold-campo-01")
	mBase, okBase, rawBase := getFrameMap(port, map[string]any{"tabId": tabID})
	nBase := countElementsRaw(mBase)
	if !paso("FOLD-24-1: baseline getFrame + refs de fold-agregar/fold-campo-01",
		okBase && adderOK && campoOK,
		fmt.Sprintf(" (nBase=%d, refAdder=%v, refCampo01=%v; raw %.200s)", nBase, adderOK, campoOK, rawBase)) {
		return false
	}

	// barrera: siembra lastFrameByTab sobre el DOM actual (§5.1 paso 5).
	mBarrier, okBarrier, rawBarrier := getFrameMap(port, map[string]any{"tabId": tabID})
	if !paso("FOLD-24-2: barrera getFrame → changedSinceLast:false", okBarrier && !invChanged(mBarrier),
		fmt.Sprintf(" (raw %.200s)", rawBarrier)) {
		return false
	}

	// FOLD-24: la llamada del pliegue.
	start24 := time.Now()
	mAct, toolErr24, answered24, text24 := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refAdder, "action": "click", "frame": map[string]any{}}, 20*time.Second)
	elapsed24 := time.Since(start24)
	shapeOK24, shapeDet24 := foldShape(mAct, elapsed24, text24)
	ok24, _ := mAct["ok"].(bool)
	frame24 := foldFrameOf(mAct)
	nAfter24 := countElementsRaw(frame24)
	changed24, changedBool24 := invOf(frame24)["changedSinceLast"].(bool)
	elapsedOK24 := elapsed24 < 12*time.Second
	allOK = paso("FOLD-24a: act click con frame:{} → ok:true, Regla FE, nBase+3, fold-nuevo-1-3, changedSinceLast:true, elapsed<12s",
		answered24 && !toolErr24 && ok24 && shapeOK24 &&
			nAfter24 == nBase+3 && strings.Contains(text24, "fold-nuevo-1-3") &&
			changedBool24 && changed24 && elapsedOK24,
		fmt.Sprintf(" (ok=%v, nBase=%d nAfter=%d, changed bool=%v val=%v, elapsed<12s=%v)%s",
			ok24, nBase, nAfter24, changedBool24, changed24, elapsedOK24, shapeDet24)) && allOK

	mReread24, okReread24, rawReread24 := getFrameMap(port, map[string]any{"tabId": tabID})
	nReread24 := countElementsRaw(mReread24)
	changedReread24 := invChanged(mReread24)
	allOK = paso("FOLD-24b: getFrame plain posterior → mismo conteo (nBase+3), changedSinceLast:false",
		okReread24 && nReread24 == nBase+3 && !changedReread24,
		fmt.Sprintf(" (nReread=%d expected=%d, changed=%v; raw %.200s)",
			nReread24, nBase+3, changedReread24, rawReread24)) && allOK

	// FOLD-25: el acotamiento llega al serializer, sobre el mismo DOM (§5.2).
	start25a := time.Now()
	m25a, toolErr25a, answered25a, text25a := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refCampo01, "action": "focus", "frame": map[string]any{}}, 20*time.Second)
	elapsed25a := time.Since(start25a)
	shapeOK25a, shapeDet25a := foldShape(m25a, elapsed25a, text25a)
	n0 := countElementsRaw(foldFrameOf(m25a))
	allOK = paso("FOLD-25a: focus frame:{} → Regla FE, n0>=25 (línea base)",
		answered25a && !toolErr25a && shapeOK25a && n0 >= 25,
		fmt.Sprintf(" (n0=%d)%s", n0, shapeDet25a)) && allOK

	start25b := time.Now()
	m25b, toolErr25b, answered25b, text25b := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refCampo01, "action": "focus",
			"frame": map[string]any{"roles": []string{"textbox"}}}, 20*time.Second)
	elapsed25b := time.Since(start25b)
	shapeOK25b, shapeDet25b := foldShape(m25b, elapsed25b, text25b)
	frame25b := foldFrameOf(m25b)
	n1 := countElementsRaw(frame25b)
	names25b := elementNamesRaw(frame25b)
	excluded25b := hasExcludedNoise(names25b)
	allOK = paso("FOLD-25b: focus frame:{roles:[textbox]} → Regla FE, n1<n0, sin nombres de ruido (aísla roles de maxElementsPerPage)",
		answered25b && !toolErr25b && shapeOK25b && n1 < n0 && !excluded25b,
		fmt.Sprintf(" (n1=%d n0=%d, sin ruido=%v, names=%v)%s", n1, n0, !excluded25b, names25b, shapeDet25b)) && allOK

	start25c := time.Now()
	m25c, toolErr25c, answered25c, text25c := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refCampo01, "action": "focus",
			"frame": map[string]any{"roles": []string{"textbox"}, "namedOnly": true, "maxElementsPerPage": 5}}, 20*time.Second)
	elapsed25c := time.Since(start25c)
	shapeOK25c, shapeDet25c := foldShape(m25c, elapsed25c, text25c)
	frame25c := foldFrameOf(m25c)
	n2 := countElementsRaw(frame25c)
	names25c := elementNamesRaw(frame25c)
	allNamedCampo25c := allNamesHavePrefix(names25c, "fold-campo-")
	r1 := elementRefsRaw(frame25c)
	allOK = paso("FOLD-25c: focus frame:{roles,namedOnly,maxElementsPerPage:5} → Regla FE, 1<=n2<=5, n2<=n1, n2<n0, todos fold-campo-*, refs no vacíos",
		answered25c && !toolErr25c && shapeOK25c && n2 >= 1 && n2 <= 5 && n2 <= n1 && n2 < n0 &&
			allNamedCampo25c && len(r1) > 0,
		fmt.Sprintf(" (n2=%d n1=%d n0=%d, names=%v, refs=%d)%s", n2, n1, n0, names25c, len(r1), shapeDet25c)) && allOK

	start25d := time.Now()
	m25d, toolErr25d, answered25d, text25d := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refCampo01, "action": "focus",
			"frame": map[string]any{"roles": []string{"textbox"}, "namedOnly": true, "maxElementsPerPage": 5, "page": 2}}, 20*time.Second)
	elapsed25d := time.Since(start25d)
	shapeOK25d, shapeDet25d := foldShape(m25d, elapsed25d, text25d)
	frame25d := foldFrameOf(m25d)
	n3 := countElementsRaw(frame25d)
	names25d := elementNamesRaw(frame25d)
	allNamedCampo25d := allNamesHavePrefix(names25d, "fold-campo-")
	r2 := elementRefsRaw(frame25d)
	disjoint25d := refsDisjoint(r1, r2) && len(r1) > 0 && len(r2) > 0
	allOK = paso("FOLD-25d: page:2 → Regla FE, 1<=n3<=5, todos fold-campo-*, refs disjuntos de la página 1 (ambos no vacíos)",
		answered25d && !toolErr25d && shapeOK25d && n3 >= 1 && n3 <= 5 && allNamedCampo25d && disjoint25d,
		fmt.Sprintf(" (n3=%d, names=%v, |r1|=%d |r2|=%d disjoint=%v)%s",
			n3, names25d, len(r1), len(r2), disjoint25d, shapeDet25d)) && allOK

	mFin, okFin, rawFin := getFrameMap(port, map[string]any{"tabId": tabID})
	nFin := countElementsRaw(mFin)
	allOK = paso("FOLD-25e: getFrame plain de cierre → nFin == n0 (DOM no cambió: focus no muta)",
		okFin && nFin == n0,
		fmt.Sprintf(" (nFin=%d n0=%d; raw %.200s)", nFin, n0, rawFin)) && allOK

	if n1 == n2 {
		fmt.Println("  [NOTE] FOLD-25: n1 == n2 con el mismo cap — namedOnly no recortó nada más allá de roles; " +
			"si el serializer ya descarta de fábrica los elementos sin nombre accesible, la única cobertura viva de " +
			"namedOnly queda en el unit P8 (§5.2 del diseño, no es FAIL).")
	}
	printRoleKeyDiagnostic(frame25c)

	return allOK
}

// ---- 5.3: FOLD-26 (navigate con pliegue responde después del aterrizaje) ----

func foldTabNavigate(port int, pageURL string) bool {
	allOK := true
	tabID, _, _, ready, why := openFoldTab(port, pageURL)
	if !paso("FOLD-26-0: tab propio de /fold-act abierto, documento fresco", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	// siembra el marcador de origen (sin aserción, §5.3 paso 2).
	getFrameMap(port, map[string]any{"tabId": tabID})

	slowURL7 := strings.TrimSuffix(pageURL, "/") + "/slow?ms=2000&n=7"
	start26a := time.Now()
	m26a, toolErr26a, answered26a, text26a := toolMapTimeout(port, "vlp_navigate",
		map[string]any{"tabId": tabID, "url": slowURL7, "frame": map[string]any{}}, 25*time.Second)
	elapsed26a := time.Since(start26a)
	shapeOK26a, shapeDet26a := foldShape(m26a, elapsed26a, text26a)
	success26a, _ := m26a["success"].(bool)
	frame26a := foldFrameOf(m26a)
	hasDest26a := strings.Contains(text26a, "destino-lento-listo-7")
	hasOrigin26a := strings.Contains(text26a, "fold-fixture-listo")
	inv26a := invOf(frame26a)
	settled26a, settledBool26a := inv26a["settled"].(bool)
	_, hasNavigating26a := inv26a["navigating"]
	elapsedOK26a := elapsed26a >= 1800*time.Millisecond && elapsed26a < 12*time.Second
	allOK = paso("FOLD-26a: navigate con frame:{} a slow n=7 → success:true, Regla FE, destino-lento-listo-7, sin fold-fixture-listo, settled:true, sin navigating, 1800ms<=elapsed<12s",
		answered26a && !toolErr26a && success26a && shapeOK26a && hasDest26a && !hasOrigin26a &&
			settledBool26a && settled26a && !hasNavigating26a && elapsedOK26a,
		fmt.Sprintf(" (success=%v, destino=%v origen=%v, settled bool=%v val=%v, navigating presente=%v, elapsed ok=%v)%s",
			success26a, hasDest26a, hasOrigin26a, settledBool26a, settled26a, hasNavigating26a, elapsedOK26a, shapeDet26a)) && allOK

	slowURL8 := strings.TrimSuffix(pageURL, "/") + "/slow?ms=2000&n=8"
	start26b := time.Now()
	m26b, toolErr26b, answered26b, text26b := toolMapTimeout(port, "vlp_navigate",
		map[string]any{"tabId": tabID, "url": slowURL8}, 25*time.Second)
	elapsed26b := time.Since(start26b)
	exact26b := exactKeys(m26b, "success", "tabId", "url")
	elapsedOK26b := elapsed26b < 1500*time.Millisecond
	allOK = paso("FOLD-26b: navigate sin frame a slow n=8 → exactKeys(success,tabId,url), elapsed<1500ms (respondió al despacho, no al aterrizaje)",
		answered26b && !toolErr26b && exact26b && elapsedOK26b,
		fmt.Sprintf(" (%dms, exactKeys=%v; raw %.300s)", elapsed26b.Milliseconds(), exact26b, text26b)) && allOK

	// drenaje: no dejar una navegación en vuelo que contamine el cleanup.
	drained := waitFoldRawContains(port, tabID, "destino-lento-listo-8", 15*time.Second)
	paso("FOLD-26-drenaje: destino-lento-listo-8 observado antes de cerrar el tab", drained, "")

	return allOK
}

// ---- 5.3b: FOLD-27 (bloqueante review fb-020-008 §1: act click que navega
// de verdad, no una mutación in-place) ----
//
// Ningún caso anterior de esta batería ejercita esto: FOLD-24/25 (foldTabAct)
// clickean fold-agregar, que muta el DOM in-place; FOLD-26 (foldTabNavigate)
// ejercita `navigate`, que ya esperaba el commit antes del fix del review.
// Este es el caso central del bloqueante: un `act click` sobre un elemento
// que dispara una navegación de página completa. Antes del fix, la ruta de
// pliegue de `act` no esperaba `waitForNavCommit` y podía serializar el
// documento VIEJO (quieto ⇒ settled:true mentiroso). Mismas aserciones
// discriminantes que FOLD-26a: mapa del DESTINO, nada del ORIGEN, settled:true,
// sin navigating, y un techo de tiempo que delate una lectura prematura.
func foldTabActNavigate(port int, pageURL string) bool {
	tabID, fi, raw, ready, why := openFoldTab(port, pageURL)
	if !paso("FOLD-27-0: tab propio de /fold-act abierto, documento fresco", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	refNav, refOK := refByName(fi, raw, "fold-navega-lento")
	if !paso("FOLD-27-1: ref de fold-navega-lento resuelto", refOK, "") {
		return false
	}

	start27 := time.Now()
	m27, toolErr27, answered27, text27 := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refNav, "action": "click", "frame": map[string]any{}}, 25*time.Second)
	elapsed27 := time.Since(start27)
	shapeOK27, shapeDet27 := foldShape(m27, elapsed27, text27)
	ok27, _ := m27["ok"].(bool)
	frame27 := foldFrameOf(m27)
	hasDest27 := strings.Contains(text27, "destino-lento-listo-10")
	hasOrigin27 := strings.Contains(text27, "fold-fixture-listo")
	inv27 := invOf(frame27)
	settled27, settledBool27 := inv27["settled"].(bool)
	_, hasNavigating27 := inv27["navigating"]
	// Contra un destino de 2000ms, un elapsed < ~1800ms delata una lectura
	// prematura sobre el documento VIEJO (exactamente el modo de falla del
	// bloqueante: settled:true certificado sobre un documento ya muerto).
	elapsedOK27 := elapsed27 >= 1800*time.Millisecond && elapsed27 < 15*time.Second

	return paso("FOLD-27: act click que dispara una navegación de página completa (frame:{}) → ok:true, Regla FE, destino-lento-listo-10, sin fold-fixture-listo, settled:true, sin navigating, 1800ms<=elapsed<15s",
		answered27 && !toolErr27 && ok27 && shapeOK27 && hasDest27 && !hasOrigin27 &&
			settledBool27 && settled27 && !hasNavigating27 && elapsedOK27,
		fmt.Sprintf(" (ok=%v, destino=%v origen=%v, settled bool=%v val=%v, navigating presente=%v, elapsed ok=%v)%s",
			ok27, hasDest27, hasOrigin27, settledBool27, settled27, hasNavigating27, elapsedOK27, shapeDet27))
}

// ---- 5.4: FOLD-28 (clave desconocida end-to-end, nada despachado) ----

func foldTabReject(port int, pageURL string) bool {
	allOK := true
	tabID, fi, raw, ready, why := openFoldTab(port, pageURL)
	if !paso("FOLD-28-0: tab propio de /fold-act abierto, documento fresco", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	mPre, okPre, rawPre := getFrameMap(port, map[string]any{"tabId": tabID})
	nPre := countElementsRaw(mPre)
	refAdder, refOK := refByName(fi, raw, "fold-agregar")
	if !paso("FOLD-28-1: baseline getFrame + ref de fold-agregar", okPre && refOK,
		fmt.Sprintf(" (nPre=%d; raw %.200s)", nPre, rawPre)) {
		return false
	}

	textAct28, toolErrAct28, answeredAct28 := mcpCallEnvelope(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refAdder, "action": "click", "frame": map[string]any{"maxElements": 1}}, 15*time.Second)
	allOK = paso("FOLD-28a: act con frame:{maxElements:1} → error de tool que nombra maxElements",
		answeredAct28 && toolErrAct28 && strings.Contains(textAct28, "maxElements"),
		fmt.Sprintf(" (respondió=%v, error de tool=%v; raw %.300s)", answeredAct28, toolErrAct28, textAct28)) && allOK

	slowURL9 := strings.TrimSuffix(pageURL, "/") + "/slow?ms=2000&n=9"
	textNav28, toolErrNav28, answeredNav28 := mcpCallEnvelope(port, "vlp_navigate",
		map[string]any{"tabId": tabID, "url": slowURL9, "frame": map[string]any{"maxElements": 1}}, 15*time.Second)
	allOK = paso("FOLD-28b: navigate con frame:{maxElements:1} → error de tool que nombra maxElements (D-8/§9.5: el guard interior hay que construirlo en navigate)",
		answeredNav28 && toolErrNav28 && strings.Contains(textNav28, "maxElements"),
		fmt.Sprintf(" (respondió=%v, error de tool=%v; raw %.300s)", answeredNav28, toolErrNav28, textNav28)) && allOK

	textOmit28, toolErrOmit28, answeredOmit28 := mcpCallEnvelope(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refAdder, "action": "click", "frame": map[string]any{"omitIfUnchanged": true}}, 15*time.Second)
	allOK = paso("FOLD-28c (opcional, refuerza §9.1): act con frame:{omitIfUnchanged:true} → error de tool que nombra omitIfUnchanged",
		answeredOmit28 && toolErrOmit28 && strings.Contains(textOmit28, "omitIfUnchanged"),
		fmt.Sprintf(" (respondió=%v, error de tool=%v; raw %.300s)", answeredOmit28, toolErrOmit28, textOmit28)) && allOK

	// la espera es parte del diseño: un chequeo inmediato pasaría igual con un
	// comando despachado y en vuelo.
	time.Sleep(1500 * time.Millisecond)

	textTabs28, okTabs28 := mcpCall(port, "vlp_listTabs", map[string]any{})
	var tabs28 []tabInfo
	urlOK28 := false
	expectedURL28 := strings.TrimSuffix(pageURL, "/") + "/fold-act"
	if okTabs28 && parseJSON(textTabs28, &tabs28) {
		for _, t := range tabs28 {
			if t.ID == tabID {
				urlOK28 = t.URL == expectedURL28
				break
			}
		}
	}
	mPost28, okPost28, rawPost28 := getFrameMap(port, map[string]any{"tabId": tabID})
	nPost28 := countElementsRaw(mPost28)
	noDest28 := !strings.Contains(rawPost28, "destino-lento-listo-9")
	noNuevo28 := !strings.Contains(rawPost28, "fold-nuevo-")
	allOK = paso("FOLD-28d: 1500ms después, la URL sigue en /fold-act, sin destino ni fold-nuevo-* (nada despachado), nPost==nPre",
		urlOK28 && okPost28 && noDest28 && noNuevo28 && nPost28 == nPre,
		fmt.Sprintf(" (url ok=%v, sin destino=%v, sin nuevo=%v, nPost=%d nPre=%d; raw %.300s)",
			urlOK28, noDest28, noNuevo28, nPost28, nPre, rawPost28)) && allOK

	return allOK
}

// ---- 5.5: FOLD-23 (diálogo nativo en vivo) ----

func foldTabDialog(port int, pageURL string) bool {
	tabID, fi, raw, ready, why := openNativeDialogTab(port, pageURL, "confirm-sync")
	if !paso("FOLD-23-0: tab de confirm-sync abierto, documento fresco", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer func() {
		navigateNativeDialogStep(port, tabID, pageURL, "sin-dialogo")
		mcpCallEnvelope(port, "vlp_closeTab", map[string]any{"tabId": tabID}, 3*time.Second)
	}()

	refTrigger, refOK := refByName(fi, raw, "Disparar")
	if !paso("FOLD-23-1: ref de Disparar resuelto", refOK, "") {
		return false
	}

	start23 := time.Now()
	m23, toolErr23, answered23, text23 := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTrigger, "action": "click", "frame": map[string]any{}}, 10*time.Second)
	elapsed23 := time.Since(start23)

	ok23, _ := m23["ok"].(bool)
	nd23 := nativeDialogOf(m23)
	ndMatch23 := nativeDialogMatches(nd23, "confirm", "¿Borrar el registro?")
	shapeOK23, shapeDet23 := foldShape(m23, elapsed23, text23)
	frame23 := foldFrameOf(m23)
	inv23 := invOf(frame23)
	settled23, settledBool23 := inv23["settled"].(bool)
	ndFrame23 := nativeDialogOf(frame23)
	ndEqual23 := nativeDialogEquals(ndFrame23, nd23)
	elapsedOK23 := elapsed23 < 3*time.Second

	return paso("FOLD-23a: act click que abre confirm-sync con frame:{} → ok:true, nativeDialog nivel superior, Regla FE, settled:false, frame.nativeDialog==nivel superior, elapsed<3s",
		answered23 && !toolErr23 && ok23 && ndMatch23 && shapeOK23 &&
			settledBool23 && !settled23 && ndEqual23 && elapsedOK23,
		fmt.Sprintf(" (ok=%v, nativeDialog match=%v, settled bool=%v val=%v, nativeDialog anidado igual=%v, %dms<3000=%v)%s",
			ok23, ndMatch23, settledBool23, settled23, ndEqual23, elapsed23.Milliseconds(), elapsedOK23, shapeDet23))
}

// ---- 4: estructura de la corrida ----

// runActFrameFoldE2E corre los cinco bloques del diseño (§4). Cada bloque
// abre su tab propio y lo cierra/libera en defer; ninguno toca el tab
// compartido de runFrameE2E/runSettleE2E. Corre aunque un bloque previo haya
// fallado (más evidencia, nunca enmascara).
func runActFrameFoldE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-fold] Pliegue del mapa en act/navigate (fb-020-008) — P23-live, P24, P25, P26, P28")
	if !paso("FOLD-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	okArt := foldPreArtifact(port, pageURL)       // §5.0
	okA := foldTabAct(port, pageURL)              // §5.1 P24, §5.2 P25
	okRej := foldTabReject(port, pageURL)         // §5.4 P28
	okNav := foldTabNavigate(port, pageURL)       // §5.3 P26
	okActNav := foldTabActNavigate(port, pageURL) // §5.3b FOLD-27 (bloqueante review §1)
	okDlg := foldTabDialog(port, pageURL)         // §5.5 P23-live
	return okArt && okA && okRej && okNav && okActNav && okDlg
}
