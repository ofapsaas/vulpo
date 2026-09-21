/**
 * inert-popup-dialogo.test.js — fb-020-004 (sub-fase RED).
 *
 * Verifica P6, P7, P8, P9 y P10 de docs/specs/fb-020-004/spec.md
 * §3 (contrato §2.3: `ownedPopup` del diálogo activo).
 *
 * Escrito SOLO contra la superficie pública observable — serializeFrame(root,
 * options), resolveRef(ref, root) y performAction(el, action, value, options).
 * Aislamiento anti-trampa: no se leyó dialog.js, serializer.js, act.js,
 * resolver.js ni background.js; NO se importa `isInert`.
 *
 * Fixtures: réplica del markup real medido en la sonda S-F8 (§6): diálogo Odoo
 * `<div role="dialog" class="modal d-block">` dentro de `.o-overlay-container > div`,
 * popover HERMANO POSTERIOR `div.o_popover.o_select_menu_menu[role=menu]` con
 * `span[role=menuitem]`, y toggler `div.o-dropdown.dropdown-toggle[aria-expanded=true]`
 * con `input.o_select_menu_toggler` dentro del diálogo. Ningún test depende de
 * las clases de Odoo: la lógica sólo puede salir de roles/atributos ARIA y del
 * orden de documento (I-2).
 *
 * Régimen `blocking`: jsdom no tiene hit-test, así que (como en
 * dialogo-inerte.test.js) el veredicto es `blocking`. Cada test abre con una
 * guarda de no-vacuidad: el botón de fondo DEBE salir `inert:true`; si no, las
 * aserciones "no lleva inert" serían verdes vacuas.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  · FALLAN por AssertionError (la rama ownedPopup no existe todavía):
 *    P6 (menuitems con aria-controls salen inert y act los rechaza),
 *    P7 (menuitems con aria-expanded="true" salen inert y act los rechaza).
 *  · PINES / anti-regresión — se espera que PASEN ya en RED:
 *    P8 (a)(b)(c), P9 (hoy todo lo que está fuera del diálogo activo es inerte;
 *    pinean que la excepción nueva no se abra de más),
 *    P10 (serializer y act ya comparten isInert; pinea I-3 sobre los DOM nuevos).
 *  · La segunda cláusula de P9 (dialogo-inerte / inert-generico siguen verdes
 *    sin editarlos) se verifica corriendo la suite completa, no con un test nuevo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';
import { performAction } from './act.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
/** Elemento del frame cuyo ref resuelve exactamente a `nodo`. */
function emitidoPara(frame, root, nodo, etiqueta) {
  const el = allElements(frame).find((e) => resolveRef(e.ref, root) === nodo);
  assert.ok(
    el,
    `precondición (${etiqueta}): el frame emite el nodo; refs emitidos: ${JSON.stringify(allElements(frame).map((e) => e.ref))}`,
  );
  return el;
}
/** Guarda de no-vacuidad: régimen blocking activo (el fondo es inerte). */
function assertFondoInerte(frame, root, doc, etiqueta) {
  assert.ok(frame.dialog, `${etiqueta}: precondición — hay diálogo activo; claves=${JSON.stringify(Object.keys(frame))}`);
  const fondo = emitidoPara(frame, root, doc.getElementById('fondo'), etiqueta);
  assert.equal(fondo.inert, true, `${etiqueta}: precondición — el botón de fondo sale inert:true (blocking)`);
}
function contarClicks(nodos) {
  const cuenta = { n: 0 };
  for (const n of nodos) n.addEventListener('click', () => cuenta.n++);
  return cuenta;
}

// ── fixtures (markup real S-F8) ─────────────────────────────────────────────

const FONDO = '<div class="o_action_manager"><button id="fondo">Validar</button></div>';

function dialogoOdoo({ id = '', titulo = 'Formulario', toggler }) {
  return (
    '<div class="o_dialog">' +
    `<div role="dialog" ${id ? `id="${id}"` : ''} class="modal d-block o_technical_modal" tabindex="-1">` +
    '<div class="modal-dialog"><div class="modal-content">' +
    `<header class="modal-header"><h4 class="modal-title">${titulo}</h4></header>` +
    '<main class="modal-body"><div name="state_choice" class="o_field_widget o_field_selection">' +
    toggler +
    '</div></main>' +
    '<footer class="modal-footer"><button>Guardar</button></footer>' +
    '</div></div></div></div>'
  );
}

function toggler({ expanded = 'true', controls = '' } = {}) {
  return (
    `<div class="o-dropdown dropdown-toggle o-dropdown--no-caret" tabindex="-1"` +
    `${expanded === null ? '' : ` aria-expanded="${expanded}"`}` +
    `${controls ? ` aria-controls="${controls}"` : ''}>` +
    '<input type="text" class="o_input o_select_menu_toggler" aria-label="Estado">' +
    '</div>'
  );
}

