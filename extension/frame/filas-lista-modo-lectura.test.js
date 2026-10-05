/**
 * filas-lista-modo-lectura.test.js — fb-023-004 "filas de lista en modo lectura"
 * (sub-fase 3.1 RED). Archivo NUEVO y aditivo: las suites existentes NO se
 * editan (I-5). En particular NO se tocan los ORDEN_CANONICO stale.
 *
 * Spec: docs/specs/fb-023-004-filas-lista-modo-lectura/spec.md
 *   §3.2 postcondiciones P1–P10 + fixtures FA/FC/FE/FB/FA-auto/FC-auto.
 *   §4 invariantes I-1..I-10. §5 criterios de aceptación.
 * AUDIT (APTO CON CONDICIONES): docs/specs/fb-023-004-filas-lista-modo-lectura/test-audit.md
 *   §6 gaps/foco del RED; §9 condiciones.
 *
 * Aislamiento de rol: este test NO lee serializer.js ni importa internals
 * (`isCellLike`/`isActionableCell`). Sólo usa el oráculo `serializeFrame` y el
 * resolver público `resolveRef` (identidad de nodo), como ya hacen las suites
 * vigentes.
 *
 * Mapa RED / PIN (spec §5 #2, audit §8):
 *   RED (deben FALLAR hoy, AssertionError de contrato):
 *     P1a, P1b, P7b, P8a, P8b, P9.
 *   PIN (deben PASAR en RED, guardan el contrato ya vigente):
 *     P2, P3, P7c.
 *   P4/P5/P6 (T-field) y P10 (T-doc + docsguard) NO son de esta suite (§7).
 *
 * NO-VACUIDAD: las postcondiciones negativas (P2) son "present-only": hoy —sin
 * implementación— "ninguna celda lleva `actionable`" es verde VACUO en RED.
 * Se declara honestamente: el contraste positivo (las celdas pointer SÍ lo
 * llevan) vive en P1b (RED), y en P2 se reforzará condicionalmente post-GREEN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

/** Serializa y conserva el root (y su doc) para poder resolver identidad de nodo. */
function serializeDom(html, options) {
  const doc = makeDom(html);
  const root = doc.body;
  return { frame: serializeFrame(root, options), root, doc };
}

function serialized(html, options) {
  return serializeDom(html, options).frame;
}

function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}

/** Celdas emitidas (tag `td`), cualquiera sea la puerta de entrada. */
function celdas(frame) {
  return allElements(frame).filter((e) => e.tag === 'td');
}

/** Elemento emitido cuyo ref resuelve EXACTAMENTE al nodo del DOM `nodo`. */
function celdaPara(frame, root, nodo) {
  return allElements(frame).find((el) => {
    try {
      return resolveRef(el.ref, root) === nodo;
    } catch {
      return false;
    }
  });
}

// ── fixtures (§3.2, verbatim; higiene pública I-7: datos inventados) ────────

/** FA — tabla simple, una fila; la celda promovida es la del producto. */
const FA =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '<th data-name="sol_qty"><span>Cantidad</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_id" style="cursor:pointer">Mesa de roble</td>' +
  '<td name="sol_qty">3</td>' +
  '</tr></tbody></table></main>';

/** FA-auto — idéntica a FA sin `cursor:pointer` (negativo P2). */
const FA_AUTO = FA.replace(' style="cursor:pointer"', '');

/** FC — role="gridcell" explícito: dos celdas accionables y una negativa en la MISMA fila. */
const FC =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '<th data-name="sol_qty"><span>Cantidad</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_id" role="gridcell" style="cursor:pointer">Mesa de roble</td>' +
  '<td name="sol_qty" role="gridcell" style="cursor:pointer">3</td>' +
  '<td role="gridcell">nota</td>' +
  '</tr></tbody></table></main>';

/** FC-auto — idéntica a FC sin los dos `cursor:pointer` (negativo P2). */
const FC_AUTO = FC.replaceAll(' style="cursor:pointer"', '');

/** FE — tabla cruzada con celda accionable. */
const FE =
  '<main><table>' +
  '<thead><tr><th></th><th data-name="ene"><span>Enero</span></th></tr></thead>' +
  '<tbody><tr><th scope="row">Ropa</th>' +
  '<td name="ene" role="gridcell" style="cursor:pointer">10</td></tr></tbody>' +
  '</table></main>';

/** FB — tabla simple de DOS filas (lista no editable) con pointer en la celda de nombre (D-7a). */
const FB =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '<th data-name="sol_qty"><span>Cantidad</span></th>' +
  '</tr></thead>' +
  '<tbody>' +
  '<tr><td name="product_id" style="cursor:pointer">Mesa de roble</td><td name="sol_qty">3</td></tr>' +
  '<tr><td name="product_id" style="cursor:pointer">Silla de pino</td><td name="sol_qty">1</td></tr>' +
  '</tbody></table></main>';

