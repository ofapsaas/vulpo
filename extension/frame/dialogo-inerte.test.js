/**
 * dialogo-inerte.test.js — fb-018-004-dialogo-y-fondo-inerte (sub-fase RED).
 *
 * Verifica P1–P19 y el property test del invariante I-4 del spec
 * docs/specs/fb-018-004-dialogo-y-fondo-inerte/spec.md §3 y §4.
 * (P20 vive en Go: src/server/internal/mcp/mcp_dialogo_inerte_test.go.)
 *
 * Escrito SOLO contra la superficie pública observable —
 * serializeFrame(root, options), resolveRef(ref, root) y
 * performAction(el, action, value, options) — con aislamiento anti-trampa: el
 * test-writer no leyó serializer.js, act.js, resolver.js ni background.js. En
 * particular NO se importa el módulo compartido `dialog.js` de §2.6, que es un
 * detalle de implementación (aún inexistente): importarlo haría fallar la suite
 * por error de import y no por aserción.
 *
 * Los fixtures replican el markup REAL medido contra Odoo 19 (§2.1.1): el
 * `<div role="dialog" class="modal d-block">` SIN `aria-modal` con
 * `<h4 class="modal-title">`, y la pila de dos diálogos HERMANOS bajo
 * `.o-overlay-container`. Deliberadamente ningún test depende de la clase
 * `o_inactive_modal` (§6.3): está en el fixture porque es el markup real, pero
 * la detección debe salir del orden de documento.
 *
 * ── Naturaleza RED esperada (precedente: payload-efficiency.test.js:12-27) ───
 *
 *  · FALLAN por AssertionError (la funcionalidad no existe todavía):
 *    P3, P4, P5, P6, P7, P8, P9, P11, P11b, P12, P14, I-4.
 *
 *  · PINES / anti-regresión — se espera que PASEN ya en RED:
 *    P1, P2  (hoy no existe ninguna de las dos claves: se cumplen de hecho;
 *             tras GREEN son el guard de que la detección no dispare de más),
 *    P10     (hoy no se filtra nada; pinea I-A contra la implementación nueva),
 *    P13, P15, P16 (comportamiento actual de act que la feature no debe tocar),
 *    P17, P18, P19 (la huella ya es función pura del DOM y serializar ya es
 *             read-only; pinean que la feature no lo rompa).
 *
 * ── Guardas de no-vacuidad (deliberadas) ────────────────────────────────────
 * Varias postcondiciones son de la forma "si X entonces Y" y con la feature
 * ausente X nunca ocurre → verde VACUO. Por eso P8/P11/P11b/I-4 abren con
 * `assertAlgoInerte()` (exige al menos un `inert:true` emitido) y P14 abre
 * exigiendo que SIN `force` el guard rechace. Esas líneas son el
 * AssertionError que hace el RED real y siguen siendo significativas después
 * de GREEN (un refactor que borre la clave no puede dejarlas verdes por
 * ausencia).
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
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}
function porRef(frame, ref) {
  const el = allElements(frame).find((e) => e.ref === ref);
  assert.ok(el, `precondición: el frame emite el elemento ${ref}; emitidos: ${JSON.stringify(allRefs(frame))}`);
  return el;
}
/** Guarda de no-vacuidad: la feature tiene que estar marcando ALGO como inerte. */
function assertAlgoInerte(frame, etiqueta) {
  const inertes = allElements(frame).filter((e) => e.inert === true);
  assert.ok(
    inertes.length > 0,
    `${etiqueta}: con diálogo activo el serializer debe emitir al menos un elemento con inert:true (§2.4). ` +
      'Sin esta guarda las aserciones "no lleva inert" serían verdes vacuas. ' +
      `Emitido: ${JSON.stringify(allElements(frame))}`,
  );
  return inertes;
}

// Markup REAL medido (§2.1.1): fondo accionable + diálogo anónimo con
// header/main/footer y un role=alert. Réplica del §2.3 del finding.
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

const REF_DIALOGO_ODOO = 'div:2';
const REFS_FONDO_ODOO = ['div:1>ol>li>a', 'div:1>button', 'div:1>input', 'div:1>select'];

