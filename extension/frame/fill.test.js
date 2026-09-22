/**
 * fill.test.js — fb-020-002-type-commit-cycle v2, componente C1 (sub-fase RED).
 *
 * Verifica P12–P14 de docs/specs/fb-020-002-type-commit-cycle/spec.md §3.2
 * (performFill), con la semántica de §2.3 y la forma de §2.2.
 * T1: jsdom con timers REALES cortos.
 *
 * Superficie pública del spec §2.1:
 *   performFill(el, value, {waitMs?, quietMs?}) → Promise
 * exportada por ./index.js. performAction (./act.js) sólo se usa para la
 * precondición de no-vacuidad de P14. El test-writer no leyó código de producción.
 *
 * Forma: performFill no recibe selector; `selector` de §2.2 lo agrega la capa de la
 * tool. Por eso no se hace deepEqual de la respuesta: se asertan los campos que
 * nombran P12/P13.
 *
 * Guard de RED: import dinámico de ./index.js con catch (precedente
 * settle.test.js:62-71) y `api(id)` al inicio de cada test ⇒ hoy todos fallan por
 * AssertionError "performFill no exportada (RED)".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { performAction } from './act.js';

// ── Guard de RED ────────────────────────────────────────────────────────────
let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  frame = null;
  errorDeCarga = e;
}

function api(id) {
  const fn = frame?.performFill;
  assert.equal(
    typeof fn,
    'function',
    `performFill no exportada (RED) por ./index.js — ${id} de fb-020-002` +
      (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MARGEN = 30;

function estadoA(p, ms) {
  return Promise.race([p.then(() => 'resuelta', () => 'rechazada'), sleep(ms).then(() => 'pendiente')]);
}

// ── P12: escritura, eventos y observación ───────────────────────────────────

test('P12 (escritura): input habilitado ⇒ .value es el texto, input y change una vez cada uno y burbujeantes, {success:true, value, settled, waitedMs}', async () => {
  const fill = api('P12');
  const doc = makeDom('<main><input id="x" value="orig" aria-label="campo"></main>');
  const el = doc.getElementById('x');
  const enElemento = { input: 0, change: 0 };
  const enDocumento = { input: 0, change: 0 };
  const bubbles = { input: [], change: [] };
  for (const t of ['input', 'change']) {
    el.addEventListener(t, (e) => {
      enElemento[t]++;
      bubbles[t].push(e.bubbles);
    });
    // SIN capture: sólo lo recibe si el evento burbujea.
    doc.addEventListener(t, () => {
      enDocumento[t]++;
    });
  }
  let valorAlResolver;
  const res = await Promise.resolve(fill(el, 'Nuevo texto', { waitMs: 2000, quietMs: 80 })).then((r) => {
    valorAlResolver = el.value;
    return r;
  });
  const json = JSON.stringify(res);
  assert.equal(el.value, 'Nuevo texto', 'P12: .value pasa a ser el texto');
  for (const t of ['input', 'change']) {
    assert.equal(enElemento[t], 1, `P12: ${t} se dispara exactamente una vez (hubo ${enElemento[t]})`);
    assert.deepEqual(bubbles[t], [true], `P12: ${t} con bubbles:true; recibido ${JSON.stringify(bubbles[t])}`);
    assert.equal(enDocumento[t], 1, `P12: ${t} llega a un listener sin capture en document (burbujea); hubo ${enDocumento[t]}`);
  }
  assert.equal(res.success, true, `P12: success:true; recibido ${json}`);
  assert.equal(typeof res.value, 'string', `P12: value es string; recibido ${json}`);
  assert.equal(res.value, valorAlResolver, `P12: value === el.value al resolver; recibido ${json}`);
  assert.equal(res.value, 'Nuevo texto', `P12: value es el texto escrito (sin cambios posteriores, I-5); recibido ${json}`);
  assert.equal(typeof res.settled, 'boolean', `P12: settled booleano; recibido ${json}`);
  assert.ok(Number.isInteger(res.waitedMs) && res.waitedMs >= 0, `P12: waitedMs entero ≥ 0; recibido ${json}`);
});

test('P12 (caso representativo, como P3): cambio SÓLO de la propiedad value a los t ms ⇒ no resuelve antes de t+quietMs y value lo refleja', async () => {
  const fill = api('P12');
  const T = 100;
  const QUIET = 150;
  const doc = makeDom('<main><input id="x" aria-label="campo"></main>');
  const el = doc.getElementById('x');
  // Timer programado inmediatamente antes de la llamada (la escritura ocurre dentro de ella).
  const cambio = setTimeout(() => {
    el.value = 'nuevo';
  }, T);
  try {
    const p = Promise.resolve(fill(el, 'abc', { waitMs: 3000, quietMs: QUIET }));
    const estado = await estadoA(p, T + QUIET - MARGEN);
    assert.equal(
      estado,
      'pendiente',
      `P12: piso t+quietMs = ${T + QUIET} ms; a los ${T + QUIET - MARGEN} ms (margen ${MARGEN}) debe seguir pendiente (§2.3.1)`,
    );
    const res = await p;
    const json = JSON.stringify(res);
    assert.equal(el.value, 'nuevo', 'precondición P12: el cambio de propiedad ocurrió');
    assert.equal(res.success, true, `P12: success:true; recibido ${json}`);
    assert.equal(res.settled, true, `P12: tras la ventana completa desde el cambio ⇒ settled:true; recibido ${json}`);
    assert.equal(res.value, 'nuevo', `P12: value refleja el valor asignado por propiedad; recibido ${json}`);
  } finally {
    clearTimeout(cambio);
  }
});

// ── P13: guard disabled ─────────────────────────────────────────────────────

test('P13: <input disabled> y <textarea> en <fieldset disabled> ⇒ {success:false, disabled:true, error} de una línea sin "force"; .value igual, sin input/change', async () => {
  const fill = api('P13');
  for (const [nombre, html] of [
    ['input disabled', '<main><input id="x" value="orig" disabled></main>'],
    ['textarea en fieldset disabled', '<form><fieldset disabled><legend>L</legend><textarea id="x">orig</textarea></fieldset></form>'],
  ]) {
    const doc = makeDom(html);
    const el = doc.getElementById('x');
    assert.equal(el.matches(':disabled'), true, `precondición P13 ${nombre}: el control matchea :disabled`);
    assert.equal(el.value, 'orig', `precondición P13 ${nombre}: valor inicial`);
    const counts = { input: 0, change: 0 };
    // En captura sobre document: ve el evento aunque no burbujee.
    for (const t of ['input', 'change']) doc.addEventListener(t, () => counts[t]++, true);

    const res = await fill(el, 'nuevo', { waitMs: 1000, quietMs: 80 });
    const json = JSON.stringify(res);
    assert.equal(res.success, false, `P13 ${nombre}: success:false; recibido ${json}`);
    assert.equal(res.disabled, true, `P13 ${nombre}: disabled:true; recibido ${json}`);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, `P13 ${nombre}: error string no vacío; recibido ${json}`);
    assert.ok(!res.error.includes('\n'), `P13 ${nombre}: error de una sola línea; recibido ${json}`);
    assert.ok(!res.error.includes('force'), `P13 ${nombre}: el error no menciona force; recibido ${json}`);
    for (const k of ['value', 'settled', 'waitedMs', 'detached']) {
      assert.equal(k in res, false, `P13 ${nombre}: la respuesta disabled no trae la clave de observación ${k} (§2.2); recibido ${json}`);
    }
    assert.equal(el.value, 'orig', `P13 ${nombre}: .value no cambia`);
    assert.equal(counts.input, 0, `P13 ${nombre}: no se dispara input`);
    assert.equal(counts.change, 0, `P13 ${nombre}: no se dispara change`);
  }
});

// ── P14: fill no aplica inert ───────────────────────────────────────────────

// Duplicado de dialogo-inerte.test.js (no exportado): markup real de Odoo 19 con
// fondo accionable y diálogo modal activo.
const HTML_ODOO =
  '<div class="o_content">' +
  '<ol class="breadcrumb"><li><a href="#recepciones">Recepciones</a></li></ol>' +
  '<button>Validar</button>' +
  '<input value="ACME">' +
  '<select><option value="a">Alfa</option><option value="b">Beta</option></select>' +
  '</div>' +
  '<div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
  '<div class="modal-dialog modal-dialog-centered modal-xl">' +
  '<div class="modal-content o_error_dialog">' +
  '<header class="modal-header"><h4 class="modal-title text-break flex-grow-1">Operación no válida</h4>' +
  '<button type="button" class="btn-close" aria-label="Cerrar el diálogo" tabindex="-1"></button></header>' +
  '<main class="modal-body"><div role="alert"><p class="text-prewrap">Solo puede devolver los albaranes.</p></div></main>' +
  '<footer class="modal-footer"><button>Cerrar</button></footer>' +
  '</div></div></div>';

test('P14: input habilitado en el fondo de un diálogo modal activo ⇒ success:true y el valor escrito (fill no aplica inert)', async () => {
  const fill = api('P14');

  // Precondición de no-vacuidad (patrón act-disabled.test.js:373-382), en DOM aparte:
  // el mismo input responde inert:true a performAction sin force, o sea el fixture
  // se detecta como diálogo modal y el guard inert existiría para act.
  const docPre = makeDom(HTML_ODOO);
  const fondoPre = docPre.querySelector('.o_content input');
  assert.ok(fondoPre, 'precondición P14: existe el input del fondo');
  assert.equal(fondoPre.matches(':disabled'), false, 'precondición P14: el input del fondo está habilitado');
  const pre = performAction(fondoPre, 'click');
  assert.equal(
    pre.inert,
    true,
    `precondición P14: el fixture debe detectarse como diálogo modal (performAction sin force ⇒ inert:true); recibido ${JSON.stringify(pre)}`,
  );

  const doc = makeDom(HTML_ODOO);
  const el = doc.querySelector('.o_content input');
  const res = await fill(el, 'Globex', { waitMs: 2000, quietMs: 80 });
  const json = JSON.stringify(res);
  assert.equal(res.success, true, `P14: fill no aplica inert ⇒ success:true; recibido ${json}`);
  assert.equal(el.value, 'Globex', 'P14: el valor quedó escrito en el input del fondo');
  assert.equal(res.value, 'Globex', `P14: la respuesta trae el valor escrito; recibido ${json}`);
});
