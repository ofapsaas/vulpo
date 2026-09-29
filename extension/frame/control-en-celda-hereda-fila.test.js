/**
 * control-en-celda-hereda-fila.test.js — fb-023-001 (sub-fase 3.1 RED).
 *
 * Verifica P1(a/b/c), P2, P3(a/b), P4, P5(a/b), P6 de
 * docs/specs/fb-023-001-control-en-celda-hereda-fila/spec.md §3.2 (P7 es
 * sonda de campo post-GREEN, §7 — no vive en este archivo).
 *
 * Escrito SOLO contra el contrato del spec §3.2: esta sesión NO leyó
 * `serializer.js`, `index.js` ni ningún módulo de implementación (rol
 * test-writer, aislamiento de fase). `serializeFrame` (serializer.js) y
 * `resolveRef` (resolver.js) son el oráculo observable, importados con la
 * MISMA forma verbatim de los precedentes de casa
 * (`contenido-asociado.test.js`, `campo-selector-expands.test.js`). El
 * fixture base §3.2 es verbatim; los textos ("WH/IN/00001", "Azure
 * Interior", …) son datos inventados de fixture, sin nombres de cliente ni
 * URLs de instancia (I-3). El problema real es "medido en campo
 * 2026-09-25" (§1 del spec), sin identidad.
 *
 * ── Naturaleza RED esperada (§5 del spec, verificado acá) ────────────────
 *  · FALLAN por AssertionError, en el mecanismo y por la razón predicha:
 *      P1 (a/b/c) — hoy el control en celda NO lleva context de fila
 *        (undefined fuera de diálogo; [nombreDeDiálogo] dentro, P1c);
 *      P2 — hoy los checkboxes de filas distintas llevan el MISMO context
 *        (undefined, el caso medido en campo llevaba [diálogo]);
 *      P6 — hoy el control en tabla anidada NO lleva context.
 *  · PIN / anti-regresión — pasan YA en RED por diseño, con guarda de
 *      no-vacuidad (§5):
 *      P3 (a/b) — sin ancestro cell-like, cero regresión del walk
 *        group|region vigente (guarda: la 0b no puede disparar);
 *      P4 — las celdas promovidas del fixture base siguen emitiendo
 *        exactamente el context de hoy (guarda: existen 3 y no vacías);
 *      P5 (a/b) — el efecto se confina a la clave `context`, cero claves
 *        nuevas (guarda P5a: el testigo de afuera NUNCA gana context;
 *        guarda P5b: hay elementos con `context` ya hoy, cláusula 0a).
 *
 * Un rojo fuera de P1/P2/P6 —o en cualquier suite existente— es defecto
 * preexistente o inexactitud del spec §5: se reporta, no se dobla el test
 * (instrucción del orquestador; §5 del spec).
 *
 * ── Advertencia de fixture (misma que contenido-asociado §3) ─────────────
 * Con `elementFromPoint` inexistente en jsdom, `isBlocking` da true en cuanto
 * hay un `role=dialog`, y todo lo de afuera sale `inert:true`. El único
 * fixture con diálogo es el de P1c, y lo testeado está DENTRO del diálogo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

// ── Helpers (patrón de campo-selector-expands.test.js, reuso verbatim) ─────

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
/** Celdas promovidas por grid (§2.2 de fb-018-005): tag `td`. */
function celdas(frame) {
  return allElements(frame).filter((e) => e.tag === 'td');
}
/**
 * Oráculo independiente del nombre accesible de una fila: el texto de sus
 * celdas `<td>` normalizado y unido con un espacio (lo que el spec §3.2 P1a
 * describe: "computeAccessibleName(tr) normalizado", mismo valor que
 * `contenido-asociado.test.js` P6 mide sobre el mismo fixture). Se usa SÓLO
 * para guardas de fixture (P2: los textos difieren dentro del cap), nunca
 * como aserción principal — las aserciones usan literales del spec.
 */
function nombreDeFila(tr) {
  return Array.from(tr.children)
    .filter((c) => c.tagName === 'TD')
    .map((c) => c.textContent.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '')
    .join(' ');
}

