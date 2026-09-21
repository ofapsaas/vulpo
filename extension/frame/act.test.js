/**
 * act.test.js — fb-017-002 frame-map-api (sub-fase RED). PC7–PC13.
 * Verifica el contrato observable de performAction(el, action, value) →
 * ActResponse sobre jsdom: disparo de eventos, efectos sobre valor/foco,
 * stale y error, y el shape del ActResponse (I3).
 * El módulo act.js no existe aún → RED por error de import (documentado).
 * PC11 (stale) se verifica pasando a performAction el null que produce un ref
 * no resoluble (resolveRef → null): el contrato de "act sobre un ref que no
 * resuelve". PC13 asegura shape: ok booleano; ok:false ⇒ a lo sumo un true entre
 * stale|inert|disabled, error puede acompañar, error no vacío si no hay ninguno
 * (fb-020-001 §2.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { performAction } from './act.js';
import { resolveRef } from './resolver.js';

function makeDom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

test('PC7: performAction(el, "click") dispara el listener de click y devuelve {ok:true}', () => {
  const doc = makeDom('<main><button id="b">Go</button></main>');
  const btn = doc.getElementById('b');
  let clicks = 0;
  btn.addEventListener('click', () => clicks++);
  const res = performAction(btn, 'click');
  assert.deepEqual(res, { ok: true });
  assert.equal(clicks, 1, 'el listener de click se ejecutó una vez');
  // fb-020-001 P17: ok:true must not have disabled/inert/stale/error
  assert.equal(res.disabled, undefined, 'ok:true must not have disabled');
  assert.equal(res.inert, undefined, 'ok:true must not have inert');
  assert.equal(res.stale, undefined, 'ok:true must not have stale');
  assert.equal(res.error, undefined, 'ok:true must not have error');
});

test('PC8: performAction(input, "type", "hola") setea value y dispara input+change burbujeantes', () => {
  const doc = makeDom('<main><input id="i"></main>');
  const input = doc.getElementById('i');
  let inputCount = 0;
  let changeCount = 0;
  doc.body.addEventListener('input', () => inputCount++);
  doc.body.addEventListener('change', () => changeCount++);
  const res = performAction(input, 'type', 'hola');
  assert.equal(input.value, 'hola', 'value seteado');
  assert.equal(inputCount, 1, 'evento input disparado y burbujeado al ancestro');
  assert.equal(changeCount, 1, 'evento change disparado y burbujeado al ancestro');
  assert.deepEqual(res, { ok: true });
});

test('PC9: performAction(el, "focus") enfoca el elemento y devuelve {ok:true}', () => {
  const doc = makeDom('<main><input id="i"></main>');
  const input = doc.getElementById('i');
  const res = performAction(input, 'focus');
  assert.equal(doc.activeElement, input, 'el input es el activeElement');
  assert.deepEqual(res, { ok: true });
});

test('PC10: performAction(select, "select", "v") setea el valor y dispara change', () => {
  const doc = makeDom(
    '<main><select id="s"><option value="a">A</option><option value="v">V</option></select></main>',
  );
  const select = doc.getElementById('s');
  let changeCount = 0;
  select.addEventListener('change', () => changeCount++);
  const res = performAction(select, 'select', 'v');
  assert.equal(select.value, 'v', 'el select quedó en la opción value="v"');
  assert.equal(changeCount, 1, 'evento change disparado');
  assert.deepEqual(res, { ok: true });
});

test('PC11: act sobre un ref que no resuelve devuelve {ok:false, stale:true} y no dispara nada', () => {
  const doc = makeDom('<main><button id="b">x</button></main>');
  let clicks = 0;
  doc.body.addEventListener('click', () => clicks++);
  // El path de "mapa stale": el agente intenta actuar sobre un ref guardado que
  // ya no está en el DOM. resolveRef lo resuelve a null; performAction sobre ese
  // null es lo que el act tool ejecuta. No debe disparar ninguna acción.
  const missing = resolveRef('main>input', doc.body); // <input> no existe → null
  assert.equal(missing, null, 'precondición: el ref no resuelve');
  const res = performAction(missing, 'click');
  assert.deepEqual(res, { ok: false, stale: true }, 'ref no resoluble → stale');
  assert.equal(clicks, 0, 'no se disparó ninguna acción sobre el ref stale');
});

test('PC12: acción inaplicable devuelve {ok:false, error} sin lanzar y sin stack trace', () => {
  const doc = makeDom('<main><div id="d">x</div></main>');
  const div = doc.getElementById('d');
  assert.doesNotThrow(() => {
    const res = performAction(div, 'select', 'v');
    assert.equal(res.ok, false, 'select sobre <div> → ok:false');
    assert.ok(typeof res.error === 'string' && res.error.length > 0, 'error no vacío');
    assert.ok(!res.error.includes('\n'), 'error sin stack trace (una línea)');
    assert.ok(!/^\s*at\s/.test(res.error), 'error no contiene frames "at ..."');
  });

  const docBtn = makeDom('<main><button id="b">x</button></main>');
  const btn = docBtn.getElementById('b');
  assert.doesNotThrow(() => {
    const res = performAction(btn, 'type', 'hola');
    assert.equal(res.ok, false, 'type sobre <button> → ok:false');
    assert.ok(typeof res.error === 'string' && res.error.length > 0, 'error no vacío');
    assert.ok(!res.error.includes('\n'), 'error sin stack trace');
  });
});

// helper de shape del ActResponse (I3 / PC13).
function assertShape(res) {
  assert.equal(typeof res, 'object', 'ActResponse es un objeto');
  assert.equal(typeof res.ok, 'boolean', 'ok es booleano');
  if (res.ok === false) {
    // fb-020-001 §2.4: a lo sumo un true entre stale|inert|disabled; error puede
    // acompañar a un booleano; error no vacío si no hay ninguno.
    const booleanos = [res.stale === true, res.inert === true, res.disabled === true].filter(Boolean).length;
    assert.ok(
      booleanos <= 1,
      `ok:false debe tener a lo sumo un true entre stale|inert|disabled — recibido ${JSON.stringify(res)} (booleanos: ${booleanos})`,
    );
    if (booleanos === 0) {
      assert.ok(
        typeof res.error === 'string' && res.error.length > 0,
        `ok:false sin stale|inert|disabled debe traer error no vacío — recibido ${JSON.stringify(res)}`,
      );
    }
  } else {
    // ok:true must not have any of the failure reason fields
    assert.equal(res.stale, undefined, 'ok:true must not have stale');
    assert.equal(res.error, undefined, 'ok:true must not have error');
    assert.equal(res.inert, undefined, 'ok:true must not have inert');
    assert.equal(res.disabled, undefined, 'ok:true must not have disabled');
  }
}

test('PC13: toda respuesta de act cumple el shape (ok booleano; ok:false ⇒ a lo sumo un true entre stale|inert|disabled, error no vacío si no hay ninguno)', () => {
  const doc = makeDom(
    '<main>' +
      '<button id="b">Go</button>' +
      '<input id="i">' +
      '<input id="f">' +
      '<select id="s"><option value="v">V</option></select>' +
      '<div id="d">x</div>' +
    '</main>',
  );
  const btn = doc.getElementById('b');
  const input = doc.getElementById('i');
  const focusEl = doc.getElementById('f');
  const select = doc.getElementById('s');
  const div = doc.getElementById('d');

  // Casos de éxito PC7–PC10:
  assertShape(performAction(btn, 'click'));
  assertShape(performAction(input, 'type', 'hola'));
  assertShape(performAction(focusEl, 'focus'));
  assertShape(performAction(select, 'select', 'v'));

  // Caso stale PC11:
  assertShape(performAction(doc.getElementById('no-existe'), 'click'));

  // Casos de error PC12:
  assertShape(performAction(div, 'select', 'v'));
  assertShape(performAction(btn, 'type', 'hola'));
});