// Pila de dos diálogos HERMANOS bajo el overlay container (§2.4.1 / P11).
const HTML_PILA_HERMANA =
  '<div class="o-main-components-container"><div class="o-overlay-container">' +
  '<div class="o-overlay-item">' +
  '<div class="o_dialog o_inactive_modal" id="dialog_2">' +
  '<div role="dialog" class="modal d-block o_technical_modal o_inactive_modal" tabindex="-1">' +
  '<h4>Confirmación</h4><button>Descartar</button></div></div></div>' +
  '<div class="o-overlay-item">' +
  '<div class="o_dialog" id="dialog_3">' +
  '<div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
  '<h4>Operación no válida</h4><button>Cerrar</button></div></div></div>' +
  '</div></div>';

// ── §3 Caso base / no-regresión ─────────────────────────────────────────────

test('P1 (§3, PIN): sin ningún dialog/alertdialog visible, no hay clave `dialog` ni ningún `inert`', () => {
  const doc = makeDom('<main><h1>Recepción</h1><button>Validar</button><input value="x"></main>');
  const frame = serializeFrame(doc.body, {});

  assert.ok(allElements(frame).length >= 2, 'precondición: el fixture emite elementos');
  assert.equal('dialog' in frame, false, 'sin diálogo la clave `dialog` está AUSENTE (no null, no {}) — §2.2');
  for (const el of allElements(frame)) {
    assert.equal('inert' in el, false, `sin diálogo ningún elemento lleva la clave inert: ${JSON.stringify(el)}`);
  }
});

test('P2 (§3, PIN): un role="dialog" descartado por isHidden/isAriaHidden NO activa la detección', () => {
  const doc = makeDom(
    '<main><button>Validar</button></main>' +
      '<div role="dialog" style="display:none" class="modal"><h4>Fantasma bootstrap</h4><button>Cerrar</button></div>' +
      '<div role="dialog" aria-hidden="true" class="modal"><h4>Fantasma aria</h4><button>Cerrar</button></div>',
  );
  const frame = serializeFrame(doc.body, {});

  assert.ok(
    doc.querySelectorAll('[role="dialog"]').length === 2,
    'precondición: los dos nodos .modal están en el DOM',
  );
  assert.equal('dialog' in frame, false, 'un diálogo oculto no activa la detección (§2.1) — se cumple P1');
  for (const el of allElements(frame)) {
    assert.equal('inert' in el, false, `ningún elemento se marca inerte por un diálogo oculto: ${JSON.stringify(el)}`);
  }
});

// ── §2.2 Campo `dialog` de primer nivel ─────────────────────────────────────

test('P3 (§2.2): con diálogo activo el Frame trae `dialog` {ref, role, name} y resolveRef(dialog.ref) da ese elemento', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const esperado = doc.querySelector('[role="dialog"]');
  const frame = serializeFrame(root, {});

  assert.ok(
    frame.dialog,
    'el Frame debe traer la clave `dialog` de primer nivel (§2.2); claves=' + JSON.stringify(Object.keys(frame)),
  );
  assert.equal(typeof frame.dialog.ref, 'string', '`dialog.ref` es un string');
  assert.ok(frame.dialog.ref.length > 0, '`dialog.ref` no puede ser vacío');
  assert.equal(typeof frame.dialog.role, 'string', '`dialog.role` es un string');
  assert.equal(typeof frame.dialog.name, 'string', '`dialog.name` es un string');
  assert.equal(
    resolveRef(frame.dialog.ref, root),
    esperado,
    `resolveRef(dialog.ref) debe devolver exactamente el elemento del diálogo activo; ref=${frame.dialog.ref}`,
  );
  assert.equal(frame.dialog.ref, REF_DIALOGO_ODOO, 'el ref del diálogo va en el encoding compacto de fb-018-001 §2.1');
});

test('P4 (§2.2): `dialog.role` sale de getRole — div[role=dialog], div[role=alertdialog] y <dialog> nativo', () => {
  const conDialog = serializeFrame(makeDom('<div role="dialog"><h4>Uno</h4><button>Ok</button></div>').body, {});
  assert.ok(conDialog.dialog, 'div[role=dialog] activa la detección');
  assert.equal(conDialog.dialog.role, 'dialog');

  const conAlert = serializeFrame(makeDom('<div role="alertdialog"><h4>Dos</h4><button>Ok</button></div>').body, {});
  assert.ok(conAlert.dialog, 'div[role=alertdialog] activa la detección');
  assert.equal(conAlert.dialog.role, 'alertdialog', 'alertdialog se propaga tal cual (§2.2)');

  // <dialog> nativo: entra por getRole, sin caso especial de tagName (§2.1).
  const docNativo = makeDom('<dialog open><h2>Nativo</h2><button>Ok</button></dialog>');
  const nativo = serializeFrame(docNativo.body, {});
  assert.ok(nativo.dialog, 'el <dialog> nativo entra por getRole, no por tagName (§2.1)');
  assert.equal(nativo.dialog.role, 'dialog');
  assert.equal(
    resolveRef(nativo.dialog.ref, docNativo.body),
    docNativo.querySelector('dialog'),
    'el ref del <dialog> nativo resuelve al propio <dialog>',
  );
});

