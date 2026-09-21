/**
 * inert-generico.test.js — fb-018-007-inert-generico (sub-fase RED).
 *
 * Verifica P1–P19 y el property test de I-4 en sus DOS regímenes, del spec
 * docs/specs/fb-018-007-inert-generico/spec.md §3 y §4.
 * (P20 es no-regresión de la superficie MCP: ver la nota al pie de este header.)
 *
 * Escrito SOLO contra la superficie pública observable — serializeFrame(root,
 * options), resolveRef(ref, root) y performAction(el, action, value, options).
 * Aislamiento anti-trampa: no se leyó serializer.js, act.js, dialog.js,
 * resolver.js ni background.js, ni el prototipo del architect. En particular NO
 * se importa `isBlocking` ni nada de dialog.js: el gate se ejercita por su
 * efecto observable (`dialog.modal`, `inert` por elemento, respuesta de `act`).
 *
 * ── La costura de test (§2.3) ───────────────────────────────────────────────
 * jsdom no tiene hit-testing ni layout, así que el test PROVEE la plataforma:
 * `document.elementFromPoint` y `Element.prototype.getBoundingClientRect` sobre
 * la ventana de su propia fixture, más `innerWidth`/`innerHeight`. Es stub de
 * PLATAFORMA (APIs estándar de CSSOM View), no mock sobre plumbing: no conoce
 * ninguna función interna, no congela orden ni cantidad de llamadas, y todas
 * las aserciones son sobre salida observable. El harness simula hit-testing de
 * verdad (rects + orden de pintado), no una tabla de respuestas por caso.
 *
 * Deliberadamente NO se assertea la cantidad de llamadas a elementFromPoint
 * (§7.1 C-3): K y "2 por cuadrante" pueden afinarse sin reescribir tests. Donde
 * se cuenta es para exigir CERO (P15, que es contrato) o AL MENOS UNA (guardas
 * de no-vacuidad: sin una sola llamada, el gate no corrió y el test sería
 * verde vacuo).
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *
 * ── Segunda vuelta de RED (enmiendas del review, §7.5) ──────────────────────
 * Con GREEN ya aplicado, tres cambios convierten este archivo en RED otra vez:
 *
 *  · P19 REESCRITA — cambio de contrato, no ajuste para pasar. La huella es
 *    independiente de la QUERY, y `inert` SÍ participa (antes este test exigía
 *    exactamente lo contrario). Falla hoy: las dos variantes dan la misma huella.
 *  · P17 REESCRITA — hallazgo I3: no podía fallar, porque ningún fixture
 *    activaba `hasLayout` y `visible` valía `true` en los dos regímenes. Ahora
 *    la fixture lo activa y una guarda exige que `visible` tome los DOS valores.
 *  · "Cota de rects" NUEVA — hallazgo I2: §2.5/§5 declaran ≤ 8
 *    `getBoundingClientRect` por frame, pero el loop de elegibilidad los lee
 *    sobre todo `W₀`. Se cuenta en los dos caminos. Falla hoy: 30 sobre 30.
 *
 * El ledger de abajo describe la PRIMERA vuelta de RED (antes de GREEN) y se
 * conserva como registro de por qué cada test existe.
 *
 *  · FALLABAN por AssertionError (el gate no existía todavía; `blocking` era
 *    siempre true de hecho, y `dialog.modal` no existía):
 *    P1, P2, P3, P4, P6, P7, P8, P9, P10, P11, P12, P13, P14, P19, I-4.
 *
 *    P7 merece una aclaración: su cláusula de fondo (H4 — el elemento fuera del
 *    viewport sale inerte igual) YA se cumple hoy, porque hoy el veredicto es
 *    estructural. Queda en rojo por su guarda de no-vacuidad: sin una sola
 *    llamada a elementFromPoint, P7 no estaría demostrando nada sobre el gate
 *    nuevo — pasaría por la razón vieja. Post-GREEN es el testigo de que la
 *    trampa H4 sigue desactivada.
 *
 *  · PINES / anti-regresión — se espera que PASEN ya en RED:
 *    P5  (la protección de Odoo ya funciona: pinea que el fix no la apague),
 *    P15, P16, P17, P18 (costo cero sin diálogo, I-A, I-1, I-D).
 *
 * Nota sobre P20: es no-regresión pura de la superficie MCP (§2.7 no cambia
 * ningún schema y no agrega tools). Ya está cubierta por los tests Go que
 * escribí en fb-018-004 y que siguen vivos: `TestAct_InputSchemaHasForce`
 * (declara `force` + conteo 34) y `TestAct_ForceTypeAsserted`. Un test nuevo
 * sería un duplicado por completitud, que es justo lo que la convención de
 * tests del ciclo prohíbe. Decisión reportada al orquestador.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';
import { performAction } from './act.js';

// ── helpers de frame ────────────────────────────────────────────────────────

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
  assert.ok(el, `precondición: el frame emite ${ref}; emitidos: ${JSON.stringify(allRefs(frame))}`);
  return el;
}
function inertes(frame) {
  return allElements(frame).filter((e) => e.inert === true);
}

/**
 * Harness de PLATAFORMA (§2.3). Simula CSSOM View sobre la ventana de una
 * fixture: rects por elemento, orden de pintado, viewport y hit-testing
 * geométrico real (el punto se resuelve contra los rects, no contra una tabla
 * de respuestas escrita a mano).
 *
 *   const h = plataforma(doc);
 *   h.rect(el, x, y, w, alto);   // en orden de pintado: el último queda arriba
 *   h.activar();
 *
 * Los elementos sin rect declarado quedan con rect degenerado (0×0), o sea
 * NO elegibles como testigos (§2.2.4) — eso hace que cada fixture declare
 * explícitamente su universo de testigos.
 */