// ── Fixtures (§3.2 verbatim; I-3: datos inventados, sin identidad) ──────────

/** Fixture base §3.2: grilla simple con controles por fila (P1a/P2/P4/P5). */
const HTML_BASE =
  '<main><table>' +
  '<thead><tr><th>Ref</th><th>Socio</th></tr></thead>' +
  '<tbody>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td><td>Azure Interior</td></tr>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td><td>Deco Addict</td></tr>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00003</td><td>Gemini Furniture</td></tr>' +
  '</tbody></table></main>';

/**
 * P1b: texto de fila que supera `DEFAULT_MAX_CONTEXT_LENGTH` (120, I-2).
 * Una sola celda con texto, espacios simples: el nombre accesible de la fila
 * es exactamente este texto normalizado (el checkbox no aporta texto).
 */
const TEXTO_FILA_LARGO =
  'Registro de inventario con descripcion extendida que supera el tope de longitud del contexto de fila '.repeat(2).trim();

/**
 * Orden canónico de claves de ELEMENTO (§3.2 P5b; mismo listado que
 * `contenido-asociado.test.js` P18 y la whitelist de `inert-generico.test.js`
 * extendida por fb-018-005). Ninguna feature puede agregar una clave fuera
 * de este orden (enmienda 6 de fb-018-005: `context` es la única clave
 * afectada de este ciclo).
 */
const ORDEN_CANONICO = [
  'ref', 'role', 'name', 'tag', 'disabled', 'visible', 'inert',
  'clickable', 'context', 'options', 'value', 'checked', 'selected', 'expanded',
];
/** Claves de primer nivel del frame (§3.2 P5b; `dialog` sólo con diálogo activo). */
const CLAVES_FRAME = ['page', 'totalPages', 'sections', 'read', 'dialog', 'fingerprint'];

// ── P1 (T-jsdom, RED genuina): el control dentro de la celda hereda la fila ─

