/**
 * invalid-frame.test.js — fb-020-004 (sub-fase RED).
 *
 * Verifica P11 y P12 de docs/specs/fb-020-004/spec.md §3
 * (contrato §2.4: `invalid` por elemento e `invalidCount` a nivel frame).
 *
 * Escrito SOLO contra serializeFrame(root, options) y su `fingerprint`
 * (pineado en payload-efficiency.test.js). Aislamiento anti-trampa: no se leyó
 * serializer.js. `:user-invalid` no se ejercita: jsdom no lo implementa (R-4).
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  · FALLAN por AssertionError: P11 (positivos: invalid:true no existe),
 *    P12 (invalidCount total), P12 (fingerprint cambia al pasar a inválido;
 *    hoy aria-invalid no participa de la huella).
 *  · PINES — se espera que PASEN ya en RED: P11 (negativos: aria-invalid="false"
 *    o ausente no llevan la clave) y P12 (sin inválidos no hay invalidCount).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
function emitidoPara(frame, root, nodo) {
  const el = allElements(frame).find((e) => resolveRef(e.ref, root) === nodo);
  assert.ok(el, `precondición: el frame emite el nodo; refs=${JSON.stringify(allElements(frame).map((e) => e.ref))}`);
  return el;
}

// ── P11 ─────────────────────────────────────────────────────────────────────

test('P11 (§2.4): aria-invalid="true" y aria-invalid="grammar" llevan invalid:true', () => {
  const doc = makeDom(
    '<form><input id="t" aria-label="Cuenta" aria-invalid="true">' +
      '<textarea id="g" aria-label="Nota" aria-invalid="grammar"></textarea></form>',
  );
  const root = doc.body;
  const frame = serializeFrame(root, {});
  for (const id of ['t', 'g']) {
    const el = emitidoPara(frame, root, doc.getElementById(id));
    assert.equal(el.invalid, true, `P11: #${id} lleva invalid:true; recibido ${JSON.stringify(el)}`);
  }
});

test('P11 (§2.4, I-5): aria-invalid="false" o sin el atributo → la clave invalid está ausente', () => {
  const doc = makeDom(
    '<form><input id="f" aria-label="Cuenta" aria-invalid="false"><input id="n" aria-label="Diario"></form>',
  );
  const root = doc.body;
  const frame = serializeFrame(root, {});
  for (const id of ['f', 'n']) {
    const el = emitidoPara(frame, root, doc.getElementById(id));
    assert.equal('invalid' in el, false, `P11: #${id} no lleva la clave invalid; recibido ${JSON.stringify(el)}`);
  }
});

// ── P12 ─────────────────────────────────────────────────────────────────────

/** 3 inválidos (textbox) mezclados con 5 botones; filtrar por button los oculta. */
const HTML_P12 =
  '<form>' +
  '<input aria-label="Cuenta" aria-invalid="true">' +
  '<button>Uno</button><button>Dos</button>' +
  '<input aria-label="Diario" aria-invalid="true">' +
  '<button>Tres</button><button>Cuatro</button>' +
  '<input aria-label="Importe" aria-invalid="grammar">' +
  '<button>Cinco</button>' +
  '<input aria-label="Válido">' +
  '</form>';

test('P12 (§2.4): invalidCount es el total de inválidos, contando los de otras páginas y los filtrados', () => {
  const root = makeDom(HTML_P12).body;

  const completo = serializeFrame(root, {});
  assert.equal(completo.invalidCount, 3, `P12: frame completo → invalidCount 3; claves=${JSON.stringify(Object.keys(completo))}`);

  const pagina = serializeFrame(root, { page: 1, maxElementsPerPage: 2 });
  assert.equal(pagina.invalidCount, 3, 'P12: paginado (page 1 de a 2) → sigue contando el total');

  const filtrado = serializeFrame(root, { roles: ['button'] });
  assert.ok(
    allElements(filtrado).every((e) => e.invalid !== true),
    'precondición: el filtro por button excluye a todos los inválidos',
  );
  assert.equal(filtrado.invalidCount, 3, 'P12: filtrado por roles → cuenta antes de filtrar');
});

test('P12 (§2.4, I-5): sin inválidos no existe la clave invalidCount', () => {
  const frame = serializeFrame(makeDom('<form><input aria-label="Cuenta" aria-invalid="false"><button>Ok</button></form>').body, {});
  assert.equal('invalidCount' in frame, false, `P12: sin inválidos la clave está ausente; claves=${JSON.stringify(Object.keys(frame))}`);
});

test('P12 (§2.4): pasar un elemento de válido a inválido cambia fingerprint', () => {
  const doc = makeDom('<form><input id="c" aria-label="Cuenta"><button>Guardar</button></form>');
  const root = doc.body;
  const antes = serializeFrame(root, {});
  assert.equal(typeof antes.fingerprint, 'string', 'precondición: serializeFrame devuelve fingerprint');

  doc.getElementById('c').setAttribute('aria-invalid', 'true');
  const despues = serializeFrame(root, {});
  assert.notEqual(despues.fingerprint, antes.fingerprint, 'P12: invalid participa de la huella');
});
