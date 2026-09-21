/**
 * native-dialog-guard-act.test.js — fb-020-003-native-dialog-policy.
 *
 * Verifica P5 de docs/specs/fb-020-003-native-dialog-policy/spec.md §3.2
 * ("Guard (T1)"): con una pregunta nativa pendiente, `performActionAndObserve`
 * responde con el conjunto EXACTO de claves {ok:false, nativeDialog, error},
 * sin despacho, en los casos que enumera P5 — click/type/focus/select por
 * force, el null (stale), un elemento inerte y un control :disabled. Precede a
 * `stale`/`inert`/`disabled` (§2.3): por eso el conjunto de claves NO incluye
 * ninguna de esas tres. Nada de P6–P9 va acá.
 *
 * Superficie pública usada (./index.js):
 *   readNativeDialog(doc) → nativeDialog | null
 *   performActionAndObserve(el, action, value, {force?, waitMs?, quietMs?}) → Promise
 *
 * Escrito SOLO contra esa superficie. El test-writer no leyó ningún módulo de
 * implementación de src/extension/frame/*.js (salvo *.test.js) ni background.js.
 *
 * ── v3.3, P24: cambia sólo la FUENTE del setup ──────────────────────────────
 * Antes de v3.3 la pregunta pendiente se producía con
 * `installNativeDialogWatch(win)` del bundle y un original simulado de
 * `win.confirm` que invocaba la acción mientras corría. P24 retira ese export
 * y autoriza a los T1 que sólo necesitan una pregunta pendiente a producirla
 * "escribiendo el atributo directamente". Este archivo sólo necesita eso: nada
 * de P5 afirma sobre la instalación. Se escribe
 * `data-vulpo-native-dialog` en el `documentElement` con el JSON de
 * {type:"confirm", message:"¿Seguro?", pending:true}. Las aserciones de P5 no
 * cambian; `readNativeDialog(doc)` sigue siendo la precondición de
 * no-vacuidad (la pregunta estaba realmente pendiente al invocar la acción).
 *
 * ── Convención `el` null / globalThis.document (F3 del test-audit, v3.1 §14) ──
 * Con `el` null el guard lee la pregunta de `globalThis.document` (precedente
 * `act.js:15`, `globalThis.Event`). El test asigna `globalThis.document` al
 * documento del fixture y lo restaura en un `finally`, incluso si una
 * aserción lanza.
 *
 * ── Guard de RED (precedente: act-observe.test.js:38-57) ────────────────────
 * Import dinámico de ./index.js con catch. Cada test abre con
 * `api(id, ...nombres)`, que aserta `typeof frame[nombre] === 'function'` para
 * cada función que va a usar, ANTES de llamarla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── Guard de RED ────────────────────────────────────────────────────────────
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
      `${nombre} no exportada (RED) por ./index.js — ${id} de fb-020-003 P5` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MENSAJE = '¿Seguro?';
const NATIVE_DIALOG_ESPERADO = { type: 'confirm', message: MENSAJE, pending: true };
const CLAVES_GUARD = ['ok', 'nativeDialog', 'error'];
const ATRIBUTO_PREGUNTA = 'data-vulpo-native-dialog';

/** P24: produce la pregunta pendiente escribiendo el atributo directamente. */
function escribirPreguntaPendiente(doc) {
  doc.documentElement.setAttribute(ATRIBUTO_PREGUNTA, JSON.stringify(NATIVE_DIALOG_ESPERADO));
}