test('P1: un control dentro de una celda hereda el contexto de fila de su celda', async (t) => {
  await t.test('P1a: sobre el fixture base, el checkbox de la fila 1 lleva context [nombre accesible de su <tr>]', () => {
    const doc = makeDom(HTML_BASE);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const tr1 = doc.querySelectorAll('tbody tr')[0];
    const cb1 = emitidoPara(frame, root, tr1.querySelector('input'), 'checkbox de la fila 1');

    // Guarda de no-vacuidad (§3.2 P1a): el checkbox no aporta texto propio —
    // si aparece una etiqueta, viene de la FILA (rama 0b, D-1), no de él.
    assert.equal(cb1.name, '', 'guarda: el checkbox sigue sin name propio (name "")');
    assert.deepEqual(
      cb1.context,
      ['WH/IN/00001 Azure Interior'],
      'P1a (D-1): context = [computeAccessibleName(tr) normalizado] — el nombre accesible de la fila 1, ' +
        'igual que la celda promovida de esa fila (cláusula 0a). HOY (RED): el checkbox no es cell-like, ' +
        'no hay walk group|region con nombre en el fixture ⇒ sin context de fila. ' +
        `Recibido ${JSON.stringify(cb1)}`,
    );
  });

  await t.test('P1b: fila con nombre accesible > 120 caracteres ⇒ context[0] de 121 (slice(0,120) + "…"), cap intacto', () => {
    // Guarda de fixture: el texto de fila excede el cap DEFAULT_MAX_CONTEXT_LENGTH=120 (I-2).
    assert.ok(
      TEXTO_FILA_LARGO.length > 120,
      `guarda de fixture: el texto de fila (${TEXTO_FILA_LARGO.length} chars) debe superar 120`,
    );
    const html =
      '<main><table><tbody>' +
      `<tr><td><input type="checkbox"></td><td>${TEXTO_FILA_LARGO}</td></tr>` +
      '</tbody></table></main>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const cb = emitidoPara(frame, root, doc.querySelector('tbody tr td input'), 'checkbox de la fila larga');

    // Guarda de no-vacuidad: el context tiene que estar presente y no vacío
    // antes de medir el truncado — HOY no lo está (RED).
    assert.ok(
      Array.isArray(cb.context) && cb.context.length > 0,
      'P1b: el checkbox de la fila larga debe llevar context; recibido ' + JSON.stringify(cb),
    );
    assert.equal(
      cb.context[0].length,
      121,
      'P1b (I-2): 120 chars + "…" (U+2026) = 121 — el cap de longitud del payload queda intacto, ' +
        'aplicado como hoy (por el final)',
    );
    assert.equal(
      cb.context[0],
      TEXTO_FILA_LARGO.slice(0, 120) + '…',
      'P1b (I-2): truncado por el final con "…", sin relajar el cap vigente',
    );
  });

  await t.test('P1c: tabla cruzada en diálogo activo ⇒ context [nombreDiálogo, encabezadoFila, encabezadoColumna] (3 entradas, cap 3)', () => {
    // Tabla CRUZADA (th[scope=row] + th de columna, patrón HTML_PIVOT de
    // contenido-asociado) dentro de un diálogo activo: el orden de etiquetas
    // conserva [dialogName] primero, más externo (D-1). Con 3 entradas el cap
    // DEFAULT_MAX_CONTEXT_ENTRIES=3 se cumple SIN relajarlo: todas conservadas.
    const html =
      '<div role="dialog"><h4>Agregar registros</h4>' +
      '<table>' +
      '<thead><tr><th></th><th>Ene</th><th>Feb</th></tr></thead>' +
      '<tbody>' +
      '<tr><th scope="row">Ropa</th><td><input type="checkbox"></td><td>20</td></tr>' +
      '</tbody></table>' +
      '</div>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    assert.ok(frame.dialog, 'precondición (patrón P17 de contenido-asociado): hay diálogo activo');
    assert.equal(
      frame.dialog.name,
      'Agregar registros',
      'precondición: dialog.name sale del primer heading (fb-018-004 P6)',
    );
    const cb = emitidoPara(frame, root, doc.querySelector('tbody td input'), 'input de la fila Ropa, columna Ene');

    // Guarda: HOY el input ya lleva el context del diálogo (caso medido en
    // campo: context:["<nombre del diálogo>"]) — esta guarda pasa hoy y
    // deja ver, en el fallo de abajo, exactamente qué le falta.
    assert.ok(
      Array.isArray(cb.context) && cb.context.length >= 1,
      'P1c guarda: el input del diálogo lleva context (hoy [nombreDiálogo]); recibido ' + JSON.stringify(cb),
    );
    assert.deepEqual(
      cb.context,
      ['Agregar registros', 'Ropa', 'Ene'],
      'P1c (D-1 + I-2): [nombreDiálogo, encabezadoFila, encabezadoColumna] = 3 entradas, ' +
        'todas conservadas (cap 3, las más internas). HOY (RED): sólo ["Agregar registros"] — sin la fila. ' +
        `Recibido ${JSON.stringify(cb.context)}`,
    );
  });
});

// ── P2 (T-jsdom, RED genuina): filas distintas ⇒ context distintos ─────────

