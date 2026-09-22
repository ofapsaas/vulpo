/**
 * native-dialog-envoltorio.test.js — fb-020-003-native-dialog-policy.
 *
 * Verifica P1–P4 de docs/specs/fb-020-003-native-dialog-policy/spec.md §3.1
 * ("Envoltorio (T1)") y P24 (v3.3, fuente única del envoltorio MAIN). Nada de
 * P5–P9 ni del harness va acá.
 *
 * ── v3.3, P24: cambia sólo la FUENTE del setup ──────────────────────────────
 * El envoltorio bajo prueba es el que corre en producción:
 * `src/extension/native-dialog-main.js`, script clásico (sin import/export)
 * que declara `installNativeDialogWatchMain()` y
 * `restoreNativeDialogWatchMain()`, que sólo usan el `window` de su ámbito.
 * El test lo lee EN RUNTIME y lo evalúa con el `window` de jsdom en el ámbito
 * (`cargarNativeDialogMain(win)`, abajo). El lector sigue siendo
 * `readNativeDialog(doc)` del bundle (`./index.js`).
 *
 * Antes de v3.3 el setup usaba `installNativeDialogWatch(win)` /
 * `restoreNativeDialogWatch(win)` del bundle, que P24 retira. Las aserciones
 * de P1–P4 NO cambian: sólo cambia de dónde sale el envoltorio.
 *
 * El test-writer no leyó `native-dialog-main.js` (no existe al escribir este
 * RED) ni ningún módulo de implementación de src/extension/frame/*.js ni
 * background.js: se especifica el contrato, no la implementación.
 *
 * ── Modelo de "pregunta pendiente" en T1 (§3 del spec) ──────────────────────
 * Un original simulado de win.confirm/alert/prompt que, MIENTRAS CORRE,
 * ejecuta la aserción: llama a readNativeDialog(doc) y guarda lo observado
 * antes de devolver su valor (o de lanzar).
 *
 * ── Orden del fixture (F4 del test-audit) ────────────────────────────────────
 * Los originales simulados se asignan a win.confirm/alert/prompt ANTES de
 * instalar, porque jsdom no los implementa: si se instalara primero, no habría
 * nada que envolver. `win` es el `window` de un `new JSDOM(...)`; `doc` es
 * `win.document`.
 *
 * ── Naturaleza RED esperada (lote v3.3) ─────────────────────────────────────
 * Mientras `src/extension/native-dialog-main.js` no exista, todo test que lo
 * carga cae por AssertionError en `cargarNativeDialogMain` (nombra P24). El
 * test de P24 sobre los exports cae por AssertionError mientras el bundle siga
 * exportando install/restore.
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
      `${nombre} no exportada (RED) por ./index.js — ${id} de fb-020-003` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// ── Carga de native-dialog-main.js (P24) ────────────────────────────────────
// Duplicado local en cada test que lo usa: el hook del rol no permite escribir
// un helper compartido fuera de *.test.js.
// Lee el archivo EN RUNTIME y lo evalúa con `win` como `window` del ámbito.
// Una evaluación por llamada: cada carga modela una inyección independiente
// (en producción, `func` sin clausura compartida entre inyecciones). Si el
// archivo no existe o no declara las dos funciones ⇒ AssertionError (P24).
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

// ── helpers ─────────────────────────────────────────────────────────────────

/** window de un documento jsdom nuevo, vacío. */
function nuevaVentana() {
  return new JSDOM('<!DOCTYPE html><html><body></body></html>').window;
}

// ═══════════════════════════════════════════════════════════════════════════
// P24 — el bundle deja de exportar install/restore y conserva readNativeDialog
// ═══════════════════════════════════════════════════════════════════════════

test('P24: el bundle del frame (./index.js) ya no exporta installNativeDialogWatch ni restoreNativeDialogWatch, y conserva readNativeDialog', () => {
  assert.ok(frame, `precondición P24: ./index.js carga${errorDeCarga ? `; error: ${errorDeCarga.message}` : ''}`);
  assert.equal('installNativeDialogWatch' in frame, false, 'P24: ./index.js ya no exporta installNativeDialogWatch (la única fuente del envoltorio es native-dialog-main.js)');
  assert.equal('restoreNativeDialogWatch' in frame, false, 'P24: ./index.js ya no exporta restoreNativeDialogWatch (la única fuente del envoltorio es native-dialog-main.js)');
  assert.equal(typeof frame.readNativeDialog, 'function', 'P24: ./index.js conserva readNativeDialog');
});

