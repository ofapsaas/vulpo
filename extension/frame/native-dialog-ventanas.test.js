/**
 * native-dialog-ventanas.test.js — fb-020-003-native-dialog-policy (v3.3, lote de fixes del review).
 *
 * Verifica P25 (ventanas solapadas, R-01) de
 * docs/specs/fb-020-003-native-dialog-policy/spec.md §3 ("Postcondiciones de
 * los fixes del review (v3.3)"), T1 sobre `src/extension/native-dialog-main.js`.
 *
 * Contrato bajo prueba (sólo la parte T1 de P25; el glue de background.js lo
 * verifica el reviewer y no va acá):
 *   - `installNativeDialogWatchMain()` devuelve `true` si la llamada queda
 *     registrada como ventana viva (instaló, o se sumó a una instalación viva
 *     de este mismo archivo); `false` si no, y en ese caso no toca
 *     `confirm/alert/prompt`. Pasa cuando
 *     `window.__vulpoNativeDialogOriginals__` existe pero no tiene la forma
 *     que escribe este archivo.
 *   - Tras N install que devolvieron `true`: las primeras N−1 llamadas a
 *     restore dejan los envoltorios puestos (un `confirm` sigue anotando, como
 *     en P2); la N-ésima aplica la restauración selectiva de P4 y borra la
 *     global; cada restore extra no hace nada y no lanza.
 *
 * ── Carga del archivo (P24) ─────────────────────────────────────────────────
 * `cargarNativeDialogMain(win)` lee el archivo EN RUNTIME y lo evalúa con el
 * `window` de jsdom en el ámbito. Cada llamada a install/restore usa una carga
 * PROPIA: modela inyecciones independientes (en producción, cada `act click`
 * inyecta con `func`, sin clausura compartida). El único estado compartido
 * entre ventanas es el que la implementación deje en `window`.
 *
 * El lector de la anotación es `readNativeDialog(doc)` del bundle (./index.js).
 *
 * El test-writer no leyó `native-dialog-main.js` (no existe al escribir este
 * RED) ni ningún módulo de implementación.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 * Mientras `src/extension/native-dialog-main.js` no exista, todos los tests
 * caen por AssertionError en `cargarNativeDialogMain` (nombra P24).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// ── Guard de RED (bundle) ───────────────────────────────────────────────────
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
      `${nombre} no exportada por ./index.js — ${id} de fb-020-003 P25` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// ── Carga de native-dialog-main.js (P24) ────────────────────────────────────
// Duplicado local en cada test que lo usa: el hook del rol no permite escribir
// un helper compartido fuera de *.test.js.
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

/** Una inyección independiente de install sobre `win`; devuelve su valor de retorno. */
function install(win) {
  return cargarNativeDialogMain(win).installNativeDialogWatchMain();
}

/** Una inyección independiente de restore sobre `win`. */
function restore(win) {
  return cargarNativeDialogMain(win).restoreNativeDialogWatchMain();
}

// ── helpers ─────────────────────────────────────────────────────────────────

const GLOBAL_ORIGINALES = '__vulpoNativeDialogOriginals__';

/**
 * window jsdom nuevo con originales simulados de confirm/alert/prompt
 * asignados ANTES de cualquier install (jsdom no los implementa).
 */
function ventanaConOriginales() {
  const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window;
  const originales = {
    confirm: () => true,
    alert: () => undefined,
    prompt: () => null,
  };
  win.confirm = originales.confirm;
  win.alert = originales.alert;
  win.prompt = originales.prompt;
  return { win, doc: win.document, originales };
}

function assertOriginalesIntactos(win, originales, etiqueta) {
  assert.equal(win.confirm, originales.confirm, `${etiqueta}: win.confirm es idéntico (===) al original`);
  assert.equal(win.alert, originales.alert, `${etiqueta}: win.alert es idéntico (===) al original`);
  assert.equal(win.prompt, originales.prompt, `${etiqueta}: win.prompt es idéntico (===) al original`);
}

// ═══════════════════════════════════════════════════════════════════════════
// P25 — valor de retorno de install
// ═══════════════════════════════════════════════════════════════════════════

test('P25: installNativeDialogWatchMain() devuelve true cuando instala sobre una ventana sin instalación viva', () => {
  const { win } = ventanaConOriginales();
  assert.strictEqual(install(win), true, 'P25: install sobre una ventana limpia devuelve exactamente true');
});