test('P2: el context de fila distingue filas — distintas para textos distintos, iguales para textos idénticos', async (t) => {
  await t.test('P2 (filas distintas): los checkboxes de la fila 1 y la fila 2 emiten context DISTINTOS', () => {
    const doc = makeDom(HTML_BASE);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const filas = doc.querySelectorAll('tbody tr');
    const cb1 = emitidoPara(frame, root, filas[0].querySelector('input'), 'checkbox fila 1');
    const cb2 = emitidoPara(frame, root, filas[1].querySelector('input'), 'checkbox fila 2');

    // Guarda de fixture (acotación honesta del spec, AP-015): la garantía vale
    // para textos que difieren DENTRO de los primeros 120 caracteres — el
    // fixture base cumple (WH/IN/00001… vs WH/IN/00002… difieren del char 9).
    // La colisión post-cap NO es garantía de este ciclo (mide la sonda §7).
    assert.notEqual(
      nombreDeFila(filas[0]).slice(0, 120),
      nombreDeFila(filas[1]).slice(0, 120),
      'guarda de fixture: los textos de fila difieren dentro de los primeros 120 caracteres',
    );

    assert.notDeepEqual(
      cb1.context,
      cb2.context,
      'P2: filas con texto distinto (dentro del cap) ⇒ context distintos — sin esto el agente no puede ' +
        'elegir un registro sin contar su posición (inferencia posicional, §1 del spec). ' +
        `HOY (RED): ambos llevan el mismo context (${JSON.stringify(cb1.context)} vs ${JSON.stringify(cb2.context)}; ` +
        'el caso medido en campo llevaba [nombre del diálogo])',
    );
  });

  await t.test('P2 (caso compañero): dos filas con texto de fila IDÉNTICO emiten context IGUAL', () => {
    // El spec lo declara permitido (no es error): la garantía de P2 es
    // distinción por TEXTO, no unicidad de context por checkbox.
    const html =
      '<main><table><tbody>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00009</td><td>Deco Addict</td></tr>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00009</td><td>Deco Addict</td></tr>' +
      '</tbody></table></main>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const filas = doc.querySelectorAll('tbody tr');
    const cbA = emitidoPara(frame, root, filas[0].querySelector('input'), 'checkbox fila repetida 1');
    const cbB = emitidoPara(frame, root, filas[1].querySelector('input'), 'checkbox fila repetida 2');

    // En RED este compañero pasa trivialmente (ambos sin context); su trabajo
    // empieza en GREEN, donde P1a ya garantiza que el checkbox de celda lleva
    // context: este subtest fija que para textos IGUALES el resultado es IGUAL.
    assert.deepEqual(
      cbA.context,
      cbB.context,
      'P2 (caso compañero): textos de fila idénticos ⇒ context iguales (no se exige unicidad por checkbox)',
    );
  });
});

// ── P3 (T-jsdom, PIN verde-en-RED): sin ancestro cell-like, cero regresión ─

test('P3: sin ancestro cell-like, el comportamiento vigente queda intacto', async (t) => {
  await t.test('P3a: input en role=region con nombre, FUERA de toda tabla ⇒ context ["Filtros"] exacto', () => {
    const html = '<main><div role="region" aria-label="Filtros"><input type="checkbox" id="f"></div></main>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    // Guarda de no-vacuidad (§5): sin tabla en el fixture, la rama 0b no puede
    // disparar (closestGridRoot null) — este PIN aísla el walk group|region.
    assert.equal(doc.querySelector('table'), null, 'guarda de no-vacuidad: el fixture no tiene tabla');
    const el = emitidoPara(frame, root, doc.getElementById('f'), 'input dentro de la region Filtros');
    assert.deepEqual(
      el.context,
      ['Filtros'],
      'P3a: el walk group|region vigente queda intacto — el input conserva exactamente su context actual',
    );
  });

  await t.test('P3b: input dentro de un <th> no hereda la fila (th no es cell-like) — cae al walk vigente', () => {
    // Pin del discriminante de D-3: `isCellLike` no matchea <th>, así que un
    // control dentro de un th no hereda nada por la rama 0b y cae al walk
    // group|region vigente. El walk tiene que encontrar la region "Selecciones"
    // (mismo mecanismo que P3a) — sin la region el PIN sería verde vacuo.
    const html =
      '<main><div role="region" aria-label="Selecciones"><table>' +
      '<thead><tr><th>Ref</th><th><input type="checkbox" id="sel"></th></tr></thead>' +
      '<tbody><tr><td><input type="checkbox"></td><td>WH/IN/00001</td><td>Azure Interior</td></tr></tbody>' +
      '</table></div></main>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    // Guarda de no-vacuidad: el input está DENTRO de una tabla (con filas con
    // texto en el cuerpo): si la 0b disparara para el th, el context ganaría
    // etiqueta de fila y este PIN la detectaría.
    assert.ok(doc.querySelector('table'), 'guarda: el input del th está dentro de una tabla');
    const el = emitidoPara(frame, root, doc.getElementById('sel'), 'input dentro del th');
    assert.deepEqual(
      el.context,
      ['Selecciones'],
      'P3b (D-3): th no es cell-like ⇒ sin etiqueta de fila; cae al walk group|region vigente y encuentra ' +
        'la region con nombre. Comportamiento actual intacto, hoy y tras la 0b',
    );
  });
});

