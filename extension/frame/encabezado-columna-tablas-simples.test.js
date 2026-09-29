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