test('P5 (§2.3): con nombre accesible (aria-labelledby), `dialog.name` es ese nombre', () => {
  const doc = makeDom(
    '<div role="dialog" aria-labelledby="t"><h4 id="t">Título accesible</h4>' +
      '<h4>Heading posterior que NO debe ganar</h4><button>Ok</button></div>',
  );
  const frame = serializeFrame(doc.body, {});
  assert.ok(frame.dialog, 'precondición: hay diálogo activo');
  assert.equal(frame.dialog.name, 'Título accesible', 'el nombre accesible tiene prioridad sobre el fallback');
});

test('P6 (§2.3, markup real §2.1.1): nombre accesible vacío → texto del PRIMER heading; sin heading → ""', () => {
  // (a) markup real de Odoo: <div role="dialog"> anónimo con <h4 class="modal-title">.
  const frameOdoo = serializeFrame(makeDom(HTML_ODOO).body, {});
  assert.ok(frameOdoo.dialog, 'precondición: hay diálogo activo');
  assert.equal(
    frameOdoo.dialog.name,
    'Operación no válida',
    'fallback al <h4 class="modal-title"> del markup real — sin él el campo nace inútil en el caso que motiva la feature',
  );

  // (b) primer heading en ORDEN DE DOCUMENTO, normalizado, incluyendo [role=heading].
  const frameOrden = serializeFrame(
    makeDom(
      '<div role="dialog"><div><span role="heading" aria-level="2">  Primero  \n  del documento </span></div>' +
        '<h1>Segundo</h1><button>Ok</button></div>',
    ).body,
    {},
  );
  assert.ok(frameOrden.dialog, 'precondición: hay diálogo activo');
  assert.equal(frameOrden.dialog.name, 'Primero del documento', 'primer heading en orden de documento, normalizado');

  // (c) sin heading y sin nombre accesible → "".
  const frameSin = serializeFrame(makeDom('<div role="dialog"><p>texto suelto</p><button>Ok</button></div>').body, {});
  assert.ok(frameSin.dialog, 'precondición: hay diálogo activo');
  assert.equal(frameSin.dialog.name, '', 'sin nombre accesible ni heading, `name` es "" (nunca ausente ni null)');
});

test('P7 (§2.1): el activo es el último en orden de documento; aria-modal="true" tiene precedencia', () => {
  const dosModales = serializeFrame(
    makeDom(
      '<div role="dialog" aria-modal="true"><h4>Primero</h4><button>a</button></div>' +
        '<div role="dialog" aria-modal="true"><h4>Segundo</h4><button>b</button></div>',
    ).body,
    {},
  );
  assert.ok(dosModales.dialog, 'precondición: hay diálogo activo');
  assert.equal(dosModales.dialog.name, 'Segundo', 'con dos aria-modal, el activo es el último en orden de documento (rama 2)');

  const ningunModal = serializeFrame(
    makeDom(
      '<div role="dialog"><h4>Primero</h4><button>a</button></div>' +
        '<div role="dialog"><h4>Segundo</h4><button>b</button></div>',
    ).body,
    {},
  );
  assert.ok(ningunModal.dialog, 'precondición: hay diálogo activo');
  assert.equal(ningunModal.dialog.name, 'Segundo', 'sin aria-modal (caso Odoo), el activo es el último en orden de documento (rama 3)');

  const mixto = serializeFrame(
    makeDom(
      '<div role="dialog" aria-modal="true"><h4>Marcado</h4><button>a</button></div>' +
        '<div role="dialog"><h4>Posterior sin marcar</h4><button>b</button></div>',
    ).body,
    {},
  );
  assert.ok(mixto.dialog, 'precondición: hay diálogo activo');
  assert.equal(
    mixto.dialog.name,
    'Marcado',
    'si M no está vacío gana el último de M, aunque haya un dialog posterior sin aria-modal (rama 2 antes que la 3)',
  );
});

// ── §2.4 `inert` por elemento ───────────────────────────────────────────────