// ── P4 (T-jsdom, PIN verde-en-RED): cláusula 0a intacta ──────────────────────

test('P4: las celdas <td> promovidas del fixture base siguen emitiendo EXACTAMENTE el mismo context que hoy', () => {
  // Redundante con contenido-asociado.test.js P6 A PROPÓSITO (§3.2): guarda
  // contra un implementer que mueva la rama isCellLike(el) (cláusula 0a)
  // en vez de AGREGAR la 0b — la celda promovida de cada fila tiene que
  // seguir con su context de fila byte-idéntico.
  const doc = makeDom(HTML_BASE);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const promovidas = celdas(frame);
  assert.equal(
    promovidas.length,
    3,
    'guarda de no-vacuidad (§5): las celdas promovidas existen (una por fila de cuerpo)',
  );
  assert.deepEqual(
    promovidas.map((e) => e.name),
    ['WH/IN/00001', 'WH/IN/00002', 'WH/IN/00003'],
    'identidad de las promovidas: la primera celda con texto de cada fila (como hoy)',
  );
  for (const c of promovidas) {
    assert.ok(
      Array.isArray(c.context) && c.context.length > 0,
      `guarda de no-vacuidad (§5): la celda promovida ${c.ref} lleva context no vacío (ya hoy)`,
    );
  }
  assert.deepEqual(
    promovidas.map((e) => e.context),
    [
      ['WH/IN/00001 Azure Interior'],
      ['WH/IN/00002 Deco Addict'],
      ['WH/IN/00003 Gemini Furniture'],
    ],
    'P4 (I-4): la cláusula 0a queda intacta — exactamente el mismo context de celda que hoy',
  );
});

// ── P5 (T-jsdom, PIN): única fuente de context, cero claves nuevas ───────────

