/**
 * act-disabled.test.js — fb-020-001-act-occlusion-honesty (sub-fase RED).
 *
 * Verifica P1–P17 de docs/specs/fb-020-001-act-occlusion-honesty/spec.md §3
 * (honestidad de `ok` en `act` ante controles deshabilitados, §2.2–§2.5).
 * P14 y P15 cubren sólo la mitad con `force` (la mitad sin `force` ya está en
 * PC11 y PC7–PC10 de act.test.js; test-audit.md §Mapeo).
 *
 * Escrito sólo contra la superficie pública: performAction(el, action, value,
 * options) y resolveRef(ref, root). El test-writer no leyó el código de
 * producción. Import estático: una falla de import es una falla, no un skip.
 *
 * "Sin efecto" (§3): 0 invocaciones de listeners click/input/change/focus
 * registrados en el documento (en captura, porque focus no burbujea), `.value`
 * y `document.activeElement` iguales a antes, y `outerHTML` del body idéntico.
 *
 * Naturaleza RED esperada:
 *  · Fallan por AssertionError (hoy act despacha y responde {ok:true}):
 *    P1, P2, P3, P4, P6, P7, P8, P10, P12, P13, P16, P17.
 *  · Pines que pasan ya en RED: P5, P9, P11, P14 (force), P15 (force).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { performAction } from './act.js';
import { resolveRef } from './resolver.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

const TIPOS = ['click', 'input', 'change', 'focus'];

/**
 * Ejecuta un caso: arma el DOM, aplica `preparar` (p. ej. foco previo), toma la
 * foto de "antes", registra los listeners en captura y llama a performAction.
 */
function ejecutar(caso) {
  const doc = makeDom(caso.html);
  const el = caso.ref !== undefined ? resolveRef(caso.ref, doc.body) : doc.getElementById(caso.id);
  if (caso.preparar) caso.preparar(doc, el);
  const antes = {
    value: el && 'value' in el ? el.value : undefined,
    active: doc.activeElement,
    html: doc.body.outerHTML,
  };
  const counts = { click: 0, input: 0, change: 0, focus: 0 };
  for (const t of TIPOS) doc.addEventListener(t, () => counts[t]++, true);
  const res =
    caso.opciones === undefined
      ? performAction(el, caso.accion, caso.valor)
      : performAction(el, caso.accion, caso.valor, caso.opciones);
  return { res, doc, el, antes, counts };
}

function assertSinEfecto({ doc, el, antes, counts }, etiqueta) {
  for (const t of TIPOS) {
    assert.equal(counts[t], 0, `${etiqueta}: el listener de ${t} no debe correr (sin efecto, §3)`);
  }
  if (el && 'value' in el) {
    assert.equal(el.value, antes.value, `${etiqueta}: .value no cambia`);
  }
  assert.equal(doc.activeElement, antes.active, `${etiqueta}: document.activeElement no cambia`);
  assert.equal(doc.body.outerHTML, antes.html, `${etiqueta}: outerHTML del body idéntico`);
}

function assertDisabled(res, etiqueta) {
  assert.equal(res.ok, false, `${etiqueta}: control deshabilitado → ok:false; recibido ${JSON.stringify(res)}`);
  assert.equal(res.disabled, true, `${etiqueta}: → disabled:true; recibido ${JSON.stringify(res)}`);
}

function assertEsDisabledHtml(el, etiqueta) {
  assert.ok(el, `precondición ${etiqueta}: el elemento existe`);
  assert.equal(el.matches(':disabled'), true, `precondición ${etiqueta}: el control matchea :disabled`);
}

function focoEnOtro(doc) {
  doc.getElementById('otro').focus();
  assert.equal(doc.activeElement, doc.getElementById('otro'), 'precondición: el foco está en otro elemento habilitado');
}

// Fixture de diálogo modal: markup real de Odoo 19 (precedente dialogo-inerte.test.js
// HTML_ODOO), con un control deshabilitado en el fondo y otro dentro del diálogo.
const HTML_MODAL =
  '<div class="o_content">' +
  '<button id="fondo-deshab" disabled>Guardar</button>' +
  '<input value="ACME">' +
  '</div>' +
  '<div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
  '<div class="modal-dialog modal-dialog-centered modal-xl">' +
  '<div class="modal-content">' +
  '<header class="modal-header"><h4 class="modal-title">Crear Contacto</h4></header>' +
  '<main class="modal-body"><p>Complete los datos.</p></main>' +
  '<footer class="modal-footer"><button id="dlg-deshab" disabled>Confirmar</button><button>Cerrar</button></footer>' +
  '</div></div></div>';

const FORCE = { force: true };