// Orden canónico de ELEMENTO tras 004 (D-3): clave `actionable` entre
// `clickable` y `context`. Corrige en un archivo aditivo la lista stale de las
// suites existentes (I-5 prohíbe editarlas).
const ORDEN_CANONICO_D3 = [
  'ref', 'role', 'expands', 'name', 'tag', 'disabled', 'visible', 'inert',
  'clickable', 'actionable', 'context', 'column', 'options', 'value', 'checked',
  'selected', 'expanded', 'invalid',
];

/** Claves de primer nivel del frame (§3.2 P7c; `dialog` sólo con diálogo activo). */
const CLAVES_FRAME = ['page', 'totalPages', 'sections', 'read', 'dialog', 'fingerprint'];

// ── P1 (T-jsdom, RED): celda accionable marcada por AMBAS puertas ───────────

test('P1a: FA — la celda promovida (product_id) emite actionable:true', () => {
  const doc = makeDom(FA);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const td = doc.querySelector('td[name="product_id"]');
  const celda = celdaPara(frame, root, td);

  // Guardas de no-vacuidad (§3.2 P1): la celda existe, role cell y context no vacío.
  assert.ok(celda, 'no-vacuidad: la celda promovida product_id tiene que estar en el frame');
  assert.equal(celda.role, 'cell', 'no-vacuidad: el role implícito de <td> es "cell"');
  assert.ok(Array.isArray(celda.context) && celda.context.length > 0, 'no-vacuidad: la celda promovida lleva context no vacío');

  // Contrato 004: la celda accionable (cursor:pointer) emite la clave present-only.
  assert.equal(celda.actionable, true, 'P1a: la celda de la lista accionable emite `actionable:true` (D-1)');
});

test('P1b: FC — AMBAS celdas role="gridcell" con pointer emiten actionable:true (loop principal)', () => {
  const doc = makeDom(FC);
  const root = doc.body;
  const frame = serializeFrame(root, {});

  const tds = doc.querySelectorAll('td[role="gridcell"]');
  assert.equal(tds.length, 3, 'no-vacuidad: FC emite las tres celdas con role="gridcell"');

  const producto = celdaPara(frame, root, doc.querySelector('td[name="product_id"]'));
  const cantidad = celdaPara(frame, root, doc.querySelector('td[name="sol_qty"]'));

  for (const [nombre, celda] of [['product_id', producto], ['sol_qty', cantidad]]) {
    assert.ok(celda, `no-vacuidad: la celda ${nombre} (gridcell) tiene que estar en el frame`);
    assert.equal(celda.role, 'gridcell', `no-vacuidad: la celda ${nombre} conserva su role explícito`);
    assert.ok(Array.isArray(celda.context) && celda.context.length > 0, `no-vacuidad: la celda ${nombre} lleva context no vacío`);
    assert.equal(celda.actionable, true, `P1b: la celda ${nombre} (pointer) emite \`actionable:true\` por el loop principal`);
  }
});

// ── P2 (T-jsdom, PIN): present-only negativo ────────────────────────────────

test('P2: present-only — las celdas auto NO llevan actionable y ningún elemento emite actionable:false', () => {
  // FA-auto: la celda promovida existe y lleva context (guard RED-safe), pero
  // SIN cursor:pointer no debe emitir la clave.
  const faAuto = serializeDom(FA_AUTO);
  const celdaFa = celdaPara(faAuto.frame, faAuto.root, faAuto.doc.querySelector('td[name="product_id"]'));
  assert.ok(celdaFa, 'no-vacuidad: en FA-auto la celda promovida existe');
  assert.equal(celdaFa.role, 'cell', 'no-vacuidad: role cell');
  assert.ok(Array.isArray(celdaFa.context) && celdaFa.context.length > 0, 'no-vacuidad: context no vacío (el mecanismo de grid corrió)');
  assert.equal('actionable' in celdaFa, false, 'P2: sin cursor:pointer la celda NO emite `actionable`');

  // FC-auto: las tres gridcell están emitidas (no-vacuidad), ninguna lleva la clave.
  const fcAuto = serializeDom(FC_AUTO);
  const emitidas = celdas(fcAuto.frame).filter((e) => e.role === 'gridcell');
  assert.equal(emitidas.length, 3, 'no-vacuidad: FC-auto emite sus tres celdas role="gridcell" con context');
  for (const celda of emitidas) {
    assert.ok(Array.isArray(celda.context) && celda.context.length > 0, `${celda.ref}: no-vacuidad, context no vacío`);
    assert.equal('actionable' in celda, false, `${celda.ref}: cursor auto ⇒ sin \`actionable\` (I-1, present-only)`);
  }

  // I-1: la clave se emite SÓLO true, nunca false, en ningún frame.
  for (const frame of [serialized(FA_AUTO), serialized(FC_AUTO), serialized(FA), serialized(FC)]) {
    for (const el of allElements(frame)) {
      assert.notEqual(el.actionable, false, `${el.ref}: \`actionable\` nunca se emite false (I-1)`);
    }
  }

  // Fuerza post-GREEN (condicional para no romper la validez PIN en RED): el
  // contraste positivo —si el mecanismo existe— es que las celdas pointer de FC
  // SÍ llevan la clave; queda cubierto como RED por P1b. En RED se saltea.
  const fc = serializeDom(FC);
  if (allElements(fc.frame).some((e) => e.actionable === true)) {
    for (const selector of ['td[name="product_id"]', 'td[name="sol_qty"]']) {
      const celda = celdaPara(fc.frame, fc.root, fc.doc.querySelector(selector));
      assert.ok(celda, `post-GREEN: la celda pointer ${selector} se emite`);
      assert.equal(celda.actionable, true, `post-GREEN: la celda pointer ${selector} lleva \`actionable:true\` (no-vacuidad del mecanismo)`);
    }
  }
});

