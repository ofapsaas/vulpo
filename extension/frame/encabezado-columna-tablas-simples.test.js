/**
 * encabezado-columna-tablas-simples.test.js — fb-023-002 (sub-fase 3.1 RED).
 *
 * Verifica P1(a/b), P2, P3, P4(a/b), P5, P6(a/b), P7(a/b/c) de
 * docs/specs/fb-023-002-encabezado-columna-tablas-simples/spec.md §3.2
 * (decisiones D-1..D-6 cerradas en §3.1; GREEN no las renegocia).
 *
 * Escrito SOLO contra el contrato del spec §3.2/§3.1: esta sesión NO leyó
 * `serializer.js` ni ningún módulo de producción (rol test-writer,
 * aislamiento de fase, ADR-011). `serializeFrame` (serializer.js) y
 * `resolveRef` (resolver.js) son el oráculo observable, importados con la
 * MISMA forma verbatim del precedente de casa
 * (`control-en-celda-hereda-fila.test.js`, ciclo hermano fb-023-001 —
 * helpers de carga reusados verbatim). Los fixtures F1/F2/F3, la réplica
 * P4a del P1c de 001 y los sintéticos de P4b/P6a/P6b son verbatim del spec
 * §3.2; los textos ("Mesa de roble", "Cantidad", "Precio", "Producto"…) son
 * datos inventados de fixture, sin nombres de cliente ni URLs de instancia
 * (I-3). El problema real es "medido en campo 2026-09-29", sin identidad.
 *
 * ── Naturaleza RED esperada (spec §5, verificado acá) ──────────────────────
 *  · FALLAN por AssertionError, todos por la EMISIÓN AUSENTE de la clave
 *    `column` (hoy no existe en ningún elemento — D-1/D-3):
 *      P1(a) — la celda promovida (product_id) no lleva column "Producto"
 *        (cláusula 0a);
 *      P1(b) — input#cantidad / input#precio no llevan column
 *        "Cantidad"/"Precio" (cláusula 0b: heredan de la celda ancestro);
 *      P2 (mitad "el resto de la fila SÍ") — ídem sobre el fixture F2;
 *      P3 (compañero) — la celda product_id de F3 no lleva column
 *        "Producto" (sin el compañero, la ausencia en el handle sería
 *        verde vacua);
 *      P5 — input#cantidad: la fila ya está (context, fb-023-001 rama 0b)
 *        pero falta la columna ⇒ falla sólo por column (puente 001+002);
 *      P6(b) — la celda data-row con name+colspan no lleva column "Col A"
 *        (D-5: el colspan no se inspecciona, manda el campo técnico).
 *  · PIN / anti-regresión — pasan YA en RED por diseño, con guarda de
 *    no-vacuidad (§5):
 *      P2 (td del widget qty_at_date, SIN name) — no emite column
 *        (guarda: está emitida, candidata por [role] — patrón P6c de
 *        contenido-asociado);
 *      P3 (handle) — th o_handle_cell sin texto ⇒ etiqueta accesible
 *        vacía ⇒ sin column (guarda: el compañero SÍ debería, y ése es
 *        el rojo);
 *      P4(a/b) — tablas cruzadas byte-idénticas y SIN column (D-2; guarda:
 *        context no vacío; P4b pinea el gate de D-2: cruzada CON campo
 *        técnico ⇒ igual se omite);
 *      P6(a) — filas no-data (colspan, sin name) sin column (guarda:
 *        emitidas con context no vacío);
 *      P7 — orden canónico COMPLETO (D-6) verde hoy porque ninguna clave
 *        nueva aparece; la guarda "F1 tiene column" madura en GREEN (la
 *        exigen P1(b)/P5, hoy rojos — no se evalúa acá como fallo, spec
 *        §3.2 P7a: "es la aserción 'column existe en F1' la que es RED,
 *        no el orden").
 *
 * Un rojo fuera de P1/P2-mitad/P3-compañero/P5/P6(b) —o en cualquier suite
 * existente— es defecto preexistente, no ruido del ciclo: se reporta, no
 * se dobla el test (instrucción del orquestador; spec §5).
 *
 * ── Advertencia de fixture (misma que 001) ─────────────────────────────────
 * Con `elementFromPoint` inexistente en jsdom, `isBlocking` da true en cuanto
 * hay un `role=dialog`, y todo lo de afuera sale `inert:true`. El único
 * fixture con diálogo es el de P4a (réplica byte-idéntica del P1c de
 * fb-023-001), y lo testeado está DENTRO del diálogo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

// ── Helpers (patrón de control-en-celda-hereda-fila.test.js, reuso verbatim) ─

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function allElements(frame) {
  if (!Array.isArray(frame?.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}
function emitidoPara(frame, root, nodo, etiqueta) {
  const el = allElements(frame).find((e) => resolveRef(e.ref, root) === nodo);
  assert.ok(
    el,
    `precondición (${etiqueta}): el frame emite el nodo; refs=${JSON.stringify(allRefs(frame))}`,
  );
  return el;
}

// ── Fixtures (§3.2 verbatim; I-3: datos inventados, sin identidad) ───────────

/** F1 (§3.2, verbatim): grilla simple con th[data-name] y td[name]. */
const F1 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '<th data-name="product_uom_qty"><span>Cantidad</span></th>' +
  '<th data-name="price_unit"><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody>' +
  '<tr>' +
  '<td name="product_id">Mesa de roble</td>' +
  '<td name="product_uom_qty"><input type="text" id="cantidad"></td>' +
  '<td name="price_unit"><input type="text" id="precio"></td>' +
  '</tr>' +
  '</tbody></table></main>';

/** F2 (§3.2, verbatim): F1 + la columna del widget qty_at_date (td SIN name
 *  bajo th sin texto). */
const F2 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '<th data-name="product_uom_qty"><span>Cantidad</span></th>' +
  '<th style="width:29px;"></th>' +
  '<th data-name="price_unit"><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody>' +
  '<tr>' +
  '<td name="product_id">Mesa de roble</td>' +
  '<td name="product_uom_qty"><input type="text" id="cantidad"></td>' +
  '<td role="gridcell" class="o_data_cell"><div class="o_widget_qty_at_date_widget"></div></td>' +
  '<td name="price_unit"><input type="text" id="precio"></td>' +
  '</tr>' +
  '</tbody></table></main>';

