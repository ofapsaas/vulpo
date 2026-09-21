/**
 * native-dialog-guard-fill.test.js — fb-020-003-native-dialog-policy.
 *
 * Verifica P6 de docs/specs/fb-020-003-native-dialog-policy/spec.md §3.2
 * ("Guard (T1)"): con una pregunta nativa pendiente, `performFill` responde
 * con el conjunto EXACTO de claves {success:false, nativeDialog, error}, sin
 * escribir ni disparar eventos, sobre un input habilitado y sobre uno
 * :disabled. Precede a `disabled` (§2.3, tabla de `fill`): por eso el
 * conjunto de claves NO incluye `disabled`. Nada de P7–P9 va acá.
 *
 * Superficie pública usada (./index.js):
 *   readNativeDialog(doc) -> nativeDialog | null
 *   performFill(el, value, {waitMs?, quietMs?}) -> Promise
 *
 * Escrito SOLO contra esa superficie. El test-writer no leyó ningún módulo de
 * implementación de src/extension/frame/*.js (salvo *.test.js) ni background.js.
 *
 * -- v3.3, P24: cambia sólo la FUENTE del setup ----------------------------
 * Antes de v3.3 la pregunta pendiente se producía con
 * `installNativeDialogWatch(win)` del bundle y un original simulado de
 * `win.confirm` que invocaba `performFill` mientras corría. P24 retira ese
 * export y autoriza a los T1 que sólo necesitan una pregunta pendiente a
 * producirla "escribiendo el atributo directamente". Este archivo sólo
 * necesita eso: nada de P6 afirma sobre la instalación. Se escribe
 * `data-vulpo-native-dialog` en el `documentElement` con el JSON de
 * {type:"confirm", message:"¿Seguro?", pending:true}. Las aserciones de P6 no
 * cambian; `readNativeDialog(doc)` sigue siendo la precondición de
 * no-vacuidad.
 *
 * -- Timing --------------------------------------------------------------
 * waitMs/quietMs cortos ({waitMs:150, quietMs:40}): sólo para no alargar una
 * corrida sin guard (`fill` espera quietud); el guard responde antes de que
 * estos valores importen.
 *
 * -- Guard de RED (precedente: native-dialog-guard-act.test.js) ----------
 * Import dinámico de ./index.js con catch. Cada test abre con
 * `api(id, ...nombres)`, que aserta `typeof frame[nombre] === 'function'` para
 * cada función que va a usar, ANTES de llamarla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// -- Guard de RED -----------------------------------------------------------
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
      `${nombre} no exportada (RED) por ./index.js -- ${id} de fb-020-003 P6` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// -- helpers ------------------------------------------------------------

const MENSAJE = '¿Seguro?';
const NATIVE_DIALOG_ESPERADO = { type: 'confirm', message: MENSAJE, pending: true };
const CLAVES_GUARD = ['success', 'nativeDialog', 'error'];
const ATRIBUTO_PREGUNTA = 'data-vulpo-native-dialog';

/** P24: produce la pregunta pendiente escribiendo el atributo directamente. */
function escribirPreguntaPendiente(doc) {
  doc.documentElement.setAttribute(ATRIBUTO_PREGUNTA, JSON.stringify(NATIVE_DIALOG_ESPERADO));
}