// ── casos (reusados por P17) ────────────────────────────────────────────────

const CASOS = {
  p1Button: { html: '<main><button id="x" disabled>Registrar</button></main>', id: 'x', accion: 'click' },
  p2Input: { html: '<main><input id="x" value="v0" disabled></main>', id: 'x', accion: 'click' },
  p2Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'click',
  },
  p2Textarea: { html: '<main><textarea id="x" disabled>t0</textarea></main>', id: 'x', accion: 'click' },
  p3Markup: { html: '<main><button id="x" disabled="disabled">Go</button></main>', id: 'x', accion: 'click' },
  p3Propiedad: {
    html: '<main><button id="x">Go</button></main>',
    id: 'x',
    accion: 'click',
    preparar: (doc, el) => {
      el.disabled = true;
    },
  },
  p4Button: {
    html: '<form><fieldset disabled><legend>Datos</legend><button id="x" type="button">Go</button></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p4Input: {
    html: '<form><fieldset disabled><legend>Datos</legend><input id="x" type="checkbox"></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p5Legend: {
    html: '<form><fieldset disabled><legend><button id="x" type="button">En legend</button></legend><input></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p6Input: { html: '<main><input id="x" value="orig" disabled></main>', id: 'x', accion: 'type', valor: 'nuevo' },
  p6TextareaFieldset: {
    html: '<form><fieldset disabled><legend>L</legend><textarea id="x">orig</textarea></fieldset></form>',
    id: 'x',
    accion: 'type',
    valor: 'nuevo',
  },
  p7Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'b',
  },
  p8Focus: {
    html: '<main><input id="otro"><input id="x" disabled></main>',
    id: 'x',
    accion: 'focus',
    preparar: (doc) => focoEnOtro(doc),
  },
  p9Type: { html: '<main><button id="x" disabled>Go</button></main>', id: 'x', accion: 'type', valor: 'hola' },
  p9Desconocida: { html: '<main><button id="x" disabled>Go</button></main>', id: 'x', accion: 'frobnicar' },
  p10Click: {
    html: '<main><button id="x" disabled>Go</button></main>',
    id: 'x',
    accion: 'click',
    opciones: FORCE,
  },
  p10Type: {
    html: '<main><input id="x" value="orig" disabled></main>',
    id: 'x',
    accion: 'type',
    valor: 'nuevo',
    opciones: FORCE,
  },
  p10Focus: {
    html: '<main><input id="otro"><input id="x" disabled></main>',
    id: 'x',
    accion: 'focus',
    opciones: FORCE,
    preparar: (doc) => focoEnOtro(doc),
  },
  p10Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'b',
    opciones: FORCE,
  },
  p11Fondo: { html: HTML_MODAL, id: 'fondo-deshab', accion: 'click' },
  p12FondoForce: { html: HTML_MODAL, id: 'fondo-deshab', accion: 'click', opciones: FORCE },
  p13Dialogo: { html: HTML_MODAL, id: 'dlg-deshab', accion: 'click' },
  p13DialogoForce: { html: HTML_MODAL, id: 'dlg-deshab', accion: 'click', opciones: FORCE },
  p14StaleForce: {
    html: '<main><button>x</button></main>',
    ref: 'main>input',
    accion: 'click',
    opciones: FORCE,
  },
  p15Click: { html: '<main><button id="x">Go</button></main>', id: 'x', accion: 'click', opciones: FORCE },
  p15Type: { html: '<main><input id="x"></main>', id: 'x', accion: 'type', valor: 'hola', opciones: FORCE },
  p15Focus: { html: '<main><input id="x"></main>', id: 'x', accion: 'focus', opciones: FORCE },
  p15Select: {
    html: '<main><select id="x"><option value="a">A</option><option value="v">V</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'v',
    opciones: FORCE,
  },
  inaplicableHabilitado: { html: '<main><button id="x">Go</button></main>', id: 'x', accion: 'type', valor: 'hola' },
};

// ── §3.1 Rechazo por control deshabilitado ──────────────────────────────────

test('P1: act click sobre <button disabled> responde ok:false con disabled:true, sin efecto', () => {
  const r = ejecutar(CASOS.p1Button);
  assertEsDisabledHtml(r.el, 'P1');
  assertDisabled(r.res, 'P1');
  assertSinEfecto(r, 'P1');
});

test('P2: act click sobre <input|select|textarea disabled> responde ok:false con disabled:true, sin efecto', () => {
  for (const [nombre, caso] of [
    ['input', CASOS.p2Input],
    ['select', CASOS.p2Select],
    ['textarea', CASOS.p2Textarea],
  ]) {
    const r = ejecutar(caso);
    assertEsDisabledHtml(r.el, `P2 ${nombre}`);
    assertDisabled(r.res, `P2 ${nombre}`);
    assertSinEfecto(r, `P2 ${nombre}`);
  }
});