// ── P3 (T-jsdom, PIN): orden canónico D-3 ──────────────────────────────────

test('P3: orden canónico D-3 — toda clave emitida es subsecuencia en orden, y `actionable` precede inmediatamente a `context`', () => {
  const { frame } = serializeDom(FC);
  const elementos = allElements(frame);
  assert.ok(elementos.length > 0, 'no-vacuidad: FC emite elementos para auditar el orden');

  // Cero claves nuevas de primer nivel (I-2).
  const clavesFrame = Object.keys(frame);
  assert.deepEqual(
    clavesFrame,
    CLAVES_FRAME.filter((k) => clavesFrame.includes(k)),
    `el frame no agrega claves de primer nivel ni rompe su orden: ${JSON.stringify(clavesFrame)}`,
  );

  for (const el of elementos) {
    const claves = Object.keys(el);
    assert.deepEqual(
      claves,
      ORDEN_CANONICO_D3.filter((k) => claves.includes(k)),
      `${el.ref}: las claves salen en el orden canónico D-3 (determinismo del JSON)`,
    );
  }

  // Adyacencia específica de 004 (post-GREEN): si hay `context`, `actionable` lo
  // precede inmediatamente (D-3). En RED ningún elemento tiene `actionable`, así
  // que este bloque se saltea sin romper la validez PIN.
  for (const el of elementos.filter((e) => 'actionable' in e)) {
    const claves = Object.keys(el);
    const i = claves.indexOf('actionable');
    if ('context' in el) {
      assert.equal(claves[i + 1], 'context', `${el.ref}: \`actionable\` precede inmediatamente a \`context\` (D-3)`);
    }
    // No puede colarse antes de un bloque anterior del orden canónico.
    assert.ok(i > claves.indexOf('role'), `${el.ref}: \`actionable\` va después de \`role\` (D-3)`);
  }
});

// ── P7b (T-jsdom, RED): actionable participa de la huella (D-4) ─────────────

test('P7b: dos DOMs idénticos salvo cursor:pointer vs auto producen huellas DISTINTAS (D-4)', () => {
  const con = serializeDom(FA);
  const sin = serializeDom(FA_AUTO);

  assert.equal(typeof con.frame.fingerprint, 'string', 'precondición: el frame trae fingerprint');
  assert.equal(typeof sin.frame.fingerprint, 'string', 'precondición: el frame trae fingerprint');

  // Guarda de no-vacuidad: en ambos DOMs existe la celda promovida.
  const celdaCon = celdaPara(con.frame, con.root, con.doc.querySelector('td[name="product_id"]'));
  const celdaSin = celdaPara(sin.frame, sin.root, sin.doc.querySelector('td[name="product_id"]'));
  assert.ok(celdaCon, 'no-vacuidad: FA emite la celda promovida');
  assert.ok(celdaSin, 'no-vacuidad: FA-auto emite la celda promovida');

  assert.notEqual(
    con.frame.fingerprint,
    sin.frame.fingerprint,
    'P7b: la aparición de `actionable` es un cambio observable del contrato ⇒ la huella tiene que moverse (D-4/I-4)',
  );
});

// ── P7c (T-jsdom, PIN): huella invariante a la query ───────────────────────