// NOTA sobre el oráculo de P8/P11/P11b: usan `Node.contains()` para decidir
// qué esperar. Es válido POR FIXTURE (ninguno tiene shadow roots, y ahí la
// contención compuesta y `contains` coinciden), NO por contrato: desde la
// enmienda de §2.4 el contrato es la contención COMPUESTA — ver P8b. No
// re-derivar la regla vieja a partir de estos tests.
test('P8 (§2.4): todo elemento NO contenido en el diálogo activo lleva inert:true; los contenidos (y el diálogo) no llevan la clave', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const dialogo = doc.querySelector('[role="dialog"]');
  const frame = serializeFrame(root, {});
  assertAlgoInerte(frame, 'P8');

  for (const el of allElements(frame)) {
    const nodo = resolveRef(el.ref, root);
    assert.ok(nodo, `precondición: el ref emitido resuelve — ${el.ref}`);
    if (dialogo.contains(nodo)) {
      assert.equal('inert' in el, false, `elemento del diálogo (contains reflexivo) SIN la clave inert: ${el.ref}`);
    } else {
      assert.equal(el.inert, true, `elemento del fondo con inert:true: ${el.ref}`);
    }
  }

  // Explícito sobre el caso medido: el propio diálogo y los botones del
  // header/footer no son inertes; `Validar` y el breadcrumb sí.
  assert.equal('inert' in porRef(frame, REF_DIALOGO_ODOO), false, 'el diálogo activo no es inerte de sí mismo');
  for (const ref of REFS_FONDO_ODOO) {
    assert.equal(porRef(frame, ref).inert, true, `elemento de fondo inerte: ${ref}`);
  }
});

/**
 * DOM con shadow roots ABIERTOS a ambos lados de la frontera del diálogo:
 * un host en el fondo y un host dentro del diálogo activo. El serializer
 * aplana los shadow abiertos y emite sus elementos con `::shadow` en el ref,
 * así que la contención tiene que ser COMPUESTA (§2.4): ascenso por
 * parentElement y salto de shadow root a host al agotar el árbol propio.
 */
function domConShadow() {
  const doc = makeDom(
    '<div class="o_content"><button>Fondo</button><bg-host></bg-host></div>' +
      '<div role="dialog"><h4>Confirmación</h4><dlg-host></dlg-host>' +
      '<footer><button>Cerrar</button></footer></div>',
  );
  doc.querySelector('bg-host').attachShadow({ mode: 'open' }).innerHTML =
    '<button>Botón de fondo en shadow</button>';
  doc.querySelector('dlg-host').attachShadow({ mode: 'open' }).innerHTML =
    '<button>Confirmar</button>';
  return doc;
}

const REF_SHADOW_EN_DIALOGO = 'div:2>dlg-host::shadow>button';
const REF_SHADOW_EN_FONDO = 'div:1>bg-host::shadow>button';

test('P8b (§2.4 enmendado): la contención es COMPUESTA — el shadow del diálogo no es inerte; el shadow del fondo sí', () => {
  const doc = domConShadow();
  const root = doc.body;
  const frame = serializeFrame(root, {});
  assertAlgoInerte(frame, 'P8b');

  // Dirección 1 — dentro del diálogo: `Node.contains()` NO cruza la shadow
  // boundary, así que la regla literal previa marcaba inerte un elemento cuyo
  // propio ref dice que cuelga del diálogo. Falso negativo sobre un elemento
  // accionable: violación de I-B.
  const dialogo = doc.querySelector('[role="dialog"]');
  const enDialogo = resolveRef(REF_SHADOW_EN_DIALOGO, root);
  assert.ok(enDialogo, `precondición: ${REF_SHADOW_EN_DIALOGO} resuelve`);
  assert.equal(
    dialogo.contains(enDialogo),
    false,
    'precondición del defecto: Node.contains() devuelve false pese a que el host cuelga del diálogo',
  );
  assert.equal(
    'inert' in porRef(frame, REF_SHADOW_EN_DIALOGO),
    false,
    'un elemento de un shadow root abierto cuyo host cuelga del diálogo activo NO lleva inert (§2.4)',
  );
  const resDialogo = performAction(enDialogo, 'focus');
  assert.deepEqual(resDialogo, { ok: true }, 'act lo acciona normalmente (coherencia I-4 del lado correcto)');

  // Dirección 2 — en el fondo: un fix que simplemente dejara de marcar inerte
  // TODO lo que esté en cualquier shadow root pasaría la dirección 1 y
  // fallaría acá. Por eso las dos direcciones van en el mismo test.
  const enFondo = resolveRef(REF_SHADOW_EN_FONDO, root);
  assert.ok(enFondo, `precondición: ${REF_SHADOW_EN_FONDO} resuelve`);
  assert.equal(
    porRef(frame, REF_SHADOW_EN_FONDO).inert,
    true,
    'un elemento de un shadow root del FONDO sigue saliendo inert:true',
  );
  const resFondo = performAction(enFondo, 'focus');
  assert.equal(resFondo.ok, false, 'act rechaza el elemento del shadow de fondo');
  assert.equal(resFondo.inert, true, `act lo rechaza por inerte; recibido ${JSON.stringify(resFondo)}`);
});