test('P3: el rechazo es el mismo con disabled="disabled" en el markup y con el.disabled = true posterior', () => {
  const markup = ejecutar(CASOS.p3Markup);
  assertEsDisabledHtml(markup.el, 'P3 markup');
  assertDisabled(markup.res, 'P3 markup');
  assertSinEfecto(markup, 'P3 markup');

  const prop = ejecutar(CASOS.p3Propiedad);
  assert.equal(prop.el.hasAttribute('disabled'), true, 'precondición P3: la propiedad dejó el control deshabilitado');
  assertEsDisabledHtml(prop.el, 'P3 propiedad');
  assertDisabled(prop.res, 'P3 propiedad');
  assertSinEfecto(prop, 'P3 propiedad');

  assert.deepEqual(prop.res, markup.res, 'P3: misma respuesta por ambos caminos');
});

test('P4: act click sobre <button>/<input> dentro de <fieldset disabled> (fuera del legend) responde disabled:true, sin efecto', () => {
  for (const [nombre, caso] of [
    ['button', CASOS.p4Button],
    ['input', CASOS.p4Input],
  ]) {
    const doc = makeDom(caso.html);
    const el = doc.getElementById(caso.id);
    assert.equal(el.disabled, false, `precondición P4 ${nombre}: la propiedad disabled del control es false`);
    assert.equal(el.matches(':disabled'), true, `precondición P4 ${nombre}: el control matchea :disabled por el fieldset`);

    const r = ejecutar(caso);
    assertDisabled(r.res, `P4 ${nombre}`);
    assertSinEfecto(r, `P4 ${nombre}`);
    if (nombre === 'input') {
      assert.equal(r.el.checked, false, 'P4 input: el checkbox del fixture (sin checked) sigue sin marcar');
    }
  }
});

test('P5: act click sobre <button> dentro del primer <legend> de <fieldset disabled> responde exactamente {ok:true} y el listener corre una vez', () => {
  const doc = makeDom(CASOS.p5Legend.html);
  assert.equal(
    doc.getElementById('x').matches(':disabled'),
    false,
    'precondición P5: el botón del legend no matchea :disabled',
  );
  const r = ejecutar(CASOS.p5Legend);
  assert.deepEqual(r.res, { ok: true }, 'P5: HTML no lo considera deshabilitado');
  assert.equal(r.counts.click, 1, 'P5: el listener de click corrió una vez');
});

test('P6: act type sobre <input disabled> y sobre <textarea> en <fieldset disabled> responde disabled:true; .value igual, sin input/change', () => {
  for (const [nombre, caso] of [
    ['input disabled', CASOS.p6Input],
    ['textarea en fieldset', CASOS.p6TextareaFieldset],
  ]) {
    const r = ejecutar(caso);
    assertEsDisabledHtml(r.el, `P6 ${nombre}`);
    assert.equal(r.antes.value, 'orig', `precondición P6 ${nombre}: valor inicial`);
    assertDisabled(r.res, `P6 ${nombre}`);
    assert.equal(r.el.value, 'orig', `P6 ${nombre}: el .value no cambia`);
    assert.equal(r.counts.input, 0, `P6 ${nombre}: no se dispara input`);
    assert.equal(r.counts.change, 0, `P6 ${nombre}: no se dispara change`);
    assertSinEfecto(r, `P6 ${nombre}`);
  }
});

test('P7: act select con valor existente sobre <select disabled> responde disabled:true; valor igual, sin change', () => {
  const r = ejecutar(CASOS.p7Select);
  assertEsDisabledHtml(r.el, 'P7');
  assert.equal(r.antes.value, 'a', 'precondición P7: seleccionada la opción a');
  assertDisabled(r.res, 'P7');
  assert.equal(r.el.value, 'a', 'P7: el valor seleccionado no cambia');
  assert.equal(r.counts.change, 0, 'P7: no se dispara change');
  assertSinEfecto(r, 'P7');
});

test('P8: con foco previo en otro elemento, act focus sobre un control deshabilitado responde disabled:true y el foco sigue en el otro', () => {
  const r = ejecutar(CASOS.p8Focus);
  const otro = r.doc.getElementById('otro');
  assertEsDisabledHtml(r.el, 'P8');
  assert.equal(r.antes.active, otro, 'precondición P8: antes de act el foco está en el otro elemento');
  assertDisabled(r.res, 'P8');
  assert.equal(r.doc.activeElement, otro, 'P8: document.activeElement sigue siendo el otro elemento');
  assertSinEfecto(r, 'P8');
});