test('P7c: en FC variar page/maxElementsPerPage/roles/namedOnly/maxContextLength NO mueve la huella', () => {
  const { frame: base, root } = serializeDom(FC);
  assert.equal(typeof base.fingerprint, 'string', 'precondición: serializeFrame devuelve la huella');
  assert.ok(celdas(base).length > 0, 'no-vacuidad: FC aporta celdas emitidas');

  const variantes = [
    { page: 2, maxElementsPerPage: 1 },
    { maxElementsPerPage: 1 },
    { roles: ['button'] },
    { namedOnly: true },
    { maxContextLength: 5 },
  ];
  for (const opciones of variantes) {
    assert.equal(
      serializeFrame(root, opciones).fingerprint,
      base.fingerprint,
      `I-C: ninguna opción de QUERY puede mover la huella: ${JSON.stringify(opciones)}`,
    );
  }
});

// ── P8 (T-jsdom, RED): alcance del discriminante ───────────────────────────

test('P8a: FB (lista no editable, celdas pointer) — las celdas promovidas de las DOS filas emiten actionable:true con context distintos', () => {
  const doc = makeDom(FB);
  const root = doc.body;
  const frame = serializeFrame(root, {});

  const filas = doc.querySelectorAll('tbody tr');
  assert.equal(filas.length, 2, 'no-vacuidad: FB tiene dos filas de datos');

  const fila1 = celdaPara(frame, root, filas[0].querySelector('td[name="product_id"]'));
  const fila2 = celdaPara(frame, root, filas[1].querySelector('td[name="product_id"]'));

  assert.ok(fila1 && fila2, 'no-vacuidad: ambas celdas promovidas están emitidas');
  assert.equal(fila1.role, 'cell', 'no-vacuidad: role cell (tabla simple)');
  assert.equal(fila2.role, 'cell', 'no-vacuidad: role cell (tabla simple)');
  assert.ok(fila1.context && fila1.context.length > 0, 'no-vacuidad: context de la fila 1 no vacío');
  assert.ok(fila2.context && fila2.context.length > 0, 'no-vacuidad: context de la fila 2 no vacío');
  assert.notDeepEqual(fila1.context, fila2.context, 'no-vacuidad: dos filas distintas ⇒ contexts distintos');

  assert.equal(fila1.actionable, true, 'P8a (D-7a): en lista NO editable, la celda pointer de la fila 1 emite `actionable:true`');
  assert.equal(fila2.actionable, true, 'P8a (D-7a): y la de la fila 2 también');
});

test('P8b: FE (cruzada) — la celda con pointer emite actionable:true (context de 2 entradas)', () => {
  const doc = makeDom(FE);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const celda = celdaPara(frame, root, doc.querySelector('td[name="ene"]'));

  // Guarda de no-vacuidad (§3.2 P8b): la celda cruzada existe, su context es de
  // 2 entradas y no vacío.
  assert.ok(celda, 'no-vacuidad: la celda cruzada td[name="ene"] está emitida');
  assert.equal(celda.role, 'gridcell', 'no-vacuidad: role gridcell explícito');
  assert.equal(celda.context.length, 2, `no-vacuidad: context cruzado de 2 entradas ["Ropa","Enero"]; got ${JSON.stringify(celda.context)}`);
  assert.ok(celda.context.every((s) => s && s.length > 0), 'no-vacuidad: las dos entradas de context no vacías');

  assert.equal(celda.actionable, true, 'P8b (D-7b): la celda cruzada con pointer emite `actionable:true`');
});

// ── P9 (T-jsdom, RED): cotas intactas / no confundir con clickable ─────────

test('P9: FC con {maxPromotedClickables:0} — las celdas accionables SIGUEN en el mapa y NO llevan clickable', () => {
  const doc = makeDom(FC);
  const root = doc.body;
  const frame = serializeFrame(root, { maxPromotedClickables: 0 });

  const producto = celdaPara(frame, root, doc.querySelector('td[name="product_id"]'));
  const cantidad = celdaPara(frame, root, doc.querySelector('td[name="sol_qty"]'));

  assert.ok(producto && cantidad, 'no-vacuidad: las celdas accionables siguen emitidas con la cota en 0 (D-5/I-6)');
  for (const [nombre, celda] of [['product_id', producto], ['sol_qty', cantidad]]) {
    assert.equal(celda.role, 'gridcell', `no-vacuidad: role gridcell (${nombre})`);
    assert.ok(Array.isArray(celda.context) && celda.context.length > 0, `no-vacuidad: context no vacío (${nombre})`);
    assert.equal(celda.actionable, true, `P9: ${nombre} conserva \`actionable:true\` (no participa de maxPromotedClickables)`);
    assert.equal('clickable' in celda, false, `P9: ${nombre} NO lleva \`clickable\` (semánticas distintas, D-1)`);
  }
});
