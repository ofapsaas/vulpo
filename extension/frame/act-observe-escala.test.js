/**
 * act-observe-escala.test.js — fb-020-002-type-commit-cycle v2, sub-fase 3.1 RED
 * (fixes del review v2).
 *
 * Verifica el techo waitMs+500 (spec §2.3.3/I-7) y el veto de §2.3.2 en tres
 * escenarios que el reviewer independiente (Opus, review-v2-2026-09-13.md)
 * reprodujo en jsdom contra el módulo real y que el RED previo
 * (act-observe-profundidad.test.js, cadena estática de 16 niveles sin
 * mutaciones ni shadow roots) no cubre — R-08 lo señala explícitamente:
 * "no cubre mutaciones, shadow roots ni N grande".
 *
 * Referencias normativas (docs/specs/fb-020-002-type-commit-cycle/spec.md):
 *   - I-7 (acotado): "La observación resuelve antes de waitMs + 500 ms y
 *     nunca rechaza (P6, P10, P22)."
 *   - §2.3.1: reinician la ventana de quietud las mutaciones "en el documento
 *     y sus shadow roots abiertos".
 *   - §2.3.2 (veto): con un indicador de carga estándar presente
 *     ([aria-busy="true"], [role="progressbar"], progress), la quietud no se
 *     declara.
 *   - §2.3.3: settled:true exige una ventana quietMs completa, "antes de
 *     t₀ + waitMs".
 *
 * Hallazgos del reviewer que motivan cada caso (review-v2-2026-09-13.md §3,
 * sondas en review-v2-sondas/probe.mjs, probe2.mjs, probe3.mjs; medidas en
 * jsdom, módulo real, build fca3e17..dfbebca — el mismo build que este
 * archivo ejercita):
 *   - R-01: `onMutation` barre el subárbol completo de cada nodo agregado
 *     (O(N·h)). Cadena construida ADJUNTA de arriba hacia abajo dentro de la
 *     ventana: D=1000 → 1705 ms (waitMs 1000, quietMs 100, techo 1500);
 *     D=2000 → 6929 ms; D=4000 → 26053 ms. Control: construir sin observador
 *     cuesta 266 ms (D=1000), 801 ms (D=2000); construida SUELTA y adjuntada
 *     una sola vez (costo lineal real) → 405 ms (D=1000).
 *   - R-02: el barrido inicial de shadow roots es sincrónico y ocurre ANTES
 *     de armar el deadline; cada cierre de ventana de quietud vuelve a
 *     barrer. Documento de N=80000 nodos con un <progress> SIEMPRE presente
 *     (veto §2.3.2 nunca se levanta), quietMs 50, waitMs 1000 →
 *     waitedMs 1884 (> waitMs+500 = 1500). Recalibrado 2026-09-13 a
 *     N=160000 (ver comentario junto al Test 2): a N=80000 la separación
 *     contra el build viejo (dfbebca) cayó dentro del ruido de jsdom — el
 *     costo del barrido O(N) del build viejo crece con N mientras que el
 *     build actual mantiene waitedMs≈1000 estable sin importar N.
 *   - R-03: el Set de shadow roots conocidos no se poda cuando el host que
 *     los contiene sale del documento — el veto de §2.3.2 sigue activo sobre
 *     un [role="progressbar"] que ya no es alcanzable. Host con shadow root
 *     ABIERTO removido a los 100 ms; waitMs 1500 → {settled:false,
 *     waitedMs:1502}, aunque doc.querySelector ya no encuentra el indicador.
 *     Control con el mismo indicador en light DOM, removido a 100 ms →
 *     settled:true a ~197 ms.
 *   - R-08 (propuesta b, GUARDIA): shadow roots anidados que mutan DENTRO de
 *     la ventana deben seguir reiniciando la quietud (§2.3.1) — el fix de
 *     R-01/R-02/R-03 no debe romper esto. probe3.mjs E1 (shadow x3
 *     preexistente, mutación en el más interno a t=200, quietMs 100) midió
 *     604 ms (≥ 600 esperado) con el build fca3e17..854a06f.
 *
 * Import: mismo mecanismo que act-observe.test.js / act-observe-profundidad.test.js
 * — dinámico con catch, `api(nombre, id)` al inicio de cada test asertando
 * que la función existe. La función ya está exportada e implementada
 * (act-observe.test.js y act-observe-profundidad.test.js pasan); el RED de
 * este archivo es de la MISMA naturaleza que act-observe-profundidad.test.js:
 * no falla por AssertionError de guard de superficie, sino porque el trabajo
 * SINCRÓNICO de observar excede el techo waitMs+500 documentado en I-7 (tests
 * 1-3), o porque el veto de §2.3.2/2.3.3 queda mal resuelto (test 2 y 3).
 *
 * IMPORTANTE — por qué se mide tiempo de PARED tras el await y no
 * Promise.race con un sleep: el trabajo que bloquea (barrido de subárbol,
 * querySelectorAll('*') sobre documentos grandes) es SINCRÓNICO — no cede el
 * event loop — así que un timer de "sleep" corriendo en paralelo no puede
 * adelantarse a la resolución real ni acotar el costo. Se mide con Date.now()
 * inmediatamente antes de llamar y después de que el `await` resuelve.
 *
 * El test-writer no leyó observe.js, act.js, index.js ni background.js.
 * Las sondas de review-v2-sondas/ se leyeron como referencia de superficie
 * pública (mismo import que este archivo), no como código de implementación.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── Guard de import (mismo patrón que act-observe.test.js/act-observe-profundidad.test.js) ──
let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  frame = null;
  errorDeCarga = e;
}

function api(nombre, id) {
  const fn = frame?.[nombre];
  assert.equal(
    typeof fn,
    'function',
    `${nombre} no exportada por ./index.js — ${id} de fb-020-002 review-v2` +
      (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

function mkdoc(bodyHtml) {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`).window.document;
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — R-01: subárbol profundo agregado durante la ventana (I-7)
// ═══════════════════════════════════════════════════════════════════════════
//
// Parámetros: D=2000 nodos en cadena, construidos ADJUNTOS (cada nodo se
// appendea al anterior, ya insertado en el documento) uno por uno dentro de
// un único timer sincrónico que arranca a los 50 ms del inicio de la espera.
// waitMs=2000 ⇒ techo I-7 = waitMs+500 = 2500 ms.
//
// Justificación del margen: el propio costo de CONSTRUIR la cadena en jsdom
// (loop de 2000 createElement+appendChild) cuenta en el tiempo de pared medido
// por este test, sea cual sea el costo de la observación — es trabajo previo
// al await, no atribuible al observador. El reviewer midió ese costo de
// construcción solo (sin observador) en 801 ms para D=2000. Con una
// observación de costo LINEAL (el objetivo del fix: descubrir shadow roots al
// cierre de ventana en vez de por cada nodo agregado, o deduplicar dentro del
// lote), el costo total esperado es:
//   50 ms (delay del timer) + ~801 ms (construir 2000 nodos) + quietMs (100)
//   + margen de jsdom/scheduler ≈ 950-1200 ms — bien por debajo del techo de
//   2500 ms. Con el build actual (barrido O(N·h) por cada nodo agregado), el
//   reviewer midió 6929 ms para la misma D=2000 con waitMs=1000/quietMs=100
//   (excede su techo de 1500 más de 4x), así que con waitMs=2000 el fallo
//   sigue siendo claro.
{
  const D = 2000;
  const WAIT_MS = 2000;
  const QUIET_MS = 100;
  const TECHO_MS = WAIT_MS + 500; // I-7

  test(
    'fb-020-002 R-01 subárbol profundo agregado durante la ventana (type): D=2000 nodos en cadena adjunta top-down a los 50ms ⇒ resuelve en menos de waitMs+500 ms de pared (I-7), ok:true, settled:true, value === lo escrito',
    { timeout: 120000 },
    async () => {
      const performActionAndObserve = api('performActionAndObserve', 'R-01-type');
      const doc = mkdoc('<main><input id="x"><div id="root"></div></main>');
      const el = doc.getElementById('x');
      const root = doc.getElementById('root');
      const TEXTO = 'valor-r01';

      setTimeout(() => {
        let cur = root;
        for (let i = 0; i < D; i++) {
          const d = doc.createElement('div');
          cur.appendChild(d);
          cur = d;
        }
      }, 50);

      const inicio = Date.now();
      const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
      const elapsed = Date.now() - inicio;
      const json = JSON.stringify(res);

      assert.ok(
        elapsed < TECHO_MS,
        `R-01 type: tiempo de pared (${elapsed} ms) debe ser < waitMs+500 (${TECHO_MS} ms) — I-7, ` +
          `con D=2000 nodos en cadena adjunta agregados dentro de la ventana; recibido ${json}`,
      );
      assert.equal(res.ok, true, `R-01 type: ok:true; recibido ${json}`);
      assert.equal(res.settled, true, `R-01 type: sin más actividad tras construir la cadena ⇒ settled:true; recibido ${json}`);
      assert.equal(res.value, TEXTO, `R-01 type: value === el texto escrito; recibido ${json}`);
    },
  );

  test(
    'fb-020-002 R-01 subárbol profundo agregado durante la ventana (fill): D=2000 nodos en cadena adjunta top-down a los 50ms ⇒ resuelve en menos de waitMs+500 ms de pared (I-7), success:true, settled:true, value === lo escrito',
    { timeout: 120000 },
    async () => {
      const performFill = api('performFill', 'R-01-fill');
      const doc = mkdoc('<main><input id="x"><div id="root"></div></main>');
      const el = doc.getElementById('x');
      const root = doc.getElementById('root');
      const TEXTO = 'valor-r01-fill';

      setTimeout(() => {
        let cur = root;
        for (let i = 0; i < D; i++) {
          const d = doc.createElement('div');
          cur.appendChild(d);
          cur = d;
        }
      }, 50);

      const inicio = Date.now();
      const res = await performFill(el, TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
      const elapsed = Date.now() - inicio;
      const json = JSON.stringify(res);

      assert.ok(
        elapsed < TECHO_MS,
        `R-01 fill: tiempo de pared (${elapsed} ms) debe ser < waitMs+500 (${TECHO_MS} ms) — I-7, ` +
          `con D=2000 nodos en cadena adjunta agregados dentro de la ventana; recibido ${json}`,
      );
      assert.equal(res.success, true, `R-01 fill: success:true; recibido ${json}`);
      assert.equal(res.settled, true, `R-01 fill: sin más actividad tras construir la cadena ⇒ settled:true; recibido ${json}`);
      assert.equal(res.value, TEXTO, `R-01 fill: value === el texto escrito; recibido ${json}`);
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — R-02: techo con documento grande y veto persistente (I-7, §2.3.2)
// ═══════════════════════════════════════════════════════════════════════════
//
// N=160000 nodos. Recalibrado 2026-09-13 (el N=80000 original dejó de
// discriminar: contra el build previo a los fixes (dfbebca, 0.4.29) el
// test-writer midió waitedMs con 3 corridas de 1884/1888/2117 ms en una
// medición pero, en otra corrida a N=80000, waitedMs entró por debajo del
// techo (falso PASS) — el costo del build viejo (barrido inicial O(N) antes
// de armar el deadline + re-barrido en cada cierre de ventana) a N=80000
// queda dentro del ruido de jsdom/scheduler frente al techo de 1500 ms. Ese
// costo crece con N (más nodos ⇒ barridos más caros), así que N=160000 abre
// margen: separación esperada del build viejo por encima del techo en las
// tres corridas (medición de discriminación, criterio de aceptación #2 del
// handoff de recalibración).
//
// Con el build actual (HEAD), el test-writer midió — sonda propia, mismo
// fixture, node --test, jsdom, 3 valores de N en una sola corrida —:
//   N=80000:  performAction solo 411 ms  | waitedMs 1000
//   N=160000: performAction solo 809 ms  | waitedMs 1000
//   N=240000: performAction solo 1224 ms | waitedMs 1001
// waitedMs es ESTABLE ≈1000-1001 ms sin importar N (el fix actual arma el
// deadline ANTES del barrido inicial y no re-barre con el veto activo — el
// costo de N solo pesa sobre performAction/despacho, nunca sobre waitedMs).
// <progress> presente desde el despacho y NUNCA removido ⇒ el veto de
// §2.3.2 nunca se levanta: la única resolución conforme al contrato es
// settled:false por deadline (§2.3.4), dentro del techo I-7. quietMs=50,
// waitMs=1000 ⇒ techo=1500.
//
// I-7 ("La observación resuelve antes de waitMs + 500 ms") es un contrato
// sobre `res.waitedMs` — el reloj interno de la observación — no sobre el
// tiempo de pared alrededor de toda la llamada. `performAction` (el
// despacho de act.js, PREVIO al inicio de la observación) está fuera del
// alcance de I-7 y es intocable por I-1; con N=160000 el test-writer midió
// performAction solo en 809 ms (ver arriba). Por eso hay dos aserciones
// separadas: la principal sobre waitedMs (el techo real de I-7) y una de
// pared con presupuesto de despacho documentado (PRESUPUESTO_DESPACHO_MS =
// 1200 ms, holgado frente a los 809 ms medidos — ~400 ms de margen sobre
// variación de scheduler/jsdom) para que un cuelgue real en la observación
// siga haciendo fallar el test sin que el costo del despacho de act.js
// vuelva marginal la aserción de pared.
{
  const N = 160000;
  const WAIT_MS = 1000;
  const QUIET_MS = 50;
  const TECHO_MS = WAIT_MS + 500; // I-7 — techo sobre waitedMs (la observación)
  const PRESUPUESTO_DESPACHO_MS = 1200; // holgura sobre performAction (809 ms medidos a N=160000), fuera de I-7/I-1

  test(
    'fb-020-002 R-02 techo con documento grande y veto persistente: N=160000 nodos, <progress> presente todo el tiempo ⇒ la observación (waitedMs) resuelve en menos de waitMs+500 ms (I-7) con settled:false (el veto nunca se levanta, §2.3.2)',
    { timeout: 120000 },
    async () => {
      const performActionAndObserve = api('performActionAndObserve', 'R-02');
      const filas = '<div><span>a</span><span>b</span><span>c</span></div>'.repeat(N / 4);
      const doc = mkdoc(`<main><input id="x"><progress></progress>${filas}</main>`);
      const el = doc.getElementById('x');
      const TEXTO = 'valor-r02';

      const inicio = Date.now();
      const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
      const elapsed = Date.now() - inicio;
      const json = JSON.stringify(res);

      assert.ok(
        res.waitedMs < TECHO_MS,
        `R-02: waitedMs de la observación (${res.waitedMs} ms) debe ser < waitMs+500 (${TECHO_MS} ms) — I-7, ` +
          `con N=160000 nodos y <progress> presente todo el tiempo; recibido ${json}`,
      );
      assert.equal(
        res.settled,
        false,
        `R-02: <progress> presente todo el tiempo ⇒ el veto de §2.3.2 nunca se levanta ⇒ settled:false por deadline; recibido ${json}`,
      );
      assert.ok(
        elapsed < TECHO_MS + PRESUPUESTO_DESPACHO_MS,
        `R-02: tiempo de pared (${elapsed} ms) debe ser < waitMs+500+presupuesto de despacho ` +
          `(${TECHO_MS + PRESUPUESTO_DESPACHO_MS} ms) — separado de I-7, cubre el despacho previo de ` +
          `performAction (809 ms medidos a N=160000) sin volver marginal el test; recibido ${json}`,
      );
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — R-03: indicador en shadow root cuyo host se quita (§2.3.2, §2.3.3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Host con shadow root ABIERTO que contiene [role="progressbar"]. El host se
// quita del documento a los 100 ms. waitMs=1500, quietMs=100. Conforme a
// §2.3.2, el veto es sobre indicadores "en el documento y sus shadow roots
// abiertos" (§2.3.1) — una vez que el host (y por tanto el shadow root) sale
// del documento, el indicador deja de estar en el documento y el veto debe
// levantarse. La respuesta debe resolver settled:true poco después de
// 100+quietMs.
//
// Piso documentado: 100 ms (remoción del host) + quietMs (100 ms) = 200 ms.
// Se asertá tiempo de pared < 1000 ms: margen amplio sobre el piso de 200 ms,
// muy por debajo del comportamiento roto (el reviewer midió 1502 ms, atado al
// deadline de waitMs=1500 — nunca se levanta el veto) y por debajo también
// del techo I-7 (waitMs+500=2000), para que el assert distinga el fix (~200
// ms) del bug (~1500 ms) con holgura en ambas direcciones.
{
  const WAIT_MS = 1500;
  const QUIET_MS = 100;
  const REMOVE_AT_MS = 100;
  const TECHO_ESPERADO_MS = 1000; // piso 200 ms + margen amplio, por debajo del bug (~1502 ms)

  test(
    'fb-020-002 R-03 indicador en shadow root cuyo host se quita: [role="progressbar"] en shadow root abierto, host removido a los 100ms ⇒ el veto se levanta (§2.3.2), settled:true, value === lo escrito, tiempo de pared < 1000 ms',
    { timeout: 120000 },
    async () => {
      const performActionAndObserve = api('performActionAndObserve', 'R-03');
      const doc = mkdoc('<main><input id="x"><div id="host"></div></main>');
      const host = doc.getElementById('host');
      const sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = '<div role="progressbar"></div>';
      const el = doc.getElementById('x');
      const TEXTO = 'valor-r03';

      setTimeout(() => host.remove(), REMOVE_AT_MS);

      const inicio = Date.now();
      const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
      const elapsed = Date.now() - inicio;
      const json = JSON.stringify(res);

      assert.ok(
        elapsed < TECHO_ESPERADO_MS,
        `R-03: tiempo de pared (${elapsed} ms) debe ser < ${TECHO_ESPERADO_MS} ms — el veto de §2.3.2 debe levantarse ` +
          `al quitarse el host del shadow root que contenía el indicador (100 ms) + quietMs (100 ms); recibido ${json}`,
      );
      assert.equal(
        res.settled,
        true,
        `R-03: tras quitarse el host, el indicador ya no está "en el documento y sus shadow roots abiertos" (§2.3.1) ` +
          `⇒ el veto se levanta ⇒ settled:true; recibido ${json}`,
      );
      assert.equal(res.value, TEXTO, `R-03: value === el texto escrito; recibido ${json}`);
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4 — R-08b: shadow roots anidados que mutan dentro de la ventana
// (GUARDIA de regresión, §2.3.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Shadow root abierto dentro de otro shadow root abierto (dos niveles), con
// una mutación del DOM interno a t=200 ms. quietMs=100 ⇒ la ventana de
// quietud no puede cerrarse antes de t=200+100=300 ms (§2.3.1: las
// mutaciones en shadow roots abiertos reinician la ventana de quietud).
//
// ESTE CASO ES GUARDIA DE REGRESIÓN, no RED: el propósito es que el fix de
// R-01/R-02/R-03 (que toca cómo se descubren/podan shadow roots) no rompa la
// cobertura transitiva de shadow roots anidados que el reviewer verificó con
// probe3.mjs (E1: shadow x3 preexistente, mutación en el más interno a
// t=200ms, quietMs=100 ⇒ 604 ms medidos, ≥ 600 esperado, con el build actual
// fca3e17..854a06f). Se declara explícitamente: PROBABLEMENTE PASE ya con el
// build actual.
//
// Margen documentado: piso lógico = 600 ms (mutación a t=200 + quietMs 400).
// QUIET_MS se eligió > MUTATE_AT_MS a propósito: con QUIET_MS <= MUTATE_AT_MS
// la primera ventana de quietud podría cerrarse ANTES de que la mutación
// programada llegara a dispararse, y el test dejaría de ejercitar el
// reinicio de ventana que exige §2.3.1 (bug del primer intento de este test:
// con QUIET_MS=100 y MUTATE_AT_MS=200 la ventana cerraba a los ~100 ms, sin
// haber visto la mutación de t=200 — falso "regresión" por parámetros mal
// elegidos, no por el producto). Mismos parámetros que probe3.mjs E1
// (quietMs 400, mutación a t=200, esperado >=600; medido 604 ms con el build
// fca3e17..854a06f). Se asertá pared >= 600 - 50 (margen de tolerancia de
// scheduler/jsdom) = 550 ms.
{
  const WAIT_MS = 3000;
  const QUIET_MS = 400;
  const MUTATE_AT_MS = 200;
  const PISO_LOGICO_MS = MUTATE_AT_MS + QUIET_MS; // 600
  const MARGEN_TOLERANCIA_MS = 50;
  const PISO_MEDIDO_MS = PISO_LOGICO_MS - MARGEN_TOLERANCIA_MS; // 550

  test(
    'fb-020-002 R-08b shadow roots anidados que mutan dentro de la ventana (GUARDIA de regresión, §2.3.1): shadow dentro de shadow, mutación en el más interno a t=200ms ⇒ no resuelve antes de t+quietMs (pared >= 550ms), settled:true — probablemente pasa ya con el build actual',
    { timeout: 120000 },
    async () => {
      const performActionAndObserve = api('performActionAndObserve', 'R-08b');
      const doc = mkdoc('<main><input id="x"><div id="host-externo"></div></main>');
      const el = doc.getElementById('x');
      const hostExterno = doc.getElementById('host-externo');

      const shadowExterno = hostExterno.attachShadow({ mode: 'open' });
      shadowExterno.innerHTML = '<section><div id="host-interno"></div></section>';
      const hostInterno = shadowExterno.getElementById('host-interno');
      const shadowInterno = hostInterno.attachShadow({ mode: 'open' });
      shadowInterno.innerHTML = '<b id="marca">x</b>';

      setTimeout(() => {
        shadowInterno.getElementById('marca').textContent = 'y';
      }, MUTATE_AT_MS);

      const TEXTO = 'valor-r08b';
      const inicio = Date.now();
      const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
      const elapsed = Date.now() - inicio;
      const json = JSON.stringify(res);

      assert.ok(
        elapsed >= PISO_MEDIDO_MS,
        `R-08b (guardia): tiempo de pared (${elapsed} ms) debe ser >= ${PISO_MEDIDO_MS} ms — la mutación en el shadow root ` +
          `interno a t=${MUTATE_AT_MS}ms debe reiniciar la ventana de quietud (§2.3.1), así que no puede resolver antes de ` +
          `t+quietMs=${PISO_LOGICO_MS}ms (margen de tolerancia ${MARGEN_TOLERANCIA_MS}ms); recibido ${json}`,
      );
      assert.equal(
        res.settled,
        true,
        `R-08b (guardia): sin más actividad tras la mutación de t=${MUTATE_AT_MS}ms, dentro de waitMs=${WAIT_MS} ⇒ settled:true; recibido ${json}`,
      );
      assert.equal(res.value, TEXTO, `R-08b (guardia): value === el texto escrito; recibido ${json}`);
    },
  );
}
