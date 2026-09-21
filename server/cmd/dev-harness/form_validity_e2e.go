// fb-020-005 — Validez de formulario en el mapa, perfil REAL de Odoo: P15,
// P16, P21 (docs/specs/fb-020-005-odoo-form-validity/harness-design.md).
//
// Los 17 unit tests de esta feature usan un perfil de prueba inventado
// (selectores genéricos): correcto para probar que el mecanismo es una
// convención inyectada como dato, pero deja sin ejercitar el perfil REAL de
// Odoo. Un perfil que no detecta produce la misma salida que un formulario
// válido: silencio. Por eso la fixture usa los literales reales
// (`.o_web_client`, `.o_field_invalid, .o_invalid_cell`, atributo `name`,
// id de perfil `"odoo"`) y por eso la primera aserción de todos los bloques
// es `invalidProfile == "odoo"`.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---- §3.1/3.2: fixture /form-validez?estado=enabled|disabled ----

// validityPageHTML: template sin rellenar (VAL-fix se ejecuta sobre ESTA
// constante: ningún reemplazo introduce "aria-invalid", así que el chequeo
// estático vale para los dos estados sin necesidad de renderizarlos).
const validityPageHTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>fb-020-005 fixture</title></head>
<body>
<div class="o_web_client">
  <button id="val-marker" type="button">%MARKER%</button>
  <form id="val-form">

    <!-- (1) campo simple: marcador con ` + "`name`" + ` propio -->
    <div id="w-alfa" name="campo-alfa"%C_ALFA%>
      <label for="in-alfa">Alfa</label><input id="in-alfa">
    </div>

    <!-- (2) segundo campo simple -->
    <div id="w-beta" name="campo-beta"%C_BETA%>
      <label for="in-beta">Beta</label><input id="in-beta">
    </div>

    <!-- (3) marcador OCULTO, pre-horneado en los dos estados: aporta CERO -->
    <div id="w-oculto" name="campo-oculto" class="o_field_invalid" style="display:none">
      <label for="in-oculto">Oculto</label><input id="in-oculto">
    </div>

    <!-- (4) lista editable: las DOS formas de celda que pide P16 -->
    <table id="val-lista">
      <thead><tr><th>Linea</th><th>Cantidad</th></tr></thead>
      <tbody>
        <!-- 4a. celda inválida CON input (fila en edición) -->
        <tr>
          <td>Linea uno</td>
          <td id="cel-cant" name="campo-cantidad"%C_CANT%>
            <div id="w-cant"%C_WCANT%><input id="in-cant" aria-label="Cantidad"></div>
          </td>
        </tr>
        <!-- 4b. celda inválida VACÍA (fila fuera de edición) -->
        <tr>
          <td>Linea dos</td>
          <td id="cel-precio" name="campo-precio"%C_PRECIO%></td>
        </tr>
      </tbody>
    </table>

    <button id="val-guardar" type="button"%DISABLED%>Guardar</button>
  </form>
