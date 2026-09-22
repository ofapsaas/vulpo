/**
 * act-observe-shadow-tardio.test.js — fb-020-002-type-commit-cycle v2, sub-fase 3.1 RED.
 *
 * Verifica P35 (spec §12.1, guardia de regresión detectada en el GREEN del review):
 * un shadow root abierto adjuntado con `attachShadow` a un elemento YA EXISTENTE
 * durante la ventana (ese `attachShadow` en sí mismo no produce registro de
 * mutación — no es `childList`/`attributes`/`characterData` del documento) cuenta
 * igual como parte del documento a los efectos de §2.3.1: si en su interior hay
 * mutaciones a intervalos menores que `quietMs` hasta t₀+t, la respuesta no
 * resuelve antes de t₀+t+`quietMs`; luego `settled:true`.
 *
 * Referencias normativas (docs/specs/fb-020-002-type-commit-cycle/spec.md):
 *   - §2.3.1 (reinician la ventana): "cualquier mutación del documento
 *     (`childList`, `attributes`, `characterData`, en el documento y sus shadow
 *     roots abiertos)".
 *   - §12.1 P35: "Un shadow root abierto adjuntado con `attachShadow` a un
 *     elemento ya existente durante la ventana (sin registro de mutación) cuenta
 *     como parte del documento: si en su interior hay mutaciones a intervalos
 *     menores que `quietMs` hasta t₀+t, la respuesta no resuelve antes de
 *     t₀+t+`quietMs`; luego `settled:true`."
 *
 * Evidencia (fixture de referencia, spec §12.1 P35): `review-v2-sondas/probe3.mjs`
 * caso E4 — `attachShadow` a los 100 ms sobre un elemento existente (`#h1`),
 * mutaciones internas cada 100 ms hasta n=8 (última mutación en t=900 ms).
 * Parámetros de la sonda: `waitMs: 3000, quietMs: 400`. Esperado wall >= 1300
 * (900 + 400). Con la build 0.4.29 medía 1305 ms (OK); con el build actual del
 * GREEN del review (`dfeb697`) mide 409 ms, `settled:true` (VIOLATION) — la
 * suite existente (232 tests) no cubre este caso, de ahí P35.
 *
 * Import: mismo mecanismo que act-observe-escala.test.js/act-observe-profundidad.test.js
 * — dinámico con catch, `api(nombre, id)` al inicio de cada test asertando que
 * la función existe. La función ya está exportada e implementada
 * (act-observe.test.js, act-observe-profundidad.test.js y act-observe-escala.test.js
 * pasan); el RED de este archivo es de la MISMA naturaleza que esos dos últimos:
 * no falla por AssertionError de guard de superficie, sino porque el `attachShadow`
 * tardío sobre un elemento ya existente no arma (o pierde) el reinicio de ventana
 * que exige §2.3.1 con el build actual.
 *
 * IMPORTANTE — por qué se mide tiempo de PARED tras el await, no Promise.race con
 * un sleep: la observación puede depender de trabajo sincrónico interno (barridos
 * de shadow roots); medir con Date.now() inmediatamente antes de llamar y después
 * de que el `await` resuelve captura el costo real, lo haga o no en varias pasadas.
 *
 * El test-writer no leyó observe.js, act.js, index.js ni background.js.
 * `review-v2-sondas/probe3.mjs` se leyó como fixture de referencia (mismo import
 * de superficie pública que este archivo), no como código de implementación.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── Guard de import (mismo patrón que act-observe.test.js/act-observe-escala.test.js) ──
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
    `${nombre} no exportada por ./index.js — ${id} de fb-020-002 P35` +
      (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

function mkdoc(bodyHtml) {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`).window.document;
}

// ═══════════════════════════════════════════════════════════════════════════
// P35 — shadow root adjuntado tarde (attachShadow sobre elemento existente,
// sin registro de mutación en sí mismo) con mutaciones internas periódicas
// ═══════════════════════════════════════════════════════════════════════════
//
// Réplica de probe3.mjs caso E4, mismos parámetros: waitMs=3000, quietMs=400.
// A los 100 ms, `attachShadow({mode:'open'})` sobre `#host-existente` (elemento
// YA presente en el documento antes de iniciar la observación — el propio
// attachShadow no dispara childList/attributes/characterData del documento).
// Dentro del shadow root recién adjuntado, un `setInterval` de 100 ms muta
// `textContent` 8 veces (n=1..8): t=200,300,400,500,600,700,800,900. Última
// mutación en t=900 ms. Por §2.3.1, cada una de esas mutaciones (dentro de un
// shadow root abierto) reinicia la ventana de quietud, así que la ventana
// completa de quietMs=400 sólo puede empezar a contarse DESPUÉS de t=900 ⇒
// piso lógico = 900 + 400 = 1300 ms (idéntico al minMs=1300 de probe3.mjs E4).
//
// Margen: probe3.mjs usa una tolerancia de 5 ms (`w >= minMs - 5`) porque corre
// una sola vez fuera del test runner. Acá, con el overhead propio de node:test
// y jsdom en CI, documentamos un margen más generoso y explícito: 50 ms (mismo
// margen de tolerancia que usa R-08b en act-observe-escala.test.js para un
// escenario de la misma familia — mutaciones periódicas que deben reiniciar la
// ventana). PISO_MEDIDO_MS = 1300 - 50 = 1250.
const WAIT_MS = 3000;
const QUIET_MS = 400;
const ATTACH_AT_MS = 100;
const MUTACIONES = 8;
const INTERVALO_MUTACION_MS = 100;
const ULTIMA_MUTACION_MS = ATTACH_AT_MS + MUTACIONES * INTERVALO_MUTACION_MS; // 900
const PISO_LOGICO_MS = ULTIMA_MUTACION_MS + QUIET_MS; // 1300
const MARGEN_TOLERANCIA_MS = 50;
const PISO_MEDIDO_MS = PISO_LOGICO_MS - MARGEN_TOLERANCIA_MS; // 1250

function programarShadowTardioConMutaciones(doc, hostId) {
  setTimeout(() => {
    const host = doc.getElementById(hostId);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<i id="marca">0</i>';
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      shadow.getElementById('marca').textContent = String(n);
      if (n >= MUTACIONES) clearInterval(iv);
    }, INTERVALO_MUTACION_MS);
  }, ATTACH_AT_MS);
}

test(
  'fb-020-002 P35 shadow root adjuntado tarde con mutaciones internas (type): attachShadow sobre elemento existente a los 100ms (sin registro de mutación), mutaciones internas cada 100ms hasta t=900ms ⇒ no resuelve antes de 900+quietMs (pared >= 1250ms), settled:true, value === lo escrito',
  { timeout: 120000 },
  async () => {
    const performActionAndObserve = api('performActionAndObserve', 'P35-type');
    const doc = mkdoc('<main><input id="x"><div id="host-existente"></div></main>');
    const el = doc.getElementById('x');
    const TEXTO = 'valor-p35';

    programarShadowTardioConMutaciones(doc, 'host-existente');

    const inicio = Date.now();
    const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
    const elapsed = Date.now() - inicio;
    const json = JSON.stringify(res);

    assert.ok(
      elapsed >= PISO_MEDIDO_MS,
      `P35 type: tiempo de pared (${elapsed} ms) debe ser >= ${PISO_MEDIDO_MS} ms — el shadow root adjuntado tarde ` +
        `(attachShadow a t=${ATTACH_AT_MS}ms sobre elemento existente, sin registro de mutación propio) cuenta como parte ` +
        `del documento (§2.3.1); sus mutaciones internas hasta t=${ULTIMA_MUTACION_MS}ms reinician la ventana de quietud, ` +
        `así que no puede resolver antes de t+quietMs=${PISO_LOGICO_MS}ms (margen de tolerancia ${MARGEN_TOLERANCIA_MS}ms); ` +
        `recibido ${json}`,
    );
    assert.equal(
      res.settled,
      true,
      `P35 type: sin más actividad tras la última mutación (t=${ULTIMA_MUTACION_MS}ms), dentro de waitMs=${WAIT_MS} ⇒ settled:true; recibido ${json}`,
    );
    assert.equal(res.value, TEXTO, `P35 type: value === el texto escrito; recibido ${json}`);
  },
);

test(
  'fb-020-002 P35 shadow root adjuntado tarde con mutaciones internas (fill): attachShadow sobre elemento existente a los 100ms (sin registro de mutación), mutaciones internas cada 100ms hasta t=900ms ⇒ no resuelve antes de 900+quietMs (pared >= 1250ms), settled:true, value === lo escrito',
  { timeout: 120000 },
  async () => {
    const performFill = api('performFill', 'P35-fill');
    const doc = mkdoc('<main><input id="x"><div id="host-existente"></div></main>');
    const el = doc.getElementById('x');
    const TEXTO = 'valor-p35-fill';

    programarShadowTardioConMutaciones(doc, 'host-existente');

    const inicio = Date.now();
    const res = await performFill(el, TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
    const elapsed = Date.now() - inicio;
    const json = JSON.stringify(res);

    assert.ok(
      elapsed >= PISO_MEDIDO_MS,
      `P35 fill: tiempo de pared (${elapsed} ms) debe ser >= ${PISO_MEDIDO_MS} ms — el shadow root adjuntado tarde ` +
        `(attachShadow a t=${ATTACH_AT_MS}ms sobre elemento existente, sin registro de mutación propio) cuenta como parte ` +
        `del documento (§2.3.1); sus mutaciones internas hasta t=${ULTIMA_MUTACION_MS}ms reinician la ventana de quietud, ` +
        `así que no puede resolver antes de t+quietMs=${PISO_LOGICO_MS}ms (margen de tolerancia ${MARGEN_TOLERANCIA_MS}ms); ` +
        `recibido ${json}`,
    );
    assert.equal(
      res.settled,
      true,
      `P35 fill: sin más actividad tras la última mutación (t=${ULTIMA_MUTACION_MS}ms), dentro de waitMs=${WAIT_MS} ⇒ settled:true; recibido ${json}`,
    );
    assert.equal(res.value, TEXTO, `P35 fill: value === el texto escrito; recibido ${json}`);
  },
);
