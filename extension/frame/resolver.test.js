/**
 * resolver.test.js — fb-017-002 frame-map-api (sub-fase RED). PC5–PC6.
 * Verifica el contrato observable de resolveRef(ref, root) → Element|null:
 * resolución por posición (tag + nth-of-type + shadow path, índice omitido si
 * único) y el segmento ::shadow (open → elemento; closed/sin shadow → null).
 * No depende de internals del resolver (I1/I4: read-only, sin identidad
 * inyectada) — solo de qué elemento resuelve y qué devuelve null.
 * Los módulos resolver.js no existen aún → RED por error de import (documentado).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolveRef } from './resolver.js';

function makeDom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

test('PC5: resolveRef :nth-of-type resuelve el input correcto entre hermanos', () => {
  const doc = makeDom(
    '<main><form><div><input id="a"></div><div><input id="b"></div></form></main>',
  );
  const root = doc.body;
  const first = resolveRef('main>form>div:nth-of-type(1)>input', root);
  assert.ok(first, 'resuelve un elemento para <div:nth-of-type(1)>input');
  assert.equal(first.id, 'a', 'input #a del primer div hermano');
  const second = resolveRef('main>form>div:nth-of-type(2)>input', root);
  assert.ok(second, 'resuelve un elemento para <div:nth-of-type(2)>input');
  assert.equal(second.id, 'b', 'input #b del segundo div hermano');
});

test('PC5: resolveRef omite el índice cuando el tag es único', () => {
  const doc = makeDom('<main><button id="only">x</button></main>');
  const el = resolveRef('main>button', doc.body);
  assert.ok(el, 'main>button resuelve al único button');
  assert.equal(el.id, 'only');
});

test('PC5: resolveRef devuelve null para un ref inexistente', () => {
  const doc = makeDom('<main><button id="b">x</button></main>');
  assert.equal(resolveRef('main>input', doc.body), null, 'tag inexistente → null');
  assert.equal(resolveRef('main>button>span', doc.body), null, 'path inexistente → null');
  assert.equal(resolveRef('form>button', doc.body), null, 'ref anclado más allá del root → null');
});

test('PC6: ::shadow resuelve el elemento dentro de un shadow root abierto', () => {
  const doc = makeDom('<main><my-widget></my-widget></main>');
  const host = doc.querySelector('my-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="sbtn">Shadow</button>';
  const el = resolveRef('main>my-widget::shadow>button', doc.body);
  assert.ok(el, 'resuelve un button dentro del shadow root abierto');
  assert.equal(el.id, 'sbtn', 'es el button del shadow root');
  assert.equal(el.getRootNode(), shadow, 'el elemento resuelto vive en el shadow root');
});

test('PC6: ::shadow sobre un shadow root cerrado devuelve null', () => {
  const doc = makeDom('<main><my-widget></my-widget></main>');
  doc.querySelector('my-widget').attachShadow({ mode: 'closed' });
  assert.equal(
    resolveRef('main>my-widget::shadow>button', doc.body),
    null,
    'shadow root cerrado → no resoluble → null',
  );
});

test('PC6: ::shadow sobre un elemento sin shadow root devuelve null', () => {
  const doc = makeDom('<main><my-widget></my-widget></main>'); // sin attachShadow
  assert.equal(
    resolveRef('main>my-widget::shadow>button', doc.body),
    null,
    'elemento sin shadow root → ::shadow no aplica → null',
  );
});

// ── Regresión review H1 (fb-017-002) ─────────────────────────────────────────
// Un ref malformado que produce CERO segmentos (">", ">>>" — strings no-vacíos
// que pasan el gate Go "act requires ref") era resuelto al ROOT: el loop de
// segmentos no corre y el resolver devolvía el root como elemento. Un ref
// malformado del agente terminaba disparando una acción sobre el elemento
// raíz (handlers globales de click en body/document). Justificación (review
// H1 de fb-017-002): un ref malformado debe ser "no resoluble" → resolveRef
// devuelve null → act compone con performAction(null) → stale (PC11, ya
// cubierta). NUNCA el root. Esperado en RED: AssertionError (hoy devuelve el
// root, no null).

test('PC5: resolveRef devuelve null para refs malformados sin segmentos (regresión H1)', () => {
  const doc = makeDom('<main><button id="b">x</button></main>');
  assert.equal(
    resolveRef('>', doc.body),
    null,
    'ref malformado ">" (cero segmentos) no debe resolver al root → null (review H1)',
  );
  assert.equal(
    resolveRef('>>>', doc.body),
    null,
    'ref malformado ">>>" (cero segmentos) no debe resolver al root → null (review H1)',
  );
});

test('PC5: resolveRef devuelve null para un ref vacío (regresión H1, case whitespace)', () => {
  const doc = makeDom('<main><button id="b">x</button></main>');
  assert.equal(
    resolveRef('', doc.body),
    null,
    'ref vacío "" (cero segmentos) no debe resolver al root → null (review H1)',
  );
});