// NOTA de testabilidad (reportada al orquestador): la cláusula literal de P9
// ("un elemento del fondo fuera del viewport sale visible:false e inert:true")
// NO es alcanzable desde la superficie pública bajo jsdom — se probó stubbeando
// getBoundingClientRect() fuera del viewport y achicando window.innerHeight/
// innerWidth, y `visible` sigue en true en ambos casos. Forzarla exigiría
// conocer el mecanismo interno de `visible` (prohibido para el test-writer) y
// congelaría un detalle de implementación. Se verifica la ortogonalidad con las
// dos dimensiones que SÍ son controlables desde afuera: `disabled` (real) y la
// invariancia de `visible` respecto del DOM equivalente sin la feature.
test('P9 (§2.4 / I-1): `inert` es ortogonal a `visible` y a `disabled`', () => {
  const doc = makeDom(
    '<div class="o_content"><button disabled>Validar</button></div>' +
      '<div role="dialog"><h4>Aviso</h4><button disabled>Cerrar</button></div>',
  );
  const root = doc.body;
  const frame = serializeFrame(root, {});
  assertAlgoInerte(frame, 'P9');

  const fondo = porRef(frame, 'div:1>button');
  const enDialogo = porRef(frame, 'div:2>button');

  assert.equal(fondo.disabled, true, 'precondición: el botón del fondo está disabled');
  assert.equal(fondo.inert, true, 'disabled:true e inert:true conviven — son dimensiones distintas');
  assert.equal(enDialogo.disabled, true, 'precondición: el botón del diálogo está disabled');
  assert.equal('inert' in enDialogo, false, 'disabled dentro del diálogo NO implica inert (son ortogonales)');

  // La feature no toca la semántica de `visible`: el valor de `visible` de cada
  // ref con diálogo activo es idéntico al que ese mismo ref tiene sin la feature
  // activa (mismo DOM, sin role=dialog).
  const docBase = makeDom(
    '<div class="o_content"><button disabled>Validar</button></div>' +
      '<div><h4>Aviso</h4><button disabled>Cerrar</button></div>',
  );
  const base = serializeFrame(docBase.body, {});
  for (const el of allElements(frame)) {
    const gemelo = allElements(base).find((e) => e.ref === el.ref);
    if (!gemelo) continue;
    assert.equal(el.visible, gemelo.visible, `\`visible\` no cambia por la feature — ${el.ref}`);
  }
});

test('P10 (§2.4 / I-A, PIN): ningún elemento se excluye por ser inerte (a igual paginación y filtros)', () => {
  const doc = makeDom(HTML_ODOO);
  const conDialogo = doc.body;

  // Oráculo independiente: el MISMO DOM sin el role="dialog" (feature inactiva).
  const docBase = makeDom(HTML_ODOO);
  docBase.querySelector('[role="dialog"]').removeAttribute('role');
  const sinDialogo = docBase.body;

  for (const opciones of [{}, { roles: ['button'] }, { page: 1, maxElementsPerPage: 2 }]) {
    const refsCon = new Set(allRefs(serializeFrame(conDialogo, opciones)));
    const refsSin = allRefs(serializeFrame(sinDialogo, opciones));
    assert.ok(refsSin.length > 0, `precondición: el oráculo emite refs con ${JSON.stringify(opciones)}`);
    for (const ref of refsSin) {
      assert.ok(
        refsCon.has(ref),
        `el diálogo activo no puede hacer desaparecer el ref ${ref} (I-A) con ${JSON.stringify(opciones)}; ` +
          `emitidos: ${JSON.stringify([...refsCon])}`,
      );
    }
  }
});