function popover(id = '') {
  return (
    `<div ${id ? `id="${id}" ` : ''}class="o_popover popover mw-100 o_select_menu_menu" role="menu">` +
    '<span role="menuitem" class="o_select_menu_item dropdown-item">Devolver</span>' +
    '<span role="menuitem" class="o_select_menu_item dropdown-item">Reprogramar</span>' +
    '</div>'
  );
}

function overlay(...hijos) {
  return (
    '<div class="o-main-components-container"><div class="o-overlay-container">' +
    hijos.join('') +
    '</div></div>'
  );
}

/** P6: toggler con aria-controls → id del menú (sin aria-expanded="true"). */
const HTML_P6 = FONDO + overlay(dialogoOdoo({ toggler: toggler({ expanded: 'false', controls: 'menu_sel' }) }), popover('menu_sel'));
/** P6 (variante): aria-controls apunta a un ANCESTRO del menú. */
const HTML_P6_ANCESTRO =
  FONDO +
  overlay(
    dialogoOdoo({ toggler: toggler({ expanded: 'false', controls: 'envoltorio' }) }),
    `<div id="envoltorio">${popover()}</div>`,
  );
/** P7: markup real S-F8 — sin aria-controls, toggler aria-expanded="true". */
const HTML_P7 = FONDO + overlay(dialogoOdoo({ toggler: toggler({ expanded: 'true' }) }), popover());
/** P8(a): menú posterior sin vínculo y sin aria-expanded="true" en el diálogo. */
const HTML_P8A = FONDO + overlay(dialogoOdoo({ toggler: toggler({ expanded: 'false' }) }), popover());
/** P8(b): menú ANTERIOR al diálogo, aunque el diálogo tenga aria-expanded="true". */
const HTML_P8B = FONDO + overlay(popover(), dialogoOdoo({ toggler: toggler({ expanded: 'true' }) }));
/** P8(c): contenido NO-popup posterior al diálogo, con aria-expanded="true" en el diálogo. */
const HTML_P8C =
  FONDO +
  overlay(
    dialogoOdoo({ toggler: toggler({ expanded: 'true' }) }),
    '<div class="o_notification_manager"><button id="nopopup">Deshacer</button><a href="#x" id="nopopup-link">Ver</a></div>',
  );
/**
 * P9: dos diálogos hermanos. El menú pertenece al INFERIOR: su toggler (en el
 * inferior) lo controla por aria-controls y está aria-expanded="true"; el menú
 * queda entre ambos diálogos. El activo (superior) no tiene vínculo ni
 * aria-expanded="true".
 */
const HTML_P9 =
  FONDO +
  overlay(
    '<div class="o-overlay-item">' +
      dialogoOdoo({ titulo: 'Inferior', toggler: toggler({ expanded: 'true', controls: 'menu_inferior' }) }).replace(
        'class="modal d-block',
        'class="modal d-block o_inactive_modal',
      ) +
      '</div>',
    popover('menu_inferior'),
    '<div class="o-overlay-item">' +
      '<div class="o_dialog"><div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
      '<h4 class="modal-title">Superior</h4><footer><button>Cerrar</button></footer></div></div>' +
      '</div>',
  );

function menuitems(doc) {
  return [...doc.querySelectorAll('[role="menuitem"]')];
}

// ── P6 ──────────────────────────────────────────────────────────────────────

for (const [variante, html] of [
  ['aria-controls → id del menú', HTML_P6],
  ['aria-controls → id de un ancestro del menú', HTML_P6_ANCESTRO],
]) {
  test(`P6 (§2.3 rama i, ${variante}): los menuitems salen sin inert y act click los despacha sin force`, () => {
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    assertFondoInerte(frame, root, doc, 'P6');

    const items = menuitems(doc);
    assert.equal(items.length, 2, 'precondición: el popover tiene dos menuitems');
    for (const item of items) {
      const el = emitidoPara(frame, root, item, 'P6');
      assert.equal('inert' in el, false, `P6: menuitem del popup del diálogo activo SIN la clave inert: ${JSON.stringify(el)}`);
    }

    const clicks = contarClicks(items);
    const res = performAction(items[0], 'click');
    assert.equal(res.ok, true, `P6: act click sin force acepta el menuitem; recibido ${JSON.stringify(res)}`);
    assert.equal('inert' in res, false, `P6: la respuesta no lleva inert; recibido ${JSON.stringify(res)}`);
    assert.equal(clicks.n, 1, 'P6: el click se despachó sobre el menuitem');
  });
}

// ── P7 ──────────────────────────────────────────────────────────────────────

