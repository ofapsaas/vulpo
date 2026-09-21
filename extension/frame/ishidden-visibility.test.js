/**
 * ishidden-visibility.test.js — fb-018-006 / generalidad no-Odoo #1 (sub-fase RED).
 *
 * Defecto: findings/generalidad-no-odoo-ishidden-visibility-override-2026-09-08.md
 * `isHidden(el, win)` (dialog.js:56-71) camina el elemento Y TODOS sus ancestros
 * chequeando display:none Y visibility:hidden/collapse. El chequeo de
 * visibility POR ANCESTROS es incorrecto: en CSS `visibility` se hereda CON
 * OVERRIDE — un descendiente con `visibility: visible` se renderiza visible
 * bajo un ancestro `visibility: hidden`, y el computed style DEL PROPIO
 * elemento ya resuelve la herencia (devuelve el valor final de la cadena).
 * Bite real: Gmail envuelve su compose (role=dialog, Para/Asunto, Enviar) en
 * un wrapper `visibility:hidden` con un panel `visibility:visible` ⇒ el
 * compose entero salía invisible al contrato (`dialog:null`, cero campos)
 * estando visible en pantalla.
 *
 * ── Semántica PINADA por estos tests (definida con el orquestador) ──────────
 *  (a) display:none en CUALQUIER ancestro (incluido self) ⇒ oculto — display
 *      NO se hereda: no hay override posible y la caminata de ancestros es lo
 *      único que lo cubre (caso Bootstrap `.modal{display:none}` que motivó
 *      el criterio original, comentario dialog.js:48-55).
 *  (b) la visibilidad se resuelve con el computed style DEL PROPIO elemento
 *      (`hidden`/`collapse` ⇒ oculto): el valor resuelto ya incluye la
 *      herencia con overrides, así que la caminata de ancestros NO chequea
 *      visibility.
 *  (c) `aria-hidden` NO cambia: sigue siendo dominio de `isAriaHidden`
 *      (caminata de ancestros intacta — aria-hidden no tiene semántica de
 *      override), y `isHidden` no lo considera.
 *
 * ── Naturaleza RED esperada (precedente: dialogo-inerte.test.js:23-34) ──────
 *  · FALLAN por AssertionError (el defecto existe hoy): G1, G7.
 *  · PINES / anti-regresión — se espera que PASEN ya en RED (fijan la
 *    semántica que el fix NO debe romper): G2, G3, G4, G5, G6.
 *
 * ── Lecciones jsdom aplicadas (fb-018-005) ──────────────────────────────────
 *  · Los estilos van INLINE (style="..."), NO vía <style>: jsdom no aplica
 *    hojas de estilo en getComputedStyle.
 *  · jsdom SÍ resuelve la HERENCIA de visibility en getComputedStyle con
 *    estilos inline (probe 2026-09-08: hijo sin override bajo wrapper hidden
 *    ⇒ computed "hidden"; nieto con ancestro intermedio sin style ⇒
 *    "hidden"; hijo bajo panel visible ⇒ "visible"). Por eso G2 y el control
 *    de G7 pueden apoyarse en la herencia resuelta.
 *  · Sin layout real: getClientRects() vacío ⇒ serializer degrada a
 *    visible:true (el filtro de zero-rects no interfiere); elementFromPoint
 *    ausente ⇒ isBlocking degrada a true (irrelevante para estas aserciones).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isHidden, isAriaHidden } from './dialog.js';
import { serializeFrame } from './serializer.js';

// ── helpers (house style: dialogo-inerte.test.js) ───────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}

// ── G1..G6 — unit: el predicado isHidden/isAriaHidden directamente ─────────

// RED (el defecto). El override `visibility:visible` del subárbol debe ganar:
// hoy la caminata de ancestros condena al input por el wrapper (finding
// §Causa raíz) y devuelve true ⇒ AssertionError.
test('G1 RED (finding §Causa raíz): wrapper visibility:hidden + panel visibility:visible ⇒ isHidden(input) es false — el override de visibilidad se respeta', () => {
  const doc = makeDom(
    '<div id="wrap" style="visibility:hidden">' +
      '<div id="panel" style="visibility:visible"><input id="para" aria-label="Destinatarios en Para"></div>' +
    '</div>',
  );
  const win = doc.defaultView;
  const input = doc.getElementById('para');
  // Guardas del fixture: jsdom resuelve los estilos inline (probe en header).
  assert.equal(win.getComputedStyle(doc.getElementById('wrap')).visibility, 'hidden');
  assert.equal(win.getComputedStyle(input).visibility, 'visible');
  // Semántica (b): el computed del PROPIO elemento ya resuelve la cadena.
  assert.equal(isHidden(input, win), false);
});

// PIN (regresión). Sin override, la herencia resuelve `hidden` en el computed
// del propio panel — la semántica (b) debe seguir ocultándolo tras el fix.
test('G2 PIN (finding §Fix): wrapper visibility:hidden + panel SIN visibilidad propia ⇒ isHidden(panel) es true — el computed style ya resuelve la herencia', () => {
  const doc = makeDom(
    '<div id="wrap" style="visibility:hidden"><div id="panel"><input aria-label="x"></div></div>',
  );
  const win = doc.defaultView;
  const panel = doc.getElementById('panel');
  assert.equal(win.getComputedStyle(panel).visibility, 'hidden');
  assert.equal(isHidden(panel, win), true);
});

// PIN (regresión). display:none NO se hereda: el computed del propio elemento
// nunca lo refleja — la caminata de ancestros (semántica (a)) es lo único que
// lo cubre, a cualquier profundidad.
test('G3 PIN (dialog.js:48-55): ancestro display:none a cualquier profundidad ⇒ isHidden(el) es true — display no se hereda, el walk de ancestros es lo único que lo cubre', () => {
  const doc = makeDom('<div style="display:none"><div><div><input id="x" aria-label="x"></div></div></div>');
  const win = doc.defaultView;
  const input = doc.getElementById('x');
  assert.notEqual(win.getComputedStyle(input).display, 'none');
  assert.equal(isHidden(input, win), true);
});

// PIN (regresión). La visibilidad PROPIA del elemento (hidden y collapse) debe
// seguir ocultándolo — semántica (b) con el propio valor, sin ancestros.
test('G4 PIN (finding §Fix): visibilidad PROPIA hidden o collapse ⇒ isHidden(el) es true (ambos valores)', () => {
  const doc = makeDom(
    '<input id="a" style="visibility:hidden" aria-label="a">' +
      '<input id="b" style="visibility:collapse" aria-label="b">',
  );
  const win = doc.defaultView;
  assert.equal(win.getComputedStyle(doc.getElementById('b')).visibility, 'collapse');
  assert.equal(isHidden(doc.getElementById('a'), win), true);
  assert.equal(isHidden(doc.getElementById('b'), win), true);
});

// PIN (regresión). El caso Bootstrap que motivó el criterio original
// (comentario dialog.js:48-55): `.modal { display: none }` con role=dialog
// adentro debe seguir contando como oculto — semántica (a).
test('G5 PIN (dialog.js:48-55): div.modal con display:none conteniendo role=dialog ⇒ isHidden(dialogEl) es true — el caso Bootstrap que motivó el criterio', () => {
  const doc = makeDom(
    '<div class="modal" style="display:none">' +
      '<div role="dialog" id="d" aria-label="Sin abrir"><button>Cerrar</button></div>' +
    '</div>',
  );
  const win = doc.defaultView;
  const dialogEl = doc.getElementById('d');
  assert.notEqual(win.getComputedStyle(dialogEl).display, 'none');
  assert.equal(isHidden(dialogEl, win), true);
});

// PIN (regresión). Separación de dominios (semántica (c)): aria-hidden es
// dominio EXCLUSIVO de isAriaHidden (caminata de ancestros intacta — no tiene
// override); isHidden NO lo considera: sin display/visibility en juego, un
// subárbol aria-hidden NO está "hidden" para isHidden.
test('G6 PIN (finding §Fix): ancestro aria-hidden="true" SIN display/visibility ⇒ isAriaHidden(el) es true e isHidden(el) es false — el dominio de aria-hidden no se toca', () => {
  const doc = makeDom('<div aria-hidden="true"><button id="b">x</button></div>');
  const win = doc.defaultView;
  const b = doc.getElementById('b');
  assert.equal(win.getComputedStyle(b).visibility, 'visible');
  assert.notEqual(win.getComputedStyle(b).display, 'none');
  assert.equal(isAriaHidden(b), true);
  assert.equal(isHidden(b, win), false);
});

// ── G7 — serializer-level (integración): el caso Gmail del finding ──────────

// Fixture que replica la estructura Gmail medida en campo (finding §Hallazgo):
// wrapper `visibility:hidden` (típico de animaciones slide-in) con panel
// `visibility:visible` adentro, el compose (role=dialog + Para + Enviar)
// dentro del panel, y un control SIN override dentro del wrapper pero FUERA
// del panel (su computed heredado es `hidden` ⇒ debe seguir excluido).
//
// RED hoy: la caminata de ancestros de isHidden excluye TODO el subárbol del
// compose (dialog:null, cero elementos) pese a estar visible ⇒ las aserciones
// de emisión fallan por AssertionError.
test('G7 RED serializer (finding §Hallazgo, caso Gmail): wrapper hidden + panel visible ⇒ serializeFrame EMITE el compose (role=dialog, Para, Enviar) y el control sin override sigue excluido', () => {
  const doc = makeDom(
    '<div id="app"><button id="bandeja">Bandeja</button></div>' +
      '<div id="compose-wrap" style="visibility:hidden">' +
      '<div id="compose-panel" style="visibility:visible">' +
      '<div role="dialog" aria-labelledby="cmp-t">' +
      '<h3 id="cmp-t">Redactar: Mensaje nuevo</h3>' +
      '<input id="para" aria-label="Destinatarios en Para">' +
      '<div role="button" id="enviar" aria-label="Enviar"></div>' +
      '</div>' +
      '</div>' +
      // Control: dentro del wrapper, FUERA del panel, SIN override — su
      // computed heredado es `hidden` (guarda abajo) ⇒ debe seguir excluido.
      '<div role="button" id="oculto" aria-label="Boton oculto del wrapper"></div>' +
      '</div>',
  );
  const win = doc.defaultView;
  // Guardas del fixture: el override del panel y la herencia sin override.
  assert.equal(win.getComputedStyle(doc.getElementById('compose-wrap')).visibility, 'hidden');
  assert.equal(win.getComputedStyle(doc.getElementById('compose-panel')).visibility, 'visible');
  assert.equal(win.getComputedStyle(doc.getElementById('para')).visibility, 'visible');
  assert.equal(win.getComputedStyle(doc.getElementById('oculto')).visibility, 'hidden');

  const frame = serializeFrame(doc.body, {});
  const els = allElements(frame);

  // Guarda de no-vacuidad: el serializer sigue emitiendo el contenido normal
  // (sin este guard, "el compose no está" sería verde vacuo si el frame
  // viniera vacío por otra rotura).
  const bandeja = els.find((e) => e.name === 'Bandeja');
  assert.ok(bandeja, `guarda: el contenido normal (#app) se emite; emitidos: ${JSON.stringify(els)}`);

  // RED 1 (finding: "cero textboxes de Para/Asunto"): el input Para se emite.
  const para = els.find((e) => e.name === 'Destinatarios en Para');
  assert.ok(para, `RED: el compose visible debe emitirse; emitidos: ${JSON.stringify(els)}`);
  assert.equal(para.role, 'textbox');
  assert.equal(para.tag, 'input');

  // RED 2 (finding: "cero botón Enviar").
  const enviar = els.find((e) => e.name === 'Enviar');
  assert.ok(enviar, `RED: el botón Enviar debe emitirse; emitidos: ${JSON.stringify(els)}`);
  assert.equal(enviar.role, 'button');

  // RED 3 (finding: "dialog:null en todas las páginas"): el role=dialog del
  // compose es el diálogo activo. (No se pina el name del diálogo: es dominio
  // de dialogNameOf, cubierto por dialogo-inerte.test.js.)
  assert.ok(frame.dialog, 'RED: el compose debe detectarse como diálogo activo (frame.dialog presente)');
  assert.equal(frame.dialog.role, 'dialog');

  // Control (regresión): el hermano del panel SIN override sigue excluido.
  const oculto = els.find((e) => e.name === 'Boton oculto del wrapper');
  assert.equal(oculto, undefined, 'control: el elemento del wrapper sin override visibility:visible NO se emite');
});