/** F3 (§3.2, verbatim): handle vacío (th o_handle_cell SIN texto) + compañero
 *  product_id con role="gridcell". */
const F3 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="sequence" class="o_handle_cell"></th>' +
  '<th data-name="product_id"><span>Producto</span></th>' +
  '</tr></thead>' +
  '<tbody>' +
  '<tr>' +
  '<td name="sequence"><span class="o_handle">≡</span></td>' +
  '<td name="product_id" role="gridcell">Mesa de roble</td>' +
  '</tr>' +
  '</tbody></table></main>';

/** P4a (§3.2): réplica byte-idéntica del fixture P1c de fb-023-001 (tabla
 *  cruzada th[scope=row] dentro de role=dialog) — el pin de 001 + la clave
 *  `column` ausente (D-2). */
const F4A =
  '<div role="dialog"><h4>Agregar registros</h4>' +
  '<table>' +
  '<thead><tr><th></th><th>Ene</th><th>Feb</th></tr></thead>' +
  '<tbody>' +
  '<tr><th scope="row">Ropa</th><td><input type="checkbox"></td><td>20</td></tr>' +
  '</tbody></table>' +
  '</div>';

/** P4b (§3.2, verbatim): tabla CRUZADA sintética CON data-name — el gate de
 *  D-2 (cruzada con campo técnico ⇒ igual se omite `column`). */
const F4B =
  '<main><table>' +
  '<thead><tr><th></th><th data-name="ene"><span>Enero</span></th><th data-name="feb"><span>Febrero</span></th></tr></thead>' +
  '<tbody><tr><th scope="row">Ropa</th><td name="ene">10</td><td name="feb">20</td></tr></tbody>' +
  '</table></main>';

/** P6a (§3.2): grilla con filas no-data (agregar colspan="9", tfoot
 *  colspan="3") SIN name — celdas promovidas sin campo técnico. */
const F6A =
  '<main><table>' +
  '<thead><tr><th data-name="product_id"><span>Producto</span></th></tr></thead>' +
  '<tbody>' +
  '<tr><td name="product_id">Mesa de roble</td></tr>' +
  '<tr><td colspan="9">Agregar un producto</td></tr>' +
  '</tbody>' +
  '<tfoot><tr><td colspan="3">Pie</td></tr></tfoot>' +
  '</table></main>';

/** P6b (§3.2, verbatim): celda data-row con name Y colspan (sintético,
 *  comportamiento declarado D-5). */
const F6B =
  '<main><table>' +
  '<thead><tr><th data-name="a"><span>Col A</span></th><th data-name="b"><span>Col B</span></th></tr></thead>' +
  '<tbody><tr><td name="a" role="gridcell" colspan="2">Celda expandida</td></tr></tbody>' +
  '</table></main>';

/**
 * Orden canónico COMPLETO de claves de ELEMENTO (D-6, §3.1: la lista
 * vigente de `emitElement` l.516-539 — con `expands` tras `role`, `invalid`
 * al final y `column` tras `context`). Corrige la staleness documentada
 * (F-5 de fb-023-001 / A-1 del audit) en un archivo aditivo, sin tocar las
 * suites existentes (I-4). Ninguna feature puede agregar una clave fuera
 * de este orden.
 */
const ORDEN_CANONICO_COMPLETO = [
  'ref', 'role', 'expands', 'name', 'tag', 'disabled', 'visible', 'inert',
  'clickable', 'context', 'column', 'options', 'value', 'checked', 'selected',
  'expanded', 'invalid',
];
/** Claves de primer nivel del frame (§3.2 P7c; `dialog` sólo con diálogo activo). */
const CLAVES_FRAME = ['page', 'totalPages', 'sections', 'read', 'dialog', 'fingerprint'];

// ── P1 (T-jsdom, RED genuina): la celda y el control emiten columna (D-1) ────

test('P1: la celda y el control dentro de la celda emiten la columna — emparejamiento th[data-name]↔td[name]', async (t) => {
  await t.test('P1a: sobre F1, la celda promovida (product_id, "Mesa de roble") emite column "Producto"; su context queda igual', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const td = doc.querySelector('td[name="product_id"]');
    // Guarda de no-vacuidad (§3.2 P1a): la celda promovida existe y su
    // context no vacío (ya hoy, cláusula 0a).
    const celda = emitidoPara(frame, root, td, 'celda promovida product_id');
    assert.ok(
      Array.isArray(celda.context) && celda.context.length > 0,
      `guarda de no-vacuidad (P1a): la celda promovida lleva context no vacío (ya hoy); recibido ${JSON.stringify(celda)}`,
    );
    assert.deepEqual(
      celda.context,
      ['Mesa de roble'],
      'P1a (D-1): el context de la celda promovida sigue siendo ["Mesa de roble"] — sin cambios',
    );
    assert.equal(
      celda.column,
      'Producto',
      'P1a (D-1/D-3): la celda promovida emite column "Producto" — la etiqueta del th[data-name="product_id"] ' +
        '(emparejamiento por campo técnico, SIN fallback posicional). HOY (RED): la clave column no existe ⇒ ' +
        `undefined. Recibido ${JSON.stringify(celda)}`,
    );
  });

  await t.test('P1b: input#cantidad (en td product_uom_qty) emite column "Cantidad"', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad');
    // Guarda de no-vacuidad (§3.2 P1b): el input no aporta texto propio
    // (name "") ⇒ toda columna que aparezca proviene de la celda ancestro.
    assert.equal(
      input.name,
      '',
      'guarda de no-vacuidad (P1b): el input sigue sin name propio (name "") — toda columna proviene de la celda ancestro',
    );
    assert.equal(
      input.column,
      'Cantidad',
      'P1b (D-1, cláusula 0b de fb-023-001): el control en celda hereda la COLUMNA de su celda ancestro — ' +
        'column "Cantidad" (th[data-name="product_uom_qty"]). HOY (RED): la clave column no existe ⇒ undefined. ' +
        `Recibido ${JSON.stringify(input)}`,
    );
  });

  await t.test('P1b: input#precio (en td price_unit) emite column "Precio"', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio');
    assert.equal(
      input.name,
      '',
      'guarda de no-vacuidad (P1b): el input sigue sin name propio (name "")',
    );
    assert.equal(
      input.column,
      'Precio',
      'P1b (D-1, cláusula 0b): column "Precio" (th[data-name="price_unit"]) — sin esto, Cantidad y Precio son ' +
        'indistinguibles salvo por posición (riesgo V-3, inferencia posicional). HOY (RED): undefined. ' +
        `Recibido ${JSON.stringify(input)}`,
    );
  });
});