test('P5: el efecto del mecanismo se confina a la clave context — cero claves nuevas', async (t) => {
  await t.test('P5a: checkbox en celda vs checkbox idéntico fuera de toda tabla ⇒ idénticos salvo context (y ref)', () => {
    // Fixture base + testigo: el MISMO checkbox (mismos atributos) fuera de
    // toda tabla. Lo único que puede diferir entre los dos elementos emitidos
    // es `context` (y el `ref`, que codifica la posición). name, role, value,
    // checked, disabled… intactos (I-1: una sola fuente de context).
    const html =
      '<main><table>' +
      '<thead><tr><th>Ref</th><th>Socio</th></tr></thead>' +
      '<tbody>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td><td>Azure Interior</td></tr>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td><td>Deco Addict</td></tr>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00003</td><td>Gemini Furniture</td></tr>' +
      '</tbody></table>' +
      '<input type="checkbox" id="fuera">' +
      '</main>';
    const doc = makeDom(html);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const enCelda = emitidoPara(frame, root, doc.querySelector('tbody tr td input'), 'checkbox dentro de la celda');
    const fuera = emitidoPara(frame, root, doc.getElementById('fuera'), 'checkbox testigo fuera de toda tabla');
    // Guarda de fixture: el testigo está fuera de toda tabla.
    assert.equal(
      doc.getElementById('fuera').closest('table'),
      null,
      'guarda de fixture: el testigo no tiene ancestro tabla',
    );
    // Guarda de no-vacuidad (§5, "el de afuera no"): el testigo de afuera
    // NUNCA gana context — ni hoy ni con la 0b. La mitad "el de la celda
    // efectivamente gana context" es la postcondición P1a (RED genuino);
    // P5a aísla que NADA MÁS que `context` puede diferir entre los dos.
    assert.equal(
      fuera.context,
      undefined,
      'P5a guarda de no-vacuidad: el testigo fuera de toda tabla nunca lleva context',
    );

    const claves = new Set(
      [...Object.keys(enCelda), ...Object.keys(fuera)].filter((k) => k !== 'ref' && k !== 'context'),
    );
    for (const k of claves) {
      assert.deepEqual(
        enCelda[k],
        fuera[k],
        `P5a (I-1/enmienda 6): la clave '${k}' queda intacta — checkboxes idénticos en atributos difieren ` +
          'sólo en context (y en el ref de posición). ' +
          `enCelda=${JSON.stringify(enCelda[k])} fuera=${JSON.stringify(fuera[k])}`,
      );
    }
  });

  await t.test('P5b: ninguna clave nueva — orden canónico de elemento y claves de frame vigentes', () => {
    const doc = makeDom(HTML_BASE);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const elementos = allElements(frame);
    // Guarda de no-vacuidad (§5): hay elementos con `context` ya hoy (las
    // celdas promovidas, cláusula 0a) — sin esto el chequeo de orden no
    // probaría nada sobre la clave que este ciclo toca.
    const conContext = elementos.filter((e) => 'context' in e);
    assert.ok(
      conContext.length >= 3,
      'guarda de no-vacuidad: hay celdas promovidas con context (ya hoy, cláusula 0a)',
    );
    for (const el of conContext) {
      assert.ok(el.context.length > 0, `guarda: ${el.ref}: context no vacío (I-2 de fb-018-005)`);
    }
    for (const el of elementos) {
      assert.deepEqual(
        Object.keys(el),
        ORDEN_CANONICO.filter((k) => k in el),
        `P5b (I-1/enmienda 6): ${el.ref} no agrega ninguna clave fuera del orden canónico (subconjunto del ` +
          'orden y en el orden) — context sigue siendo la única clave que este ciclo afecta',
      );
    }
    assert.deepEqual(
      Object.keys(frame),
      CLAVES_FRAME.filter((k) => k in frame),
      'P5b: las claves de primer nivel del frame son las vigentes (dialog sólo con diálogo activo) — cero claves nuevas',
    );
  });
});

// ── P6 (T-jsdom, RED genuina): grid anidado toma SU fila ────────────────────

test('P6: un checkbox en una tabla ANIDADA hereda la fila de SU tabla, no la de la exterior', () => {
  // D-2: el ancestro cell-like más cercano pertenece al mismo
  // closestGridRoot del control — un control en una tabla anidada no puede
  // subir por encima de su propia tabla a heredar la fila exterior.
  const html =
    '<main><table><tbody>' +
    '<tr>' +
    '<td><table><tbody>' +
    '<tr><td><input type="checkbox"></td><td>WH/IN/00010</td><td>Socio interior</td></tr>' +
    '</tbody></table></td>' +
    '<td>EXTERIOR-A</td>' +
    '</tr>' +
    '</tbody></table></main>';
  const doc = makeDom(html);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const cb = emitidoPara(frame, root, doc.querySelector('table table input'), 'checkbox de la tabla interior');

  // Guarda de no-vacuidad: HOY el control en tabla anidada no lleva context (RED).
  assert.ok(
    Array.isArray(cb.context) && cb.context.length > 0,
    'P6: el checkbox de la tabla anidada debe llevar context; recibido ' + JSON.stringify(cb),
  );
  assert.deepEqual(
    cb.context,
    ['WH/IN/00010 Socio interior'],
    'P6 (D-2): context = fila de la tabla INTERIOR (su grid más cercano), igual que la celda promovida ' +
      'de esa fila interior. Recibido ' + JSON.stringify(cb.context),
  );
  for (const etiqueta of cb.context) {
    assert.ok(
      !etiqueta.includes('EXTERIOR'),
      `P6 (D-2): ninguna etiqueta de la fila exterior puede colarse en el context del control interior ` +
        `(recibido ${JSON.stringify(cb.context)})`,
    );
  }
});