</div>
<script>%SCRIPT%</script>
</body></html>`

// validityFixtureScript: inline, síncrono, sin timers (§3.3 del diseño). Sin
// revalidación: escribir en un campo no le saca la clase.
const validityFixtureScript = `(function () {
  document.getElementById('val-guardar').addEventListener('click', function () {
    document.getElementById('w-alfa').classList.add('o_field_invalid');
    document.getElementById('w-beta').classList.add('o_field_invalid');
    document.getElementById('w-cant').classList.add('o_field_invalid');
    document.getElementById('cel-cant').classList.add('o_invalid_cell');
    document.getElementById('cel-precio').classList.add('o_invalid_cell');
  });
  document.getElementById('val-lista').addEventListener('click', function (e) {
    var td = e.target && e.target.closest ? e.target.closest('td') : null;
    if (td && td.id === 'cel-precio' && td.textContent === '') {
      td.textContent = 'celda-abierta-ok';
    }
  });
})();`

// formValidezHTML: rellena el template para un estado dado (§3.2, tabla de
// placeholders). "disabled" trae las marcas pre-horneadas porque un botón
// deshabilitado no se puede clickear para que las pinte.
func formValidezHTML(estado string) string {
	marker := "validez-fixture-listo-" + estado
	classInvalidField, classInvalidCell, disabledAttr := "", "", ""
	if estado == "disabled" {
		classInvalidField = ` class="o_field_invalid"`
		classInvalidCell = ` class="o_invalid_cell"`
		disabledAttr = " disabled"
	}
	r := strings.NewReplacer(
		"%MARKER%", marker,
		"%C_ALFA%", classInvalidField,
		"%C_BETA%", classInvalidField,
		"%C_WCANT%", classInvalidField,
		"%C_CANT%", classInvalidCell,
		"%C_PRECIO%", classInvalidCell,
		"%DISABLED%", disabledAttr,
		"%SCRIPT%", validityFixtureScript,
	)
	return r.Replace(validityPageHTML)
}

// registerValidityRoutes: /form-validez?estado=enabled|disabled. Sin CSP
// (patrón testPageHTML), no pollea /mutate-cmd (§3.1: un segundo poller le
// robaría los comandos one-shot a la página principal).
func registerValidityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/form-validez", func(w http.ResponseWriter, r *http.Request) {
		estado := r.URL.Query().Get("estado")
		if estado != "enabled" && estado != "disabled" {
			http.Error(w, "estado invalido", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, formValidezHTML(estado))
	})
}

// ---- §2.1: libro de llamadas ----

// callLedger: el harness ES el cliente MCP, así que el conteo es exacto por
// construcción. Dentro de un segmento medido todas las llamadas pasan por
// call() — no negociable (§2.1 del diseño).
type callLedger struct {
	port   int
	counts map[string]int
	order  []string
}

func newCallLedger(port int) *callLedger {
	return &callLedger{port: port, counts: map[string]int{}}
}

func (l *callLedger) call(tool string, args map[string]any, to time.Duration) (map[string]any, bool, string) {
	m, toolErr, answered, text := toolMapTimeout(l.port, tool, args, to)
	ok := answered && !toolErr
	l.counts[tool]++
	l.order = append(l.order, tool)
	return m, ok, text
}

func (l *callLedger) reset() {
	l.counts = map[string]int{}
	l.order = nil
}

func (l *callLedger) total() int {
	n := 0
	for _, c := range l.counts {
		n += c
	}
	return n
}

func (l *callLedger) String() string {
	return fmt.Sprintf("act=%d getFrame=%d getDOM=%d order=%v",
		l.counts["vlp_act"], l.counts["vlp_getFrame"], l.counts["vlp_getDOM"], l.order)
}

// ---- §1.1: helpers nuevos ----

// invalidEntriesOf: entradas de m["invalidElements"] como []map[string]any.
// m puede ser el frame plegado (nested bajo "frame" en un act) o la
// respuesta plana de getFrame — en ambos casos invalidElements es una clave
// de nivel superior del mapa que se pasa.
func invalidEntriesOf(m map[string]any) []map[string]any {
	list, _ := m["invalidElements"].([]any)
	var out []map[string]any
	for _, e := range list {
		if em, ok := e.(map[string]any); ok {
			out = append(out, em)
		}
	}
	return out
}

// entryByField: la entrada cuyo campo `field` matchea exactamente.
func entryByField(entries []map[string]any, field string) (map[string]any, bool) {
	for _, e := range entries {
		if f, _ := e["field"].(string); f == field {
			return e, true
		}
	}
	return nil, false
}

// invalidElementsJSON: JSON canónico (json.Marshal ordena las claves de mapa
// determinísticamente) de la lista invalidElements — orden de LISTA incluido
// (se preserva del array JSON original). Usado por VAL-15b/c para comparar
// "idénticos" entre foldA/gA y foldB/gB (P15).
func invalidElementsJSON(m map[string]any) (string, bool) {
	list, ok := m["invalidElements"].([]any)
	if !ok {
		return "", false
	}
	b, err := json.Marshal(list)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// invalidElementsRawSpan: el substring `[...]` de "invalidElements" dentro
// del raw JSON completo — acota la búsqueda de entryKeyOrder para no
// confundir la entrada del resumen con el elemento homónimo de `sections`
// (ambos comparten el mismo `ref`, I-7).
func invalidElementsRawSpan(raw string) (string, bool) {
	key := `"invalidElements":`
	idx := strings.Index(raw, key)
	if idx < 0 {
		return "", false
	}
	start := idx + len(key)
	for start < len(raw) && raw[start] != '[' {
		start++
	}
	if start >= len(raw) {
		return "", false
	}
	depth := 0
	for i := start; i < len(raw); i++ {
		switch raw[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return raw[start : i+1], true
			}
		}
	}
	return "", false
}

// jsonObjectSpanAround: [start,end] (inclusive) del objeto JSON balanceado
// que contiene la posición pos dentro de s.
func jsonObjectSpanAround(s string, pos int) (int, int, bool) {
	depth := 0
	start := -1
	for i := pos; i >= 0; i-- {
		switch s[i] {
		case '}':
			depth++
		case '{':
			if depth == 0 {
				start = i
			} else {
				depth--
			}
		}
		if start >= 0 {
			break
		}
	}
	if start < 0 {
		return 0, 0, false
	}
	depth = 0
	for i := start; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return start, i, true
			}
		}
	}
	return 0, 0, false
}

var entryKeyRe = regexp.MustCompile(`"(\w+)"\s*:`)

// entryKeyOrder: orden de claves TAL COMO APARECEN en el raw JSON para la
// entrada de invalidElements con este ref — sobre el raw, no el mapa (Go
// pierde el orden en map[string]any). Acotado a la sección invalidElements
// (invalidElementsRawSpan) para no leer el ref homónimo de `sections`.
func entryKeyOrder(raw string, ref string) []string {
	span, ok := invalidElementsRawSpan(raw)
	if !ok {
		return nil
	}
	marker := fmt.Sprintf("%q:%q", "ref", ref)
	idx := strings.Index(span, marker)
	if idx < 0 {
		return nil
	}
	start, end, ok := jsonObjectSpanAround(span, idx)
	if !ok {
		return nil
	}
	obj := span[start : end+1]
	matches := entryKeyRe.FindAllStringSubmatch(obj, -1)
	var keys []string
	for _, m := range matches {
		keys = append(keys, m[1])
	}
	return keys
}

// fb-020-005 §12.2 (ruling post-E2E) — antes había acá `entryKeyOrderOK` +
// `isSubsequenceOf` + `canonicalEntryKeyOrder`, que convertían `entryKeyOrder`
// en una aserción PASS/FAIL contra [ref,name,context,field,notInMap]. Se
// retiraron: medían una propiedad que ninguna implementación de la extensión
// puede satisfacer del otro lado del relay Go (ver el diagnóstico de
// VAL-16b-orden más abajo, y la nota junto a `entryKeyOrder`). `entryKeyOrder`
// se conserva porque el diagnóstico todavía la usa para mostrar el orden
// observado.

// findElementByRef: el elemento de sections[*].elements[*] cuyo ref matchea.
func findElementByRef(m map[string]any, ref string) (map[string]any, bool) {
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		for _, e := range elems {
			el, _ := e.(map[string]any)
			if r, _ := el["ref"].(string); r == ref {
				return el, true
			}
		}
	}
	return nil, false
}

// fieldSet: el conjunto (ordenado) de `field` de las entradas.
func fieldSet(entries []map[string]any) []string {
	var out []string
	for _, e := range entries {
		if f, ok := e["field"].(string); ok {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

func stringSliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func setEqual(a, b []string) bool {
	aa := append([]string(nil), a...)
	bb := append([]string(nil), b...)
	sort.Strings(aa)
	sort.Strings(bb)
	return stringSliceEqual(aa, bb)
}

func countNotInMap(entries []map[string]any) int {
	n := 0
	for _, e := range entries {
		if b, ok := e["notInMap"].(bool); ok && b {
			n++
		}
	}
	return n
}

func hasFieldValue(entries []map[string]any, field string) bool {
	_, ok := entryByField(entries, field)
	return ok
}

// keysOf: claves de m, ordenadas (para comparar conjuntos sin depender del
// orden de iteración de Go sobre mapas).
func keysOf(m map[string]any) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// expectedInvalidFields: el conjunto de `field` que produce la fixture con
// las cuatro marcas horneadas/dinámicas (§3.4 del diseño). N = 4, no se
// renegocia (cada forma de la fixture es una forma que la suite unit ya
// mide verde contra este mismo build).
var expectedInvalidFields = []string{"campo-alfa", "campo-beta", "campo-cantidad", "campo-precio"}

// waitValidityFixtureReady: polea getFrame hasta que el raw contenga el
// marker de documento fresco (mismo patrón que waitFoldFixtureReady).
func waitValidityFixtureReady(port, tabID int, marker string, timeout time.Duration) (frameInfo, bool, string) {
	deadline := time.Now().Add(timeout)
	var fi frameInfo
	var raw string
	for time.Now().Before(deadline) {
		var ok bool
		fi, ok, raw = getFrameRaw(port, tabID)
		if ok && strings.Contains(raw, marker) {
			return fi, true, raw
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fi, false, raw
}

// openValidityTab: build mode + openTab + findTabByURL + documento fresco
// por marker (patrón openFoldTab/loadTypeObserveStep).
func openValidityTab(port int, pageURL, estado string) (tabID int, fi frameInfo, raw string, ok bool, detail string) {
	if !ensureBuildMode(port) {
		return 0, fi, "", false, "build mode no disponible"
	}
	target := strings.TrimSuffix(pageURL, "/") + "/form-validez?estado=" + estado
	if _, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": target}); !openOK {
		return 0, fi, "", false, "openTab falló"
	}
	var tabOK bool
	tabID, tabOK = findTabByURL(port, target, 15*time.Second)
	if !tabOK {
		return tabID, fi, "", false, "tab no detectado"
	}
	marker := "validez-fixture-listo-" + estado
	fi, fresh, raw := waitValidityFixtureReady(port, tabID, marker, 15*time.Second)
	if !fresh {
		return tabID, fi, raw, false, "documento fresco no observado"
	}
	return tabID, fi, raw, true, ""
}

// ---- §5.4: VAL-21* (P21, con VAL-detecta §5.1 como primer paso) ----

func valTabDisabled(port int, pageURL string) bool {
	allOK := true
	tabID, fi, raw, ready, why := openValidityTab(port, pageURL, "disabled")
	if !paso("VAL-21-0: tab propio de /form-validez?estado=disabled abierto, documento fresco", ready,
		fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	// VAL-detecta (§5.1): getFrameMap plano — la guarda que distingue "no
	// detecta" de "todo bien". Corre primero a propósito: la fixture disabled
	// trae las marcas pre-horneadas.
	mDetect, okDetect, rawDetect := getFrameMap(port, map[string]any{"tabId": tabID})
	profileDetect, hasProfileDetect := mDetect["invalidProfile"].(string)
	countDetect, hasCountDetect := isNonNegInt(mDetect, "invalidCount")
	entriesDetect := invalidEntriesOf(mDetect)
	guardHint := ""
	if okDetect && !hasProfileDetect {
		if hasCountDetect {
			guardHint = "invalidCount presente sin invalidProfile: la invalidez salió del camino estándar — defecto del núcleo. "
		} else {
			guardHint = "o el artefacto no trae fb-020-005, o el perfil de Odoo no detecta sobre su firma de raíz — " +
				"reconstruir/reinstalar la XPI y revisar detect() antes de leer el resto del bloque. "
		}
	} else if okDetect && hasProfileDetect && profileDetect != "odoo" {
		guardHint = fmt.Sprintf("invalidProfile=%q no es \"odoo\": el id del perfil es contrato (spec §11.3). ", profileDetect)
	}
	allOK = paso("VAL-detecta: invalidProfile==\"odoo\", invalidCount==4, len(invalidElements)==4",
		okDetect && hasProfileDetect && profileDetect == "odoo" && hasCountDetect && countDetect == 4 && len(entriesDetect) == 4,
		fmt.Sprintf(" %s(profile=%q presente=%v, count=%d presente=%v, entries=%d; raw %.400s)",
			guardHint, profileDetect, hasProfileDetect, countDetect, hasCountDetect, len(entriesDetect), rawDetect)) && allOK

	refGuardar, refOK := refByName(fi, raw, "Guardar")
	if !paso("VAL-21-1: ref de Guardar resuelto", refOK, "") {
		return false
	}

	mConFrame, toolErrCF, answeredCF, textCF := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refGuardar, "action": "click", "frame": map[string]any{}}, 20*time.Second)
	okCF, _ := mConFrame["ok"].(bool)
	disabledCF, _ := mConFrame["disabled"].(bool)
	_, hasFrameCF := mConFrame["frame"]
	_, hasFrameErrCF := mConFrame["frameError"]
	allOK = paso("VAL-21a: act click con frame:{} sobre Guardar deshabilitado → ok:false, disabled:true, frame y frameError AUSENTES",
		answeredCF && !toolErrCF && !okCF && disabledCF && !hasFrameCF && !hasFrameErrCF,
		fmt.Sprintf(" (ok=%v, disabled=%v, frame presente=%v, frameError presente=%v; raw %.300s)",
			okCF, disabledCF, hasFrameCF, hasFrameErrCF, textCF)) && allOK

	mSinFrame, toolErrSF, answeredSF, textSF := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refGuardar, "action": "click"}, 20*time.Second)
	okSF, _ := mSinFrame["ok"].(bool)
	disabledSF, _ := mSinFrame["disabled"].(bool)
	keysCF := keysOf(mConFrame)
	keysSF := keysOf(mSinFrame)
	sameKeys := stringSliceEqual(keysCF, keysSF)
	allOK = paso("VAL-21b: exactKeys(mConFrame)==exactKeys(mSinFrame) (comparación interna, sin golden histórico — §9.4 del diseño), ok/disabled iguales",
		answeredSF && !toolErrSF && sameKeys && okCF == okSF && disabledCF == disabledSF,
		fmt.Sprintf(" (claves con frame=%v, claves sin frame=%v, ok con=%v sin=%v, disabled con=%v sin=%v; raw sin frame %.300s)",
			keysCF, keysSF, okCF, okSF, disabledCF, disabledSF, textSF)) && allOK
	fmt.Printf("  [NOTE] VAL-21b: conjunto de claves observado en el sobre ok:false = %v\n", keysCF)
	// §7.2/§10.3 del diseño: el conjunto observado se promueve a exactKeys
	// literal en el mismo commit (no hay golden histórico — comparación
	// interna + esta captura son la única cobertura, §9.4). Observado en
	// corrida real: {disabled, error, ok} (VAL-21a ya verifica que "error"
	// no está vacío; acá sólo se promueve el CONJUNTO de claves).
	allOK = paso("VAL-21b-exact: exactKeys(mConFrame, \"disabled\", \"error\", \"ok\") — claves promovidas de la observación de esta corrida",
		exactKeys(mConFrame, "disabled", "error", "ok"),
		fmt.Sprintf(" (claves observadas=%v)", keysCF)) && allOK

	ledger21 := newCallLedger(port)
	g21, ok21, text21 := ledger21.call("vlp_getFrame", map[string]any{"tabId": tabID}, 15*time.Second)
	profile21, hasProfile21 := g21["invalidProfile"].(string)
	count21, hasCount21 := isNonNegInt(g21, "invalidCount")
	entries21 := invalidEntriesOf(g21)
	fields21 := fieldSet(entries21)
	notInMap21 := countNotInMap(entries21)
	allOK = paso("VAL-21c: g21 invalidProfile==\"odoo\", invalidCount==4, 4 entradas, mismo conjunto de field que VAL-16b, una sola notInMap",
		ok21 && hasProfile21 && profile21 == "odoo" && hasCount21 && count21 == 4 && len(entries21) == 4 &&
			setEqual(fields21, expectedInvalidFields) && notInMap21 == 1,
		fmt.Sprintf(" (profile=%q count=%d entries=%d fields=%v notInMap=%d; raw %.400s)",
			profile21, count21, len(entries21), fields21, notInMap21, text21)) && allOK
	allOK = paso("VAL-21c-libro: flujo-P21 getFrame==1, getDOM==0 (§3.6.1: una llamada, no N)",
		ledger21.counts["vlp_getFrame"] == 1 && ledger21.counts["vlp_getDOM"] == 0,
		fmt.Sprintf(" (%s)", ledger21.String())) && allOK

	return allOK
}

// ---- §5.2: VAL-16* (P16) ----

func valTabDinamico(port int, pageURL string) bool {
	allOK := true
	tabID, fi, raw, ready, why := openValidityTab(port, pageURL, "enabled")
	if !paso("VAL-16-0: tab propio de /form-validez?estado=enabled abierto, documento fresco", ready,
		fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	// Punto A (§5.2): getFrameMap plano, ANTES del click.
	mA, okA, rawA := getFrameMap(port, map[string]any{"tabId": tabID})
	_, hasElemsA := mA["invalidElements"]
	_, hasCountA := mA["invalidCount"]
	_, hasProfileA := mA["invalidProfile"]
	hasNoKeysA := !hasElemsA && !hasCountA && !hasProfileA
	hasElA := hasElements(mA)
	containsAll := strings.Contains(rawA, "Alfa") && strings.Contains(rawA, "Beta") &&
		strings.Contains(rawA, "Cantidad") && strings.Contains(rawA, "Guardar")
	allOK = paso("VAL-16a: punto A — invalidElements/invalidCount/invalidProfile AUSENTES antes del click, hasElements, contiene Alfa/Beta/Cantidad/Guardar (P11 en vivo: el marcador oculto ya está en el DOM y no produce clave)",
		okA && hasNoKeysA && hasElA && containsAll,
		fmt.Sprintf(" (elems presente=%v count presente=%v profile presente=%v, hasElements=%v, contiene todo=%v; raw %.400s)",
			hasElemsA, hasCountA, hasProfileA, hasElA, containsAll, rawA)) && allOK

	refGuardar, refOK := refByName(fi, raw, "Guardar")
	if !paso("VAL-16-1: ref de Guardar resuelto", refOK, "") {
		return false
	}

	// Segmento flujo-P16: una sola llamada, techo 20 s, midiendo elapsed.
	ledger16 := newCallLedger(port)
	ledger16.reset()
	startB := time.Now()
	mB, okB, textB := ledger16.call("vlp_act",
		map[string]any{"tabId": tabID, "ref": refGuardar, "action": "click", "frame": map[string]any{}}, 20*time.Second)
	elapsedB := time.Since(startB)

	shapeOKB, shapeDetB := foldShape(mB, elapsedB, textB)
	okBoolB, _ := mB["ok"].(bool)
	frameB := foldFrameOf(mB)
	profileB, hasProfileB := frameB["invalidProfile"].(string)
	countB, hasCountB := isNonNegInt(frameB, "invalidCount")
	entriesB := invalidEntriesOf(frameB)
	fieldsB := fieldSet(entriesB)
	notInMapB := countNotInMap(entriesB)
	entryPrecio, hasPrecio := entryByField(entriesB, "campo-precio")
	entryAlfa, hasAlfa := entryByField(entriesB, "campo-alfa")
	entryBeta, hasBeta := entryByField(entriesB, "campo-beta")
	entryCant, hasCant := entryByField(entriesB, "campo-cantidad")
	refsInSectionsB := elementRefsRaw(frameB)

	var precioIsNotInMap bool
	if hasPrecio {
		precioIsNotInMap, _ = entryPrecio["notInMap"].(bool)
	}
	othersNoNotInMapKey := true
	for _, e := range entriesB {
		f, _ := e["field"].(string)
		if f == "campo-precio" {
			continue
		}
		if _, has := e["notInMap"]; has {
			othersNoNotInMapKey = false
		}
	}
	refsAndNameKeyOK := len(entriesB) > 0
	for _, e := range entriesB {
		r, rOK := e["ref"].(string)
		_, nameHas := e["name"]
		if !rOK || r == "" || !nameHas {
			refsAndNameKeyOK = false
		}
	}
	nameOf := func(e map[string]any) string {
		n, _ := e["name"].(string)
		return n
	}
	refOf := func(e map[string]any) string {
		r, _ := e["ref"].(string)
		return r
	}
	namesOK := hasAlfa && nameOf(entryAlfa) == "Alfa" &&
		hasBeta && nameOf(entryBeta) == "Beta" &&
		hasCant && nameOf(entryCant) == "Cantidad"
	portadorRefsInSections := hasAlfa && hasBeta && hasCant &&
		refsInSectionsB[refOf(entryAlfa)] && refsInSectionsB[refOf(entryBeta)] && refsInSectionsB[refOf(entryCant)]
	precioRefNotInSections := hasPrecio && !refsInSectionsB[refOf(entryPrecio)]
	elapsedOKB := elapsedB < 12*time.Second

	allOK = paso("VAL-16b: ok:true, Regla FE, invalidProfile==\"odoo\", invalidCount==4, len(invalidElements)==4, fields exactos, ninguna campo-oculto, exactamente una notInMap==campo-precio, refs/name presentes, names correctos, refs de portador ⊆ sections y el de campo-precio ∉ sections, elapsed<12s",
		okB && okBoolB && shapeOKB &&
			hasProfileB && profileB == "odoo" &&
			hasCountB && countB == 4 && len(entriesB) == 4 &&
			setEqual(fieldsB, expectedInvalidFields) &&
			!hasFieldValue(entriesB, "campo-oculto") &&
			notInMapB == 1 && hasPrecio && precioIsNotInMap && othersNoNotInMapKey &&
			refsAndNameKeyOK && namesOK && portadorRefsInSections && precioRefNotInSections &&
			elapsedOKB,
		fmt.Sprintf(" (profile=%q count=%d entries=%d fields=%v notInMap=%d precio.notInMap=%v, %dms<12000=%v)%s",
			profileB, countB, len(entriesB), fieldsB, notInMapB, precioIsNotInMap,
			elapsedB.Milliseconds(), elapsedOKB, shapeDetB)) && allOK

	// fb-020-005 §12.2 (ruling post-E2E) — el orden canónico de claves
	// (ref, name, context, field, notInMap) es contrato DE LA EXTENSIÓN, no
	// del cable: `makeInvalidEntry` construye la entrada en ese orden y el
	// unit P5 lo verifica en verde sobre `Object.keys`. Lo que se mide acá es
	// el raw JSON DESPUÉS del relay Go, que transporta la respuesta como
	// `map[string]any`; `json.Marshal` de un map en Go ordena las claves
	// ALFABÉTICAMENTE por diseño del lenguaje, así que ninguna implementación
	// de la extensión puede satisfacer una aserción de orden medida del otro
	// lado del relay. Por eso NO es un `paso()` (no decide PASS/FAIL): queda
	// como diagnóstico impreso para que el orden observado sea visible sin que
	// nadie reponga la aserción en seis meses creyendo que falta cobertura
	// (D-8: el orden de claves en el cable es alfabético para todo el
	// producto, no el declarado en las specs).
	for _, e := range entriesB {
		ref, _ := e["ref"].(string)
		fmt.Printf("  [INFO] VAL-16b-orden (diagnóstico, §12.2, no decide PASS/FAIL): ref=%q claves-observadas=%v\n",
			ref, entryKeyOrder(textB, ref))
	}

	allOK = paso("VAL-16b-libro: flujo-P16 act==1, getFrame==0, getDOM==0, total==1 (AC-1: piso mecánico)",
		ledger16.counts["vlp_act"] == 1 && ledger16.counts["vlp_getFrame"] == 0 &&
			ledger16.counts["vlp_getDOM"] == 0 && ledger16.total() == 1,
		fmt.Sprintf(" (%s)", ledger16.String())) && allOK

	// VAL-16c: act type sobre la entrada con input (campo-alfa), fuera del
	// segmento — misma forma de llamada que los pasos TYP-* vigentes
	// (parámetro de texto: `value`).
	if hasAlfa {
		startC := time.Now()
		mC, toolErrC, answeredC, textC := toolMapTimeout(port, "vlp_act",
			map[string]any{"tabId": tabID, "ref": refOf(entryAlfa), "action": "type", "value": "valor-alfa", "frame": map[string]any{}}, 20*time.Second)
		elapsedC := time.Since(startC)
		shapeOKC, shapeDetC := foldShape(mC, elapsedC, textC)
		okC, _ := mC["ok"].(bool)
		frameC := foldFrameOf(mC)
		elemAlfaC, foundAlfaC := findElementByRef(frameC, refOf(entryAlfa))
		valueAlfaC, _ := elemAlfaC["value"].(string)
		countC, hasCountC := isNonNegInt(frameC, "invalidCount")
		allOK = paso("VAL-16c: act type sobre campo-alfa → ok:true, Regla FE, elemento con ref==entrada de campo-alfa y value==\"valor-alfa\", invalidCount sigue en 4 (sin revalidación)",
			answeredC && !toolErrC && okC && shapeOKC && foundAlfaC && valueAlfaC == "valor-alfa" &&
				hasCountC && countC == 4,
			fmt.Sprintf(" (ok=%v, elemento encontrado=%v value=%q, invalidCount=%d)%s",
				okC, foundAlfaC, valueAlfaC, countC, shapeDetC)) && allOK
	} else {
		allOK = paso("VAL-16c: act type sobre campo-alfa", false, " (entrada de campo-alfa no encontrada en VAL-16b)") && allOK
	}

	// VAL-16d: act click sobre el ref notInMap (campo-precio), fuera del
	// segmento. Deliberadamente NO se assertan invalidCount/notInMap acá: el
	// click cambia legítimamente la promovibilidad de la celda.
	if hasPrecio {
		startD := time.Now()
		mD, toolErrD, answeredD, textD := toolMapTimeout(port, "vlp_act",
			map[string]any{"tabId": tabID, "ref": refOf(entryPrecio), "action": "click", "frame": map[string]any{}}, 20*time.Second)
		elapsedD := time.Since(startD)
		shapeOKD, shapeDetD := foldShape(mD, elapsedD, textD)
		okD, _ := mD["ok"].(bool)
		hasAbierta := strings.Contains(textD, "celda-abierta-ok")
		allOK = paso("VAL-16d: act click sobre el ref notInMap (campo-precio) → ok:true, Regla FE, frame plegado contiene celda-abierta-ok (I-7: el ref del <td> resuelve al nodo exacto y es accionable)",
			answeredD && !toolErrD && okD && shapeOKD && hasAbierta,
			fmt.Sprintf(" (ok=%v, contiene celda-abierta-ok=%v)%s", okD, hasAbierta, shapeDetD)) && allOK
	} else {
		allOK = paso("VAL-16d: act click sobre el ref notInMap", false, " (entrada notInMap de campo-precio no encontrada en VAL-16b)") && allOK
	}

	return allOK
}

// ---- §5.3: VAL-15* (P15) ----

func valTabPliegue(port int, pageURL string) bool {
	allOK := true
	// Tab propio NUEVO (no se reusa el de VAL-16: quedó tipeado y con la
	// celda abierta).
	tabID, fi, raw, ready, why := openValidityTab(port, pageURL, "enabled")
	if !paso("VAL-15-0: tab propio nuevo de /form-validez?estado=enabled abierto, documento fresco", ready,
		fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	refGuardar, refGOK := refByName(fi, raw, "Guardar")
	refAlfa, refAOK := refByName(fi, raw, "Alfa")
	if !paso("VAL-15-1: refs de Guardar y Alfa resueltos", refGOK && refAOK, "") {
		return false
	}

	// bloque-P15: un único ledger acumula TODAS las llamadas del bloque
	// (incluye el oráculo, §2.1 tabla); flujo-P15 se mide por diferencia
	// antes/después de la primera llamada (sin llamarla dos veces).
	ledger := newCallLedger(port)
	actBefore, getFrameBefore, getDOMBefore, totalBefore :=
		ledger.counts["vlp_act"], ledger.counts["vlp_getFrame"], ledger.counts["vlp_getDOM"], ledger.total()

	startA := time.Now()
	foldA, okFoldA, textFoldA := ledger.call("vlp_act",
		map[string]any{"tabId": tabID, "ref": refGuardar, "action": "click", "frame": map[string]any{}}, 20*time.Second)
	elapsedA := time.Since(startA)
	shapeOKA, shapeDetA := foldShape(foldA, elapsedA, textFoldA)
	okA, _ := foldA["ok"].(bool)
	frameA := foldFrameOf(foldA)
	profileA, hasProfileA := frameA["invalidProfile"].(string)
	countA, hasCountA := isNonNegInt(frameA, "invalidCount")
	entriesA := invalidEntriesOf(frameA)

	actFlowOK := ledger.counts["vlp_act"]-actBefore == 1
	getFrameFlowOK := ledger.counts["vlp_getFrame"]-getFrameBefore == 0
	getDOMFlowOK := ledger.counts["vlp_getDOM"]-getDOMBefore == 0
	totalFlowOK := ledger.total()-totalBefore == 1

	allOK = paso("VAL-15a: foldA ok:true, Regla FE, invalidProfile==\"odoo\", invalidCount==4",
		okFoldA && okA && shapeOKA && hasProfileA && profileA == "odoo" && hasCountA && countA == 4,
		fmt.Sprintf(" (ok=%v profile=%q count=%d)%s", okA, profileA, countA, shapeDetA)) && allOK
	allOK = paso("VAL-15a-libro: flujo-P15 act==1, getFrame==0, getDOM==0, total==1 (AC-1)",
		actFlowOK && getFrameFlowOK && getDOMFlowOK && totalFlowOK,
		fmt.Sprintf(" (%s)", ledger.String())) && allOK

	// Oráculo A (fuera del segmento de flujo, dentro de bloque-P15).
	gA, okGA, textGA := ledger.call("vlp_getFrame", map[string]any{"tabId": tabID}, 15*time.Second)
	elemsJSONFoldA, okElemsFoldA := invalidElementsJSON(frameA)
	elemsJSONgA, okElemsGA := invalidElementsJSON(gA)
	profileGA, hasProfileGA := gA["invalidProfile"].(string)
	countGA, hasCountGA := isNonNegInt(gA, "invalidCount")
	identicalAB := okElemsFoldA && okElemsGA && elemsJSONFoldA == elemsJSONgA

	allOK = paso("VAL-15b: invalidElementsJSON(foldA)==invalidElementsJSON(gA) (JSON canónico: mismas entradas, mismo orden de lista y de claves), invalidCount/invalidProfile iguales, ambos no vacíos",
		okGA && identicalAB && hasProfileA && hasProfileGA && profileA == profileGA &&
			hasCountA && hasCountGA && countA == countGA && countA == 4 && len(entriesA) == 4,
		fmt.Sprintf(" (idéntico=%v, profile A=%q GA=%q, count A=%d GA=%d, entradas A=%d; raw gA %.300s)",
			identicalAB, profileA, profileGA, countA, countGA, len(entriesA), textGA)) && allOK

	// Par con recorte (I-5 en vivo, VAL-15c): act focus sobre Alfa (un input
	// sin listeners — ok:true, no muta) con frame:{roles:["button"]}, y el
	// getFrame equivalente.
	foldB, okFoldB, textFoldB := ledger.call("vlp_act",
		map[string]any{"tabId": tabID, "ref": refAlfa, "action": "focus",
			"frame": map[string]any{"roles": []string{"button"}}}, 20*time.Second)
	gB, okGB, textGB := ledger.call("vlp_getFrame",
		map[string]any{"tabId": tabID, "roles": []string{"button"}}, 15*time.Second)

	frameB := foldFrameOf(foldB)
	elemsJSONFoldB, okElemsFoldB := invalidElementsJSON(frameB)
	elemsJSONgB, okElemsGB := invalidElementsJSON(gB)
	profileFoldB, hasProfileFoldB := frameB["invalidProfile"].(string)
	profileGB, hasProfileGB := gB["invalidProfile"].(string)
	countFoldB, hasCountFoldB := isNonNegInt(frameB, "invalidCount")
	countGB, hasCountGB := isNonNegInt(gB, "invalidCount")
	identicalBB := okElemsFoldB && okElemsGB && elemsJSONFoldB == elemsJSONgB

	// I-5 en vivo: sections recortado a rol botón. No hay clave de rol
	// expuesta en el mapa crudo del harness, así que se opera por nombre:
	// con roles:["button"] los únicos elementos de sections de esta fixture
	// son el marcador (`validez-fixture-listo-enabled`) y "Guardar" — ningún
	// nombre de campo/etiqueta puede aparecer.
	buttonNames := map[string]bool{"validez-fixture-listo-enabled": true, "Guardar": true}
	namesB := elementNamesRaw(frameB)
	onlyButtonsB := len(namesB) > 0
	for _, n := range namesB {
		if !buttonNames[n] {
			onlyButtonsB = false
		}
	}
	var portadorRefs []string
	for _, e := range entriesA {
		if notInMap, _ := e["notInMap"].(bool); notInMap {
			continue
		}
		if r, ok := e["ref"].(string); ok && r != "" {
			portadorRefs = append(portadorRefs, r)
		}
	}
	refsInSectionsB := elementRefsRaw(frameB)
	noPortadorRefInSectionsB := len(portadorRefs) > 0
	for _, r := range portadorRefs {
		if refsInSectionsB[r] {
			noPortadorRefInSectionsB = false
		}
	}

	allOK = paso("VAL-15c: foldB vs gB idénticos (canónico), invalidCount==4 en ambos, mismo invalidProfile, I-5 en vivo: sections sólo botones y ningún ref de portador — invalidCount NO se recortó",
		okFoldB && okGB && identicalBB &&
			hasCountFoldB && countFoldB == 4 && hasCountGB && countGB == 4 &&
			hasProfileFoldB && hasProfileGB && profileFoldB == profileGB &&
			onlyButtonsB && noPortadorRefInSectionsB,
		fmt.Sprintf(" (idéntico=%v, countFoldB=%d countGB=%d, profileFoldB=%q profileGB=%q, sólo botones=%v names=%v, sin ref de portador=%v; raw foldB %.300s raw gB %.300s)",
			identicalBB, countFoldB, countGB, profileFoldB, profileGB, onlyButtonsB, namesB, noPortadorRefInSectionsB, textFoldB, textGB)) && allOK

	allOK = paso("VAL-15d: libro bloque-P15 getDOM==0",
		ledger.counts["vlp_getDOM"] == 0,
		fmt.Sprintf(" (%s)", ledger.String())) && allOK

	return allOK
}

// ---- §4: estructura de la corrida ----

// runFormValidityE2E corre los tres bloques del diseño (§4). VAL-21 corre
// primero a propósito: su fixture trae las marcas pre-horneadas, así que su
// primer getFrame ES la guarda de detección (VAL-detecta) — distingue "el
// artefacto no trae fb-020-005"/"el perfil no detecta" de "el pliegue está
// roto" antes de leer el resto del bloque.
func runFormValidityE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-validez] Validez de formulario en el mapa (fb-020-005) — perfil REAL de Odoo — P21, P16, P15")
	if !paso("VAL-fix: la fixture no contiene aria-invalid", !strings.Contains(validityPageHTML, "aria-invalid"), "") {
		return false
	}
	if !paso("VAL-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	ok21 := valTabDisabled(port, pageURL) // §5.4 P21 (+ §5.1 VAL-detecta)
	ok16 := valTabDinamico(port, pageURL) // §5.2 P16
	ok15 := valTabPliegue(port, pageURL)  // §5.3 P15
	return ok21 && ok16 && ok15
}