// ── P2 (T-jsdom): td sin name bajo th sin texto — PIN + mitad RED ────────────

test('P2: celda sin name bajo th sin texto NO emite column; el resto de la fila SÍ', async (t) => {
  await t.test('P2 (PIN): la td del widget qty_at_date (role="gridcell", SIN name) NO emite column; su context sigue el de la fila', () => {
    const doc = makeDom(F2);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tdQty = doc.querySelector('td[role="gridcell"]');
    // Guarda de no-vacuidad (§3.2 P2): la td gridcell está EMITIDA
    // (candidata por [role], patrón P6c de contenido-asociado) y los dos
    // inputs existen (se guardan en la mitad RED de abajo).
    const celda = emitidoPara(frame, root, tdQty, 'td del widget qty_at_date (candidata por [role])');
    assert.ok(
      Array.isArray(celda.context) && celda.context.length > 0,
      `guarda de no-vacuidad (P2): la td gridcell lleva context no vacío; recibido ${JSON.stringify(celda)}`,
    );
    assert.deepEqual(
      celda.context,
      ['Mesa de roble'],
      'P2 (D-1): el context de la td qty_at_date sigue ["Mesa de roble"] — la fila',
    );
    assert.equal(
      'column' in celda,
      false,
      'P2 (D-1/D-3, PIN): sin campo técnico (td SIN name) la clave column NO se emite — present-only. ' +
        `Recibido ${JSON.stringify(celda)}`,
    );
  });

  await t.test('P2 (RED, el resto de la fila SÍ): input#cantidad emite column "Cantidad"', () => {
    const doc = makeDom(F2);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (F2)');
    assert.equal(
      input.column,
      'Cantidad',
      'P2 (D-1, mitad "el resto de la fila SÍ"): input#cantidad → column "Cantidad". HOY (RED): la clave ' +
        `column no existe ⇒ undefined. Recibido ${JSON.stringify(input)}`,
    );
  });

  await t.test('P2 (RED, el resto de la fila SÍ): input#precio emite column "Precio"', () => {
    const doc = makeDom(F2);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio (F2)');
    assert.equal(
      input.column,
      'Precio',
      'P2 (D-1, mitad "el resto de la fila SÍ"): input#precio → column "Precio". HOY (RED): la clave ' +
        `column no existe ⇒ undefined. Recibido ${JSON.stringify(input)}`,
    );
  });
});

// ── P3 (T-jsdom): handle vacío sin columna — PIN + compañero RED ─────────────

test('P3: el handle (th sin texto) no emite column — el compañero product_id SÍ (RED)', async (t) => {
  await t.test('P3 (PIN): la celda del handle (name="sequence", th o_handle_cell SIN texto) NO emite column', () => {
    const doc = makeDom(F3);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tdHandle = doc.querySelector('td[name="sequence"]');
    // Guarda de no-vacuidad (§3.2 P3): ambas celdas están emitidas (el
    // compañero se guarda en el subtest de abajo — y su rojo es el que
    // evita que este PIN sea verde vacuo).
    const handle = emitidoPara(frame, root, tdHandle, 'celda del handle (name="sequence")');
    assert.equal(
      'column' in handle,
      false,
      'P3 (D-1/D-3, PIN): etiqueta accesible del th VACÍA ⇒ sin column. Sin el compañero RED esto sería verde ' +
        'vacuo — el rojo de abajo (product_id SÍ emite) es la guarda (§5). Recibido ' + JSON.stringify(handle),
    );
  });

  await t.test('P3 (RED, compañero): la celda product_id (role="gridcell") SÍ emite column "Producto"', () => {
    const doc = makeDom(F3);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tdProd = doc.querySelector('td[name="product_id"]');
    // Guarda de no-vacuidad (§3.2 P3): la celda compañera está emitida —
    // si este rojo fallara por INexistencia del elemento sería otro defecto.
    const companero = emitidoPara(frame, root, tdProd, 'celda compañera product_id (role="gridcell")');
    assert.equal(
      companero.column,
      'Producto',
      'P3 (D-1, compañero RED): la celda product_id de F3 SÍ emite column "Producto" — sin el compañero, la ' +
        'ausencia en el handle sería verde vacua (§3.2 P3). HOY (RED): la clave column no existe ⇒ undefined. ' +
        `Recibido ${JSON.stringify(companero)}`,
    );
  });
});

// ── P4 (T-jsdom, PIN verde-en-RED): cero regresión en cruzadas (D-2) ─────────