test('P9: type y acción desconocida sobre <button disabled> responden ok:false con error de acción inaplicable, sin la clave disabled, sin efecto', () => {
  for (const [nombre, caso] of [
    ['type', CASOS.p9Type],
    ['acción desconocida', CASOS.p9Desconocida],
  ]) {
    let r;
    assert.doesNotThrow(() => {
      r = ejecutar(caso);
    }, `P9 ${nombre}: act no lanza`);
    assertEsDisabledHtml(r.el, `P9 ${nombre}`);
    assert.equal(r.res.ok, false, `P9 ${nombre}: ok:false; recibido ${JSON.stringify(r.res)}`);
    assert.ok(
      typeof r.res.error === 'string' && r.res.error.length > 0,
      `P9 ${nombre}: error no vacío; recibido ${JSON.stringify(r.res)}`,
    );
    assert.equal('disabled' in r.res, false, `P9 ${nombre}: la aplicabilidad precede al guard, sin la clave disabled`);
    assertSinEfecto(r, `P9 ${nombre}`);
  }
});

// ── §3.2 force y orden de guards ────────────────────────────────────────────

test('P10: con force:true y sin diálogo, click/type/focus/select sobre controles deshabilitados responden disabled:true, sin efecto', () => {
  for (const [nombre, caso] of [
    ['click', CASOS.p10Click],
    ['type', CASOS.p10Type],
    ['focus', CASOS.p10Focus],
    ['select', CASOS.p10Select],
  ]) {
    const r = ejecutar(caso);
    assertEsDisabledHtml(r.el, `P10 ${nombre}`);
    assertDisabled(r.res, `P10 ${nombre} con force`);
    assertSinEfecto(r, `P10 ${nombre} con force`);
  }
});

test('P11: sin force, un control deshabilitado del fondo de un diálogo modal responde inert:true sin la clave disabled', () => {
  const r = ejecutar(CASOS.p11Fondo);
  assertEsDisabledHtml(r.el, 'P11');
  assert.equal(r.res.ok, false, `P11: ok:false; recibido ${JSON.stringify(r.res)}`);
  assert.equal(r.res.inert, true, `P11: la respuesta de fb-018-004 no cambia (inert:true); recibido ${JSON.stringify(r.res)}`);
  assert.equal('disabled' in r.res, false, 'P11: sin la clave disabled');
  assertSinEfecto(r, 'P11');
});

test('P12: con force:true, el control deshabilitado del fondo responde disabled:true sin la clave inert, sin efecto', () => {
  const r = ejecutar(CASOS.p12FondoForce);
  assertEsDisabledHtml(r.el, 'P12');
  assertDisabled(r.res, 'P12');
  assert.equal('inert' in r.res, false, 'P12: force saltea inert, sin la clave inert');
  assertSinEfecto(r, 'P12');
});

test('P13: un control deshabilitado dentro del diálogo modal activo responde disabled:true, con y sin force', () => {
  for (const [nombre, caso] of [
    ['sin force', CASOS.p13Dialogo],
    ['con force', CASOS.p13DialogoForce],
  ]) {
    if (caso.opciones === undefined) {
      // Precondición local (no vacuidad): sobre un DOM nuevo con el mismo fixture, un
      // control habilitado del fondo responde inert:true sin force, o sea el diálogo se
      // detecta como modal. DOM aparte: no contamina el "antes" del caso verificado.
      const docPre = makeDom(caso.html);
      const fondoHabilitado = docPre.querySelector('.o_content input');
      assert.ok(fondoHabilitado, 'precondición P13 sin force: existe un control habilitado en el fondo');
      assert.equal(fondoHabilitado.matches(':disabled'), false, 'precondición P13 sin force: el control del fondo está habilitado');
      const pre = performAction(fondoHabilitado, 'click');
      assert.equal(
        pre.inert,
        true,
        `precondición P13 sin force: el fixture debe detectarse como diálogo modal (fondo habilitado → inert:true); recibido ${JSON.stringify(pre)}`,
      );
    }
    const r = ejecutar(caso);
    assertEsDisabledHtml(r.el, `P13 ${nombre}`);
    assertDisabled(r.res, `P13 ${nombre}`);
    assertSinEfecto(r, `P13 ${nombre}`);
  }
});

test('P14: con force:true, un ref que no resuelve responde exactamente {ok:false, stale:true}', () => {
  const r = ejecutar(CASOS.p14StaleForce);
  assert.equal(r.el, null, 'precondición P14: el ref no resuelve');
  assert.deepEqual(r.res, { ok: false, stale: true }, 'P14: stale con force');
  assertSinEfecto(r, 'P14');
});