/** Conjunto EXACTO {ok:false, nativeDialog, error} y forma de error (§2.3, P16 precedente). */
function assertRespuestaGuard(res, etiqueta) {
  const json = JSON.stringify(res);
  assert.equal(typeof res, 'object', `${etiqueta}: la respuesta es un objeto; recibido ${json}`);
  for (const k of Object.keys(res)) {
    assert.ok(CLAVES_GUARD.includes(k), `${etiqueta}: clave "${k}" fuera del conjunto exacto {ok, nativeDialog, error} — la pregunta pendiente precede a stale/inert/disabled (§2.3); recibido ${json}`);
  }
  for (const k of CLAVES_GUARD) {
    assert.ok(k in res, `${etiqueta}: falta la clave "${k}"; recibido ${json}`);
  }
  assert.equal(res.ok, false, `${etiqueta}: ok:false; recibido ${json}`);
  assert.deepEqual(res.nativeDialog, NATIVE_DIALOG_ESPERADO, `${etiqueta}: nativeDialog exacto {type:"confirm", message:"${MENSAJE}", pending:true}; recibido ${json}`);
  assert.ok(typeof res.error === 'string' && res.error.length > 0, `${etiqueta}: error string no vacío; recibido ${json}`);
  assert.ok(!res.error.includes('\n'), `${etiqueta}: error de una sola línea; recibido ${json}: ${JSON.stringify(res.error)}`);
  assert.ok(!/force/i.test(res.error), `${etiqueta}: el mensaje no menciona "force" (case-insensitive): ${res.error}`);
}

/** "Sin efecto": ningún listener de click/input/change/focus corrió; value/selección/foco intactos. */
function assertSinEfecto({ doc, el, antes, counts }, etiqueta) {
  for (const t of Object.keys(counts)) {
    assert.equal(counts[t], 0, `${etiqueta}: el listener de ${t} no debe correr (sin efecto, §3.2)`);
  }
  if (el && 'value' in el) {
    assert.equal(el.value, antes.value, `${etiqueta}: .value no cambia`);
  }
  assert.equal(doc.activeElement, antes.active, `${etiqueta}: document.activeElement no cambia`);
}

/**
 * Arma un window/doc nuevo a partir de `html`, instala listeners de conteo,
 * deja una pregunta pendiente (P24: atributo directo), verifica la
 * precondición con readNativeDialog e invoca
 * `performActionAndObserve(el, accion, valor, opciones)`. Devuelve la
 * respuesta junto con el estado "antes" para verificar ausencia de efecto.
 */
async function correrConPreguntaPendiente({ html, id, accion, valor, opciones, preparar }, etiqueta) {
  const { readNativeDialog, performActionAndObserve } = api(etiqueta, 'readNativeDialog', 'performActionAndObserve');
  const win = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
  const doc = win.document;
  const el = doc.getElementById(id);
  if (preparar) preparar(doc, el);

  const antes = {
    value: el && 'value' in el ? el.value : undefined,
    active: doc.activeElement,
  };
  const counts = { click: 0, input: 0, change: 0, focus: 0 };
  for (const t of Object.keys(counts)) doc.addEventListener(t, () => counts[t]++, true);

  escribirPreguntaPendiente(doc);
  assert.deepEqual(
    readNativeDialog(doc),
    NATIVE_DIALOG_ESPERADO,
    `precondición ${etiqueta}: la pregunta estaba realmente pendiente cuando se invocó la acción (no vacuo)`,
  );

  const res = await performActionAndObserve(el, accion, valor, opciones);
  return { res, doc, el, antes, counts };
}

// ═══════════════════════════════════════════════════════════════════════════
// P5 — click, type, focus, select × force
// ═══════════════════════════════════════════════════════════════════════════

const CASOS_ACCION = [
  { accion: 'click', id: 'x', valor: undefined, html: '<main><button id="x">Go</button></main>' },
  { accion: 'type', id: 'x', valor: 'nuevo', html: '<main><input id="x" value="orig"></main>' },
  {
    accion: 'focus',
    id: 'x',
    valor: undefined,
    html: '<main><input id="otro"><input id="x"></main>',
    preparar: (doc) => {
      doc.getElementById('otro').focus();
    },
  },
  {
    accion: 'select',
    id: 'x',
    valor: 'b',
    html: '<main><select id="x"><option value="a">A</option><option value="b">B</option></select></main>',
  },
];