test('P4: en tablas CRUZADAS column NO se emite — cero regresión, byte-idéntico', async (t) => {
  await t.test('P4a: réplica del P1c de fb-023-001 — context exacto ["Agregar registros","Ropa","Ene"] y SIN la clave column', () => {
    const doc = makeDom(F4A);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    // Guardas de no-vacuidad (mismas precondiciones del P1c de 001): hay
    // diálogo activo y su nombre sale del primer heading.
    assert.ok(frame.dialog, 'precondición (patrón P1c de 001): hay diálogo activo');
    assert.equal(
      frame.dialog.name,
      'Agregar registros',
      'precondición: dialog.name sale del primer heading (fb-018-004 P6)',
    );
    const cb = emitidoPara(frame, root, doc.querySelector('tbody td input'), 'input de la fila Ropa, columna Ene');
    // Guarda de no-vacuidad (§3.2 P4a): el context de la celda cruzada es
    // no vacío (hoy ya lleva [nombreDiálogo, fila, columna]).
    assert.ok(
      Array.isArray(cb.context) && cb.context.length > 0,
      `guarda de no-vacuidad (P4a): el input del diálogo lleva context no vacío; recibido ${JSON.stringify(cb)}`,
    );
    assert.deepEqual(
      cb.context,
      ['Agregar registros', 'Ropa', 'Ene'],
      'P4a (D-2, PIN): el context del input cruzado queda byte-idéntico al pin de fb-023-001 P1c — ' +
        'la columna ya viaja dentro de context en cruzadas',
    );
    assert.equal(
      'column' in cb,
      false,
      'P4a (D-2, PIN): la clave column NO se emite en tabla cruzada — sin duplicación ni divergencia con el ' +
        'colHeader posicional que context ya lleva. Recibido ' + JSON.stringify(cb),
    );
  });

  await t.test('P4b: cruzada CON data-name (sintética) — context ["Ropa","Enero"] y SIN column aunque el emparejamiento exista', () => {
    const doc = makeDom(F4B);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tdEne = doc.querySelector('td[name="ene"]');
    const celda = emitidoPara(frame, root, tdEne, 'celda cruzada td[name="ene"]');
    // Guarda de no-vacuidad (§3.2 P4b): el context de la celda cruzada es
    // no vacío y de 2 entradas ([encabezadoFila, encabezadoColumna]).
    assert.ok(
      Array.isArray(celda.context) && celda.context.length === 2,
      `guarda de no-vacuidad (P4b): context cruzado no vacío y de 2 entradas ([fila, columna] posicional); ` +
        `recibido ${JSON.stringify(celda)}`,
    );
    assert.deepEqual(
      celda.context,
      ['Ropa', 'Enero'],
      'P4b (D-2, PIN): el context de la celda cruzada queda byte-idéntico a la forma vigente (posicional: ' +
        '[encabezadoFila, encabezadoColumna])',
    );
    // El gate de D-2 (audit A-3): éste es el ÚNICO test que pinea la
    // cruzada CON campo técnico — la clave del gate, escrita con cuidado.
    assert.equal(
      'column' in celda,
      false,
      'P4b (D-2, PIN — el gate): en tabla CRUZADA la clave column NO se emite AUNQUE el emparejamiento por ' +
        'campo técnico exista (td[name="ene"] ↔ th[data-name="ene"]) — la columna ya viaja dentro de context ' +
        '(["Ropa","Enero"]) y un segundo cómputo por data-name podría divergir del colHeader posicional. ' +
        'Regla del consumidor (D-2): si column está presente, es la columna; si no y context tiene ≥2 entradas, ' +
        'la última es la columna. Recibido ' + JSON.stringify(celda),
    );
  });
});

// ── P5 (T-jsdom, RED genuina): fila Y columna conviven (puente 001+002) ──────

test('P5: input#cantidad emite a la vez context ["Mesa de roble"] Y column "Cantidad" — la rama 0b de 001 + la columna de este ciclo', () => {
  const doc = makeDom(F1);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (P5)');
  assert.deepEqual(
    input.context,
    ['Mesa de roble'],
    'P5 (puente 001+002): la FILA ya está — context ["Mesa de roble"] vía la rama 0b de fb-023-001 (verde ya hoy)',
  );
  assert.equal(
    input.column,
    'Cantidad',
    'P5 (D-1/D-4): la COLUMNA convive con la fila en el MISMO elemento — HOY (RED): la fila ya está (001) pero ' +
    'column no existe ⇒ falla sólo por la columna. Recibido ' + JSON.stringify(input),
  );
});

// ── P6 (T-jsdom): colspans — PIN (no-data) + RED (data-row con name) ─────────

test('P6: colspan no se inspecciona (D-5) — no-data sin column (PIN); data-row con name emite la suya (RED)', async (t) => {
  await t.test('P6a (PIN): las celdas no-data (colspan="9"/"3", SIN name) NO emiten column', () => {
    const doc = makeDom(F6A);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const celdaAgregar = emitidoPara(
      frame,
      root,
      doc.querySelector('td[colspan="9"]'),
      'celda no-data "Agregar un producto" (promovida, sin name)',
    );
    const celdaPie = emitidoPara(
      frame,
      root,
      doc.querySelector('tfoot td[colspan="3"]'),
      'celda del tfoot "Pie" (promovida, sin name)',
    );
    // Guarda de no-vacuidad (§3.2 P6a): están emitidas (promovidas como
    // celdas simples) con context no vacío.
    for (const [etiqueta, c] of [['agregar', celdaAgregar], ['pie', celdaPie]]) {
      assert.ok(
        Array.isArray(c.context) && c.context.length > 0,
        `guarda de no-vacuidad (P6a): la celda no-data (${etiqueta}) está emitida con context no vacío; ` +
          `recibido ${JSON.stringify(c)}`,
      );
      assert.equal(
        'column' in c,
        false,
        `P6a (D-1/D-5, PIN): la celda no-data (${etiqueta}) SIN campo técnico NO emite column — caída segura ` +
          'natural (D-5: el colspan no se lee, manda el name). Recibido ' + JSON.stringify(c),
      );
    }
  });

  await t.test('P6b (RED): celda data-row con name Y colspan emite column "Col A" (el colspan no se inspecciona)', () => {
    const doc = makeDom(F6B);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tdExpandida = doc.querySelector('td[name="a"]');
    // Guarda de no-vacuidad (§3.2 P6b): la celda está emitida (role="gridcell").
    const celda = emitidoPara(frame, root, tdExpandida, 'celda data-row con name="a" y colspan="2"');
    assert.equal(
      celda.column,
      'Col A',
      'P6b (D-5, RED): la celda data-row con name Y colspan emite column "Col A" — el colspan/rowspan NO se ' +
        'inspecciona, manda el campo técnico (name="a" ↔ data-name="a"). Comportamiento DECLARADO para markup ' +
        'sintético no medido. HOY (RED): la clave column no existe ⇒ undefined. Recibido ' + JSON.stringify(celda),
    );
  });
});