test('P11 (§2.4.1, forma medida obligatoria): dos diálogos HERMANOS — el activo es el segundo; el primero y su contenido son inertes', () => {
  const doc = makeDom(HTML_PILA_HERMANA);
  const root = doc.body;
  const dialogos = doc.querySelectorAll('[role="dialog"]');
  assert.equal(dialogos.length, 2, 'precondición: dos diálogos');
  assert.equal(dialogos[0].contains(dialogos[1]), false, 'precondición §2.4.1: son HERMANOS, no anidados');

  const frame = serializeFrame(root, {});
  assert.ok(frame.dialog, 'hay diálogo activo');
  assert.equal(
    resolveRef(frame.dialog.ref, root),
    dialogos[1],
    'el activo es el ÚLTIMO en orden de documento (rama 3), sin leer o_inactive_modal (§6.3)',
  );
  assert.equal(frame.dialog.name, 'Operación no válida', 'el nombre sale del heading del diálogo activo');

  assertAlgoInerte(frame, 'P11');
  for (const el of allElements(frame)) {
    const nodo = resolveRef(el.ref, root);
    if (dialogos[1].contains(nodo)) {
      assert.equal('inert' in el, false, `contenido del diálogo activo sin la clave: ${el.ref}`);
    } else {
      assert.equal(el.inert, true, `el diálogo inactivo y su contenido salen inertes: ${el.ref}`);
    }
  }
});

test('P11b (§2.4.1, forma anidada): el activo es el interno; el externo y su contenido no-anidado son inertes', () => {
  const doc = makeDom(
    '<div role="dialog" id="externo"><h4>Externo</h4><button>Del externo</button>' +
      '<div role="dialog" id="interno"><h4>Interno</h4><button>Del interno</button></div></div>',
  );
  const root = doc.body;
  const externo = doc.getElementById('externo');
  const interno = doc.getElementById('interno');
  assert.equal(externo.contains(interno), true, 'precondición: realmente anidados');

  const frame = serializeFrame(root, {});
  assert.ok(frame.dialog, 'hay diálogo activo');
  assert.equal(resolveRef(frame.dialog.ref, root), interno, 'el activo es el interno (último en orden de documento)');

  assertAlgoInerte(frame, 'P11b');
  for (const el of allElements(frame)) {
    const nodo = resolveRef(el.ref, root);
    if (interno.contains(nodo)) {
      assert.equal('inert' in el, false, `contenido del diálogo interno sin la clave: ${el.ref}`);
    } else {
      assert.equal(el.inert, true, `el externo y su contenido no-anidado son inertes: ${el.ref}`);
    }
  }
});

// ── §2.5 `act` ──────────────────────────────────────────────────────────────

test('P12 (§2.5): act sobre un elemento inerte devuelve {ok:false, inert:true, error} en las CUATRO acciones y no muta el DOM', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const link = resolveRef('div:1>ol>li>a', root);
  const boton = resolveRef('div:1>button', root);
  const input = resolveRef('div:1>input', root);
  const select = resolveRef('div:1>select', root);
  for (const [nombre, el] of [['a', link], ['button', boton], ['input', input], ['select', select]]) {
    assert.ok(el, `precondición: el ${nombre} del fondo resuelve`);
  }

  let eventos = 0;
  for (const tipo of ['click', 'input', 'change', 'focus']) {
    root.addEventListener(tipo, () => eventos++, true);
  }
  const htmlAntes = root.outerHTML;
  const valorAntes = input.value;
  const selectAntes = select.value;

  const casos = [
    ['click', boton, undefined],
    ['type', input, 'texto nuevo'],
    ['focus', link, undefined],
    ['select', select, 'b'],
  ];
  for (const [accion, el, valor] of casos) {
    const res = performAction(el, accion, valor);
    assert.equal(res.ok, false, `${accion} sobre elemento inerte → ok:false; recibido ${JSON.stringify(res)}`);
    assert.equal(res.inert, true, accion + ' sobre elemento inerte → clave booleana propia inert:true, no `error` a secas');
    assert.ok(
      typeof res.error === 'string' && res.error.length > 0,
      accion + ': `error` se mantiene por legibilidad humana y no puede ser vacío',
    );
    assert.ok(res.error.includes('force'), `${accion}: el mensaje nombra la salida \`force\` (HITL 2): ${res.error}`);
    assert.notEqual(res.stale, true, `${accion}: el elemento existe, no es stale`);
  }

  assert.equal(eventos, 0, 'ninguna acción se despachó por el camino de rechazo');
  assert.equal(input.value, valorAntes, 'el value del input del fondo no cambió');
  assert.equal(select.value, selectAntes, 'el value del select del fondo no cambió');
  assert.equal(root.outerHTML, htmlAntes, 'ninguna mutación del DOM en el camino de rechazo');
});

