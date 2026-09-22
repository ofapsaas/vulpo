/**
 * act-observe-profundidad.test.js — fb-020-002-type-commit-cycle v2, sub-fase RED.
 *
 * Verifica el techo `waitMs` (spec §2.3.3/I-7, citado también por P6) cuando el
 * campo vive profundo en el DOM, no plano como en los fixtures existentes
 * (act-observe.test.js, fill.test.js). Ver docs/specs/fb-020-002-type-commit-cycle/spec.md:
 *   - I-7 (acotado): "La observación resuelve antes de waitMs + 500 ms y nunca
 *     rechaza (P6, P10, P22)."
 *   - §2.3.3: settled:true exige una ventana quietMs completa "antes de t₀ + waitMs".
 *   - §2.3.4 (deadline): si vence t₀+waitMs, resuelve settled:false — de cualquier
 *     forma, SIEMPRE dentro del techo de I-7.
 *
 * Motivación empírica (no cobertura por cobertura): findings/fb-020-002-campo-v2-2026-09-13.md
 * — en campo (Odoo 19 real), el primer `act type` sobre un input colgó la pestaña
 * de Firefox: 15,3 s pese al techo `waitMs` default 5000 ms. Medición del
 * orquestador: con el build actual, el costo de la observación crece con la
 * PROFUNDIDAD del DOM donde vive el campo (varias pasadas internas por llamada).
 * Calibración en jsdom con el build actual: una cadena de 16 `div` anidados
 * bloquea ~2 s por pasada interna; 20 niveles ≈ 29 s por pasada. Los fixtures
 * jsdom existentes son planos (el campo cuelga directo de <main>), por eso
 * ningún gate lo detectó.
 *
 * Import: mismo mecanismo que act-observe.test.js/fill.test.js — dinámico con
 * catch, `api(id)` al inicio de cada test asertando que la función existe.
 * A diferencia de esos archivos (sub-fase RED de P1–P14, función aún no
 * exportada), acá la función YA está exportada e implementada (verificado
 * corriendo act-observe.test.js/fill.test.js: 13/13 y N/N verdes). El RED de
 * este archivo es de OTRA naturaleza: no falla por AssertionError de guard,
 * sino porque el trabajo SINCRÓNICO de observar un campo anidado 16 niveles
 * excede el techo waitMs+500 documentado en I-7.
 *
 * IMPORTANTE — por qué NO uso Promise.race con sleep para medir: el trabajo
 * que bloquea es SINCRÓNICO (recorre el DOM dentro del hilo, no cede el
 * event loop), así que un timer de "sleep" no puede adelantarse a la
 * resolución real. Se mide tiempo de PARED con Date.now() antes de llamar y
 * después de que el `await` resuelve — eso captura el costo sincrónico
 * completo, lo haga o no en varias pasadas.
 *
 * El test-writer no leyó observe.js, act.js, index.js ni background.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── Guard de import (mismo patrón que act-observe.test.js/fill.test.js) ─────
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
    `${nombre} no exportada por ./index.js — ${id} de fb-020-002 P6-profundidad` +
      (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * DOM con el input dentro de 16 `div` anidados (no más — 16 ya calibra ~2 s por
 * pasada interna con el build actual; más profundidad haría el runner tardar
 * minutos). Agrega 1–2 hermanos cada 4 niveles para que no sea una cadena
 * artificialmente mínima, sin superar 16 de profundidad hasta el input.
 */
function makeDomProfundo() {
  let html = '<input id="x" aria-label="campo">';
  for (let nivel = 15; nivel >= 0; nivel--) {
    const hermanos = nivel % 4 === 0 ? '<span>ruido</span><p>ruido2</p>' : '';
    html = `<div class="nivel-${nivel}">${hermanos}${html}</div>`;
  }
  return new JSDOM(`<!DOCTYPE html><html><body><main>${html}</main></body></html>`).window.document;
}

const WAIT_MS = 1000;
const QUIET_MS = 100;
// Piso/margen: I-7 fija el techo en waitMs + 500 ms. Con WAIT_MS=1000, el
// techo es 1500 ms — el mismo margen que usa el spec (P6), no uno inventado
// para este test.
const TECHO_MS = WAIT_MS + 500;

// ── P6-profundidad: type ─────────────────────────────────────────────────

test(
  'fb-020-002 P6-profundidad type: input anidado 16 niveles ⇒ resuelve en menos de waitMs+500 ms de pared (I-7), ok:true, settled:true, value === lo escrito',
  { timeout: 120000 },
  async () => {
    const performActionAndObserve = api('performActionAndObserve', 'P6-profundidad-type');
    const doc = makeDomProfundo();
    const el = doc.getElementById('x');
    const TEXTO = 'valor-profundo';

    const inicio = Date.now();
    const res = await performActionAndObserve(el, 'type', TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
    const elapsed = Date.now() - inicio;
    const json = JSON.stringify(res);

    assert.ok(
      elapsed < TECHO_MS,
      `P6-profundidad type: tiempo de pared (${elapsed} ms) debe ser < waitMs+500 (${TECHO_MS} ms) — I-7, ` +
        `independiente de la profundidad del DOM (16 niveles); recibido ${json}`,
    );
    assert.equal(res.ok, true, `P6-profundidad type: ok:true incluso con el campo anidado profundo; recibido ${json}`);
    assert.equal(res.settled, true, `P6-profundidad type: sin actividad en el DOM profundo ⇒ settled:true (mismo contrato que plano); recibido ${json}`);
    assert.equal(res.value, TEXTO, `P6-profundidad type: value === el texto escrito; recibido ${json}`);
  },
);

// ── P6-profundidad: fill ─────────────────────────────────────────────────

test(
  'fb-020-002 P6-profundidad fill: input anidado 16 niveles ⇒ resuelve en menos de waitMs+500 ms de pared (I-7), success:true, settled:true, value === lo escrito',
  { timeout: 120000 },
  async () => {
    const performFill = api('performFill', 'P6-profundidad-fill');
    const doc = makeDomProfundo();
    const el = doc.getElementById('x');
    const TEXTO = 'valor-profundo-fill';

    const inicio = Date.now();
    const res = await performFill(el, TEXTO, { waitMs: WAIT_MS, quietMs: QUIET_MS });
    const elapsed = Date.now() - inicio;
    const json = JSON.stringify(res);

    assert.ok(
      elapsed < TECHO_MS,
      `P6-profundidad fill: tiempo de pared (${elapsed} ms) debe ser < waitMs+500 (${TECHO_MS} ms) — I-7, ` +
        `independiente de la profundidad del DOM (16 niveles); recibido ${json}`,
    );
    assert.equal(res.success, true, `P6-profundidad fill: success:true incluso con el campo anidado profundo; recibido ${json}`);
    assert.equal(res.settled, true, `P6-profundidad fill: sin actividad en el DOM profundo ⇒ settled:true (mismo contrato que plano); recibido ${json}`);
    assert.equal(res.value, TEXTO, `P6-profundidad fill: value === el texto escrito; recibido ${json}`);
  },
);