// ── P7 (T-jsdom, PIN verde-en-RED): orden canónico completo (D-6) ────────────

test('P7: cero claves nuevas aparte de column — orden canónico completo y claves de frame vigentes', async (t) => {
  await t.test('P7a: TODO elemento emitido de F1 — Object.keys subsecuencia EN ORDEN de la lista canónica completa', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const elementos = allElements(frame);
    // Guarda de no-vacuidad (§3.2 P7a): el frame emite elementos y al menos
    // uno lleva `context` (la frontera donde `column` se inserta) — verde
    // hoy y tras GREEN.
    assert.ok(elementos.length > 0, 'guarda de no-vacuidad (P7a): F1 emite elementos');
    const conContext = elementos.filter((e) => 'context' in e);
    assert.ok(
      conContext.length >= 1,
      'guarda de no-vacuidad (P7a): hay elementos con context (celda promovida por 0a, inputs por 0b de 001)',
    );
    // Guarda de no-vacuidad específica de `column` (§3.2 P7a): "F1 contiene
    // al menos un elemento con column" VALE tras GREEN; hoy (RED) es
    // precisamente la aserción RED de P1(b)/P5 ("column existe en F1"), no
    // del orden — NO se evalúa acá como fallo ("en RED la guarda no se
    // evalúa como fallo", §3.2 P7a). Tras GREEN, P1(b) garantiza ≥2
    // elementos con column (input#cantidad/precio) ⇒ este chequeo de orden
    // deja de ser vacuo para la clave nueva sin guarda aparte.
    for (const el of elementos) {
      assert.deepEqual(
        Object.keys(el),
        ORDEN_CANONICO_COMPLETO.filter((k) => k in el),
        `P7a (D-6): ${el.ref} — claves subsecuencia EN ORDEN de la lista canónica completa ` +
          '(ref, role, expands, name, tag, disabled, visible, inert, clickable, context, column, options, ' +
          'value, checked, selected, expanded, invalid) — cero claves nuevas aparte de column. Recibido ' +
          JSON.stringify(Object.keys(el)),
      );
    }
  });

  await t.test('P7b: en el elemento que lleva column, la clave va inmediatamente después de context y antes de options', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const elementos = allElements(frame);
    // En RED ningún elemento lleva column ⇒ este PIN pasa vacío; su
    // no-vacuidad la garantizan P1(b)/P5 (rojos hoy, verdes tras GREEN) —
    // "la guarda madura en GREEN" (§3.2 P7a/§5). Tras GREEN este loop
    // corre sobre ≥2 elementos (input#cantidad/precio) y pina la posición.
    const conColumn = elementos.filter((e) => 'column' in e);
    for (const el of conColumn) {
      const claves = Object.keys(el);
      const i = claves.indexOf('context');
      assert.ok(
        i !== -1,
        `P7b guarda (D-4): ${el.ref} con column también lleva context — fila y columna salen del mismo punto de cómputo (gridRowColContext); recibido ${JSON.stringify(claves)}`,
      );
      assert.equal(
        claves[i + 1],
        'column',
        `P7b (D-6): ${el.ref} — column inmediatamente DESPUÉS de context; recibido ${JSON.stringify(claves)}`,
      );
      if ('options' in el) {
        assert.ok(
          claves.indexOf('options') > claves.indexOf('column'),
          `P7b (D-6): ${el.ref} — column ANTES de options; recibido ${JSON.stringify(claves)}`,
        );
      }
    }
  });

  await t.test('P7c: las claves de primer nivel del frame son las vigentes — sin claves nuevas', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    assert.deepEqual(
      Object.keys(frame),
      CLAVES_FRAME.filter((k) => k in frame),
      'P7c (D-6/I-4): claves de primer nivel del frame = page, totalPages, sections, read, dialog?, ' +
        'fingerprint (dialog sólo con diálogo activo; F1 no tiene diálogo) — cero claves nuevas',
    );
  });
});

// ═══ P8 (Enmienda 1 del spec — E1.2/E1.4, RED parcial) ═══════════════════════

// Agregados por la Enmienda 1 (2026-09-30) de fb-023-002: en una fila recién
// agregada de una lista editable (inputs sin atributo `value`, sin texto) la
// fila NO tiene nombre accesible; hoy las guardas `if (rc.length)` de las
// cláusulas 0a/0b descartan la `column` de la celda de referencia y caen al
// walk `group|region`, que devuelve `column: undefined` (V-3). La enmienda
// (D-7/D-8, más D-6 reformulada) exige conservar la `column` de la celda de
// referencia con `context` EXACTAMENTE como hoy (Invariantes I-6/I-7). GREEN
// no renegocia estas decisiones.
//
// ── Naturaleza RED esperada (E1.4, verificada acá) ───────────────────────────
//  · FALLAN por AssertionError, todos por la EMISIÓN de `column`:
//      P8a (2) — input#cantidad / input#precio sobre F8 (0b sin fila);
//      P8b (4) — las 2 td (0a) y los 2 inputs (0b) sobre F8-gc;
//      P8c (2) — los 2 inputs sobre F8-reg (column, no el context);
//      P8d (2) — los 2 inputs sobre F8-dlg (column, no el context);
//      P8f (2) — el compañero RED: td e input de la tabla simple.
//  · PIN / pasan por diseño ya en RED: guardas sin `context` de P8a/P8b,
//    `context` exactos de P8c/P8d, P8e, la cruzada de P8f y P8g. Un rojo
//    fuera de esas aserciones es defecto a reportar, no ruido del ciclo.
//
// Advertencia de fixture (misma cabecera del archivo): F8-dlg tiene un
// `role=dialog` — con `elementFromPoint` inexistente en jsdom todo lo de
// afuera sale `inert:true`; todo lo testeado acá está DENTRO del diálogo.
//
// I-3: fixtures sintéticos, sin nombres de cliente ni URLs (src/ es público).