// ═══════════════════════════════════════════════════════════════════════════
// P1 — transparencia
// ═══════════════════════════════════════════════════════════════════════════

test('P1: win.confirm(m) devuelve lo que devuelve el original — true y false — y el original se invoca exactamente una vez con el mismo argumento', () => {
  for (const valor of [true, false]) {
    const win = nuevaVentana();
    const llamadas = [];
    // F4: el original se asigna ANTES de install.
    win.confirm = (...args) => {
      llamadas.push(args);
      return valor;
    };
    cargarNativeDialogMain(win).installNativeDialogWatchMain();

    const resultado = win.confirm('¿Confirma?');

    assert.equal(resultado, valor, `P1: win.confirm devuelve exactamente lo que devuelve el original (${valor})`);
    assert.deepEqual(llamadas, [['¿Confirma?']], `P1: el original de confirm se invocó exactamente una vez, con el mismo argumento (caso ${valor})`);
  }
});

test('P1: win.alert(m) devuelve undefined y el original se invoca exactamente una vez con el mismo argumento', () => {
  const win = nuevaVentana();
  const llamadas = [];
  win.alert = (...args) => {
    llamadas.push(args);
    // El alert real no devuelve nada.
  };
  cargarNativeDialogMain(win).installNativeDialogWatchMain();

  const resultado = win.alert('Guardado');

  assert.equal(resultado, undefined, 'P1: win.alert devuelve undefined, como el original');
  assert.deepEqual(llamadas, [['Guardado']], 'P1: el original de alert se invocó exactamente una vez, con el mismo argumento');
});