/** Conjunto EXACTO {success:false, nativeDialog, error} y forma de error (§2.3, P6). */
function assertRespuestaGuard(res, etiqueta) {
  const json = JSON.stringify(res);
  assert.equal(typeof res, 'object', `${etiqueta}: la respuesta es un objeto; recibido ${json}`);
  for (const k of Object.keys(res)) {
    assert.ok(
      CLAVES_GUARD.includes(k),
      `${etiqueta}: clave "${k}" fuera del conjunto exacto {success, nativeDialog, error} -- la pregunta pendiente precede a disabled (§2.3); recibido ${json}`,
    );
  }
  for (const k of CLAVES_GUARD) {
    assert.ok(k in res, `${etiqueta}: falta la clave "${k}"; recibido ${json}`);
  }
  assert.equal(res.success, false, `${etiqueta}: success:false; recibido ${json}`);
  assert.deepEqual(
    res.nativeDialog,
    NATIVE_DIALOG_ESPERADO,
    `${etiqueta}: nativeDialog exacto {type:"confirm", message:"${MENSAJE}", pending:true}; recibido ${json}`,
  );
  assert.ok(typeof res.error === 'string' && res.error.length > 0, `${etiqueta}: error string no vacío; recibido ${json}`);
  assert.ok(!res.error.includes('\n'), `${etiqueta}: error de una sola línea; recibido ${json}: ${JSON.stringify(res.error)}`);
  assert.ok(!/force/i.test(res.error), `${etiqueta}: el mensaje no menciona "force" (case-insensitive): ${res.error}`);
}

/** "Sin efecto": .value no cambia y no se disparan input/change (§3.2 P6). */
function assertSinEfecto({ el, valorAntes, counts }, etiqueta) {
  assert.equal(el.value, valorAntes, `${etiqueta}: .value no cambia`);
  assert.equal(counts.input, 0, `${etiqueta}: no se dispara input`);
  assert.equal(counts.change, 0, `${etiqueta}: no se dispara change`);
}

/**
 * Arma un window/doc nuevo a partir de `html`, instala un contador de
 * input/change, deja una pregunta pendiente (P24: atributo directo), verifica
 * la precondición con readNativeDialog e invoca performFill(el, 'nuevo',
 * opciones). Devuelve la respuesta junto con el estado "antes".
 */
async function correrConPreguntaPendiente({ html, id, opciones }, etiqueta) {
  const { readNativeDialog, performFill } = api(etiqueta, 'readNativeDialog', 'performFill');
  const win = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
  const doc = win.document;
  const el = doc.getElementById(id);

  const valorAntes = el.value;
  const counts = { input: 0, change: 0 };
  // En captura sobre document: ve el evento aunque no burbujee.
  for (const t of Object.keys(counts)) doc.addEventListener(t, () => counts[t]++, true);

  escribirPreguntaPendiente(doc);
  assert.deepEqual(
    readNativeDialog(doc),
    NATIVE_DIALOG_ESPERADO,
    `precondición ${etiqueta}: la pregunta estaba realmente pendiente cuando se invocó el fill (no vacuo)`,
  );

  const res = await performFill(el, 'nuevo', opciones);
  return { res, el, valorAntes, counts };
}

// =============================================================================
// P6 -- input habilitado
// =============================================================================

test('P6: input habilitado con pregunta pendiente => {success:false, nativeDialog, error} exacto, sin escritura ni eventos', async () => {
  const etiqueta = 'P6 habilitado';
  const opciones = { waitMs: 150, quietMs: 40 };
  const { res, el, valorAntes, counts } = await correrConPreguntaPendiente(
    { html: '<main><input id="x" value="orig" aria-label="campo"></main>', id: 'x', opciones },
    etiqueta,
  );
  assertRespuestaGuard(res, etiqueta);
  assertSinEfecto({ el, valorAntes, counts }, etiqueta);
});

// =============================================================================
// P6 -- control :disabled
// =============================================================================

test('P6: input :disabled con pregunta pendiente => {success:false, nativeDialog, error} exacto, sin la clave disabled, sin escritura ni eventos', async () => {
  const etiqueta = 'P6 disabled';
  const opciones = { waitMs: 150, quietMs: 40 };
  const { res, el, valorAntes, counts } = await correrConPreguntaPendiente(
    { html: '<main><input id="x" value="orig" disabled aria-label="campo"></main>', id: 'x', opciones },
    etiqueta,
  );
  assert.equal(el.matches(':disabled'), true, `precondición ${etiqueta}: el control matchea :disabled`);
  assertRespuestaGuard(res, etiqueta);
  assertSinEfecto({ el, valorAntes, counts }, etiqueta);
});
