/**
 * native-dialog-frame.test.js — fb-020-003-native-dialog-policy.
 *
 * Verifica P8 y P9 de docs/specs/fb-020-003-native-dialog-policy/spec.md §3.3
 * ("Frame (T1)"): el campo `nativeDialog` de primer nivel que agrega
 * `serializeFrame` mientras hay una pregunta nativa pendiente. Nada de
 * P1–P7 va acá.
 *
 * Superficie pública usada:
 *   - `serializeFrame(root, options)` — `./serializer.js` (sin cambios de
 *     firma; existente desde fb-017/018, spec §14 "Campo del frame").
 *   - `readNativeDialog(doc)` — `./index.js`.
 *   - `installNativeDialogWatchMain()` — `src/extension/native-dialog-main.js`
 *     (v3.3, P24), cargado en runtime con el `window` de jsdom.
 *
 * ── v3.3, P24: cambia sólo la FUENTE del setup ──────────────────────────────
 * Antes de v3.3 la instalación usaba `installNativeDialogWatch(win)` del
 * bundle, que P24 retira. Ahora el envoltorio sale de
 * `native-dialog-main.js`, leído en runtime y evaluado con el `window` de
 * jsdom en el ámbito (`cargarNativeDialogMain`, abajo). Se usa el archivo (y
 * no el atributo directo) porque P8 afirma también que la sola instalación no
 * altera el frame: esa aserción no tiene sujeto sin instalación. Las
 * aserciones de P8/P9 no cambian.
 *
 * Escrito SOLO contra esa superficie. El test-writer no leyó
 * `src/extension/frame/serializer.js`, `native-dialog-main.js` ni ningún otro
 * módulo de implementación (salvo `*.test.js`), ni `background.js`.
 *
 * ── Modelo de "pregunta pendiente" en T1 (§3 del spec) ──────────────────────
 * Un original simulado de `win.prompt`/`win.confirm` que, MIENTRAS CORRE (sin
 * `await` de por medio), llama a `serializeFrame(doc.body)` y guarda el
 * resultado, además de `readNativeDialog(doc)` como precondición de
 * no-vacuidad.
 *
 * ── Orden del fixture (F4 del test-audit) ───────────────────────────────────
 * El original simulado se asigna a `win.prompt`/`win.confirm` ANTES de
 * instalar, porque jsdom no los implementa y porque `install` envuelve la
 * referencia vigente en el momento de instalar.
 *
 * ── Comparación "todo lo demás, incluida fingerprint, es deepEqual a la
 *    serialización del mismo DOM sin pregunta" (P8) ────────────────────────
 * Se arman DOS `window`/`document` de jsdom, construidos con el MISMO HTML:
 *   - `winLimpio`: nunca instala el envoltorio.
 *   - `winInstalado`: instala el envoltorio y, más tarde, la pregunta pendiente.
 * Se serializa `winLimpio` una sola vez (`frameLimpio`) y se usa como
 * oráculo. Si la instalación dejara en el DOM una marca que el serializer
 * viera sin pregunta, `frameInstaladoSinPregunta` dejaría de ser `deepEqual` a
 * `frameLimpio` y el test lo señalaría con AssertionError.
 *
 * `fingerprint` es una clave más del frame: al comparar `frameConPregunta` sin
 * la clave `nativeDialog` contra `frameLimpio` con `deepEqual`, la comparación
 * de `fingerprint` queda incluida.
 *
 * ── DOM del diálogo modal (P9) ────────────────────────────────────────────
 * `HTML_ODOO` es un DUPLICADO LOCAL (no importado) del fixture de
 * `dialogo-inerte.test.js:83-97` (fb-018-004): fondo accionable + diálogo
 * modal anónimo con `<h4 class="modal-title">`. Sin hit-test disponible en
 * jsdom, `dialog.modal` degrada a `true` (`inert-generico.test.js:426-437`).
 *
 * ── Naturaleza RED esperada (lote v3.3) ─────────────────────────────────────
 * Mientras `src/extension/native-dialog-main.js` no exista, P8 y P9 caen por
 * AssertionError en `cargarNativeDialogMain` (nombra P24).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';

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
      `${nombre} no exportada por ./index.js — ${id} de fb-020-003 P8/P9` +
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

// ── helpers ─────────────────────────────────────────────────────────────────

function nuevaVentana(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window;
}
function allElements(frameObj) {
  if (!Array.isArray(frameObj.sections)) return [];
  return frameObj.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
/** Mapa ref → inert (o undefined si la clave no está presente), para comparar por elemento. */
function mapaInert(frameObj) {
  const mapa = {};
  for (const el of allElements(frameObj)) {
    mapa[el.ref] = 'inert' in el ? el.inert : undefined;
  }
  return mapa;
}