test('P13 (§2.5, PIN): act sobre un elemento DEL diálogo se comporta como hoy', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const cerrar = resolveRef('div:2>div>div>footer>button', root);
  assert.ok(cerrar, 'precondición: el botón del footer del diálogo resuelve');
  let clicks = 0;
  cerrar.addEventListener('click', () => clicks++);

  const res = performAction(cerrar, 'click');
  assert.deepEqual(res, { ok: true }, 'el elemento del diálogo activo se acciona sin cambios de contrato');
  assert.equal(clicks, 1, 'el listener corrió');
});

test('P14 (§2.5): con { force: true } la acción se ejecuta y la respuesta NO lleva `inert`', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;

  // Guarda de no-vacuidad: sin `force` el guard TIENE que rechazar. Sin esta
  // línea el test pasaría hoy vacuamente (el 4º argumento se ignora).
  const boton = resolveRef('div:1>button', root);
  const sinForce = performAction(boton, 'click');
  assert.equal(
    sinForce.inert,
    true,
    `precondición de P14: sin force el elemento del fondo debe ser rechazado (§2.5); recibido ${JSON.stringify(sinForce)}`,
  );

  let clicks = 0;
  boton.addEventListener('click', () => clicks++);
  const res = performAction(boton, 'click', undefined, { force: true });
  assert.deepEqual(res, { ok: true }, 'con force:true la respuesta es la normal, sin la clave inert');
  assert.equal('inert' in res, false, 'la respuesta forzada no lleva `inert`');
  assert.equal(clicks, 1, 'con force:true la acción SÍ se despacha');

  const input = resolveRef('div:1>input', root);
  const resType = performAction(input, 'type', 'forzado', { force: true });
  assert.deepEqual(resType, { ok: true }, 'force:true también aplica a type');
  assert.equal(input.value, 'forzado', 'con force:true el value se escribió');
});

test('P15 (§2.5, PIN): sin diálogo activo, act es indistinguible del comportamiento previo', () => {
  const doc = makeDom('<main><button>Go</button><input><select><option value="v">V</option></select></main>');
  const root = doc.body;
  const boton = resolveRef('main>button', root);
  const input = resolveRef('main>input', root);
  const select = resolveRef('main>select', root);

  for (const res of [
    performAction(boton, 'click'),
    performAction(input, 'type', 'hola'),
    performAction(boton, 'focus'),
    performAction(select, 'select', 'v'),
  ]) {
    assert.deepEqual(res, { ok: true }, `sin diálogo ninguna respuesta gana inert: ${JSON.stringify(res)}`);
  }
});

test('P16 (§2.5, PIN): precedencia — un ref no resoluble sigue devolviendo {ok:false, stale:true} con diálogo activo', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  assert.ok(doc.querySelector('[role="dialog"]'), 'precondición: hay un diálogo activo en el DOM');

  const missing = resolveRef('div:1>ol>li>a>span', root);
  assert.equal(missing, null, 'precondición: el ref no resuelve');
  const res = performAction(missing, 'click');
  assert.deepEqual(res, { ok: false, stale: true }, '`stale` primero: el guard de inertness requiere un elemento');
});

// ── §3 Invalidación e integridad ────────────────────────────────────────────

test('P17 (§2.3 fb-018-001, PIN): abrir y cerrar un diálogo cambia el `fingerprint`', () => {
  // `changedSinceLast` lo deriva background.js comparando la huella entre
  // llamadas; acá se verifica la condición necesaria y suficiente en la
  // superficie del serializer: la huella cambia al abrir y al cerrar.
  const doc = makeDom('<div class="o_content"><button>Validar</button></div>');
  const root = doc.body;
  const huellaSinDialogo = serializeFrame(root, {}).fingerprint;
  assert.ok(typeof huellaSinDialogo === 'string' && huellaSinDialogo.length > 0, 'precondición: hay huella');

  const dialogo = doc.createElement('div');
  dialogo.setAttribute('role', 'dialog');
  dialogo.innerHTML = '<h4>Operación no válida</h4><button>Cerrar</button>';
  root.appendChild(dialogo);
  const huellaConDialogo = serializeFrame(root, {}).fingerprint;
  assert.notEqual(huellaConDialogo, huellaSinDialogo, 'abrir el diálogo cambia la huella → changedSinceLast:true');

  dialogo.remove();
  const huellaTrasCerrar = serializeFrame(root, {}).fingerprint;
  assert.notEqual(huellaTrasCerrar, huellaConDialogo, 'cerrar el diálogo también cambia la huella');
});

