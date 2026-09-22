/**
 * caso-real-type-value.test.js — fb-020-004 (sub-fase RED).
 *
 * Verifica P5 de docs/specs/fb-020-004/spec.md §3
 * (contrato §2.2: defensa en profundidad de `act` ante `value` null/undefined).
 *
 * Escrito SOLO contra la superficie pública performActionAndObserve(el, action,
 * value, opts) exportada por ./index.js (mismo patrón que act-observe.test.js:
 * import dinámico con guard). Aislamiento anti-trampa: no se leyó act.js,
 * index.js, settle.js ni background.js.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  · FALLAN por AssertionError: P5 type (undefined/null) y P5 select
 *    (undefined/null). Hoy `type` sin value escribe '' (causa de F1, spec §1),
 *    así que falla el `ok:false`; en select falla `ok:false` o el value/eventos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  errorDeCarga = e;
}

function api(id) {
  const fn = frame?.performActionAndObserve;
  assert.equal(
    typeof fn,
    'function',
    `performActionAndObserve no exportada por ./index.js — ${id}` +
      (errorDeCarga ? `; ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

function contarEventos(el) {
  const cuenta = { input: 0, change: 0 };
  el.addEventListener('input', () => cuenta.input++);
  el.addEventListener('change', () => cuenta.change++);
  return cuenta;
}

const OPTS = { waitMs: 300, quietMs: 50 };

for (const valor of [undefined, null]) {
  test(`P5 (§2.2): type con value ${valor} → ok:false con error, el.value intacto y cero eventos input/change`, async () => {
    const observe = api('P5 type');
    const doc = makeDom('<main><input id="x" aria-label="Referencia" value="previo"></main>');
    const el = doc.getElementById('x');
    const eventos = contarEventos(el);

    const res = await observe(el, 'type', valor, OPTS);
    const json = JSON.stringify(res);
    assert.equal(res.ok, false, `P5: type sin value ⇒ ok:false; recibido ${json}`);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, `P5: trae error no vacío; recibido ${json}`);
    assert.equal(el.value, 'previo', 'P5: el.value no cambia (no se vacía el campo, F1)');
    assert.equal(eventos.input, 0, 'P5: cero eventos input');
    assert.equal(eventos.change, 0, 'P5: cero eventos change');
  });

  test(`P5 (§2.2): select con value ${valor} → ok:false con error, el.value intacto y cero eventos input/change`, async () => {
    const observe = api('P5 select');
    const doc = makeDom(
      '<main><select id="s" aria-label="Diario">' +
        '<option value="a">Alfa</option><option value="b" selected>Beta</option><option value="">Vacío</option>' +
        '</select></main>',
    );
    const el = doc.getElementById('s');
    const eventos = contarEventos(el);

    const res = await observe(el, 'select', valor, OPTS);
    const json = JSON.stringify(res);
    assert.equal(res.ok, false, `P5: select sin value ⇒ ok:false; recibido ${json}`);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, `P5: trae error no vacío; recibido ${json}`);
    assert.equal(el.value, 'b', 'P5: el.value no cambia');
    assert.equal(eventos.input, 0, 'P5: cero eventos input');
    assert.equal(eventos.change, 0, 'P5: cero eventos change');
  });
}