// ── §3.3 Regresión y forma ──────────────────────────────────────────────────

test('P15: con force:true, fuera de diálogo, click/type/focus/select sobre controles habilitados responden {ok:true} con el efecto de hoy', () => {
  const click = ejecutar(CASOS.p15Click);
  assert.deepEqual(click.res, { ok: true }, 'P15 click con force');
  assert.equal(click.counts.click, 1, 'P15 click: listener una vez');

  const type = ejecutar(CASOS.p15Type);
  assert.deepEqual(type.res, { ok: true }, 'P15 type con force');
  assert.equal(type.el.value, 'hola', 'P15 type: .value escrito');
  assert.equal(type.counts.input, 1, 'P15 type: input disparado');
  assert.equal(type.counts.change, 1, 'P15 type: change disparado');

  const focus = ejecutar(CASOS.p15Focus);
  assert.deepEqual(focus.res, { ok: true }, 'P15 focus con force');
  assert.equal(focus.doc.activeElement, focus.el, 'P15 focus: el control recibe el foco');

  const select = ejecutar(CASOS.p15Select);
  assert.deepEqual(select.res, { ok: true }, 'P15 select con force');
  assert.equal(select.el.value, 'v', 'P15 select: opción seleccionada');
  assert.equal(select.counts.change, 1, 'P15 select: change disparado');
});

test('P16: la respuesta disabled trae error string no vacío, de una línea, sin la palabra force', () => {
  for (const [nombre, caso] of [
    ['P1', CASOS.p1Button],
    ['P4 button en fieldset', CASOS.p4Button],
    ['P6', CASOS.p6Input],
    ['P6 textarea en fieldset', CASOS.p6TextareaFieldset],
    ['P7', CASOS.p7Select],
    ['P8', CASOS.p8Focus],
    ['P10 click', CASOS.p10Click],
    ['P12', CASOS.p12FondoForce],
    ['P13', CASOS.p13DialogoForce],
  ]) {
    const { res } = ejecutar(caso);
    assert.equal(res.disabled, true, `precondición P16 ${nombre}: respuesta disabled; recibido ${JSON.stringify(res)}`);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, `P16 ${nombre}: error string no vacío`);
    assert.ok(!res.error.includes('\n'), `P16 ${nombre}: error de una sola línea`);
    assert.ok(!res.error.includes('force'), `P16 ${nombre}: el mensaje no menciona force: ${res.error}`);
  }
});

test('P17: forma de ActResponse (§2.4) sobre las respuestas de P1–P15 y de una acción inaplicable a un control habilitado', () => {
  const CLAVES = new Set(['ok', 'stale', 'inert', 'disabled', 'error']);
  const respuestas = Object.entries(CASOS).map(([nombre, caso]) => [nombre, ejecutar(caso).res]);

  for (const [nombre, res] of respuestas) {
    const json = JSON.stringify(res);
    assert.equal(typeof res, 'object', `${nombre}: ActResponse es un objeto`);
    assert.equal(typeof res.ok, 'boolean', `${nombre}: ok es booleano; recibido ${json}`);
    for (const k of Object.keys(res)) {
      assert.ok(CLAVES.has(k), `${nombre}: clave ${k} fuera del conjunto cerrado {ok, stale, inert, disabled, error}; recibido ${json}`);
    }
    if (res.ok === true) {
      assert.deepEqual(res, { ok: true }, `${nombre}: ok:true ⇒ exactamente {ok:true}`);
    } else {
      const booleanos = [res.stale === true, res.inert === true, res.disabled === true].filter(Boolean).length;
      assert.ok(booleanos <= 1, `${nombre}: ok:false ⇒ a lo sumo un true entre stale|inert|disabled; recibido ${json}`);
      if (booleanos === 0) {
        assert.ok(
          typeof res.error === 'string' && res.error.length > 0,
          `${nombre}: ok:false sin booleano ⇒ error string no vacío; recibido ${json}`,
        );
      }
    }
  }

  // Guarda de no-vacuidad: el recorrido tiene que incluir respuestas disabled e inert.
  const conDisabled = respuestas.filter(([, r]) => r.disabled === true).length;
  const conInert = respuestas.filter(([, r]) => r.inert === true).length;
  assert.ok(conDisabled > 0, `P17: el recorrido debe incluir al menos una respuesta disabled:true (recibidas ${conDisabled})`);
  assert.ok(conInert > 0, `P17: el recorrido debe incluir al menos una respuesta inert:true (recibidas ${conInert})`);
});