test('P18 (I-C, PIN): con diálogo activo, la huella es independiente de la query', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const queries = [
    {},
    { page: 1, maxElementsPerPage: 2 },
    { page: 2, maxElementsPerPage: 2 },
    { roles: ['button'] },
    { namedOnly: true },
  ];
  const huellas = queries.map((q) => serializeFrame(root, q).fingerprint);
  assert.ok(typeof huellas[0] === 'string' && huellas[0].length > 0, 'precondición: hay huella');
  for (let i = 1; i < huellas.length; i++) {
    assert.equal(huellas[i], huellas[0], `la huella no cambia con ${JSON.stringify(queries[i])} (I-C)`);
  }
});

test('P19 (I-D, PIN): serializar con diálogo activo no muta el DOM ni setea el atributo/propiedad `inert`', () => {
  const doc = makeDom(HTML_ODOO);
  const root = doc.body;
  const antes = root.outerHTML;

  const frame = serializeFrame(root, {});
  assert.ok(allElements(frame).length > 0, 'precondición: el frame emite elementos');

  assert.equal(root.outerHTML, antes, 'el outerHTML de root es idéntico antes y después');
  assert.equal(
    root.querySelectorAll('[inert]').length,
    0,
    'la feature NO setea el atributo inert en el DOM: lo computa (I-D)',
  );
  // En jsdom `inert` no está en HTMLElement.prototype (§7.2), así que una
  // asignación el.inert = true quedaría como propiedad PROPIA invisible al
  // outerHTML — se chequea explícitamente.
  for (const nodo of root.querySelectorAll('*')) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(nodo, 'inert'),
      false,
      `ningún nodo gana la propiedad propia \`inert\`: ${nodo.tagName}`,
    );
  }
});

// ── §4 I-4 (property test obligatorio) ──────────────────────────────────────

test('I-4 (property, §4): para todo DOM y todo elemento emitido, inert:true ⟺ act lo rechaza con {ok:false, inert:true}', () => {
  // El quinto DOM (shadow a ambos lados de la frontera) se agrega a raíz del
  // hallazgo de review de P8b: la bicondicional quedaba VERDE porque serializer
  // y act coincidían en la respuesta equivocada (ambos usaban `contains`), y
  // sin un DOM con shadow el property test no podía detectarlo. Un invariante
  // de coherencia solo vale sobre los DOMs que lo ejercitan.
  const doms = [
    ['sin diálogo', () => makeDom('<main><h1>Recepción</h1><button>Validar</button><input value="x"><a href="#y">Ir</a></main>')],
    ['con diálogo (markup real)', () => makeDom(HTML_ODOO)],
    ['pila hermana', () => makeDom(HTML_PILA_HERMANA)],
    [
      'anidado',
      () =>
        makeDom(
          '<div role="dialog"><h4>Externo</h4><button>Del externo</button>' +
            '<div role="dialog"><h4>Interno</h4><button>Del interno</button></div></div>',
        ),
    ],
    ['shadow abierto a ambos lados de la frontera', domConShadow],
  ];

  let inertesTotales = 0;
  for (const [etiqueta, construir] of doms) {
    const doc = construir();
    const root = doc.body;
    const elementos = allElements(serializeFrame(root, {}));
    assert.ok(elementos.length > 0, `${etiqueta}: precondición, el DOM emite elementos`);

    for (const el of elementos) {
      const nodo = resolveRef(el.ref, root);
      assert.ok(nodo, `${etiqueta}: el ref emitido resuelve — ${el.ref}`);
      const res = performAction(nodo, 'focus');
      const mapaDiceInerte = el.inert === true;
      const actRechaza = res.ok === false && res.inert === true;
      assert.equal(
        actRechaza,
        mapaDiceInerte,
        `${etiqueta}: bicondicional rota en ${el.ref} — el mapa dice inert:${mapaDiceInerte} y act devolvió ${JSON.stringify(res)}`,
      );
      if (mapaDiceInerte) inertesTotales++;
    }
  }

  // Guarda de no-vacuidad: sin esto, "false ⟺ false" en todos los elementos
  // haría verde el property test con la feature entera ausente.
  assert.ok(
    inertesTotales > 0,
    'la bicondicional debe ejercitarse sobre elementos realmente inertes: los DOMs con diálogo tienen que emitir inert:true (§2.4)',
  );
});
