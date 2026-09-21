/**
 * native-dialog-lectura-defensiva.test.js — fb-020-003-native-dialog-policy (v3.3, lote de fixes del review).
 *
 * Verifica P26 (lectura defensiva, R-02) de
 * docs/specs/fb-020-003-native-dialog-policy/spec.md §3 ("Postcondiciones de
 * los fixes del review (v3.3)"), T1:
 *   - `readNativeDialog(doc)` devuelve `null` si el atributo falta, no es JSON
 *     válido, o no es un objeto con `type ∈ {"confirm","alert","prompt"}`,
 *     `message` string y `pending === true`.
 *   - Si es válido, devuelve un objeto nuevo con exactamente esas tres claves.
 *   - Consecuencias verificables (valores literales del spec):
 *     · con el atributo en `no-es-json`, `1`, `"x"` o
 *       `{"type":"system","message":"m","pending":true}`: `serializeFrame` no
 *       lanza y no trae `nativeDialog`; `performActionAndObserve` y
 *       `performFill` despachan como sin pregunta;
 *     · con `{"type":"confirm","message":"m","pending":true,"extra":1}`,
 *       `nativeDialog` es `deepEqual` a {type:"confirm", message:"m",
 *       pending:true}, en el frame y en el rechazo del guard.
 *
 * Superficie pública usada: readNativeDialog, performActionAndObserve y
 * performFill desde ./index.js; serializeFrame desde ./serializer.js
 * (precedente de native-dialog-frame.test.js).
 *
 * ── Cómo se produce el atributo ─────────────────────────────────────────────
 * P26 trata de un atributo que escribe la PÁGINA (no el envoltorio), así que
 * se escribe directamente (autorizado por P24): `data-vulpo-native-dialog`
 * en el `documentElement`.
 *
 * ── "Despacha como sin pregunta" ────────────────────────────────────────────
 * Se compara contra el MISMO escenario sin atributo (precedente `correrPar` de
 * native-dialog-aditividad.test.js): el efecto ocurre (el click llega al
 * listener; `fill` escribe el valor), la respuesta tiene el mismo conjunto de
 * claves y valores que sin atributo (salvo `waitedMs`, sólo entero ≥ 0, F2 de
 * v3.1) y no trae `nativeDialog`.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 * Las llamadas se envuelven en `assert.doesNotThrow`/`assert.doesNotReject`:
 * un `JSON.parse` sin protección cae como AssertionError, no como SyntaxError
 * crudo. Una lectura sin validación de forma cae en `assert.equal(..., null)`
 * o en el `deepEqual` estricto (clave `extra`).
 *
 * El test-writer no leyó ningún módulo de implementación de
 * src/extension/frame/*.js (salvo *.test.js) ni background.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
// serializeFrame se importa directo de ./serializer.js (precedente de
// native-dialog-frame.test.js): no depende de que ./index.js lo reexporte.
import { serializeFrame } from './serializer.js';

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
      `${nombre} no exportada por ./index.js — ${id} de fb-020-003 P26` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const ATRIBUTO_PREGUNTA = 'data-vulpo-native-dialog';

/** Valores literales de P26 que NO son una pregunta pendiente válida. */
const ATRIBUTOS_INVALIDOS = ['no-es-json', '1', '"x"', '{"type":"system","message":"m","pending":true}'];

/** Valor literal de P26: forma válida con una clave extra. */
const ATRIBUTO_VALIDO_CON_EXTRA = '{"type":"confirm","message":"m","pending":true,"extra":1}';
const NATIVE_DIALOG_PROYECTADO = { type: 'confirm', message: 'm', pending: true };

const OPCIONES = { waitMs: 150, quietMs: 40 };

/** window jsdom con `html` en el body y, si se da, el atributo en el documentElement. */
function ventana(html, valorAtributo) {
  const win = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
  if (valorAtributo !== undefined) {
    win.document.documentElement.setAttribute(ATRIBUTO_PREGUNTA, valorAtributo);
  }
  return win;
}

/** Corre `fn` con globalThis.document apuntando a `doc` y lo restaura siempre. */
async function conDocumentGlobal(doc, fn) {
  const original = globalThis.document;
  globalThis.document = doc;
  try {
    return await fn();
  } finally {
    globalThis.document = original;
  }
}