/** F8 (E1.2, verbatim): fila nueva — sin texto, inputs SIN atributo `value`
 *  (con `value` la fila toma nombre y el caso degenera en P1). */
const F8 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_uom_qty"><span>Cantidad</span></th>' +
  '<th data-name="price_unit"><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_uom_qty"><input type="text" id="cantidad"></td>' +
  '<td name="price_unit"><input type="text" id="precio"></td>' +
  '</tr></tbody></table></main>';

/** F8-gc (E1.2, variante): F8 con role="gridcell" en las dos celdas —
 *  ejercita 0a (la celda misma) Y 0b (el control). */
const F8_GC =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_uom_qty"><span>Cantidad</span></th>' +
  '<th data-name="price_unit"><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_uom_qty" role="gridcell"><input type="text" id="cantidad"></td>' +
  '<td name="price_unit" role="gridcell"><input type="text" id="precio"></td>' +
  '</tr></tbody></table></main>';

/** F8-reg (E1.2, variante): F8 dentro de una región con nombre — el walk
 *  `group|region` sigue aportando el `context` (D-7 no lo abandona). */
const F8_REG = '<div role="region" aria-label="Líneas">' + F8 + '</div>';

/** F8-dlg (E1.2, variante): F8 dentro de un diálogo activo — el nombre del
 *  diálogo entra PRIMERO en `labels`, no se agrega la fila. */
const F8_DLG = '<div role="dialog" aria-label="Agregar líneas">' + F8 + '</div>';

/** F8e (E1.2 P8e): F8 SIN `data-name` en los `th` y SIN `name` en las `td`. */
const F8E =
  '<main><table>' +
  '<thead><tr>' +
  '<th><span>Cantidad</span></th>' +
  '<th><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td><input type="text" id="cantidad"></td>' +
  '<td><input type="text" id="precio"></td>' +
  '</tr></tbody></table></main>';

/** F8f-cruzada (E1.2 P8f, verbatim): cruzada con cabeceras vacías (etiqueta
 *  de columna sólo en `aria-label`; el colHeader posicional sale vacío y cae
 *  al walk). */
const F8F_CRUZADA =
  '<main><table><thead><tr><th></th><th data-name="ene" aria-label="Enero"></th></tr></thead>' +
  '<tbody><tr><th scope="row"></th><td name="ene" role="gridcell"><input id="v"></td></tr></tbody>' +
  '</table></main>';

/** F8f-simple (E1.2 P8f, compañero RED verbatim): la tabla SIMPLE con el
 *  mismo par — la td y el input deben emitir column "Enero". */
const F8F_SIMPLE =
  '<main><table><thead><tr><th data-name="ene" aria-label="Enero"></th></tr></thead>' +
  '<tbody><tr><td name="ene" role="gridcell"><input id="v"></td></tr></tbody>' +
  '</table></main>';

// ── P8a (cláusula 0b sin fila — RED 2 aserciones de column) ──────────────────

test('P8a: fila sin nombre accesible — el input en celda emite la columna de su celda (0b sin fila, D-7)', async (t) => {
  await t.test('P8a (guardas PIN): ambos inputs de F8 emitidos, name "" y SIN la clave context', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    for (const [id, etiqueta] of [
      ['cantidad', 'input#cantidad'],
      ['precio', 'input#precio'],
    ]) {
      const input = emitidoPara(frame, root, doc.getElementById(id), etiqueta + ' (F8)');
      // Guarda de no-vacuidad (E1.2 P8a): con atributo `value` la fila tomaría
      // nombre y el caso degeneraría en P1 — los inputs van recién agregados.
      assert.equal(
        input.name,
        '',
        'guarda de no-vacuidad (P8a): ' + etiqueta + ' con name "" — se ejercita la fila SIN nombre (inputs ' +
          'vacíos, sin atributo value); Recibido ' + JSON.stringify(input),
      );
      assert.equal(
        'context' in input,
        false,
        'guarda de no-vacuidad (P8a): ' + etiqueta + ' SIN la clave context — prueba que se ejercita la fila ' +
          'sin nombre; D-7 no inventa un context de fila (labels vacío ⇒ context ausente). Recibido ' +
          JSON.stringify(input),
      );
    }
  });

  await t.test('P8a (RED): input#cantidad (td product_uom_qty) emite column "Cantidad"', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (F8)');
    assert.equal(
      input.column,
      'Cantidad',
      'P8a (D-7, cláusula 0b sin fila): la celda de referencia es la misma que hoy y CONSERVA su `column` ' +
        'aunque su rowCol esté vacío — column "Cantidad" (th[data-name="product_uom_qty"], emparejamiento por ' +
        'campo técnico). HOY (RED): la guarda rc.length descarta la celda y cae al walk group|region ⇒ column ' +
        'undefined (V-3). Recibido ' + JSON.stringify(input),
    );
  });

  await t.test('P8a (RED): input#precio (td price_unit) emite column "Precio"', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio (F8)');
    assert.equal(
      input.column,
      'Precio',
      'P8a (D-7, cláusula 0b sin fila): column "Precio" (th[data-name="price_unit"]) — sin esto, Cantidad y ' +
        'Precio son indistinguibles en una fila recién agregada (V-3). HOY (RED): column undefined. Recibido ' +
        JSON.stringify(input),
    );
  });
});

// ── P8b (cláusula 0a sin fila — RED 4 aserciones de column) ──────────────────