test('P25: con window.__vulpoNativeDialogOriginals__ preexistente de forma ajena ({} y 1), installNativeDialogWatchMain() devuelve false y confirm/alert/prompt quedan intactos', () => {
  for (const [nombre, valorAjeno] of [['{}', {}], ['1', 1]]) {
    const etiqueta = `P25 global ajena ${nombre}`;
    const { win, originales } = ventanaConOriginales();
    win[GLOBAL_ORIGINALES] = valorAjeno;

    const resultado = install(win);

    assert.strictEqual(resultado, false, `${etiqueta}: install devuelve exactamente false`);
    assertOriginalesIntactos(win, originales, `${etiqueta}: install que devolvió false no toca confirm/alert/prompt`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P25 — restauración con N ventanas
// ═══════════════════════════════════════════════════════════════════════════

test('P25: dos install que devuelven true y un restore — los envoltorios siguen puestos: confirm sigue anotando como en P2', () => {
  const { readNativeDialog } = api('P25-dos-install-un-restore', 'readNativeDialog');
  const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window;
  const doc = win.document;

  let observadoMientrasCorre;
  // F4: el original se asigna ANTES de install.
  win.confirm = () => {
    observadoMientrasCorre = readNativeDialog(doc);
    return true;
  };

  assert.strictEqual(install(win), true, 'P25: el primer install devuelve true (instala)');
  assert.strictEqual(install(win), true, 'P25: el segundo install devuelve true (se suma a la instalación viva de este mismo archivo)');
  restore(win);

  win.confirm('¿Borrar?');

  assert.deepEqual(
    observadoMientrasCorre,
    { type: 'confirm', message: '¿Borrar?', pending: true },
    'P25: tras 2 install y 1 restore (N−1 = 1), confirm sigue pasando por el envoltorio y anota exactamente como en P2',
  );
  assert.equal(readNativeDialog(doc), null, 'P25: después de que el original vuelve, readNativeDialog es null otra vez (P2)');
});

test('P25: tras dos install, el segundo restore aplica la restauración selectiva de P4 (la función que asignó la página sobrevive) y borra la global', () => {
  const { win, originales } = ventanaConOriginales();

  assert.strictEqual(install(win), true, 'precondición P25: el primer install devuelve true');
  assert.strictEqual(install(win), true, 'precondición P25: el segundo install devuelve true');

  const confirmDeLaPagina = () => 'propio de la página';
  win.confirm = confirmDeLaPagina;

  restore(win);
  restore(win);

  assert.equal(
    win.confirm,
    confirmDeLaPagina,
    'P25: la N-ésima restauración es la selectiva de P4 — la función que la página asignó a win.confirm durante la ventana no se pisa',
  );
  assert.equal(win.alert, originales.alert, 'P25: la N-ésima restauración devuelve win.alert al original (===)');
  assert.equal(win.prompt, originales.prompt, 'P25: la N-ésima restauración devuelve win.prompt al original (===)');
  assert.equal(
    GLOBAL_ORIGINALES in win,
    false,
    'P25: la N-ésima restauración borra window.__vulpoNativeDialogOriginals__',
  );
});

test('P25: cada restore extra (más allá de N) no hace nada y no lanza; la ventana queda como sin instalación', () => {
  const { readNativeDialog } = api('P25-restore-extra', 'readNativeDialog');
  const { win, doc, originales } = ventanaConOriginales();

  assert.strictEqual(install(win), true, 'precondición P25: el primer install devuelve true');
  assert.strictEqual(install(win), true, 'precondición P25: el segundo install devuelve true');
  restore(win);
  restore(win);
  assertOriginalesIntactos(win, originales, 'precondición P25: tras N restore');

  assert.doesNotThrow(() => restore(win), 'P25: un restore extra no lanza');
  assert.doesNotThrow(() => restore(win), 'P25: un segundo restore extra no lanza');
  assertOriginalesIntactos(win, originales, 'P25: los restore extra no hacen nada');
  assert.equal(GLOBAL_ORIGINALES in win, false, 'P25: tras los restore extra la global sigue sin existir');

  // "No hace nada" también hacia adelante: los restore extra no dejan saldo.
  // Una ventana nueva (N = 1) se comporta como sobre una ventana limpia.
  let observadoMientrasCorre;
  const confirmObservador = () => {
    observadoMientrasCorre = readNativeDialog(doc);
    return true;
  };
  win.confirm = confirmObservador;
  assert.strictEqual(install(win), true, 'P25: tras los restore extra, un install nuevo devuelve true');
  win.confirm('¿Otra vez?');
  assert.deepEqual(
    observadoMientrasCorre,
    { type: 'confirm', message: '¿Otra vez?', pending: true },
    'P25: tras los restore extra, el install nuevo envuelve y confirm anota como en P2',
  );
  restore(win);
  assert.equal(win.confirm, confirmObservador, 'P25: un único restore cierra esa ventana nueva (N = 1) y devuelve confirm al original (===)');
  assert.equal(win.alert, originales.alert, 'P25: un único restore cierra esa ventana nueva y devuelve alert al original (===)');
  assert.equal(win.prompt, originales.prompt, 'P25: un único restore cierra esa ventana nueva y devuelve prompt al original (===)');
});