/** Mismo conjunto de claves y valores que sin atributo, salvo waitedMs (entero ≥ 0); sin nativeDialog. */
function assertComoSinPregunta(resSin, resCon, etiqueta) {
  const clavesSin = Object.keys(resSin).sort();
  const clavesCon = Object.keys(resCon).sort();
  assert.deepEqual(
    clavesCon,
    clavesSin,
    `${etiqueta}: mismo conjunto exacto de claves que sin atributo; sin=${JSON.stringify(resSin)} con=${JSON.stringify(resCon)}`,
  );
  for (const k of clavesSin) {
    if (k === 'waitedMs') {
      assert.ok(Number.isInteger(resCon.waitedMs) && resCon.waitedMs >= 0, `${etiqueta}: waitedMs entero >= 0; recibido ${resCon.waitedMs}`);
    } else {
      assert.deepEqual(resCon[k], resSin[k], `${etiqueta}: clave "${k}" igual que sin atributo; sin=${JSON.stringify(resSin[k])} con=${JSON.stringify(resCon[k])}`);
    }
  }
  assert.equal('nativeDialog' in resCon, false, `${etiqueta}: la respuesta no trae nativeDialog; recibido ${JSON.stringify(resCon)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// P26 — readNativeDialog
// ═══════════════════════════════════════════════════════════════════════════

test('P26: readNativeDialog devuelve null si el atributo falta, no es JSON válido o no es un objeto con type confirm/alert/prompt, message string y pending === true', () => {
  const { readNativeDialog } = api('P26-read-null', 'readNativeDialog');

  const casos = [
    ['atributo ausente', undefined],
    ...ATRIBUTOS_INVALIDOS.map((v) => [`atributo ${v}`, v]),
    // Mismas reglas de forma de P26 ("message string", "pending === true"), sobre type válido.
    ['message no string', '{"type":"confirm","message":1,"pending":true}'],
    ['pending distinto de true', '{"type":"confirm","message":"m","pending":false}'],
  ];

  for (const [nombre, valor] of casos) {
    const etiqueta = `P26 ${nombre}`;
    const doc = ventana('<main></main>', valor).document;
    let leido;
    assert.doesNotThrow(() => {
      leido = readNativeDialog(doc);
    }, `${etiqueta}: readNativeDialog no lanza`);
    assert.equal(leido, null, `${etiqueta}: readNativeDialog devuelve null; recibido ${JSON.stringify(leido)}`);
  }
});

test('P26: con {"type":"confirm","message":"m","pending":true,"extra":1}, readNativeDialog devuelve un objeto con exactamente type, message y pending', () => {
  const { readNativeDialog } = api('P26-read-proyecta', 'readNativeDialog');
  const doc = ventana('<main></main>', ATRIBUTO_VALIDO_CON_EXTRA).document;

  let leido;
  assert.doesNotThrow(() => {
    leido = readNativeDialog(doc);
  }, 'P26: readNativeDialog no lanza con una forma válida');
  assert.deepEqual(
    leido,
    NATIVE_DIALOG_PROYECTADO,
    `P26: readNativeDialog proyecta exactamente {type, message, pending}, sin la clave extra; recibido ${JSON.stringify(leido)}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P26 — serializeFrame
// ═══════════════════════════════════════════════════════════════════════════

test('P26: con el atributo en no-es-json, 1, "x" o {"type":"system",...}, serializeFrame no lanza y no trae nativeDialog', () => {

  for (const valor of ATRIBUTOS_INVALIDOS) {
    const etiqueta = `P26 serializeFrame atributo ${valor}`;
    const doc = ventana('<main><button>Go</button><input value="v"></main>', valor).document;
    let frameObj;
    assert.doesNotThrow(() => {
      frameObj = serializeFrame(doc.body);
    }, `${etiqueta}: serializeFrame no lanza`);
    assert.equal('nativeDialog' in frameObj, false, `${etiqueta}: el frame no trae nativeDialog; recibido ${JSON.stringify(frameObj.nativeDialog)}`);
  }
});

test('P26: con {"type":"confirm","message":"m","pending":true,"extra":1}, serializeFrame trae nativeDialog deepEqual a {type:"confirm", message:"m", pending:true}', () => {
  const doc = ventana('<main><button>Go</button></main>', ATRIBUTO_VALIDO_CON_EXTRA).document;

  let frameObj;
  assert.doesNotThrow(() => {
    frameObj = serializeFrame(doc.body);
  }, 'P26: serializeFrame no lanza con una forma válida');
  assert.deepEqual(
    frameObj.nativeDialog,
    NATIVE_DIALOG_PROYECTADO,
    `P26: frame.nativeDialog es exactamente {type:"confirm", message:"m", pending:true}; recibido ${JSON.stringify(frameObj.nativeDialog)}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P26 — performActionAndObserve
// ═══════════════════════════════════════════════════════════════════════════

const HTML_BOTON = '<main><button id="x">Go</button></main>';

/** Cuenta los click que llegan al botón #x. */
function contarClicks(doc) {
  const cuenta = { n: 0 };
  doc.getElementById('x').addEventListener('click', () => cuenta.n++);
  return cuenta;
}

test('P26: con el atributo inválido, performActionAndObserve click despacha como sin pregunta — el click llega al listener y la respuesta es la de sin atributo, sin nativeDialog', async () => {
  const { performActionAndObserve } = api('P26-act-invalido', 'performActionAndObserve');

  for (const valor of ATRIBUTOS_INVALIDOS) {
    const etiqueta = `P26 act click atributo ${valor}`;

    const docSin = ventana(HTML_BOTON).document;
    const clicksSin = contarClicks(docSin);
    const resSin = await conDocumentGlobal(docSin, () =>
      performActionAndObserve(docSin.getElementById('x'), 'click', undefined, OPCIONES),
    );
    assert.equal(clicksSin.n, 1, `precondición ${etiqueta}: sin atributo, el click llega al listener`);

    const docCon = ventana(HTML_BOTON, valor).document;
    const clicksCon = contarClicks(docCon);
    let resCon;
    await assert.doesNotReject(async () => {
      resCon = await conDocumentGlobal(docCon, () =>
        performActionAndObserve(docCon.getElementById('x'), 'click', undefined, OPCIONES),
      );
    }, `${etiqueta}: performActionAndObserve no rechaza`);

    assert.equal(clicksCon.n, 1, `${etiqueta}: el click llega al listener, como sin pregunta; respuesta ${JSON.stringify(resCon)}`);
    assertComoSinPregunta(resSin, resCon, etiqueta);
  }
});

test('P26: con {"type":"confirm","message":"m","pending":true,"extra":1}, el rechazo del guard de performActionAndObserve trae nativeDialog deepEqual a {type:"confirm", message:"m", pending:true}', async () => {
  const { performActionAndObserve } = api('P26-act-proyecta', 'performActionAndObserve');
  const doc = ventana(HTML_BOTON, ATRIBUTO_VALIDO_CON_EXTRA).document;

  let res;
  await assert.doesNotReject(async () => {
    res = await conDocumentGlobal(doc, () =>
      performActionAndObserve(doc.getElementById('x'), 'click', undefined, OPCIONES),
    );
  }, 'P26: performActionAndObserve no rechaza con una forma válida');
  assert.equal(res.ok, false, `precondición P26: con una pregunta pendiente válida, el guard rechaza; recibido ${JSON.stringify(res)}`);
  assert.deepEqual(
    res.nativeDialog,
    NATIVE_DIALOG_PROYECTADO,
    `P26: nativeDialog del rechazo es exactamente {type:"confirm", message:"m", pending:true}; recibido ${JSON.stringify(res.nativeDialog)}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P26 — performFill
// ═══════════════════════════════════════════════════════════════════════════

const HTML_INPUT = '<main><input id="x" value="orig" aria-label="campo"></main>';

test('P26: con el atributo inválido, performFill despacha como sin pregunta — escribe el valor y la respuesta es la de sin atributo, sin nativeDialog', async () => {
  const { performFill } = api('P26-fill-invalido', 'performFill');

  for (const valor of ATRIBUTOS_INVALIDOS) {
    const etiqueta = `P26 fill atributo ${valor}`;

    const docSin = ventana(HTML_INPUT).document;
    const resSin = await conDocumentGlobal(docSin, () => performFill(docSin.getElementById('x'), 'nuevo', OPCIONES));
    assert.equal(resSin.success, true, `precondición ${etiqueta}: sin atributo, el fill tiene éxito; recibido ${JSON.stringify(resSin)}`);
    assert.equal(docSin.getElementById('x').value, 'nuevo', `precondición ${etiqueta}: sin atributo, el fill escribe el valor`);

    const docCon = ventana(HTML_INPUT, valor).document;
    let resCon;
    await assert.doesNotReject(async () => {
      resCon = await conDocumentGlobal(docCon, () => performFill(docCon.getElementById('x'), 'nuevo', OPCIONES));
    }, `${etiqueta}: performFill no rechaza`);

    assert.equal(docCon.getElementById('x').value, 'nuevo', `${etiqueta}: el fill escribe el valor, como sin pregunta; respuesta ${JSON.stringify(resCon)}`);
    assertComoSinPregunta(resSin, resCon, etiqueta);
  }
});

test('P26: con {"type":"confirm","message":"m","pending":true,"extra":1}, el rechazo del guard de performFill trae nativeDialog deepEqual a {type:"confirm", message:"m", pending:true}', async () => {
  const { performFill } = api('P26-fill-proyecta', 'performFill');
  const doc = ventana(HTML_INPUT, ATRIBUTO_VALIDO_CON_EXTRA).document;

  let res;
  await assert.doesNotReject(async () => {
    res = await conDocumentGlobal(doc, () => performFill(doc.getElementById('x'), 'nuevo', OPCIONES));
  }, 'P26: performFill no rechaza con una forma válida');
  assert.equal(res.success, false, `precondición P26: con una pregunta pendiente válida, el guard rechaza; recibido ${JSON.stringify(res)}`);
  assert.deepEqual(
    res.nativeDialog,
    NATIVE_DIALOG_PROYECTADO,
    `P26: nativeDialog del rechazo es exactamente {type:"confirm", message:"m", pending:true}; recibido ${JSON.stringify(res.nativeDialog)}`,
  );
});