test('P7 (§2.3 rama ii, markup S-F8): sin aria-controls, toggler aria-expanded="true" → menuitems sin inert y act los acepta', () => {
  const doc = makeDom(HTML_P7);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  assertFondoInerte(frame, root, doc, 'P7');

  const items = menuitems(doc);
  assert.equal(items.length, 2, 'precondición: el popover tiene dos menuitems');
  for (const item of items) {
    const el = emitidoPara(frame, root, item, 'P7');
    assert.equal('inert' in el, false, `P7: menuitem sin la clave inert: ${JSON.stringify(el)}`);
  }

  const clicks = contarClicks(items);
  const res = performAction(items[1], 'click');
  assert.equal(res.ok, true, `P7: act click sin force acepta el menuitem; recibido ${JSON.stringify(res)}`);
  assert.equal('inert' in res, false, `P7: la respuesta no lleva inert; recibido ${JSON.stringify(res)}`);
  assert.equal(clicks.n, 1, 'P7: el click se despachó sobre el menuitem');
});

// ── P8 ──────────────────────────────────────────────────────────────────────

function assertInerteYRechazado(html, nodosDe, etiqueta) {
  const doc = makeDom(html);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  assertFondoInerte(frame, root, doc, etiqueta);

  const nodos = nodosDe(doc);
  assert.ok(nodos.length > 0, `${etiqueta}: precondición — hay nodos a verificar`);
  const clicks = contarClicks(nodos);
  for (const nodo of nodos) {
    const el = emitidoPara(frame, root, nodo, etiqueta);
    assert.equal(el.inert, true, `${etiqueta}: sigue inert:true: ${JSON.stringify(el)}`);
    const res = performAction(nodo, 'click');
    assert.equal(res.ok, false, `${etiqueta}: act lo rechaza; recibido ${JSON.stringify(res)}`);
    assert.equal(res.inert, true, `${etiqueta}: rechazo por inert; recibido ${JSON.stringify(res)}`);
  }
  assert.equal(clicks.n, 0, `${etiqueta}: ningún click despachado`);
}

test('P8(a) (§2.3): menú posterior al diálogo, sin vínculo ni aria-expanded="true" en el diálogo → inert y rechazado', () => {
  assertInerteYRechazado(HTML_P8A, menuitems, 'P8(a)');
});

test('P8(b) (§2.3): menú ANTERIOR al diálogo, aunque haya aria-expanded="true" en el diálogo → inert y rechazado', () => {
  assertInerteYRechazado(HTML_P8B, menuitems, 'P8(b)');
});

test('P8(c) (§2.3 cond. 1): contenido no-popup posterior al diálogo, con aria-expanded="true" en el diálogo → inert y rechazado', () => {
  assertInerteYRechazado(
    HTML_P8C,
    (doc) => [doc.getElementById('nopopup'), doc.getElementById('nopopup-link')],
    'P8(c)',
  );
});

// ── P9 ──────────────────────────────────────────────────────────────────────

test('P9 (§2.3): diálogos apilados hermanos — el menú del diálogo INFERIOR sigue inert y act lo rechaza', () => {
  const doc = makeDom(HTML_P9);
  const frame = serializeFrame(doc.body, {});
  assert.ok(frame.dialog, 'precondición: hay diálogo activo');
  assert.equal(frame.dialog.name, 'Superior', 'precondición: el activo es el diálogo superior (último en orden de documento)');
  assertInerteYRechazado(HTML_P9, menuitems, 'P9');
});

// ── P10 ─────────────────────────────────────────────────────────────────────

test('P10 (I-3): en los DOM de P6–P9, para todo elemento emitido, inert:true ⟺ act lo rechaza por inert', () => {
  const casos = [
    ['P6', HTML_P6],
    ['P6-ancestro', HTML_P6_ANCESTRO],
    ['P7', HTML_P7],
    ['P8(a)', HTML_P8A],
    ['P8(b)', HTML_P8B],
    ['P8(c)', HTML_P8C],
    ['P9', HTML_P9],
  ];
  let inertes = 0;
  let libres = 0;
  for (const [nombre, html] of casos) {
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    for (const el of allElements(frame)) {
      const nodo = resolveRef(el.ref, root);
      assert.ok(nodo, `${nombre}: precondición — el ref emitido resuelve: ${el.ref}`);
      const res = performAction(nodo, 'focus');
      const rechazadoPorInert = res.ok === false && res.inert === true;
      assert.equal(
        el.inert === true,
        rechazadoPorInert,
        `${nombre}: serializer inert=${el.inert} vs act ${JSON.stringify(res)} para ${el.ref}`,
      );
      if (el.inert === true) inertes++;
      else libres++;
    }
  }
  assert.ok(inertes > 0 && libres > 0, `no-vacuidad: ambos regímenes presentes (inertes=${inertes}, libres=${libres})`);
});