test('P5: click, type, focus y select con pregunta pendiente (force false y true) ⇒ {ok:false, nativeDialog, error} exacto, sin efecto', async () => {
  for (const caso of CASOS_ACCION) {
    for (const force of [false, true]) {
      const etiqueta = `P5 ${caso.accion} force:${force}`;
      // waitMs/quietMs cortos: sólo para no alargar una corrida sin guard (un
      // type/focus/select exitoso puede esperar quietud); el guard responde
      // antes de que estos valores importen.
      const opciones = { force, waitMs: 150, quietMs: 40 };
      const { res, doc, el, antes, counts } = await correrConPreguntaPendiente(
        { ...caso, opciones },
        etiqueta,
      );
      assertRespuestaGuard(res, etiqueta);
      assertSinEfecto({ doc, el, antes, counts }, etiqueta);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P5 — el null (stale), convención globalThis.document
// ═══════════════════════════════════════════════════════════════════════════

test('P5: con el null (stale) y pregunta pendiente, el guard lee globalThis.document ⇒ mismo contrato exacto, sin efecto', async () => {
  const etiqueta = 'P5 el-null-stale';
  const { readNativeDialog, performActionAndObserve } = api(etiqueta, 'readNativeDialog', 'performActionAndObserve');
  const win = new JSDOM('<!DOCTYPE html><html><body><main><button id="x">Go</button></main></body></html>').window;
  const doc = win.document;

  const counts = { click: 0, input: 0, change: 0, focus: 0 };
  for (const t of Object.keys(counts)) doc.addEventListener(t, () => counts[t]++, true);
  const antes = { value: undefined, active: doc.activeElement };

  const globalDocOriginal = globalThis.document;
  globalThis.document = doc;
  try {
    escribirPreguntaPendiente(doc);
    assert.deepEqual(
      readNativeDialog(doc),
      NATIVE_DIALOG_ESPERADO,
      `precondición ${etiqueta}: la pregunta estaba realmente pendiente cuando se invocó la acción (no vacuo)`,
    );

    // el = null: convención v3.1 — el guard toma globalThis.document, asignado arriba.
    const res = await performActionAndObserve(null, 'click', undefined, {});
    assertRespuestaGuard(res, etiqueta);
    assertSinEfecto({ doc, el: null, antes, counts }, etiqueta);
  } finally {
    globalThis.document = globalDocOriginal;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P5 — elemento inerte bajo un diálogo modal
// ═══════════════════════════════════════════════════════════════════════════

// Duplicado local (no exportado): fondo accionable + diálogo modal activo, mismo
// patrón que dialogo-inerte.test.js HTML_ODOO / act-disabled.test.js HTML_MODAL,
// pero SIN disabled en el fondo — el punto de este caso es que la respuesta no
// lleva `inert` (precedencia §2.3), no que el fondo esté además deshabilitado.
const HTML_INERTE =
  '<div class="o_content"><button id="x">Fondo</button></div>' +
  '<div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
  '<h4 class="modal-title">Confirmación</h4><button>Cerrar</button></div>';

test('P5: un elemento inerte bajo un diálogo modal, con pregunta pendiente ⇒ {ok:false, nativeDialog, error} exacto, sin la clave inert, sin efecto', async () => {
  const etiqueta = 'P5 inerte';
  const { res, doc, el, antes, counts } = await correrConPreguntaPendiente(
    { html: HTML_INERTE, id: 'x', accion: 'click', valor: undefined, opciones: {} },
    etiqueta,
  );
  assertRespuestaGuard(res, etiqueta);
  assertSinEfecto({ doc, el, antes, counts }, etiqueta);
});

// ═══════════════════════════════════════════════════════════════════════════
// P5 — control :disabled
// ═══════════════════════════════════════════════════════════════════════════

const HTML_DISABLED = '<main><button id="x" disabled>Go</button></main>';

test('P5: un control :disabled, con pregunta pendiente ⇒ {ok:false, nativeDialog, error} exacto, sin la clave disabled, sin efecto', async () => {
  const etiqueta = 'P5 disabled';
  const { res, doc, el, antes, counts } = await correrConPreguntaPendiente(
    { html: HTML_DISABLED, id: 'x', accion: 'click', valor: undefined, opciones: {} },
    etiqueta,
  );
  assert.equal(el.matches(':disabled'), true, `precondición ${etiqueta}: el control matchea :disabled`);
  assertRespuestaGuard(res, etiqueta);
  assertSinEfecto({ doc, el, antes, counts }, etiqueta);
});