test('P8b: celda cell-like SIN fila emite su columna (0a) y su control también (0b) — F8-gc, D-7', async (t) => {
  await t.test('P8b (guardas PIN): las 2 celdas role="gridcell" y los 2 inputs de F8-gc están EMITIDOS, NINGUNO con la clave context', () => {
    const doc = makeDom(F8_GC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const nodos = [
      ['td product_uom_qty', doc.querySelector('td[name="product_uom_qty"]')],
      ['td price_unit', doc.querySelector('td[name="price_unit"]')],
      ['input#cantidad', doc.getElementById('cantidad')],
      ['input#precio', doc.getElementById('precio')],
    ];
    for (const [etiqueta, nodo] of nodos) {
      const el = emitidoPara(frame, root, nodo, etiqueta + ' (F8-gc)');
      // Guarda de no-vacuidad (E1.2 P8b): emitidas — las td son candidatas
      // por [role] (patrón P6c de contenido-asociado) y sin context (la fila
      // no aporta nombre y D-7 no lo inventa).
      assert.equal(
        'context' in el,
        false,
        'guarda de no-vacuidad (P8b): ' + etiqueta + ' emitida y SIN la clave context (fila sin nombre; el walk ' +
          'de caída no agrega fila). Recibido ' + JSON.stringify(el),
      );
    }
  });

  await t.test('P8b (RED): la td product_uom_qty (role="gridcell") emite column "Cantidad"', () => {
    const doc = makeDom(F8_GC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const td = emitidoPara(frame, root, doc.querySelector('td[name="product_uom_qty"]'), 'td product_uom_qty (F8-gc)');
    assert.equal(
      td.column,
      'Cantidad',
      'P8b (D-7, cláusula 0a sin fila): la celda cell-like de F8-gc conserva su `column` aunque su rowCol esté ' +
        'vacío — column "Cantidad" (th[data-name="product_uom_qty"]). HOY (RED): la guarda rc.length descarta ' +
        'la celda ⇒ column undefined. Recibido ' + JSON.stringify(td),
    );
  });

  await t.test('P8b (RED): la td price_unit (role="gridcell") emite column "Precio"', () => {
    const doc = makeDom(F8_GC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const td = emitidoPara(frame, root, doc.querySelector('td[name="price_unit"]'), 'td price_unit (F8-gc)');
    assert.equal(
      td.column,
      'Precio',
      'P8b (D-7, cláusula 0a sin fila): column "Precio" (th[data-name="price_unit"]). HOY (RED): undefined. ' +
        'Recibido ' + JSON.stringify(td),
    );
  });

  await t.test('P8b (RED): input#cantidad de F8-gc emite column "Cantidad"', () => {
    const doc = makeDom(F8_GC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (F8-gc)');
    assert.equal(
      input.name,
      '',
      'guarda de no-vacuidad (P8b): el input no aporta texto propio (name "") — toda columna proviene de la celda ancestro',
    );
    assert.equal(
      input.column,
      'Cantidad',
      'P8b (D-7, cláusula 0b sin fila): el control hereda la COLUMNA de su celda ancestro sin fila con nombre — ' +
        'column "Cantidad". HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });

  await t.test('P8b (RED): input#precio de F8-gc emite column "Precio"', () => {
    const doc = makeDom(F8_GC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio (F8-gc)');
    assert.equal(
      input.name,
      '',
      'guarda de no-vacuidad (P8b): el input no aporta texto propio (name "")',
    );
    assert.equal(
      input.column,
      'Precio',
      'P8b (D-7, cláusula 0b sin fila): el control hereda la COLUMNA de su celda ancestro — column "Precio". ' +
        'HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });
});

// ── P8c (el walk sigue aportando context — PIN en context, RED en column) ────

test('P8c: sobre F8-reg el walk group|region sigue danto el context ["Líneas"] (PIN) Y los inputs emiten column (RED, D-7)', async (t) => {
  await t.test('P8c (PIN): cada input de F8-reg conserva context EXACTAMENTE ["Líneas"] — el walk sigue aportando', () => {
    const doc = makeDom(F8_REG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    for (const id of ['cantidad', 'precio']) {
      const input = emitidoPara(frame, root, doc.getElementById(id), 'input#' + id + ' (F8-reg)');
      assert.deepEqual(
        input.context,
        ['Líneas'],
        'P8c (D-7, PIN): el context NO cambia — con fila sin nombre se sigue el walk group|region y labels es ' +
          'exactamente ["Líneas"] (I-6: context intacto). Recibido ' + JSON.stringify(input),
      );
    }
  });

  await t.test('P8c (RED): input#cantidad de F8-reg emite column "Cantidad" además del context del walk', () => {
    const doc = makeDom(F8_REG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (F8-reg)');
    assert.equal(
      input.column,
      'Cantidad',
      'P8c (D-7): junto al context del walk ["Líneas"], la celda de 0b conserva su `column` — column "Cantidad". ' +
        'HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });

  await t.test('P8c (RED): input#precio de F8-reg emite column "Precio" además del context del walk', () => {
    const doc = makeDom(F8_REG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio (F8-reg)');
    assert.equal(
      input.column,
      'Precio',
      'P8c (D-7): column "Precio" junto al context del walk — fila y columna conviven sin mover la huella ' +
        '(I-6). HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });
});

// ── P8d (diálogo activo — PIN en context, RED en column) ─────────────────────

test('P8d: sobre F8-dlg el nombre del diálogo activo entra primero (PIN) y los inputs emiten column (RED, D-7)', async (t) => {
  await t.test('P8d (PIN): hay diálogo activo y cada input conserva context EXACTAMENTE ["Agregar líneas"] — el diálogo entra primero, no se agrega fila', () => {
    const doc = makeDom(F8_DLG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    // Precondición (patrón P4a del archivo): el role=dialog activa el diálogo.
    assert.ok(frame.dialog, 'precondición (P8d): el role=dialog activa un diálogo');
    // Advertencia inert (cabecera del archivo): lo testeado está DENTRO del
    // diálogo, no afectado por el inert de afuera.
    for (const id of ['cantidad', 'precio']) {
      const input = emitidoPara(frame, root, doc.getElementById(id), 'input#' + id + ' (F8-dlg)');
      assert.deepEqual(
        input.context,
        ['Agregar líneas'],
        'P8d (D-7, PIN): el nombre del diálogo activo entra PRIMERO en labels y NO se agrega la fila — ' +
          'context exactamente ["Agregar líneas"] (I-6: context intacto). Recibido ' + JSON.stringify(input),
      );
    }
  });

  await t.test('P8d (RED): input#cantidad de F8-dlg emite column "Cantidad" junto al context del diálogo', () => {
    const doc = makeDom(F8_DLG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('cantidad'), 'input#cantidad (F8-dlg)');
    assert.equal(
      input.column,
      'Cantidad',
      'P8d (D-7): junto a context ["Agregar líneas"], la celda de 0b conserva su `column` "Cantidad". HOY (RED): ' +
        'column undefined (V-3 en la rama de caída). Recibido ' + JSON.stringify(input),
    );
  });

  await t.test('P8d (RED): input#precio de F8-dlg emite column "Precio" junto al context del diálogo', () => {
    const doc = makeDom(F8_DLG);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('precio'), 'input#precio (F8-dlg)');
    assert.equal(
      input.column,
      'Precio',
      'P8d (D-7): column "Precio" — Cantidad y Precio distinguibles también dentro del diálogo para una línea ' +
        'nueva. HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });
});

// ── P8e (sin campo técnico — PIN pura; el compañero RED que evita el verde    //  vacuo es P8a) ──

test('P8e: F8 sin campo técnico (sin data-name en th, sin name en td) — inputs emitidos SIN column y SIN context (PIN)', () => {
  const doc = makeDom(F8E);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  for (const id of ['cantidad', 'precio']) {
    const input = emitidoPara(frame, root, doc.getElementById(id), 'input#' + id + ' (F8e)');
    // Guarda de no-vacuidad (E1.2 P8e): los inputs están EMITIDOS — sin la
    // guarda, la ausencia de column sería verde vacua (el rojo que la evita
    // es el compañero P8a).
    assert.equal(
      'column' in input,
      false,
      'P8e (D-7/D-1/D-3, PIN): SIN campo técnico no hay th[data-name] que emparejar ⇒ no hay columna que ' +
        'conservar — la clave column NO se emite (present-only). Recibido ' + JSON.stringify(input),
    );
    assert.equal(
      'context' in input,
      false,
      'P8e (D-7, PIN): sin campo técnico y sin nombre de fila, labels vacío ⇒ sin context (el walk no aporta nada ' +
        'y D-7 no lo inventa). Recibido ' + JSON.stringify(input),
    );
  }
});

// ── P8f (D-2 intacto en la rama nueva — cruzada PIN, simple RED compañera) ───

test('P8f: D-2 en la rama nueva — la cruzada con cabeceras vacías NO emite column (PIN); la simple con el mismo par SÍ (RED)', async (t) => {
  await t.test('P8f (PIN): en la cruzada con cabeceras vacías, td[name="ene"] e input#v NO emiten column ni context', () => {
    const doc = makeDom(F8F_CRUZADA);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const nodos = [
      ['td name="ene"', doc.querySelector('td[name="ene"]')],
      ['input#v', doc.getElementById('v')],
    ];
    for (const [etiqueta, nodo] of nodos) {
      const el = emitidoPara(frame, root, nodo, etiqueta + ' (F8f-cruzada)');
      // Guarda de no-vacuidad (E1.2 P8f): ambos elementos están EMITIDOS.
      assert.equal(
        'column' in el,
        false,
        'P8f (D-2/I-7, PIN): en tabla CRUZADA la clave column NO se emite, tampoco por la rama de caída de la ' +
          'enmienda (el colHeader posicional sale vacío y cae al walk). Recibido ' + JSON.stringify(el),
      );
      assert.equal(
        'context' in el,
        false,
        'P8f (D-2, PIN): cabeceras vacías ⇒ labels vacío ⇒ sin context (el walk no fabrica etiquetas); la clave ' +
          'column ausente es verde vacua sin el compañero RED de abajo (§ E1.4). Recibido ' + JSON.stringify(el),
      );
    }
  });

  await t.test('P8f (RED, compañero): la tabla simple con el mismo par emite column "Enero" en la td role="gridcell"', () => {
    const doc = makeDom(F8F_SIMPLE);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const td = emitidoPara(frame, root, doc.querySelector('td[name="ene"]'), 'td name="ene" (F8f-simple)');
    assert.equal(
      td.column,
      'Enero',
      'P8f (compañero RED): en tabla SIMPLE, la td role="gridcell" con td[name="ene"] ↔ th[data-name="ene"] ' +
        '(etiqueta en aria-label) emite column "Enero" — sin el compañero, la ausencia en la cruzada sería ' +
        'verde vacua. HOY (RED): column undefined. Recibido ' + JSON.stringify(td),
    );
  });

  await t.test('P8f (RED, compañero): la tabla simple con el mismo par emite column "Enero" en el input', () => {
    const doc = makeDom(F8F_SIMPLE);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitidoPara(frame, root, doc.getElementById('v'), 'input#v (F8f-simple)');
    assert.equal(
      input.column,
      'Enero',
      'P8f (compañero RED, 0b sin fila): el control en celda hereda la COLUMNA "Enero" también para una etiqueta ' +
        'que vive en aria-label. HOY (RED): column undefined. Recibido ' + JSON.stringify(input),
    );
  });
});

// ── P8g (orden D-6 reformulado — PIN verde-en-RED) ───────────────────────────

test('P8g: sobre F8 y F8-gc, Object.keys de cada elemento es subsecuencia EN ORDEN de la lista canónica de D-6 (sin exigir adyacencia context→column)', () => {
  for (const [nombre, html] of [
    ['F8', F8],
    ['F8-gc', F8_GC],
  ]) {
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const elementos = allElements(frame);
    // Guarda de no-vacuidad (E1.2 P8g): el frame emite elementos — sin ella
    // el chequeo de orden sería verde vacuo.
    assert.ok(elementos.length > 0, 'guarda de no-vacuidad (P8g): ' + nombre + ' emite elementos');
    for (const el of elementos) {
      assert.deepEqual(
        Object.keys(el),
        ORDEN_CANONICO_COMPLETO.filter((k) => k in el),
        'P8g (D-6 reformulada): ' + nombre + ' ' + el.ref + ' — Object.keys subsecuencia EN ORDEN de la lista ' +
          'canónica completa (column después de context SI está presente, siempre antes de options). Sin exigir ' +
          'adyacencia context→column: un elemento puede llevar column sin context (D-7: context ausente con ' +
          'labels vacío). Recibido ' + JSON.stringify(Object.keys(el)),
      );
    }
  }
});
