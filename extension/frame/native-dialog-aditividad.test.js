/**
 * native-dialog-aditividad.test.js — fb-020-003-native-dialog-policy.
 *
 * Verifica P7 de docs/specs/fb-020-003-native-dialog-policy/spec.md §3.2
 * ("Guard (T1)"): con la instalación activa pero SIN ningún diálogo en curso,
 * `performActionAndObserve` y `performFill` responden exactamente igual que
 * sin instalación, sobre un DOM equivalente. Nada de P5, P6, P8 ni P9 va acá.
 *
 * Superficie pública usada:
 *   performActionAndObserve(el, action, value, {force?, waitMs?, quietMs?}) -> Promise  (./index.js)
 *   performFill(el, value, {waitMs?, quietMs?}) -> Promise                              (./index.js)
 *   installNativeDialogWatchMain()  (src/extension/native-dialog-main.js, v3.3 P24)
 *
 * ── v3.3, P24: cambia sólo la FUENTE del setup ──────────────────────────────
 * Antes de v3.3 la instalación usaba `installNativeDialogWatch(win)` del
 * bundle, que P24 retira. Ahora el envoltorio sale de
 * `native-dialog-main.js`, leído en runtime y evaluado con el `window` de
 * jsdom en el ámbito (`cargarNativeDialogMain`, abajo). La instalación activa
 * es el sujeto de P7, así que se usa el archivo y no el atributo directo. Las
 * aserciones de P7 no cambian.
 *
 * Escrito SOLO contra esa superficie. El test-writer no leyó ningún módulo de
 * implementación de src/extension/frame/*.js (salvo *.test.js),
 * native-dialog-main.js ni background.js.
 *
 * -- Criterio de igualdad (v3.1, F2 del audit, §3.2 del spec) --------------
 * - Respuestas CON observación (`type`/`fill` exitosos): mismo conjunto EXACTO
 *   de claves entre "sin instalación" y "con instalación"; cada clave igual,
 *   salvo `waitedMs`, que en ambos lados sólo se exige entero >= 0.
 * - Respuestas SIN observación (`ok:false`, `disabled`, `CASOS` de
 *   act-disabled.test.js): `deepEqual` literal.
 * - En todos los casos, ninguna respuesta "con instalación" trae la clave
 *   `nativeDialog` (I-6).
 *
 * -- "Sin ningún diálogo en curso" ------------------------------------------
 * El lado "con instalación" instala el envoltorio con originales simulados de
 * `confirm`/`alert`/`prompt` asignados ANTES de instalar que NUNCA se
 * invocan: si algún camino llamara al diálogo en estos casos, el original
 * lanza.
 *
 * -- Casos (§3.2 P7) ---------------------------------------------------------
 *  1. `act-disabled.test.js` `CASOS` (duplicado local, no exportado) — se
 *     excluye `p15Type` (type exitoso con force), que se prueba aparte con el
 *     criterio de observación.
 *  2. Un `type` exitoso (con `value`, `settled` y `waitedMs`).
 *  3. Un `fill` exitoso.
 *  4. Un `fill` sobre `:disabled`.
 *
 * -- `el` null (stale) y globalThis.document ---------------------------------
 * `p14StaleForce` usa `el` null. Por paridad se fija `globalThis.document` al
 * documento del fixture en ambos lados de la comparación y se restaura en un
 * `finally`.
 *
 * -- Timing -------------------------------------------------------------
 * `waitMs`/`quietMs` cortos e iguales en ambos lados (150/40).
 *
 * -- Naturaleza RED esperada (lote v3.3) -------------------------------------
 * Mientras `src/extension/native-dialog-main.js` no exista, los cuatro tests
 * caen por AssertionError en `cargarNativeDialogMain` (nombra P24).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { resolveRef } from './resolver.js';

// -- Guard de RED (bundle) ----------------------------------------------
let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  frame = null;
  errorDeCarga = e;
}

/** Aserta que cada función nombrada está exportada por ./index.js antes de usarla. */
function api(id, ...nombres) {
  const fns = {};
  for (const nombre of nombres) {
    const fn = frame?.[nombre];
    assert.equal(
      typeof fn,
      'function',
      `${nombre} no exportada (RED) por ./index.js — ${id} de fb-020-003 P7` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// -- Carga de native-dialog-main.js (P24) ------------------------------------
// Duplicado local en cada test que lo usa: el hook del rol no permite escribir
// un helper compartido fuera de *.test.js.
// Lee el archivo EN RUNTIME y lo evalúa con `win` como `window` del ámbito.
// Una evaluación por llamada. Si el archivo no existe o no declara las dos
// funciones ⇒ AssertionError (P24).
const URL_NATIVE_DIALOG_MAIN = new URL('../native-dialog-main.js', import.meta.url);

function cargarNativeDialogMain(win) {
  let fuente;
  try {
    fuente = readFileSync(URL_NATIVE_DIALOG_MAIN, 'utf8');
  } catch (e) {
    assert.fail(`P24 (fb-020-003): no se pudo leer src/extension/native-dialog-main.js — ${e.code ?? e.name}: ${e.message}`);
  }
  let fns;
  try {
    fns = new Function('window', fuente + '\nreturn { installNativeDialogWatchMain, restoreNativeDialogWatchMain };')(win);
  } catch (e) {
    assert.fail(
      'P24 (fb-020-003): native-dialog-main.js no se evalúa como script clásico con `window` en el ámbito ' +
        `que declare installNativeDialogWatchMain y restoreNativeDialogWatchMain — ${e.name}: ${e.message}`,
    );
  }
  assert.equal(typeof fns.installNativeDialogWatchMain, 'function', 'P24 (fb-020-003): native-dialog-main.js declara installNativeDialogWatchMain');
  assert.equal(typeof fns.restoreNativeDialogWatchMain, 'function', 'P24 (fb-020-003): native-dialog-main.js declara restoreNativeDialogWatchMain');
  // P24 v3.4 (R2-02), inyección fiel: la evaluación de arriba sólo sirve para
  // obtener las dos funciones. Cada llamada se reevalúa desde su `toString()`,
  // sola y sin el ámbito del archivo, igual que
  // `executeScript({world:'MAIN', func})`. Una dependencia de algo declarado
  // fuera del cuerpo de la función lanza acá (p. ej. ReferenceError), sin
  // convertirse en AssertionError.
  const srcInstall = fns.installNativeDialogWatchMain.toString();
  const srcRestore = fns.restoreNativeDialogWatchMain.toString();
  return {
    installNativeDialogWatchMain: () => new Function('window', 'return (' + srcInstall + ')();')(win),
    restoreNativeDialogWatchMain: () => new Function('window', 'return (' + srcRestore + ')();')(win),
  };
}

// -- Duplicado de act-disabled.test.js (no exportado: l.79-205) -------------

function focoEnOtro(doc) {
  doc.getElementById('otro').focus();
  assert.equal(doc.activeElement, doc.getElementById('otro'), 'precondición: el foco está en otro elemento habilitado');
}

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
  // p15Type se excluye del recorrido literal (ver más abajo): es el "type exitoso" de P7.
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

// -- helpers de comparación --------------------------------------------------

function makeWin(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
}

function prepararCaso(win, caso) {
  const doc = win.document;
  const el = caso.ref !== undefined ? resolveRef(caso.ref, doc.body) : doc.getElementById(caso.id);
  if (caso.preparar) caso.preparar(doc, el);
  return el;
}

function argumentos(caso, el) {
  return caso.opciones === undefined ? [el, caso.accion, caso.valor] : [el, caso.accion, caso.valor, caso.opciones];
}

/** Originales simulados que, si se invocaran, harían fallar el test: P7 no dispara ningún diálogo. */
function instalarSinInvocar(win) {
  const noDebeLlamarse = (tipo) => () => {
    throw new Error(`P7: ${tipo} no debería invocarse — P7 no dispara ningún diálogo`);
  };
  win.confirm = noDebeLlamarse('confirm');
  win.alert = noDebeLlamarse('alert');
  win.prompt = noDebeLlamarse('prompt');
  cargarNativeDialogMain(win).installNativeDialogWatchMain();
}

/**
 * Corre la acción bajo prueba en dos DOMs equivalentes construidos desde
 * `html`: uno sin instalación, otro con el envoltorio activo y originales
 * simulados nunca invocados. `construirLlamada(win)` arma y devuelve la
 * promesa de la acción bajo prueba.
 */
async function correrPar(html, construirLlamada) {
  const winSin = makeWin(html);
  const winCon = makeWin(html);
  instalarSinInvocar(winCon);

  const globalDocOriginal = globalThis.document;
  let resSin;
  let resCon;
  try {
    globalThis.document = winSin.document;
    resSin = await construirLlamada(winSin);
    globalThis.document = winCon.document;
    resCon = await construirLlamada(winCon);
  } finally {
    globalThis.document = globalDocOriginal;
  }
  return { resSin, resCon };
}

/** Criterio de igualdad para respuestas SIN observación (v3.1 F2): deepEqual literal, sin nativeDialog. */
function assertLiteral(resSin, resCon, etiqueta) {
  assert.deepEqual(
    resCon,
    resSin,
    `${etiqueta}: con instalación activa y sin pregunta pendiente, la respuesta es deepEqual a sin instalación; ` +
      `sin=${JSON.stringify(resSin)} con=${JSON.stringify(resCon)}`,
  );
  assert.equal('nativeDialog' in resCon, false, `${etiqueta}: sin pregunta pendiente, la respuesta no trae la clave nativeDialog (I-6)`);
}

/** Criterio de igualdad para respuestas CON observación (v3.1 F2): mismo conjunto de claves, igualdad salvo waitedMs (entero >= 0 en ambos lados). */
function assertConObservacion(resSin, resCon, etiqueta) {
  const clavesSin = Object.keys(resSin).sort();
  const clavesCon = Object.keys(resCon).sort();
  assert.deepEqual(
    clavesCon,
    clavesSin,
    `${etiqueta}: mismo conjunto exacto de claves con y sin instalación; sin=${JSON.stringify(clavesSin)} con=${JSON.stringify(clavesCon)}`,
  );
  for (const k of clavesSin) {
    if (k === 'waitedMs') {
      assert.ok(
        Number.isInteger(resSin.waitedMs) && resSin.waitedMs >= 0,
        `${etiqueta}: waitedMs sin instalación entero >= 0; recibido ${resSin.waitedMs}`,
      );
      assert.ok(
        Number.isInteger(resCon.waitedMs) && resCon.waitedMs >= 0,
        `${etiqueta}: waitedMs con instalación entero >= 0; recibido ${resCon.waitedMs}`,
      );
    } else {
      assert.deepEqual(resCon[k], resSin[k], `${etiqueta}: clave "${k}" igual con y sin instalación; sin=${JSON.stringify(resSin[k])} con=${JSON.stringify(resCon[k])}`);
    }
  }
  assert.equal('nativeDialog' in resCon, false, `${etiqueta}: sin pregunta pendiente, la respuesta no trae la clave nativeDialog (I-6)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// P7 — CASOS de act-disabled.test.js (deepEqual literal), excluido p15Type
// ═══════════════════════════════════════════════════════════════════════════

test('P7: act-disabled.test.js CASOS, con instalación activa y sin pregunta pendiente, responden deepEqual literal a sin instalación', async () => {
  const { performActionAndObserve } = api('P7-CASOS', 'performActionAndObserve');
  const excluidos = [];
  let recorridos = 0;
  for (const [nombre, caso] of Object.entries(CASOS)) {
    if (caso.accion === 'type' && nombre === 'p15Type') {
      // "type exitoso" es el caso separado de P7 (criterio de observación); ver test siguiente.
      excluidos.push(nombre);
      continue;
    }
    const etiqueta = `P7 ${nombre}`;
    const { resSin, resCon } = await correrPar(caso.html, async (win) => {
      const el = prepararCaso(win, caso);
      return performActionAndObserve(...argumentos(caso, el));
    });
    assertLiteral(resSin, resCon, etiqueta);
    recorridos++;
  }
  // Guardas de no-vacuidad.
  assert.deepEqual(excluidos, ['p15Type'], `precondición P7: sólo se excluye p15Type (type exitoso); excluidos ${JSON.stringify(excluidos)}`);
  assert.ok(recorridos >= 20, `precondición P7: el recorrido cubre un número sustancial de CASOS (recorridos ${recorridos})`);
});

// ═══════════════════════════════════════════════════════════════════════════
// P7 — un type exitoso (criterio de observación)
// ═══════════════════════════════════════════════════════════════════════════

test('P7: un type exitoso, con instalación activa y sin pregunta pendiente, responde con el mismo conjunto de claves y valores que sin instalación (salvo waitedMs), sin nativeDialog', async () => {
  const { performActionAndObserve } = api('P7-type', 'performActionAndObserve');
  const html = '<main><input id="x" aria-label="campo"></main>';
  const opciones = { waitMs: 150, quietMs: 40 };
  const { resSin, resCon } = await correrPar(html, async (win) => {
    const el = win.document.getElementById('x');
    return performActionAndObserve(el, 'type', 'abc', opciones);
  });
  assert.equal(resSin.ok, true, `precondición P7 type: sin instalación, el type se despacha con éxito; recibido ${JSON.stringify(resSin)}`);
  assert.equal(resCon.ok, true, `precondición P7 type: con instalación, el type se despacha con éxito; recibido ${JSON.stringify(resCon)}`);
  assert.ok('value' in resSin && 'settled' in resSin && 'waitedMs' in resSin, `precondición P7 type: la respuesta trae value/settled/waitedMs; recibido ${JSON.stringify(resSin)}`);
  assertConObservacion(resSin, resCon, 'P7 type exitoso');
});

// ═══════════════════════════════════════════════════════════════════════════
// P7 — un fill exitoso (criterio de observación)
// ═══════════════════════════════════════════════════════════════════════════

test('P7: un fill exitoso, con instalación activa y sin pregunta pendiente, responde con el mismo conjunto de claves y valores que sin instalación (salvo waitedMs), sin nativeDialog', async () => {
  const { performFill } = api('P7-fill', 'performFill');
  const html = '<main><input id="x" value="orig" aria-label="campo"></main>';
  const opciones = { waitMs: 150, quietMs: 40 };
  const { resSin, resCon } = await correrPar(html, async (win) => {
    const el = win.document.getElementById('x');
    return performFill(el, 'Nuevo texto', opciones);
  });
  assert.equal(resSin.success, true, `precondición P7 fill: sin instalación, el fill se ejecuta con éxito; recibido ${JSON.stringify(resSin)}`);
  assert.equal(resCon.success, true, `precondición P7 fill: con instalación, el fill se ejecuta con éxito; recibido ${JSON.stringify(resCon)}`);
  assertConObservacion(resSin, resCon, 'P7 fill exitoso');
});

// ═══════════════════════════════════════════════════════════════════════════
// P7 — un fill sobre :disabled (deepEqual literal)
// ═══════════════════════════════════════════════════════════════════════════

test('P7: un fill sobre :disabled, con instalación activa y sin pregunta pendiente, responde deepEqual literal a sin instalación', async () => {
  const { performFill } = api('P7-fill-disabled', 'performFill');
  const html = '<main><input id="x" value="orig" disabled aria-label="campo"></main>';
  const opciones = { waitMs: 150, quietMs: 40 };
  const { resSin, resCon } = await correrPar(html, async (win) => {
    const el = win.document.getElementById('x');
    return performFill(el, 'nuevo', opciones);
  });
  assert.equal(resSin.success, false, `precondición P7 fill disabled: sin instalación, success:false; recibido ${JSON.stringify(resSin)}`);
  assert.equal(resSin.disabled, true, `precondición P7 fill disabled: sin instalación, disabled:true; recibido ${JSON.stringify(resSin)}`);
  assertLiteral(resSin, resCon, 'P7 fill disabled');
});