test('P1: win.prompt(m, d) devuelve el string o el null del original, y el original se invoca exactamente una vez con los mismos argumentos', () => {
  // Caso string.
  {
    const win = nuevaVentana();
    const llamadas = [];
    win.prompt = (...args) => {
      llamadas.push(args);
      return 'texto tipeado';
    };
    cargarNativeDialogMain(win).installNativeDialogWatchMain();

    const resultado = win.prompt('Nuevo nombre', 'viejo');

    assert.equal(resultado, 'texto tipeado', 'P1: win.prompt devuelve exactamente el string del original');
    assert.deepEqual(llamadas, [['Nuevo nombre', 'viejo']], 'P1: el original de prompt se invocó exactamente una vez, con los mismos argumentos (caso string)');
  }

  // Caso null (cancelado).
  {
    const win = nuevaVentana();
    const llamadas = [];
    win.prompt = (...args) => {
      llamadas.push(args);
      return null;
    };
    cargarNativeDialogMain(win).installNativeDialogWatchMain();

    const resultado = win.prompt('Nuevo nombre', 'viejo');

    assert.equal(resultado, null, 'P1: win.prompt devuelve exactamente null cuando el original cancela');
    assert.deepEqual(llamadas, [['Nuevo nombre', 'viejo']], 'P1: el original de prompt se invocó exactamente una vez, con los mismos argumentos (caso null)');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — anotación
// ═══════════════════════════════════════════════════════════════════════════

test('P2: mientras corre el original de confirm("¿Borrar?"), readNativeDialog(doc) es exactamente {type:"confirm", message:"¿Borrar?", pending:true}; antes y después de la llamada es null', () => {
  const { readNativeDialog } = api('P2-confirm', 'readNativeDialog');
  const win = nuevaVentana();
  const doc = win.document;

  assert.equal(readNativeDialog(doc), null, 'P2: precondición, antes de instalar no hay pregunta pendiente');

  let observadoMientrasCorre;
  win.confirm = () => {
    observadoMientrasCorre = readNativeDialog(doc);
    return true;
  };
  cargarNativeDialogMain(win).installNativeDialogWatchMain();

  assert.equal(readNativeDialog(doc), null, 'P2: instalado pero sin llamar todavía, readNativeDialog es null');

  win.confirm('¿Borrar?');

  assert.deepEqual(
    observadoMientrasCorre,
    { type: 'confirm', message: '¿Borrar?', pending: true },
    'P2: mientras corre el original de confirm, readNativeDialog trae exactamente ese objeto',
  );
  assert.equal(readNativeDialog(doc), null, 'P2: después de que el original vuelve, readNativeDialog es null otra vez');
});

test('P2: mientras corre el original de alert("Guardado"), readNativeDialog(doc) es exactamente {type:"alert", message:"Guardado", pending:true}; y con alert() sin argumentos, message es ""', () => {
  const { readNativeDialog } = api('P2-alert', 'readNativeDialog');

  {
    const win = nuevaVentana();
    const doc = win.document;
    let observadoMientrasCorre;
    win.alert = () => {
      observadoMientrasCorre = readNativeDialog(doc);
    };
    cargarNativeDialogMain(win).installNativeDialogWatchMain();

    win.alert('Guardado');

    assert.deepEqual(
      observadoMientrasCorre,
      { type: 'alert', message: 'Guardado', pending: true },
      'P2: mientras corre el original de alert, readNativeDialog trae exactamente ese objeto',
    );
    assert.equal(readNativeDialog(doc), null, 'P2: después de alert, readNativeDialog es null otra vez');
  }

  {
    const win = nuevaVentana();
    const doc = win.document;
    let observadoMientrasCorre;
    win.alert = () => {
      observadoMientrasCorre = readNativeDialog(doc);
    };
    cargarNativeDialogMain(win).installNativeDialogWatchMain();

    win.alert();

    assert.deepEqual(
      observadoMientrasCorre,
      { type: 'alert', message: '', pending: true },
      'P2: alert() sin argumentos ⇒ message es "" (spec §2.1)',
    );
  }
});

test('P2: mientras corre el original de prompt("Nuevo nombre", "viejo"), readNativeDialog(doc) es exactamente {type:"prompt", message:"Nuevo nombre", pending:true}; antes y después es null', () => {
  const { readNativeDialog } = api('P2-prompt', 'readNativeDialog');
  const win = nuevaVentana();
  const doc = win.document;

  let observadoMientrasCorre;
  win.prompt = () => {
    observadoMientrasCorre = readNativeDialog(doc);
    return 'texto tipeado';
  };
  cargarNativeDialogMain(win).installNativeDialogWatchMain();

  assert.equal(readNativeDialog(doc), null, 'P2: instalado pero sin llamar todavía, readNativeDialog es null');

  win.prompt('Nuevo nombre', 'viejo');

  assert.deepEqual(
    observadoMientrasCorre,
    { type: 'prompt', message: 'Nuevo nombre', pending: true },
    'P2: mientras corre el original de prompt, readNativeDialog trae exactamente ese objeto',
  );
  assert.equal(readNativeDialog(doc), null, 'P2: después de que el original vuelve, readNativeDialog es null otra vez');
});

test('P2: si el original lanza, la excepción llega al llamador y después readNativeDialog(doc) es null', () => {
  const { readNativeDialog } = api('P2-lanza', 'readNativeDialog');
  const win = nuevaVentana();
  const doc = win.document;

  const errorOriginal = new Error('el original de confirm explotó');
  win.confirm = () => {
    throw errorOriginal;
  };
  cargarNativeDialogMain(win).installNativeDialogWatchMain();

  assert.throws(
    () => win.confirm('¿Seguro?'),
    (e) => e === errorOriginal,
    'P2: si el original lanza, la excepción llega intacta al llamador',
  );
  assert.equal(readNativeDialog(doc), null, 'P2: después de la excepción, readNativeDialog vuelve a ser null');
});

// ═══════════════════════════════════════════════════════════════════════════
// P3 — varios diálogos
// ═══════════════════════════════════════════════════════════════════════════

test('P3: dentro de una misma instalación, llamar confirm y después alert — cada uno se ve con su type/message mientras corre, null entre medio, y la segunda llamada también pasa por el envoltorio', () => {
  const { readNativeDialog } = api('P3', 'readNativeDialog');
  const win = nuevaVentana();
  const doc = win.document;

  let observadoConfirm;
  let observadoAlert;
  win.confirm = () => {
    observadoConfirm = readNativeDialog(doc);
    return true;
  };
  win.alert = () => {
    observadoAlert = readNativeDialog(doc);
  };
  cargarNativeDialogMain(win).installNativeDialogWatchMain();

  win.confirm('primero');
  assert.deepEqual(
    observadoConfirm,
    { type: 'confirm', message: 'primero', pending: true },
    'P3: el primer diálogo (confirm) se ve con su type y message mientras corre',
  );
  assert.equal(readNativeDialog(doc), null, 'P3: entre las dos llamadas, readNativeDialog es null');

  win.alert('segundo');
  assert.deepEqual(
    observadoAlert,
    { type: 'alert', message: 'segundo', pending: true },
    'P3: el segundo diálogo (alert) también pasa por el envoltorio — se anota igual que el primero, dentro de la misma instalación',
  );
  assert.equal(readNativeDialog(doc), null, 'P3: después del segundo diálogo, readNativeDialog vuelve a ser null');
});

// ═══════════════════════════════════════════════════════════════════════════
// P4 — restauración
// ═══════════════════════════════════════════════════════════════════════════

test('P4: tras restoreNativeDialogWatchMain(), win.confirm/alert/prompt son idénticos (===) a los originales', () => {
  const win = nuevaVentana();
  const confirmOriginal = () => true;
  const alertOriginal = () => undefined;
  const promptOriginal = () => null;
  win.confirm = confirmOriginal;
  win.alert = alertOriginal;
  win.prompt = promptOriginal;

  const main = cargarNativeDialogMain(win);
  main.installNativeDialogWatchMain();
  main.restoreNativeDialogWatchMain();

  assert.equal(win.confirm, confirmOriginal, 'P4: win.confirm es idéntico (===) al original tras restore');
  assert.equal(win.alert, alertOriginal, 'P4: win.alert es idéntico (===) al original tras restore');
  assert.equal(win.prompt, promptOriginal, 'P4: win.prompt es idéntico (===) al original tras restore');
});

test('P4: llamar restore dos veces, o sin haber instalado, no lanza y deja los originales', () => {
  // Sin haber instalado.
  const winSinInstalar = nuevaVentana();
  const confirmSinInstalar = () => true;
  winSinInstalar.confirm = confirmSinInstalar;
  const mainSinInstalar = cargarNativeDialogMain(winSinInstalar);
  assert.doesNotThrow(
    () => mainSinInstalar.restoreNativeDialogWatchMain(),
    'P4: restore sin haber instalado antes no lanza',
  );
  assert.equal(winSinInstalar.confirm, confirmSinInstalar, 'P4: restore sin instalar deja win.confirm tal cual estaba');

  // Dos veces.
  const winDosVeces = nuevaVentana();
  const confirmDosVeces = () => true;
  winDosVeces.confirm = confirmDosVeces;
  const mainDosVeces = cargarNativeDialogMain(winDosVeces);
  mainDosVeces.installNativeDialogWatchMain();
  mainDosVeces.restoreNativeDialogWatchMain();
  assert.doesNotThrow(
    () => mainDosVeces.restoreNativeDialogWatchMain(),
    'P4: llamar restore una segunda vez no lanza',
  );
  assert.equal(winDosVeces.confirm, confirmDosVeces, 'P4: tras restaurar dos veces, win.confirm sigue siendo el original');
});

test('P4: si entre install y restore la página asignó su propia función a win.confirm, después de restore sigue siendo la de la página; alert/prompt (no tocados) vuelven a los originales', () => {
  const win = nuevaVentana();
  const confirmOriginal = () => true;
  const alertOriginal = () => undefined;
  const promptOriginal = () => null;
  win.confirm = confirmOriginal;
  win.alert = alertOriginal;
  win.prompt = promptOriginal;

  const main = cargarNativeDialogMain(win);
  main.installNativeDialogWatchMain();

  const confirmDeLaPagina = () => 'propio de la página';
  win.confirm = confirmDeLaPagina;

  main.restoreNativeDialogWatchMain();

  assert.equal(
    win.confirm,
    confirmDeLaPagina,
    'P4: la función que la página asignó a win.confirm durante la ventana sobrevive a restore — no se pisa',
  );
  assert.equal(win.alert, alertOriginal, 'P4: win.alert, no tocado por la página, vuelve al original');
  assert.equal(win.prompt, promptOriginal, 'P4: win.prompt, no tocado por la página, vuelve al original');
});