// ═══════════════════════════════════════════════════════════════════════════
// P8 — nativeDialog fuera de la huella; sin pregunta la clave no existe
// ═══════════════════════════════════════════════════════════════════════════

const HTML_PROMPT = '<main><button id="renombrar">Renombrar</button><input id="nombre" value="Documento"></main>';
const MENSAJE_PROMPT = 'Nuevo nombre';
const DEFAULT_PROMPT = 'viejo';
const NATIVE_DIALOG_ESPERADO_P8 = { type: 'prompt', message: MENSAJE_PROMPT, pending: true };

test('P8: mientras corre un prompt pendiente, serializeFrame trae nativeDialog exacto; todo lo demás, incluida fingerprint, es deepEqual a la serialización sin pregunta; sin pregunta la clave no existe', () => {
  const { readNativeDialog } = api('P8', 'readNativeDialog');

  // Lado de control: DOM equivalente que nunca instaló el envoltorio.
  const winLimpio = nuevaVentana(HTML_PROMPT);
  const frameLimpio = serializeFrame(winLimpio.document.body);
  assert.equal(
    'nativeDialog' in frameLimpio,
    false,
    'P8: sin instalación y sin pregunta pendiente, la clave nativeDialog no existe (nunca null ni false, §2.3)',
  );

  // Lado bajo prueba: mismo HTML, con el envoltorio instalado.
  const winInstalado = nuevaVentana(HTML_PROMPT);
  let frameConPregunta;
  let pendienteObservado;
  // F4: el original se asigna ANTES de install.
  winInstalado.prompt = (mensaje, valorDefault) => {
    // MIENTRAS CORRE el original, capturamos el frame y la lectura de la pregunta.
    pendienteObservado = readNativeDialog(winInstalado.document);
    frameConPregunta = serializeFrame(winInstalado.document.body);
    return 'nuevo valor tipeado';
  };
  cargarNativeDialogMain(winInstalado).installNativeDialogWatchMain();

  // Tras instalar pero ANTES de disparar el diálogo: la sola instalación no
  // puede alterar el frame respecto del DOM limpio (aditividad, I-6).
  const frameInstaladoSinPregunta = serializeFrame(winInstalado.document.body);
  assert.equal(
    'nativeDialog' in frameInstaladoSinPregunta,
    false,
    'P8: con la instalación activa pero sin ningún diálogo en curso, la clave nativeDialog no existe',
  );
  assert.deepEqual(
    frameInstaladoSinPregunta,
    frameLimpio,
    'P8: instalar el envoltorio, por sí solo (sin pregunta en curso), no cambia el frame respecto de no instalar nada — cubre el riesgo de una marca en el DOM que sobreviva a la instalación',
  );

  const resultado = winInstalado.prompt(MENSAJE_PROMPT, DEFAULT_PROMPT);
  assert.equal(
    resultado,
    'nuevo valor tipeado',
    'precondición P8: el envoltorio es transparente (P1) — se invocó el original y devolvió su valor',
  );
  assert.deepEqual(
    pendienteObservado,
    NATIVE_DIALOG_ESPERADO_P8,
    'precondición P8: la pregunta estaba realmente pendiente en el momento de serializar (no vacuo)',
  );
  assert.ok(frameConPregunta, 'precondición P8: se capturó un frame mientras corría el original');

  assert.deepEqual(
    frameConPregunta.nativeDialog,
    NATIVE_DIALOG_ESPERADO_P8,
    `P8: frame.nativeDialog es exactamente {type:"prompt", message:"${MENSAJE_PROMPT}", pending:true} mientras la pregunta está pendiente`,
  );

  const { nativeDialog: _nativeDialog, ...frameConPreguntaSinClave } = frameConPregunta;
  assert.deepEqual(
    frameConPreguntaSinClave,
    frameLimpio,
    'P8: todo lo demás del frame (sections, read, do, page, totalPages y fingerprint incluidos) es deepEqual a la serialización del mismo DOM sin pregunta',
  );

  // Tras devolver, la pregunta ya no está pendiente.
  assert.equal(
    readNativeDialog(winInstalado.document),
    null,
    'postcondición: tras devolver el original, la pregunta ya no está pendiente',
  );
  const frameTrasResponder = serializeFrame(winInstalado.document.body);
  assert.equal(
    'nativeDialog' in frameTrasResponder,
    false,
    'postcondición: tras responder, la clave nativeDialog ya no existe',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P9 — coexistencia con `dialog`/`inert` (fixture de dialogo-inerte)
// ═══════════════════════════════════════════════════════════════════════════

// Duplicado local (NO exportado) del fixture de dialogo-inerte.test.js:83-97
// (fb-018-004 §2.1.1, markup real medido contra Odoo 19).
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

const MENSAJE_CONFIRM = '¿Confirma la operación?';
const NATIVE_DIALOG_ESPERADO_P9 = { type: 'confirm', message: MENSAJE_CONFIRM, pending: true };

test('P9: con pregunta pendiente sobre el fixture de diálogo modal, la respuesta trae dialog (con modal) y nativeDialog; los inert son los mismos que sin pregunta', () => {
  const { readNativeDialog } = api('P9', 'readNativeDialog');

  // Baseline sin ningún envoltorio: dialog/modal/inert "de siempre".
  const winSinPregunta = nuevaVentana(HTML_ODOO);
  const frameSinPregunta = serializeFrame(winSinPregunta.document.body);
  assert.ok(frameSinPregunta.dialog, 'precondición P9: el fixture de dialogo-inerte activa la detección de diálogo');
  assert.equal(
    frameSinPregunta.dialog.modal,
    true,
    'precondición P9: sin capacidad de hit-test (jsdom), dialog.modal degrada a true (fb-018-005 §2.3)',
  );
  assert.equal('nativeDialog' in frameSinPregunta, false, 'precondición P9: sin instalación ni pregunta, no hay nativeDialog');
  const inertesBase = mapaInert(frameSinPregunta);
  assert.ok(
    Object.values(inertesBase).some((v) => v === true),
    'precondición P9: el fixture de diálogo modal efectivamente marca inert:true en algún elemento del fondo (no-vacuidad)',
  );

  // Lado bajo prueba: mismo fixture, con una pregunta pendiente.
  const winConPregunta = nuevaVentana(HTML_ODOO);
  let frameConPregunta;
  let pendienteObservado;
  winConPregunta.confirm = (mensaje) => {
    pendienteObservado = readNativeDialog(winConPregunta.document);
    frameConPregunta = serializeFrame(winConPregunta.document.body);
    return true;
  };
  cargarNativeDialogMain(winConPregunta).installNativeDialogWatchMain();
  winConPregunta.confirm(MENSAJE_CONFIRM);

  assert.deepEqual(
    pendienteObservado,
    NATIVE_DIALOG_ESPERADO_P9,
    'precondición P9: la pregunta estaba realmente pendiente cuando se serializó (no vacuo)',
  );
  assert.ok(frameConPregunta, 'precondición P9: se capturó un frame mientras corría el original');

  assert.deepEqual(
    frameConPregunta.nativeDialog,
    NATIVE_DIALOG_ESPERADO_P9,
    `P9: frame.nativeDialog es exactamente {type:"confirm", message:"${MENSAJE_CONFIRM}", pending:true} con la pregunta pendiente`,
  );
  assert.ok(frameConPregunta.dialog, 'P9: con la pregunta pendiente, la respuesta sigue trayendo dialog (§3.3, coexistencia con fb-018)');
  assert.deepEqual(
    frameConPregunta.dialog,
    frameSinPregunta.dialog,
    'P9: dialog (incluido modal) es el mismo con y sin pregunta pendiente',
  );

  const inertesConPregunta = mapaInert(frameConPregunta);
  assert.deepEqual(
    inertesConPregunta,
    inertesBase,
    'P9: los inert (por elemento) son los mismos con y sin pregunta pendiente',
  );
});