function plataforma(doc, { ancho = 1000, alto = 800 } = {}) {
  const win = doc.defaultView;
  const rects = new Map();
  const capas = [];
  const puntos = [];

  let lecturas = 0;

  const api = {
    puntos,
    get llamadas() {
      return puntos.length;
    },
    /** Lecturas de getBoundingClientRect sobre esta ventana (cota de §2.5/§5). */
    get lecturasRect() {
      return lecturas;
    },
    /**
     * Activa `hasLayout` (fb-017-005: `root.getClientRects().length > 0`), que
     * es lo que despierta la rama de `visible` del serializer. Sin esto todo
     * elemento sale `visible:true` y cualquier aserción sobre `visible` se hace
     * sobre una constante (hallazgo I3 del review).
     */
    conLayout() {
      doc.body.getClientRects = () => [
        { x: 0, y: 0, width: ancho, height: alto, left: 0, top: 0, right: ancho, bottom: alto, toJSON() {} },
      ];
      return api;
    },
    /** Declara rect + posición en el orden de pintado (el último pintado gana). */
    rect(el, x, y, w, h) {
      assert.ok(el, 'plataforma.rect: elemento inexistente en la fixture');
      rects.set(el, { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
      capas.push(el);
      return el;
    },
    centro(el) {
      const r = rects.get(el);
      return [r.left + r.width / 2, r.top + r.height / 2];
    },
    activar() {
      Object.defineProperty(win, 'innerWidth', { value: ancho, configurable: true });
      Object.defineProperty(win, 'innerHeight', { value: alto, configurable: true });
      win.Element.prototype.getBoundingClientRect = function () {
        lecturas++;
        const r = rects.get(this);
        return r
          ? { ...r, toJSON() {} }
          : { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON() {} };
      };
      doc.elementFromPoint = (x, y) => {
        puntos.push(`${x},${y}`);
        if (x < 0 || y < 0 || x > ancho || y > alto) return null;
        for (let i = capas.length - 1; i >= 0; i--) {
          const r = rects.get(capas[i]);
          if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return capas[i];
        }
        return null;
      };
      return api;
    },
  };
  return api;
}

/**
 * Guarda de no-vacuidad: el gate tiene que haber consultado la plataforma.
 * `desde` permite descontar las llamadas que el propio test hizo al verificar
 * sus precondiciones — sin eso, un test que sondea la geometría antes de
 * serializar se auto-satisface la guarda y deja de guardar nada.
 */
function assertHubosHitTest(h, etiqueta, desde = 0) {
  assert.ok(
    h.llamadas > desde,
    `${etiqueta}: el gate de modalidad debe consultar document.elementFromPoint (§2.2.6). ` +
      'Cero llamadas significa que el camino nuevo no corrió y el resto del test sería verde vacuo. ' +
      '(No se assertea CUÁNTAS: K es afinable, §7.1 C-3.)',
  );
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * F1 — mensajería con un `role="dialog"` que NO tapa (el bug reproducido en
 * §1). El popover ocupa una esquina; nav, input de mensaje y botón Enviar
 * quedan alcanzables. `#lejos` tiene su centro FUERA del viewport (P8).
 */
function domMensajeria() {
  const doc = makeDom(
    '<nav><a href="#inicio">Inicio</a></nav>' +
      '<main>' +
      '<input aria-label="Escribí un mensaje">' +
      '<button>Enviar</button>' +
      '<a href="#lejos">Historial viejo</a>' +
      '</main>' +
      '<div role="dialog" aria-label="Menú de emojis"><button>Carita feliz</button></div>',
  );
  const h = plataforma(doc);
  const dialogo = doc.querySelector('[role="dialog"]');
  h.rect(doc.querySelector('nav a'), 10, 10, 100, 20);
  h.rect(doc.querySelector('main input'), 10, 700, 500, 40);
  h.rect(doc.querySelector('main button'), 520, 700, 80, 40);
  h.rect(doc.querySelector('main a'), 10, 5000, 200, 20); // centro fuera del viewport
  h.rect(dialogo, 700, 100, 250, 200); // el popover, arriba de todo
  h.rect(dialogo.querySelector('button'), 720, 120, 60, 60);
  return { doc, h, dialogo };
}

/**
 * F2 — modal real con backdrop que cubre el viewport (la forma de Odoo).
 * `rolBackdrop` permite la variante de P6. El diálogo se ubica ABAJO (bottom
 * sheet, no centrado) a propósito: con un modal centrado el centro del backdrop
 * cae sobre el diálogo y el backdrop contaría como tapado igual, así que la
 * fixture centrada NO ejercitaría el filtro de roles no-testigo (§2.2.3,
 * precisión del orquestador). Acá el backdrop se golpea a sí mismo.
 */
function domModal({ rolBackdrop = null } = {}) {
  const doc = makeDom(
    '<div class="fondo">' +
      '<a href="#recepciones">Recepciones</a>' +
      '<button>Validar</button>' +
      '<input aria-label="Proveedor" value="ACME">' +
      '<select aria-label="Almacén"><option value="a">Alfa</option><option value="b">Beta</option></select>' +
      '<a href="#lejos">Nota al pie</a>' +
      '</div>' +
      `<div class="backdrop"${rolBackdrop ? ` role="${rolBackdrop}"` : ''}></div>` +
      '<div role="dialog"><h4>Operación no válida</h4><button>Cerrar</button></div>',
  );
  const h = plataforma(doc);
  const fondo = doc.querySelector('.fondo');
  const backdrop = doc.querySelector('.backdrop');
  const dialogo = doc.querySelector('[role="dialog"]');

  // Fondo (pintado primero), repartido por los cuatro cuadrantes.
  h.rect(fondo.querySelector('a'), 10, 10, 120, 20);
  h.rect(fondo.querySelector('button'), 800, 10, 120, 20);
  h.rect(fondo.querySelector('input'), 10, 380, 300, 30);
  h.rect(fondo.querySelector('select'), 700, 380, 200, 30);
  h.rect(fondo.querySelectorAll('a')[1], 10, 6000, 200, 20); // centro fuera del viewport (P7)
  // Backdrop encima de todo el fondo.
  h.rect(backdrop, 0, 0, 1000, 800);
  // Diálogo NO centrado, abajo, encima del backdrop.
  h.rect(dialogo, 0, 600, 1000, 200);
  h.rect(dialogo.querySelector('button'), 400, 700, 100, 40);
  return { doc, h, dialogo, backdrop };
}

const REFS_FONDO = ['div:1>a:1', 'div:1>button', 'div:1>input', 'div:1>select'];
const REF_FONDO_LEJOS = 'div:1>a:2';
const REF_BOTON_DIALOGO = 'div:3>button';

// ── §3 El bug que se corrige ────────────────────────────────────────────────

test('P1 (§2.2): popover role="dialog" que no tapa, con hit-test activo → NINGÚN elemento lleva `inert`', () => {
  const { doc, h } = domMensajeria();
  h.activar();
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P1');

  assert.ok(allElements(frame).length >= 4, 'precondición: la fixture emite el fondo y el popover');
  assert.deepEqual(
    inertes(frame).map((e) => e.ref),
    [],
    'un diálogo que no tapa no vuelve inerte a nadie (§2.2.7: un testigo alcanzable basta para declarar no-modal)',
  );
});

test('P2 (§2.5): en ese mismo DOM, act sobre el input de mensaje devuelve {ok:true} sin force', () => {
  const { doc, h } = domMensajeria();
  h.activar();
  const input = resolveRef('main>input', doc.body);
  assert.ok(input, 'precondición: el input de mensaje resuelve');
  const res = performAction(input, 'focus');
  assert.deepEqual(res, { ok: true }, `act no puede rechazar un control alcanzable; recibido ${JSON.stringify(res)}`);
});

test('P3 (§2.4): con popover, el Frame trae `dialog` {ref, role, name} y NO trae `dialog.modal`', () => {
  const { doc, h, dialogo } = domMensajeria();
  h.activar();
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P3');

  assert.ok(frame.dialog, 'el popover se sigue reportando: es información útil (§2.4), no se oculta');
  assert.equal(resolveRef(frame.dialog.ref, doc.body), dialogo, '`dialog.ref` resuelve al popover');
  assert.equal(frame.dialog.role, 'dialog');
  assert.equal(frame.dialog.name, 'Menú de emojis');
  assert.equal('modal' in frame.dialog, false, 'sin evidencia de tapado la clave `modal` está AUSENTE (I-2, nunca false)');

  // Guarda de no-vacuidad: "modal ausente" no puede ser cierto por el simple
  // hecho de que la clave no exista en ninguna parte del contrato.
  const { doc: docModal, h: hModal } = domModal();
  hModal.activar();
  const frameModal = serializeFrame(docModal.body, {});
  assert.equal(
    frameModal.dialog.modal,
    true,
    'la clave `modal` tiene que EXISTIR cuando el diálogo sí tapa (§2.4); si no, la ausencia de P3 es vacua',
  );
});

// ── §3 Protección de Odoo ───────────────────────────────────────────────────

test('P4 (§2.2): modal con backdrop que cubre el viewport → todo el fondo inert:true y dialog.modal === true', () => {
  const { doc, h, dialogo } = domModal();
  h.activar();
  const root = doc.body;
  const frame = serializeFrame(root, {});
  assertHubosHitTest(h, 'P4');

  assert.equal(frame.dialog.modal, true, 'con backdrop encima de todos los testigos, el veredicto es `blocking`');
  for (const ref of REFS_FONDO) {
    assert.equal(porRef(frame, ref).inert, true, `elemento del fondo inerte: ${ref}`);
  }
  for (const el of allElements(frame)) {
    const nodo = resolveRef(el.ref, root);
    if (dialogo.contains(nodo)) {
      assert.equal('inert' in el, false, `elemento del diálogo sin la clave: ${el.ref}`);
    }
  }
});

test('P5 (§2.5, PIN): act rechaza las 4 acciones sobre el fondo sin mutar el DOM, y acciona el botón del diálogo', () => {
  const { doc, h } = domModal();
  h.activar();
  const root = doc.body;
  const boton = resolveRef('div:1>button', root);
  const input = resolveRef('div:1>input', root);
  const select = resolveRef('div:1>select', root);
  const link = resolveRef('div:1>a:1', root);
  for (const [nombre, el] of [['button', boton], ['input', input], ['select', select], ['a', link]]) {
    assert.ok(el, `precondición: el ${nombre} del fondo resuelve`);
  }

  let eventos = 0;
  for (const tipo of ['click', 'input', 'change', 'focus']) root.addEventListener(tipo, () => eventos++, true);
  const htmlAntes = root.outerHTML;
  const valorAntes = input.value;
  const selectAntes = select.value;

  for (const [accion, el, valor] of [
    ['click', boton, undefined],
    ['type', input, 'texto nuevo'],
    ['focus', link, undefined],
    ['select', select, 'b'],
  ]) {
    const res = performAction(el, accion, valor);
    assert.equal(res.ok, false, `${accion} sobre el fondo de un modal real → ok:false; recibido ${JSON.stringify(res)}`);
    assert.equal(res.inert, true, accion + ': la protección de fb-018-004 no puede apagarse');
    assert.ok(typeof res.error === 'string' && res.error.length > 0, accion + ': `error` no vacío');
  }
  assert.equal(eventos, 0, 'ninguna acción se despachó');
  assert.equal(input.value, valorAntes, 'el value del input no cambió');
  assert.equal(select.value, selectAntes, 'el value del select no cambió');
  assert.equal(root.outerHTML, htmlAntes, 'ninguna mutación del DOM');

  const cerrar = resolveRef(REF_BOTON_DIALOGO, root);
  assert.ok(cerrar, 'precondición: el botón del diálogo resuelve');
  assert.deepEqual(performAction(cerrar, 'click'), { ok: true }, 'el botón del diálogo sigue accionable');
});

test('P6 (§2.2.3): con el backdrop declarando role="presentation" (diálogo NO centrado), la protección se mantiene', () => {
  const { doc, h, backdrop, dialogo } = domModal({ rolBackdrop: 'presentation' });
  h.activar();
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P6');

  // Guarda de no-vacuidad: la fixture tiene que ejercitar de verdad el filtro.
  // Con un modal CENTRADO el centro del backdrop caería sobre el diálogo y el
  // backdrop contaría como tapado igual, sin necesidad de filtro alguno. Acá el
  // backdrop se golpea a SÍ MISMO, que es el caso que hace necesario el filtro.
  const [cx, cy] = h.centro(backdrop);
  assert.equal(
    doc.elementFromPoint(cx, cy),
    backdrop,
    'precondición de P6: el centro del backdrop se golpea a sí mismo (diálogo no centrado) — si golpeara al diálogo, el test sería vacuo',
  );
  assert.ok(backdrop.matches('[role]'), 'precondición: el backdrop entra a CANDIDATE_SELECTOR vía [role]');
  assert.equal(dialogo.contains(backdrop), false, 'precondición: el backdrop no está contenido en el diálogo');

  assert.equal(frame.dialog.modal, true, 'el backdrop no puede ser testigo de su propia inocencia (§2.2.3)');
  for (const ref of REFS_FONDO) {
    assert.equal(porRef(frame, ref).inert, true, `el fondo sigue inerte pese al role="presentation": ${ref}`);
  }
});

// ── §3 Trampa H4: el veredicto es global, no por elemento ───────────────────

test('P7 (H4, PIN): con modal real, un elemento del fondo con el centro FUERA del viewport igual lleva inert:true', () => {
  const { doc, h } = domModal();
  h.activar();
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P7');

  const lejos = porRef(frame, REF_FONDO_LEJOS);
  assert.equal(
    lejos.inert,
    true,
    'su propio hit-test es irrelevante: el veredicto es global (si dependiera del elemento, elementFromPoint daría null y esto sería un falso negativo — H4)',
  );
  assert.equal(porRef(frame, 'div:1>button').inert, true, 'coincide con el resto del fondo');
});

test('P8 (H4): con popover, un elemento del fondo con el centro FUERA del viewport NO lleva inert', () => {
  const { doc, h } = domMensajeria();
  h.activar();
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P8');

  const lejos = porRef(frame, 'main>a');
  assert.equal('inert' in lejos, false, 'el veredicto global manda también en esta dirección (I-B)');
});

// ── §3 Degradación sin capacidad de hit-testing ─────────────────────────────

test('P9 (§2.3): sin hit-test disponible, el Frame es el de v0.4.4 salvo dialog.modal, y act se comporta igual', () => {
  // jsdom tal cual: no hay document.elementFromPoint.
  const { doc } = domModal();
  const root = doc.body;
  assert.equal(
    typeof doc.elementFromPoint,
    'undefined',
    'precondición de P9: sin activar el harness, jsdom no expone elementFromPoint',
  );

  const frame = serializeFrame(root, {});
  assert.equal(frame.dialog.modal, true, 'sin capacidad de hit-test el gate degrada a `true` (§2.2.2)');

  // Semántica estructural de v0.4.4, elemento por elemento.
  const dialogo = doc.querySelector('[role="dialog"]');
  for (const el of allElements(frame)) {
    const nodo = resolveRef(el.ref, root);
    if (dialogo.contains(nodo)) assert.equal('inert' in el, false, `elemento del diálogo sin clave: ${el.ref}`);
    else assert.equal(el.inert, true, `elemento del fondo inerte: ${el.ref}`);
  }
  assert.equal(performAction(resolveRef('div:1>button', root), 'click').inert, true, 'act rechaza el fondo, como v0.4.4');
  assert.deepEqual(performAction(resolveRef(REF_BOTON_DIALOGO, root), 'click'), { ok: true }, 'act acciona el diálogo, como v0.4.4');

  // "Byte-idéntico salvo `modal`" se verifica por el conjunto de claves emitidas:
  // la ÚNICA clave nueva que esta feature puede introducir en todo el JSON es
  // `dialog.modal`. (Ver el reporte: una comparación byte a byte contra v0.4.4
  // no es construible desde el test sin un golden congelado.)
  const clavesFrame = new Set(['page', 'totalPages', 'sections', 'read', 'fingerprint', 'do', 'totalElements']);
  // MODIFICADO por fb-018-005 §9.3 (justificación escrita en el spec): la
  // whitelist se EXTIENDE con `clickable`, `context` y `options`. El guard NO se
  // borra y el fixture NO se retoca: se disparó exactamente para lo que existe
  // —obligar a que toda feature que agregue una clave de elemento lo declare por
  // escrito— y rompía dos veces sobre domModal() (el <select> gana `options` por
  // P14; el <button> del diálogo gana `context` por P17). Extenderlo con
  // justificación es usarlo bien; desactivarlo o esquivarlo con otro fixture
  // sería AP-4. Queda como centinela para la próxima feature.
  const clavesElemento = new Set([
    'ref', 'role', 'name', 'tag', 'disabled', 'visible', 'inert',
    'clickable', 'context', 'options',
    'value', 'checked', 'selected', 'expanded',
  ]);
  const clavesDialog = new Set(['ref', 'role', 'name', 'modal']);
  for (const k of Object.keys(frame)) {
    assert.ok(clavesFrame.has(k) || k === 'dialog', `clave de primer nivel no prevista por el contrato: ${k}`);
  }
  for (const k of Object.keys(frame.dialog)) {
    assert.ok(clavesDialog.has(k), `clave nueva en \`dialog\` fuera de contrato: ${k}`);
  }
  for (const el of allElements(frame)) {
    for (const k of Object.keys(el)) {
      assert.ok(clavesElemento.has(k), `clave nueva en un elemento fuera de contrato: ${k} (${el.ref})`);
    }
  }
});

test('P10 (§2.2.4): con hit-test disponible pero CERO testigos elegibles, blocking es true', () => {
  const { doc } = domModal();
  // Plataforma activa pero sin declarar un solo rect: todos degenerados 0×0.
  const h = plataforma(doc);
  h.activar();
  assert.equal(typeof doc.elementFromPoint, 'function', 'precondición: la capacidad SÍ está disponible');

  const frame = serializeFrame(doc.body, {});
  assert.equal(frame.dialog.modal, true, 'cero veredictos → true (§2.2.7, status quo conservador)');
  for (const ref of REFS_FONDO) {
    assert.equal(porRef(frame, ref).inert, true, `se cae al comportamiento estructural: ${ref}`);
  }
});

// ── §3 Reglas de testigo ────────────────────────────────────────────────────

test('P11 (§2.2.3): un elemento del diálogo —incluso vía shadow root abierto— nunca es testigo', () => {
  const doc = makeDom(
    '<div class="fondo"><button>Validar</button></div>' +
      '<div role="dialog"><h4>Confirmación</h4><dlg-host></dlg-host></div>',
  );
  doc.querySelector('dlg-host').attachShadow({ mode: 'open' }).innerHTML = '<button>Confirmar</button>';
  const h = plataforma(doc);
  const dialogo = doc.querySelector('[role="dialog"]');
  const enShadow = doc.querySelector('dlg-host').shadowRoot.querySelector('button');
  // El ÚNICO elemento con centro alcanzable es del propio diálogo (a través del
  // shadow root). El botón del fondo queda con rect degenerado ⇒ no elegible.
  h.rect(dialogo, 100, 100, 400, 300);
  h.rect(enShadow, 150, 150, 100, 40);
  h.activar();

  assert.equal(doc.elementFromPoint(...h.centro(enShadow)), enShadow, 'precondición: ese elemento sí es alcanzable');

  const frame = serializeFrame(doc.body, {});
  assert.equal(
    frame.dialog.modal,
    true,
    'si un elemento del propio diálogo pudiera testificar, el modal se declararía no-modal a sí mismo',
  );
  assert.equal(porRef(frame, 'div:1>button').inert, true, 'el fondo sigue protegido');
});

test('P12 (§2.2.6): un hit que devuelve un DESCENDIENTE o un ANCESTRO del testigo cuenta como alcanzable', () => {
  // (a) descendiente: <button><span>. El impacto cae en el span.
  const docDesc = makeDom(
    '<div class="fondo"><button><span>Enviar</span></button></div>' +
      '<div role="dialog" aria-label="Popover"><button>Cerrar</button></div>',
  );
  const hd = plataforma(docDesc);
  const btn = docDesc.querySelector('.fondo button');
  const span = docDesc.querySelector('.fondo span');
  hd.rect(btn, 100, 100, 200, 60);
  hd.rect(span, 120, 110, 160, 40); // encima del botón: el hit devuelve el span
  hd.rect(docDesc.querySelector('[role="dialog"]'), 700, 600, 200, 100);
  hd.activar();
  assert.equal(docDesc.elementFromPoint(...hd.centro(btn)), span, 'precondición: el impacto cae en el descendiente');

  const sondasDesc = hd.llamadas;
  const frameDesc = serializeFrame(docDesc.body, {});
  assertHubosHitTest(hd, 'P12a', sondasDesc);
  assert.deepEqual(
    inertes(frameDesc).map((e) => e.ref),
    [],
    'el impacto en un descendiente es alcanzable ⇒ no-modal (§2.2.6)',
  );

  // (b) ancestro: el impacto cae en el <div> que envuelve al testigo.
  const docAnc = makeDom(
    '<div class="fondo"><div class="envoltorio"><a href="#x">Ir</a></div></div>' +
      '<div role="dialog" aria-label="Popover"><button>Cerrar</button></div>',
  );
  const ha = plataforma(docAnc);
  const link = docAnc.querySelector('.fondo a');
  const envoltorio = docAnc.querySelector('.envoltorio');
  ha.rect(link, 100, 100, 200, 60);
  ha.rect(envoltorio, 50, 50, 400, 200); // pintado después: el hit devuelve el ancestro
  ha.rect(docAnc.querySelector('[role="dialog"]'), 700, 600, 200, 100);
  ha.activar();
  assert.equal(docAnc.elementFromPoint(...ha.centro(link)), envoltorio, 'precondición: el impacto cae en el ancestro');

  const sondasAnc = ha.llamadas;
  const frameAnc = serializeFrame(docAnc.body, {});
  assertHubosHitTest(ha, 'P12b', sondasAnc);
  assert.deepEqual(
    inertes(frameAnc).map((e) => e.ref),
    [],
    'el impacto vino del propio linaje del testigo: no hay nada ajeno encima ⇒ no-modal (§2.2.6)',
  );
});

test('P13 (§2.2.5): determinismo — mismo DOM y mismo viewport producen el mismo veredicto y los mismos testigos', () => {
  const corrida = () => {
    const { doc, h } = domModal();
    h.activar();
    const frame = serializeFrame(doc.body, {});
    return { h, modal: frame.dialog.modal, refs: inertes(frame).map((e) => e.ref).sort(), puntos: h.puntos.slice() };
  };
  const a = corrida();
  const b = corrida();

  assertHubosHitTest(a.h, 'P13');
  assert.equal(a.modal, b.modal, 'el veredicto es determinista');
  assert.deepEqual(a.refs, b.refs, 'el conjunto de elementos inertes es idéntico');
  // Los testigos elegidos se observan por los PUNTOS consultados, no por la
  // cantidad (§7.1 C-3: K es afinable; lo que no puede variar entre corridas
  // idénticas es CUÁLES).
  assert.deepEqual(a.puntos, b.puntos, 'la selección de testigos es determinista (mismos puntos, mismo orden)');
});

test('P14 (§2.2.5): un popover que tapa los primeros en orden de documento pero deja otro cuadrante alcanzable ⇒ no-modal', () => {
  // 10 controles al principio del documento, todos en el cuadrante superior
  // izquierdo y tapados por el popover; 2 controles al final, en el cuadrante
  // inferior derecho, alcanzables. Una selección "los primeros K en orden de
  // documento" (K=8) tomaría sólo tapados y devolvería blocking = true.
  const tapados = Array.from({ length: 10 }, (_, i) => `<button>Tapado ${i + 1}</button>`).join('');
  const doc = makeDom(
    `<div class="arriba">${tapados}</div>` +
      '<div class="abajo"><button>Libre uno</button><button>Libre dos</button></div>' +
      '<div role="dialog" aria-label="Menú anclado"><button>Opción</button></div>',
  );
  const h = plataforma(doc);
  const arriba = [...doc.querySelectorAll('.arriba button')];
  const abajo = [...doc.querySelectorAll('.abajo button')];
  arriba.forEach((b, i) => h.rect(b, 20, 20 + i * 30, 120, 24));
  abajo.forEach((b, i) => h.rect(b, 700, 600 + i * 40, 120, 24));
  const dialogo = doc.querySelector('[role="dialog"]');
  h.rect(dialogo, 0, 0, 400, 400); // el popover tapa TODO el cuadrante superior izquierdo
  h.rect(dialogo.querySelector('button'), 20, 20, 100, 30);
  h.activar();

  // Guarda de no-vacuidad: los primeros K en orden de documento tienen que
  // estar efectivamente tapados, o el test no distingue las dos estrategias.
  assert.ok(arriba.length >= 9, 'precondición: hay más controles tapados al principio que el K especificado (8)');
  for (const b of arriba) {
    const hit = doc.elementFromPoint(...h.centro(b));
    assert.ok(hit !== b && !b.contains(hit) && !hit.contains(b), 'precondición: cada control de arriba está tapado por el popover');
  }
  for (const b of abajo) {
    assert.equal(doc.elementFromPoint(...h.centro(b)), b, 'precondición: los controles de abajo son alcanzables');
  }

  const sondas = h.llamadas; // las 12 llamadas de las precondiciones no cuentan
  const frame = serializeFrame(doc.body, {});
  assertHubosHitTest(h, 'P14', sondas);
  assert.deepEqual(
    inertes(frame).map((e) => e.ref),
    [],
    'la selección esparcida por cuadrantes tiene que ver el cuadrante libre ⇒ no-modal (§2.2.5)',
  );
});

// ── §3 No-regresión ─────────────────────────────────────────────────────────

test('P15 (PIN): sin diálogo no hay `dialog` ni `inert`, con y sin hit-test, y NO se llama a elementFromPoint', () => {
  const html = '<main><h1>Bandeja</h1><button>Enviar</button><input aria-label="Mensaje"></main>';

  const sinCapacidad = serializeFrame(makeDom(html).body, {});
  assert.equal('dialog' in sinCapacidad, false, 'sin diálogo, sin clave `dialog`');
  assert.equal(inertes(sinCapacidad).length, 0, 'sin diálogo, cero inertes');

  const doc = makeDom(html);
  const h = plataforma(doc);
  h.rect(doc.querySelector('button'), 10, 10, 100, 20);
  h.activar();
  const conCapacidad = serializeFrame(doc.body, {});
  assert.equal('dialog' in conCapacidad, false, 'idem con capacidad de hit-test');
  assert.equal(inertes(conCapacidad).length, 0, 'idem: cero inertes');
  assert.equal(
    h.llamadas,
    0,
    'sin diálogo activo el gate corta en el paso 1 (§2.2.1): costo cero, ni una sola llamada a elementFromPoint',
  );
});

test('P16 (I-A / I-B, PIN): ningún elemento se filtra por el gate, a igual paginación y filtros', () => {
  for (const construir of [domMensajeria, domModal]) {
    const { doc, h } = construir();
    h.activar();

    // Oráculo independiente: el MISMO DOM sin `role="dialog"` (feature inactiva).
    const { doc: docBase, h: hBase } = construir();
    docBase.querySelector('[role="dialog"]').removeAttribute('role');
    hBase.activar();

    for (const opciones of [{}, { roles: ['button'] }, { page: 1, maxElementsPerPage: 2 }]) {
      const conDialogo = new Set(allRefs(serializeFrame(doc.body, opciones)));
      const refsBase = allRefs(serializeFrame(docBase.body, opciones));
      assert.ok(refsBase.length > 0, `precondición: el oráculo emite refs con ${JSON.stringify(opciones)}`);
      for (const ref of refsBase) {
        assert.ok(conDialogo.has(ref), `el gate no puede hacer desaparecer el ref ${ref} con ${JSON.stringify(opciones)}`);
      }
    }
  }
});

test('P17 (I-1): `visible` es invariante ante esta feature, con `hasLayout` ACTIVO', () => {
  // Reescrito tras el hallazgo I3 del review: la versión anterior comparaba dos
  // regímenes en los que `hasLayout` era false, así que `visible` valía `true`
  // en todos los elementos y la postcondición se afirmaba sobre una constante.
  // Acá la fixture activa `hasLayout` (body.getClientRects) en AMBOS regímenes,
  // con la MISMA geometría, de modo que `visible` se computa de verdad y lo
  // único que difiere entre las dos corridas es la disponibilidad del hit-test.
  const construir = (conHitTest) => {
    const { doc, h } = domModal();
    h.conLayout();
    if (conHitTest) h.activar();
    else {
      // Régimen v0.4.4: misma geometría y mismo viewport, pero SIN
      // elementFromPoint (la capacidad es lo único que cambia).
      h.activar();
      delete doc.elementFromPoint;
    }
    return allElements(serializeFrame(doc.body, {}));
  };

  const conHitTest = construir(true);
  const sinHitTest = construir(false);
  assert.ok(conHitTest.length > 0, 'precondición: hay elementos');

  // Guarda de no-vacuidad (el defecto que corrige esta reescritura): `visible`
  // tiene que tomar los DOS valores, o la comparación es sobre una constante.
  const valores = new Set(conHitTest.map((e) => e.visible));
  assert.ok(
    valores.has(true) && valores.has(false),
    `la fixture debe producir \`visible\` true Y false para que P17 diga algo; valores: ${JSON.stringify([...valores])}`,
  );

  for (const el of conHitTest) {
    const gemelo = sinHitTest.find((e) => e.ref === el.ref);
    assert.ok(gemelo, `el mismo ref existe en los dos regímenes: ${el.ref}`);
    assert.equal(el.visible, gemelo.visible, `\`visible\` no cambia por el gate de modalidad: ${el.ref}`);
  }
});

test('P18 (I-D, PIN): serializar con hit-test activo no muta el DOM ni setea el atributo `inert`', () => {
  const { doc, h } = domModal();
  h.activar();
  const root = doc.body;
  const antes = root.outerHTML;

  const frame = serializeFrame(root, {});
  assert.ok(allElements(frame).length > 0, 'precondición: el frame emite elementos');
  assert.equal(root.outerHTML, antes, 'el outerHTML de root es idéntico antes y después');
  assert.equal(root.querySelectorAll('[inert]').length, 0, 'la feature no setea el atributo inert: lo computa');
  for (const nodo of root.querySelectorAll('*')) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(nodo, 'inert'),
      false,
      `ningún nodo gana la propiedad propia \`inert\`: ${nodo.tagName}`,
    );
  }
});

/**
 * Fixture de P19: modal y fondo con geometría IDÉNTICA en las dos variantes;
 * lo único que cambia es el orden de pintado del backdrop (encima o debajo del
 * fondo), que es lo que decide el veredicto de modalidad. Rects iguales ⇒
 * `visible` igual ⇒ cualquier diferencia de huella la aporta `inert` y nada más.
 */
function domGeometriaFija({ backdropEncima }) {
  const doc = makeDom(
    '<div class="fondo">' +
      '<a href="#recepciones">Recepciones</a>' +
      '<button>Validar</button>' +
      '<input aria-label="Proveedor" value="ACME">' +
      '</div>' +
      '<div class="backdrop"></div>' +
      '<div role="dialog"><h4>Operación no válida</h4><button>Cerrar</button></div>',
  );
  const h = plataforma(doc);
  const fondo = doc.querySelector('.fondo');
  const backdrop = doc.querySelector('.backdrop');
  const dialogo = doc.querySelector('[role="dialog"]');
  const pintarFondo = () => {
    h.rect(fondo.querySelector('a'), 10, 10, 120, 20);
    h.rect(fondo.querySelector('button'), 800, 10, 120, 20);
    h.rect(fondo.querySelector('input'), 10, 380, 300, 30);
  };
  const pintarBackdrop = () => h.rect(backdrop, 0, 0, 1000, 800);

  if (backdropEncima) {
    pintarFondo();
    pintarBackdrop();
  } else {
    pintarBackdrop();
    pintarFondo();
  }
  h.rect(dialogo, 0, 600, 1000, 200);
  h.rect(dialogo.querySelector('button'), 400, 700, 100, 40);
  h.conLayout().activar();
  return { doc, h };
}

test('P19 (I-C, enmendada §7.5): la huella es independiente de la QUERY y `inert` SÍ participa', () => {
  const { doc, h } = domModal();
  h.activar();
  const root = doc.body;

  const queries = [{}, { page: 1, maxElementsPerPage: 2 }, { roles: ['button'] }, { namedOnly: true }];
  const huellas = queries.map((q) => serializeFrame(root, q).fingerprint);
  assert.ok(typeof huellas[0] === 'string' && huellas[0].length > 0, 'precondición: hay huella');
  for (let i = 1; i < huellas.length; i++) {
    assert.equal(huellas[i], huellas[0], `la huella no cambia con ${JSON.stringify(queries[i])} (I-C)`);
  }

  // ── `inert` SÍ participa de la huella (inversión del contrato, §7.5) ──────
  // Antes este test exigía lo contrario. El fundamento del cambio: `visible`
  // depende del viewport y siempre participó; si un scroll cambia los flags, el
  // mapa cambió DE VERDAD y `changedSinceLast:true` es correcto. Excluir `inert`
  // dejaba un falso negativo: un scroll que cambiara `blocking` habría alterado
  // los flags sin alterar la huella.
  const tapado = domGeometriaFija({ backdropEncima: true });
  const libre = domGeometriaFija({ backdropEncima: false });
  const frameTapado = serializeFrame(tapado.doc.body, {});
  const frameLibre = serializeFrame(libre.doc.body, {});

  // Guardas de no-vacuidad: (a) los dos veredictos tienen que diferir de verdad;
  // (b) la geometría tiene que ser idéntica, para que la diferencia de huella no
  // pueda venir de `visible` — que es la otra clave dependiente del viewport.
  assert.equal(frameTapado.dialog.modal, true, 'precondición: con el backdrop encima, el veredicto es blocking');
  assert.equal('modal' in frameLibre.dialog, false, 'precondición: con el backdrop debajo, NO hay blocking');
  assert.ok(inertes(frameTapado).length > 0, 'precondición: la variante tapada marca elementos inertes');
  assert.equal(inertes(frameLibre).length, 0, 'precondición: la variante libre no marca ninguno');
  const visiblesDe = (f) => allElements(f).map((e) => `${e.ref}:${e.visible}`);
  assert.deepEqual(
    visiblesDe(frameLibre),
    visiblesDe(frameTapado),
    'precondición: misma geometría ⇒ mismos `visible`; así la única diferencia observable es `inert`',
  );

  assert.notEqual(
    frameLibre.fingerprint,
    frameTapado.fingerprint,
    '`inert` participa de la huella igual que `visible` (P19 enmendada): si los flags cambian, el mapa cambió y ' +
      'changedSinceLast:true es la respuesta correcta. Excluirlo dejaría un falso negativo.',
  );

  // Abrir/cerrar el diálogo sí cambia la huella.
  const { doc: docCiclo, h: hCiclo } = domModal();
  hCiclo.activar();
  const huellaConDialogo = serializeFrame(docCiclo.body, {}).fingerprint;
  docCiclo.querySelector('[role="dialog"]').remove();
  assert.notEqual(
    serializeFrame(docCiclo.body, {}).fingerprint,
    huellaConDialogo,
    'cerrar el diálogo sigue cambiando la huella',
  );
});

test('Cota de rects (§2.5/§5, enmienda I2): ≤ 8 getBoundingClientRect por frame, en los DOS caminos', () => {
  const K = 8; // cota declarada en §2.5 y §5. Se assertea "≤ K", nunca "= K".
  const N = 30; // candidatos de fondo: si el loop de elegibilidad no corta, son N lecturas.

  const construir = () => {
    const html =
      '<div class="fondo">' +
      Array.from({ length: N }, (_, i) => `<button>Acción ${i + 1}</button>`).join('') +
      '</div><div class="backdrop"></div>' +
      '<div role="dialog"><h4>Operación no válida</h4><button>Cerrar</button></div>';
    const doc = makeDom(html);
    const h = plataforma(doc);
    // Repartidos por los cuatro cuadrantes, todos elegibles: la selección se
    // llena rápido y el loop no tiene motivo para seguir leyendo rects.
    [...doc.querySelectorAll('.fondo button')].forEach((b, i) =>
      h.rect(b, 20 + (i % 5) * 180, 20 + Math.floor(i / 5) * 130, 120, 24),
    );
    h.rect(doc.querySelector('.backdrop'), 0, 0, 1000, 800);
    h.rect(doc.querySelector('[role="dialog"]'), 200, 250, 400, 300);
    h.rect(doc.querySelector('[role="dialog"] button'), 300, 480, 100, 40);
    // `hasLayout` queda DESACTIVADO a propósito: con él, el serializer lee un
    // rect por elemento para computar `visible` y la cuenta dejaría de aislar
    // al gate. Acá toda lectura que se cuente es del gate.
    h.activar();
    return { doc, h };
  };

  // Camino de lectura.
  const lectura = construir();
  const base = lectura.h.lecturasRect; // descuenta lo que haya leído el harness
  const frame = serializeFrame(lectura.doc.body, {});
  const rectsLectura = lectura.h.lecturasRect - base;

  assert.equal(frame.dialog.modal, true, 'precondición: el modal tapa (si no, el gate corta antes y no mide nada)');
  assert.ok(allElements(frame).length >= N, `precondición: la fixture emite los ${N} candidatos de fondo`);
  assert.ok(rectsLectura > 0, 'precondición: el gate leyó al menos un rect (si no, no está midiendo el camino nuevo)');

  // Camino de escritura (`act`), donde el costo se paga con el layout en frío.
  // Se MIDE antes de assertear sobre el camino de lectura: si asserteáramos acá
  // arriba, el test cortaría en el primer fallo y el camino de act nunca se
  // ejecutaría — quedaría como rama muerta, y un fix aplicado sólo al
  // serializer pasaría el test sin que nadie haya visto un número de `act`.
  const escritura = construir();
  const boton = resolveRef('div:1>button:1', escritura.doc.body);
  assert.ok(boton, 'precondición: el primer botón del fondo resuelve');
  const baseAct = escritura.h.lecturasRect;
  const res = performAction(boton, 'click');
  const rectsAct = escritura.h.lecturasRect - baseAct;

  assert.equal(res.inert, true, 'precondición: act pasa por el gate (el fondo de un modal real se rechaza)');
  assert.ok(rectsAct > 0, 'precondición: el gate leyó al menos un rect en el camino de act');

  // Recién ahora se assertea la cota, con los DOS números ya medidos.
  assert.ok(
    rectsLectura <= K,
    `serializeFrame: ${rectsLectura} lecturas de getBoundingClientRect sobre ${N} candidatos ` +
      `(act midió ${rectsAct}). La cota de §2.5/§5 es ≤ ${K}: el loop de elegibilidad tiene que cortar cuando ` +
      'la selección ya no puede aceptar más testigos. Leer todo W₀ es O(N), no O(1).',
  );
  assert.ok(
    rectsAct <= K,
    `performAction: ${rectsAct} lecturas de getBoundingClientRect sobre ${N} candidatos ` +
      `(serializeFrame midió ${rectsLectura}). La cota de §2.5 es ≤ ${K}, y en este camino el flush de layout ` +
      'es en frío. Un fix aplicado sólo al camino de lectura no alcanza.',
  );
});

// ── §4 I-4 en dos regímenes (property test obligatorio) ─────────────────────

/** Los ≥ 5 DOMs exigidos por §5: sin diálogo, modal con backdrop, popover, pila hermana, shadow dentro del diálogo. */
function domsDeI4() {
  return [
    [
      'sin diálogo',
      () => {
        const doc = makeDom('<main><h1>Bandeja</h1><button>Enviar</button><input aria-label="Mensaje"></main>');
        const h = plataforma(doc);
        h.rect(doc.querySelector('button'), 10, 10, 100, 20);
        return { doc, h };
      },
    ],
    ['modal con backdrop', () => domModal()],
    ['popover (mensajería)', () => domMensajeria()],
    [
      'pila hermana',
      () => {
        const doc = makeDom(
          '<div class="fondo"><button>Validar</button></div>' +
            '<div class="overlay">' +
            '<div class="item"><div role="dialog"><h4>Confirmación</h4><button>Descartar</button></div></div>' +
            '<div class="item"><div role="dialog"><h4>Operación no válida</h4><button>Cerrar</button></div></div>' +
            '</div>',
        );
        const h = plataforma(doc);
        const dialogos = doc.querySelectorAll('[role="dialog"]');
        h.rect(doc.querySelector('.fondo button'), 10, 10, 120, 24);
        h.rect(dialogos[0], 100, 100, 400, 200);
        h.rect(dialogos[1], 0, 0, 1000, 800); // el de arriba tapa todo
        return { doc, h };
      },
    ],
    [
      'shadow root dentro del diálogo',
      () => {
        const doc = makeDom(
          '<div class="fondo"><button>Validar</button></div>' +
            '<div role="dialog"><h4>Confirmación</h4><dlg-host></dlg-host></div>',
        );
        doc.querySelector('dlg-host').attachShadow({ mode: 'open' }).innerHTML = '<button>Confirmar</button>';
        const h = plataforma(doc);
        h.rect(doc.querySelector('.fondo button'), 10, 10, 120, 24);
        h.rect(doc.querySelector('[role="dialog"]'), 0, 0, 1000, 800);
        return { doc, h };
      },
    ],
  ];
}

test('I-4 (property, §4): inert:true ⟺ act rechaza con {ok:false, inert:true} — en los DOS regímenes', () => {
  let inertesTotales = 0;
  let dialogosSinInert = 0;

  for (const regimen of ['sin hit-test', 'con hit-test']) {
    for (const [etiqueta, construir] of domsDeI4()) {
      const { doc, h } = construir();
      if (regimen === 'con hit-test') h.activar();
      const root = doc.body;
      const frame = serializeFrame(root, {});
      const elementos = allElements(frame);
      assert.ok(elementos.length > 0, `${regimen} / ${etiqueta}: precondición, el DOM emite elementos`);

      for (const el of elementos) {
        const nodo = resolveRef(el.ref, root);
        assert.ok(nodo, `${regimen} / ${etiqueta}: el ref emitido resuelve — ${el.ref}`);
        const res = performAction(nodo, 'focus');
        const mapaDiceInerte = el.inert === true;
        const actRechaza = res.ok === false && res.inert === true;
        assert.equal(
          actRechaza,
          mapaDiceInerte,
          `${regimen} / ${etiqueta}: bicondicional rota en ${el.ref} — mapa inert:${mapaDiceInerte}, act ${JSON.stringify(res)}`,
        );
        if (mapaDiceInerte) inertesTotales++;
      }
      if (frame.dialog && inertes(frame).length === 0) dialogosSinInert++;
    }
  }

  // Guardas de no-vacuidad: la bicondicional tiene que ejercitarse sobre los
  // DOS veredictos. Sin la segunda, el régimen con hit-test podría estar
  // devolviendo blocking=true en todos los DOMs (que es el estado previo a la
  // feature) y el property test quedaría verde sin ejercitar nada nuevo.
  assert.ok(inertesTotales > 0, 'tiene que haber elementos realmente inertes (régimen blocking=true)');
  assert.ok(
    dialogosSinInert > 0,
    'tiene que haber al menos un DOM con `dialog` y CERO inertes (blocking=false, §2.4): es el caso que antes era imposible',
  );
});
