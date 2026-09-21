/**
 * contenido-asociado.test.js — fb-018-005 "contenido asociado a su elemento"
 * (sub-fase 3.1 RED).
 *
 * Spec: docs/specs/fb-018-005-contenido-asociado/spec.md (29 postcondiciones:
 * P1, P1b, P2..P11, P11b, P12..P14, P14b, P15, P15b, P16..P22, y —enmienda 9,
 * orden de emisión— P23, P23b, P23c(a) y P23c(b)).
 *
 * Convención de fixtures (§3 del spec): jsdom sin stub de layout salvo mención.
 * ADVERTENCIA DE FIXTURE, medida y obligatoria: con `elementFromPoint`
 * inexistente en jsdom, `isBlocking` devuelve `true` en cuanto hay un
 * `role=dialog`, y TODO lo de afuera sale `inert:true`. Por eso ningún fixture
 * de esta suite incluye diálogo salvo los de P16/P17, y en ésos el contenido
 * testeado está DENTRO del diálogo.
 *
 * Beneficio de la duda aplicado (test-audit.md §7): P2 reusa el patrón de
 * round-trip de `stability.test.js` PC3; P20 reusa el patrón de testigos de
 * mutación + lista cerrada de opciones de `payload-efficiency.test.js` P5b/P6;
 * P21 reusa el patrón de contador de `inert-generico.test.js:821`; I-D no se
 * re-testea (ya cubierto en cuatro regímenes: serializer PC10, estado-observable
 * P20, dialogo-inerte P19, inert-generico P18).
 *
 * NO-VACUIDAD: la mayoría de las postcondiciones de esta feature son de la
 * forma "X no se promueve" / "Y no aparece en read[]", que hoy —sin
 * implementación— se cumplen trivialmente. Cada uno de esos tests lleva una
 * GUARDA DE NO-VACUIDAD explícita que exige que el mecanismo haya corrido. Sin
 * esa guarda serían verdes vacuos y el gate de RED sería una mentira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';
import { performAction } from './act.js';
// Oráculo independiente para I-5: la MISMA librería que el contrato nombra en
// §6 (html-aam vía dom-accessibility-api), no una reimplementación del test.
import { getRole } from 'dom-accessibility-api';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function serialized(html, options) {
  return serializeFrame(makeDom(html).body, options);
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}
function byTag(frame, tag) {
  return allElements(frame).find((e) => e.tag === tag);
}
function byName(frame, name) {
  return allElements(frame).find((e) => e.name === name);
}
/** Celdas promovidas por §2.2 (grid): tag `td`. */
function celdas(frame) {
  return allElements(frame).filter((e) => e.tag === 'td');
}
/** Elementos promovidos por §2.4.2 (presentación). */
function clickables(frame) {
  return allElements(frame).filter((e) => e.clickable === true);
}
/** Conjunto de refs promovidos por CUALQUIERA de los dos mecanismos (P19). */
function refsPromovidos(frame) {
  return new Set([...celdas(frame), ...clickables(frame)].map((e) => e.ref));
}
function readText(frame) {
  return (frame.read || []).join('\n');
}

/** Tabla de datos simple (caso 1 del spec: vista de lista de Odoo). */
const HTML_LISTA =
  '<main><table>' +
  '<thead><tr><th>Ref</th><th>Socio</th></tr></thead>' +
  '<tbody>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td><td>Azure Interior</td></tr>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td><td>Deco Addict</td></tr>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00003</td><td>Gemini Furniture</td></tr>' +
  '</tbody></table></main>';

/** Tabla cruzada 2×2 (caso 2 del spec: pivot). §2.2.2: `th[scope=row]`. */
const HTML_PIVOT =
  '<main><table>' +
  '<thead><tr><th></th><th>Ene</th><th>Feb</th></tr></thead>' +
  '<tbody>' +
  '<tr><th scope="row">Ropa</th><td>10</td><td>20</td></tr>' +
  '<tr><th scope="row">Muebles</th><td>30</td><td>40</td></tr>' +
  '</tbody></table></main>';

/** N tarjetas sin rol con `cursor` gobernado por HOJA DE ESTILO (§2.4.2/P8). */
function htmlTarjetas(n, cursor) {
  let h = `<style>.card { cursor: ${cursor}; }</style><main>`;
  for (let i = 0; i < n; i++) {
    h += `<div class="card"><h3>Ropa${i}</h3><p>Varios colores</p></div>`;
  }
  return h + '</main>';
}

// ── Promoción de grid (§2.2) ────────────────────────────────────────────────

test('P1: tabla simple de N filas con al menos una celda sin candidatos ⇒ N elementos nuevos, role "cell", tag "td"', () => {
  const frame = serialized(HTML_LISTA);
  const promovidas = celdas(frame);
  assert.equal(promovidas.length, 3, 'una celda promovida por cada una de las 3 filas de cuerpo (§2.2.3, simple)');
  for (const el of promovidas) {
    assert.equal(el.role, 'cell', `${el.ref}: role implícito de html-aam para <td>`);
    assert.equal(el.tag, 'td', `${el.ref}: el tag real es td`);
  }
  // Las filas de ENCABEZADO no aportan celdas promovidas (§2.2.1: "fila de cuerpo").
  assert.equal(
    allElements(frame).filter((e) => e.tag === 'th').length,
    0,
    'los <th> del thead no son celdas elegibles',
  );
});

test('P1b: una fila cuyas celdas contienen TODAS algún candidato no aporta elemento promovido; su texto sigue en read[]', () => {
  const html =
    '<main><table><tbody>' +
    '<tr><td>Pendiente <button>Editar</button></td><td><a href="/x">Abrir</a></td></tr>' +
    '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td></tr>' +
    '</tbody></table></main>';
  const frame = serialized(html);
  const promovidas = celdas(frame);
  // Guarda de no-vacuidad: la SEGUNDA fila sí aporta. Sin esto el test sería
  // verde vacuo (hoy no se promueve nada).
  assert.equal(promovidas.length, 1, 'exactamente una celda promovida: sólo la fila 2 tiene celda elegible');
  assert.equal(promovidas[0].name, 'WH/IN/00002', 'la promovida es la celda identificatoria de la fila 2');
  // La correspondencia fila↔elemento es INYECTIVA, no total (§2.2, P1b).
  assert.ok(
    readText(frame).includes('Pendiente'),
    'el texto propio de la fila no promovida sigue en read[] (I-A): la promoción nunca filtra',
  );
});

test('P2: el ref de una celda promovida resuelve por resolveRef al MISMO nodo <td> (identidad, patrón de stability PC3)', () => {
  const doc = makeDom(HTML_LISTA);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const promovidas = celdas(frame);
  assert.equal(promovidas.length, 3, 'no-vacuidad: hay celdas promovidas para round-trippear');
  const esperados = new Map(
    Array.from(doc.querySelectorAll('tbody tr')).map((tr) => [
      tr.querySelectorAll('td')[1].textContent.trim(),
      tr.querySelectorAll('td')[1],
    ]),
  );
  for (const el of promovidas) {
    const nodo = resolveRef(el.ref, root);
    assert.equal(
      nodo,
      esperados.get(el.name),
      `${el.ref}: resolveRef devuelve el MISMO nodo <td> del que se derivó el ref (identidad, no igualdad de texto)`,
    );
  }
});

test('P3: performAction(resolveRef(ref promovido), "click") dispara el handler del <td>; el mismo click sobre el <tr> NO', () => {
  const doc = makeDom(HTML_LISTA);
  const root = doc.body;
  const tr = doc.querySelector('tbody tr');
  const td = tr.querySelectorAll('td')[1];
  let golpes = 0;
  td.addEventListener('click', () => golpes++);

  // Control medido (§8): el falso éxito de hoy — el handler vive en la celda.
  tr.click();
  assert.equal(golpes, 0, 'precondición medida: el click sobre el <tr> NO alcanza el handler del <td>');

  const frame = serializeFrame(root, {});
  const promovida = byName(frame, 'WH/IN/00001');
  assert.ok(promovida, 'no-vacuidad: la celda identificatoria de la fila 1 tiene que estar promovida');
  const res = performAction(resolveRef(promovida.ref, root), 'click');
  assert.deepEqual(res, { ok: true }, 'act despacha sobre la celda como sobre cualquier otro Element');
  assert.equal(golpes, 1, 'el ref promovido despacha sobre el nodo que TIENE el handler (§2.2.6)');
});

test('P4: una celda que contiene input[type=checkbox] no se promueve; la promovida es la primera celda sin candidatos', () => {
  const frame = serialized(HTML_LISTA);
  const promovidas = celdas(frame);
  assert.equal(promovidas.length, 3, 'no-vacuidad: la promoción de grid corrió');
  assert.deepEqual(
    promovidas.map((e) => e.name),
    ['WH/IN/00001', 'WH/IN/00002', 'WH/IN/00003'],
    'se saltea la celda del checkbox (§2.2.1) y se toma la primera celda elegible en orden de documento',
  );
  // I-B: el candidato interno sigue emitiéndose, la promoción no lo reemplaza.
  assert.equal(
    allElements(frame).filter((e) => e.role === 'checkbox').length,
    3,
    'los checkboxes siguen emitidos: la promoción nunca suprime un candidato (I-B)',
  );
});

/**
 * Markup real de la lista de Contactos de Odoo 19 (enmienda 7, E2E ronda 2):
 * `td:1` checkbox (excluida por §2.2.1), `td:2` celda de AVATAR —elegible pero
 * con texto propio vacío—, `td:3` el nombre del contacto. Con `alt=""` el
 * avatar es decorativo: no aporta nombre accesible ni nodos de texto, así que
 * la celda queda con texto propio vacío igual que en el DOM medido.
 */
const HTML_CONTACTOS =
  '<main><table><tbody>' +
  // Fila 1: la primera elegible es decorativa; la segunda identifica el registro.
  '<tr>' +
  '<td tabindex="-1"><input type="checkbox"></td>' +
  '<td tabindex="-1"><img src="/avatar.png" alt=""></td>' +
  '<td tabindex="-1">EMPRESA DEMO SA</td>' +
  '</tr>' +
  // Fila 2: NINGUNA elegible tiene texto propio ⇒ caso de fallback.
  '<tr>' +
  '<td tabindex="-1"><input type="checkbox"></td>' +
  '<td tabindex="-1"><img src="/avatar.png" alt=""></td>' +
  '<td tabindex="-1"><img src="/otro.png" alt=""></td>' +
  '</tr>' +
  '</tbody></table></main>';

test('P4b (enmienda 7, celda decorativa): se promueve la primera elegible CON TEXTO; sin ninguna, fallback a la primera', () => {
  const doc = makeDom(HTML_CONTACTOS);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const promovidas = celdas(frame);

  // La regla nueva elige CUÁL celda, no CUÁNTAS: la granularidad de §2.2.3
  // (una por fila) no se mueve. Si esto falla, la corrección tuvo un efecto
  // que el spec no previó y hay que parar, no ajustar el número.
  assert.equal(
    promovidas.length,
    2,
    'una celda por fila, igual que antes de la enmienda 7: la regla elige entre las ya elegibles, no cambia la granularidad',
  );

  // ── Mitad RED: la fila con celda decorativa primero ────────────────────────
  const fila1 = promovidas[0];
  assert.equal(
    fila1.name,
    'EMPRESA DEMO SA',
    'se promueve la primera celda elegible CON TEXTO PROPIO, no la de avatar: con la redacción anterior ' +
      'salían 81 de 81 celdas con name:"" en la lista de Contactos real (E2E ronda 2)',
  );
  assert.equal(
    fila1.ref,
    'main>table>tbody>tr:1>td:3',
    'el ref promovido es el de la TERCERA celda (la del nombre), no el de la segunda (el avatar)',
  );
  assert.equal(
    resolveRef(fila1.ref, root),
    doc.querySelectorAll('tbody tr')[0].querySelectorAll('td')[2],
    'identidad de nodo: el ref resuelve al <td> del nombre, no al del avatar (§2.2.6 sigue valiendo)',
  );

  // ── Mitad de anti-regresión: la fila enteramente decorativa ────────────────
  // Fallback de §2.2.3: si ninguna elegible tiene texto, se promueve la primera
  // igual. La fila NO puede aportar cero elementos: perder la direccionabilidad
  // de una fila decorativa sería un falso negativo (I-B).
  const fila2 = promovidas[1];
  assert.equal(
    resolveRef(fila2.ref, root),
    doc.querySelectorAll('tbody tr')[1].querySelectorAll('td')[1],
    'sin ninguna celda con texto, el fallback promueve la PRIMERA elegible (la del avatar)',
  );
  assert.equal(fila2.name, '', 'su name es vacío, que es exactamente lo que el fallback acepta a cambio de no perder el ref');

  // No-vacuidad del fallback: la fila decorativa aporta exactamente uno, no cero.
  const refsFila2 = promovidas.filter((e) => e.ref.includes('tr:2'));
  assert.equal(refsFila2.length, 1, 'la fila enteramente decorativa sigue aportando EXACTAMENTE un elemento (I-B)');
});

test('P5: tabla cruzada R×C con th[scope=row] y th de columna ⇒ R×C celdas, cada una con context [th_fila, th_columna]', () => {
  const frame = serialized(HTML_PIVOT);
  const promovidas = celdas(frame);
  assert.equal(promovidas.length, 4, 'R=2 filas × C=2 columnas de datos ⇒ 4 celdas promovidas (§2.2.3, cruzada)');
  const porNombre = Object.fromEntries(promovidas.map((e) => [e.name, e.context]));
  assert.deepEqual(porNombre['10'], ['Ropa', 'Ene'], 'fila 1, columna 1');
  assert.deepEqual(porNombre['20'], ['Ropa', 'Feb'], 'fila 1, columna 2');
  assert.deepEqual(porNombre['30'], ['Muebles', 'Ene'], 'fila 2, columna 1');
  assert.deepEqual(porNombre['40'], ['Muebles', 'Feb'], 'fila 2, columna 2');
});

test('P6: en tabla simple cada elemento promovido lleva context de UN elemento = nombre accesible de su <tr>', () => {
  const frame = serialized(HTML_LISTA);
  const promovidas = celdas(frame);
  assert.equal(promovidas.length, 3, 'no-vacuidad: la promoción de grid corrió');
  assert.deepEqual(
    promovidas.map((e) => e.context),
    [
      ['WH/IN/00001 Azure Interior'],
      ['WH/IN/00002 Deco Addict'],
      ['WH/IN/00003 Gemini Furniture'],
    ],
    'context = [computeAccessibleName(tr)] normalizado (§2.2.5, medido en §8)',
  );
});

test('P6b (enmienda 6, caso real de Odoo): <td tabindex="-1"> sin role emite una celda por fila, con context', () => {
  // Markup medido contra Odoo 19 real (§2.3 del spec): 722 <td>, 0 con `role`,
  // todos con tabindex="-1". Antes de la enmienda, [tabindex] sin discriminar
  // el valor negativo hacía que CADA celda entrara al mapa por el loop
  // principal (preemption del camino de grid) y NINGUNA llevara `context`.
  const html =
    '<main><table><tbody>' +
    '<tr><td tabindex="-1">WH/IN/00001</td><td tabindex="-1">Azure Interior</td></tr>' +
    '<tr><td tabindex="-1">WH/IN/00002</td><td tabindex="-1">Deco Addict</td></tr>' +
    '</tbody></table></main>';
  const frame = serialized(html);

  // Guarda de no-vacuidad / anti-regresión directa: con la especificación
  // anterior salían las 4 celdas (una por <td>) y NINGUNA con context. Si esto
  // se sigue viendo, la exclusión de tabindex="-1" no está aplicada.
  const tds = allElements(frame).filter((e) => e.tag === 'td');
  assert.equal(
    tds.length,
    2,
    'una celda POR FILA (granularidad simple, §2.2.3), no una por <td>: con [tabindex] sin discriminar salían 4',
  );
  assert.deepEqual(
    tds.map((e) => e.name),
    ['WH/IN/00001', 'WH/IN/00002'],
    'la promovida es la primera celda elegible en orden de documento, como con un <td> limpio',
  );
  assert.deepEqual(
    tds.map((e) => e.context),
    [['WH/IN/00001 Azure Interior'], ['WH/IN/00002 Deco Addict']],
    'context = [nombreDeFila] (§2.2.5): con la preemption vieja, context nunca se emitía en este markup',
  );
});

test('P6c (celda candidata por mérito propio, role="gridcell" explícito): un solo ref, y también lleva context', () => {
  // La celda es candidata por CANDIDATE_SELECTOR ([role]) y por lo tanto NUNCA
  // se promueve (§2.5 cláusula 0) — pero la cláusula unificada de contextFor le
  // asigna context de todos modos, por ser celda dentro de un subárbol de tabla,
  // sin importar la puerta de entrada. Verifica que §2.3/§2.5 son independientes
  // de si el elemento llegó por CANDIDATE_SELECTOR o por computeGridPromotions.
  const html =
    '<main><table><tbody>' +
    '<tr><td role="gridcell">WH/IN/00001</td><td>Azure Interior</td></tr>' +
    '</tbody></table></main>';
  const frame = serialized(html);

  // Guarda de no-vacuidad: ALGO con role="gridcell" tiene que estar presente.
  const conRoleExplicito = allElements(frame).filter((e) => e.role === 'gridcell');
  assert.ok(conRoleExplicito.length > 0, 'no-vacuidad: al menos un elemento con role="gridcell" se emite');

  // La aserción real: no puede haber DOS ELEMENTOS con el mismo ref (candidato
  // + celda promovida apuntando al mismo <td>). Un Set de refs NO alcanza para
  // detectar esto: los dos duplicados comparten literalmente el mismo string
  // de ref, así que un Set los colapsaría a tamaño 1 sin que la duplicación se
  // note. Hay que contar OCURRENCIAS por ref, no valores únicos.
  const refDeLaCelda = conRoleExplicito[0].ref;
  const ocurrencias = allElements(frame).filter((e) => e.ref === refDeLaCelda);
  assert.equal(
    ocurrencias.length,
    1,
    `un único ELEMENTO para el ref "${refDeLaCelda}" (§2.7 línea 245: "no se suprimen" — tampoco se duplican). ` +
      `Se emitió ${ocurrencias.length} veces: ${JSON.stringify(ocurrencias)}`,
  );
  const celda = conRoleExplicito[0];
  assert.deepEqual(
    celda.context,
    ['WH/IN/00001 Azure Interior'],
    'la celda candidata por mérito propio TAMBIÉN lleva context de fila (§2.5 cláusula 0), como si fuera promovida',
  );

  // La segunda celda de la fila (sin role) SÍ se promueve por grid, como caso
  // de control: las dos vías conviven en la misma fila sin pisarse.
  const promovida = celdas(frame).find((e) => e.name === 'Azure Interior');
  assert.ok(promovida, 'no-vacuidad: la celda sin role de la misma fila se promueve por el camino de grid');
  assert.deepEqual(promovida.context, ['WH/IN/00001 Azure Interior'], 'misma etiqueta de fila para las dos vías');
});

test('P6d (enmienda 8): la exclusión de tabindex="-1" está acotada a CELDAS — las tres direcciones', () => {
  // La enmienda 6 excluyó `tabindex="-1"` de forma GLOBAL. La enmienda 8 la
  // acota a celdas dentro de un subárbol table/grid/treegrid, que es donde el
  // camino de grid se hace cargo del elemento con granularidad y `context`.
  // Fuera de tablas no hay nada que se haga cargo: excluirlo es filtrar de más.
  const html =
    '<main>' +
    // (1) tabindex="0" fuera de tabla: entra, como siempre (P11).
    '<div tabindex="0"><h3>Positivo o cero</h3><p>sigue candidato</p></div>' +
    // (3) tabindex="-1" FUERA de toda tabla: el caso medido del falso negativo.
    // Sin role, sin href, sin onclick — el handler va por addEventListener, que
    // es justamente lo que lo hace indetectable desde el markup. Si la exclusión
    // lo alcanza, este elemento desaparece del mapa y el agente no puede siquiera
    // saber que existía.
    '<div tabindex="-1"><h3>Acción importante</h3><p>handler por addEventListener</p></div>' +
    // (2) tabindex="-1" en CELDA: no entra por la vía [tabindex]; lo emite grid.
    '<table><tbody>' +
    '<tr><td tabindex="-1">WH/IN/00001</td><td tabindex="-1">Azure Interior</td></tr>' +
    '</tbody></table>' +
    '</main>';
  const frame = serialized(html);
  const divs = allElements(frame).filter((e) => e.tag === 'div');

  // ── Dirección 1: tabindex="0" entra ───────────────────────────────────────
  // Referencia real ya medida (§2.4.1, §8.1): la tarjeta de kanban de Proyectos
  // lleva tabindex="0" y tiene que seguir siendo candidata.
  const positivo = divs.find((e) => e.name === 'Positivo o cero sigue candidato');
  assert.ok(positivo, 'dirección 1: el div con tabindex="0" entra al mapa (P11)');
  assert.equal(
    Object.prototype.hasOwnProperty.call(positivo, 'clickable'),
    false,
    'entra como candidato por ESTÁNDAR (focusability), no por inferencia: sin la clave `clickable`',
  );

  // ── Dirección 3 (enmienda 8, la que importa): tabindex="-1" FUERA de tabla ──
  // Es la anti-regresión del falso negativo. Sin ella, un elemento clickeable
  // desaparece INVISIBLEMENTE: no hay marcador, no hay entrada en read[] que lo
  // señale como accionable, y ninguna suite lo nota. Eso es I-B violado, que es
  // el lado que este contrato nunca acepta.
  const negativoFueraDeTabla = divs.find((e) => e.name === 'Acción importante handler por addEventListener');
  assert.ok(
    negativoFueraDeTabla,
    'dirección 3 (enmienda 8): un <div tabindex="-1"> FUERA de toda tabla SÍ entra al mapa. ' +
      'La exclusión de la enmienda 6 lo borraba, y lo borraba invisible: el agente no puede saber que existía. ' +
      `Divs emitidos: ${JSON.stringify(divs.map((e) => e.name))}`,
  );
  assert.equal(negativoFueraDeTabla.role, '', 'sin rol declarado ⇒ role ""');
  assert.equal(
    Object.prototype.hasOwnProperty.call(negativoFueraDeTabla, 'clickable'),
    false,
    'entra por la vía [tabindex] de PROMOTABLE_SELECTOR, no por inferencia de presentación',
  );

  // ── Dirección 2: tabindex="-1" en celda no entra por la vía [tabindex] ─────
  // Guarda de que la enmienda 8 no deshizo la 6: dentro de la tabla sigue
  // gobernando la granularidad de grid (una celda por fila), no una entrada
  // suelta por celda.
  const celdasEmitidas = celdas(frame);
  assert.equal(
    celdasEmitidas.length,
    1,
    'dirección 2: la tabla aporta UNA celda por fila (camino de grid, P6b), no una entrada por <td> vía [tabindex]',
  );
  assert.deepEqual(
    celdasEmitidas[0].context,
    ['WH/IN/00001 Azure Interior'],
    'y la emite el camino de grid, con su context de fila: la exclusión dentro de tablas sigue vigente',
  );

  // Ninguno de los dos divs se cuela por la promoción de presentación (§2.4.2):
  // no hay cursor:pointer en el fixture. Se deja explícito para que la dirección
  // 3 no pueda satisfacerse por la vía equivocada.
  assert.equal(
    clickables(frame).length,
    0,
    'ningún div entra por §2.4.2: sin cursor:pointer no hay corrida — la dirección 3 se cumple por [tabindex], no por inferencia',
  );
});

test('P7: tabla cruzada que excede maxPromotedCells degrada a una celda por fila y ningún texto desaparece de read[]', () => {
  const completo = serialized(HTML_PIVOT);
  assert.equal(celdas(completo).length, 4, 'no-vacuidad: con la cota por default se promueven las 4 celdas');

  const degradado = serialized(HTML_PIVOT, { maxPromotedCells: 3 });
  const promovidas = celdas(degradado);
  assert.equal(promovidas.length, 2, '4 celdas > cota 3 ⇒ la tabla degrada a granularidad simple: una por fila');
  assert.deepEqual(promovidas.map((e) => e.name), ['10', '30'], 'la primera celda elegible de cada fila');
  const texto = readText(degradado);
  for (const valor of ['20', '40']) {
    assert.ok(texto.includes(valor), `el texto de la celda no promovida "${valor}" sigue en read[] (I-A)`);
  }
});

// ── Promoción por presentación (§2.4) ───────────────────────────────────────

test('P8: tarjeta sin role/href/tabindex con cursor:pointer por hoja de estilo ⇒ exactamente un elemento clickable por tarjeta, raíz de corrida', () => {
  const doc = makeDom(htmlTarjetas(2, 'pointer'));
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const promovidos = clickables(frame);
  assert.equal(promovidos.length, 2, 'exactamente un elemento por tarjeta: cursor se HEREDA, sólo la raíz de corrida se promueve');
  for (const el of promovidos) {
    assert.equal(el.clickable, true, `${el.ref}: la marca de especialización va en el payload`);
    assert.equal(el.role, '', `${el.ref}: getRole(div sin rol) es null ⇒ role ""`);
    assert.equal(el.tag, 'div', `${el.ref}: tag real`);
  }
  const tarjetas = Array.from(doc.querySelectorAll('div.card'));
  assert.deepEqual(
    promovidos.map((e) => resolveRef(e.ref, root)),
    tarjetas,
    'el ref resuelve al div RAÍZ de la corrida — no a un descendiente (h3/p) ni a un ancestro (main)',
  );
});

test('P9: el name de un elemento promovido une los textos descendientes con UN espacio simple', () => {
  const frame = serialized(htmlTarjetas(1, 'pointer'));
  const promovidos = clickables(frame);
  assert.equal(promovidos.length, 1, 'no-vacuidad: la promoción por presentación corrió');
  assert.equal(
    promovidos[0].name,
    'Ropa0 Varios colores',
    'unión por espacio simple (§2.4.3): textContent crudo produce "Ropa0Varios colores" — medido en §8',
  );
});

test('P10: un elemento con cursor:pointer DENTRO de una tabla no se promueve por presentación, ni siendo raíz de corrida', () => {
  const html =
    '<style>tr { cursor: pointer; } .card { cursor: pointer; }</style>' +
    '<main><table><tbody>' +
    '<tr><td>WH/IN/00001</td><td>Azure Interior</td></tr>' +
    '</tbody></table>' +
    '<div class="card"><h3>Ropa</h3></div></main>';
  const doc = makeDom(html);
  const frame = serializeFrame(doc.body, {});
  // Guarda de no-vacuidad: el mecanismo de presentación SÍ corrió — la tarjeta
  // de afuera está promovida. Sin esto, "no hay <tr> promovido" sería vacuo.
  const promovidos = clickables(frame);
  assert.equal(promovidos.length, 1, 'no-vacuidad: la tarjeta fuera de la tabla sí se promueve por presentación');
  assert.equal(promovidos[0].tag, 'div', 'el único clickable es la tarjeta');
  assert.equal(
    allElements(frame).filter((e) => e.tag === 'tr').length,
    0,
    'la precedencia de grid (§2.3) impide promover el <tr>, que es la raíz de corrida medida en Bootstrap/Odoo',
  );
});

test('P11: [tabindex] / [onclick] / [contenteditable] sin role entran al mapa con role "", name derivado y SIN clave clickable', () => {
  const html =
    '<main>' +
    '<div tabindex="0"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '<div onclick="void 0"><h3>Muebles</h3><p>De roble</p></div>' +
    '<div contenteditable="true">Nota libre</div>' +
    '</main>';
  const frame = serialized(html);
  const divs = allElements(frame).filter((e) => e.tag === 'div');
  assert.equal(divs.length, 3, 'los tres entran al mapa por PROMOTABLE_SELECTOR (§2.4.1)');
  assert.deepEqual(
    divs.map((e) => e.name),
    ['Ropa Varios colores', 'Muebles De roble', 'Nota libre'],
    'name derivado por §2.4.3(b): computeAccessibleName devuelve "" para un div sin rol (medido)',
  );
  for (const el of divs) {
    assert.equal(el.role, '', `${el.ref}: sin rol declarado ⇒ role ""`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(el, 'clickable'),
      false,
      `${el.ref}: son candidatos POR ESTÁNDAR (focusability / event handler content attribute / editing), no inferencia`,
    );
  }
});

test('P11b (anti-regresión PC4 fb-017-001): un button/a/input SIN nombre accesible conserva su name actual — §2.4.3 no se le aplica', () => {
  const html =
    '<main>' +
    '<button><span>x</span></button>' +
    '<a href="/go"><span>y</span></a>' +
    '<div tabindex="0"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '</main>';
  const frame = serialized(html);
  // Guarda de no-vacuidad: la derivación de §2.4.3 SÍ está activa en el build.
  const div = byTag(frame, 'div');
  assert.ok(div, 'no-vacuidad: el div[tabindex] entra al mapa');
  assert.equal(div.name, 'Ropa Varios colores', 'no-vacuidad: la derivación de §2.4.3(b) está activa');

  // La cascada de nombres de fb-017-001 PC4 NO se mueve: button y a siguen
  // tomando su textContent por la regla vieja, no por la derivación nueva.
  assert.equal(byTag(frame, 'button').name, 'x', 'el <button> conserva la cascada de PC4 (textContent), sin unión por espacio nueva');
  assert.equal(byTag(frame, 'a').name, 'y', 'el <a href> conserva la cascada de PC4');
  const sinNombre = serialized('<main><input></main>');
  assert.equal(byTag(sinNombre, 'input').name, '', 'un input sin label/aria-label/placeholder sigue con name "" (PC4)');
});

test('P12: un elemento con cursor:pointer que CONTIENE un <button> no se promueve; el button sigue emitiéndose', () => {
  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    '<div class="card"><h3>Con botón</h3><button>Elegir</button></div>' +
    '<div class="card"><h3>Sin botón</h3><p>Varios colores</p></div>' +
    '</main>';
  const frame = serialized(html);
  const promovidos = clickables(frame);
  // No-vacuidad: la segunda tarjeta SÍ se promueve.
  assert.equal(promovidos.length, 1, 'sólo la tarjeta sin candidato adentro se promueve (§2.4.2 regla 5)');
  assert.equal(promovidos[0].name, 'Sin botón Varios colores', 'la promovida es la que no contiene candidatos');
  const boton = byTag(frame, 'button');
  assert.ok(boton, 'el <button> sigue emitiéndose como hoy (I-B: la promoción no suprime candidatos)');
  assert.equal(boton.name, 'Elegir');
});

test('P13: body o un landmark con cursor:pointer no se promueven, cualquiera sea su contenido', () => {
  const html =
    '<style>body, main { cursor: pointer; } .card { cursor: pointer; }</style>' +
    '<main><p>Texto de la vista</p></main>' +
    '<section><div class="card"><h3>Ropa</h3></div></section>';
  const doc = makeDom(html);
  const frame = serializeFrame(doc.body, {});
  const promovidos = clickables(frame);
  // No-vacuidad: la tarjeta de la <section> (que NO hereda pointer del body por
  // ser <section> un elemento sin la regla... hereda: por eso su padre section
  // NO es raíz y la tarjeta tampoco lo sería). Se exige explícitamente que el
  // mecanismo haya corrido sobre ALGO: el body es raíz de corrida y aun así
  // queda excluido, y `main` también.
  assert.equal(
    promovidos.filter((e) => ['body', 'html', 'main', 'section'].includes(e.tag)).length,
    0,
    'body/html/landmarks nunca se promueven (§2.4.2 regla 6): cota contra el contenedor gigante con cursor:pointer',
  );
  // Guarda de no-vacuidad, en un DOM hermano donde la corrida SÍ arranca en la tarjeta.
  const sano = serialized(htmlTarjetas(1, 'pointer'));
  assert.equal(clickables(sano).length, 1, 'no-vacuidad: el mecanismo de §2.4.2 está activo en este build');
});

// ── Claves de contenido (§2.6, §2.5) ────────────────────────────────────────

test('P14: un <select> con M opciones emite options con las M etiquetas en orden de documento, y value con la seleccionada', () => {
  const frame = serialized(
    '<select aria-label="Diario"><option value="a">Banco</option><option value="b" selected>Efectivo</option><option value="c">Cheque</option></select>',
  );
  const el = byTag(frame, 'select');
  assert.ok(el, 'el <select> se emite (no-vacuidad)');
  assert.deepEqual(el.options, ['Banco', 'Efectivo', 'Cheque'], 'etiquetas en orden de documento (§2.6)');
  assert.equal(el.value, 'Efectivo', '`value` sigue siendo la selección actual, sin cambios (fb-018-002 P4)');
});

test('P14b: con M > maxOptions, options.length === maxOptions + 1 y el marcador es la última entrada', () => {
  let opciones = '';
  for (let i = 0; i < 60; i++) opciones += `<option>Opcion-${i}</option>`;
  const frame = serialized(`<select aria-label="Muchas">${opciones}</select>`);
  const el = byTag(frame, 'select');
  assert.ok(el, 'el <select> se emite (no-vacuidad)');
  assert.equal(
    (el.options || []).length,
    51,
    'maxOptions default 50 ⇒ 50 etiquetas MÁS el marcador (mismo patrón que read[], que pinea cap+1 en mugre PC3)',
  );
  assert.equal(el.options[49], 'Opcion-49', 'las primeras maxOptions etiquetas son las primeras en orden de documento');
  const marcador = el.options[el.options.length - 1];
  const m = /^\[options truncado: (\d+) de (\d+) opciones\]$/.exec(marcador);
  assert.ok(m, `la última entrada es el marcador literal de §2.7; got ${JSON.stringify(marcador)}`);
  assert.equal(m[1], '50', 'grupo 1 = etiquetas emitidas (maxOptions)');
  assert.equal(m[2], '60', 'grupo 2 = total de <option>');
});

test('P15: el texto de las opciones de un <select> superviviente sale de read[]; si el select es filtrado, vuelve a read[] (I-A)', () => {
  const html = '<select><option>Alfa</option><option selected>Beta</option></select><button>Guardar</button>';
  const doc = makeDom(html);
  const root = doc.body;

  const completo = serializeFrame(root, {});
  const el = byTag(completo, 'select');
  assert.ok(el, 'no-vacuidad: el <select> sobrevive sin filtro');
  assert.deepEqual(el.options, ['Alfa', 'Beta'], 'no-vacuidad: el texto de las opciones viaja en el elemento');
  assert.ok(
    !readText(completo).includes('Alfa'),
    'el texto que ya viaja en `options` no se paga dos veces en read[] (§2.6, reversión de fb-018-002)',
  );

  const filtrado = serializeFrame(root, { roles: ['button'] });
  assert.ok(
    !allElements(filtrado).some((e) => e.tag === 'select'),
    'precondición: el <select> no sobrevive al filtro roles:["button"]',
  );
  assert.ok(
    readText(filtrado).includes('Alfa'),
    'unión DESPUÉS del filtro (patrón P7c de fb-018-001): un select descartado no borra sus opciones de read[] (I-A)',
  );
});

test('P15b: los nodos de texto consumidos por el name de un elemento promovido salen de read[]; filtrado, vuelven (I-A)', () => {
  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    '<div class="card"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '<button>Guardar</button></main>';
  const doc = makeDom(html);
  const root = doc.body;

  const completo = serializeFrame(root, {});
  const promovidos = clickables(completo);
  assert.equal(promovidos.length, 1, 'no-vacuidad: la tarjeta se promovió');
  assert.equal(promovidos[0].name, 'Ropa Varios colores', 'no-vacuidad: el name consumió los dos nodos de texto');
  const texto = readText(completo);
  for (const frag of ['Ropa', 'Varios colores']) {
    assert.ok(
      !texto.includes(frag),
      `"${frag}" ya viaja en el name del elemento promovido: sin esta regla se pagaría dos veces (§P15b)`,
    );
  }

  const filtrado = serializeFrame(root, { roles: ['button'] });
  assert.ok(
    clickables(filtrado).length === 0,
    'precondición: el elemento promovido (role "") no sobrevive al filtro roles:["button"]',
  );
  const textoFiltrado = readText(filtrado);
  for (const frag of ['Ropa', 'Varios colores']) {
    assert.ok(
      textoFiltrado.includes(frag),
      `"${frag}" vuelve a read[] cuando su elemento fue descartado por el filtro (unión después del filtro, I-A)`,
    );
  }
});

test('P16: role="alert" sin nombre accesible emite name con su texto normalizado, y ese texto no se duplica en read[]', () => {
  // El alert va DENTRO del diálogo por la advertencia de fixture de §3.
  const html =
    '<div role="dialog"><h4>Operación no válida</h4>' +
    '<div role="alert">Falta el diario.</div>' +
    '<button>Cerrar</button></div>';
  const frame = serialized(html);
  const alerta = allElements(frame).find((e) => e.role === 'alert');
  assert.ok(alerta, 'el elemento role=alert se emite (hoy sale con name "")');
  assert.equal(
    alerta.name,
    'Falta el diario.',
    'ARIA 1.2: alert/status/log NO son name-from-content, por eso hoy salen vacíos (§6)',
  );
  assert.ok(
    !readText(frame).includes('Falta el diario.'),
    'el texto no se duplica en read[] (maquinaria de dedup readNames ya existente — M4/mugre PC9)',
  );
});

test('P17: un elemento contenido en el diálogo activo lleva context cuyo primer elemento es dialog.name', () => {
  const html =
    '<div role="dialog"><h4>Operación no válida</h4>' +
    '<div role="alert">Falta el diario.</div>' +
    '<button>Cerrar</button></div>';
  const frame = serialized(html);
  assert.ok(frame.dialog, 'precondición: hay diálogo activo');
  assert.equal(frame.dialog.name, 'Operación no válida', 'precondición: dialog.name sale del primer heading (fb-018-004 P6)');
  const boton = byTag(frame, 'button');
  assert.ok(boton, 'el botón del diálogo se emite');
  assert.equal(
    (boton.context || [])[0],
    'Operación no válida',
    'context arranca con dialog.name cuando el elemento está contenido en el diálogo activo (§2.5.4)',
  );
});

// ── Invariantes de forma y presupuesto ──────────────────────────────────────

const ORDEN_CANONICO = [
  'ref', 'role', 'name', 'tag', 'disabled', 'visible', 'inert',
  'clickable', 'context', 'options', 'value', 'checked', 'selected', 'expanded',
];

test('P18: context/options nunca vacíos, clickable nunca false, y las claves en el orden canónico de §2.1', () => {
  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    '<table><tbody><tr><td>WH/IN/00001</td><td>Azure Interior</td></tr></tbody></table>' +
    '<div class="card"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '<select aria-label="Diario"><option>Banco</option><option selected>Efectivo</option></select>' +
    '<button>Guardar</button></main>';
  const frame = serialized(html);
  const elementos = allElements(frame);

  // No-vacuidad: las tres claves nuevas tienen que estar presentes en el frame,
  // si no el test de orden no probaría nada de esta feature.
  assert.equal(clickables(frame).length, 1, 'no-vacuidad: hay un elemento con `clickable`');
  assert.equal(celdas(frame).length, 1, 'no-vacuidad: hay una celda promovida (que lleva `context`)');
  assert.ok(
    elementos.some((e) => Array.isArray(e.options)),
    'no-vacuidad: hay un elemento con `options`',
  );

  for (const el of elementos) {
    const claves = Object.keys(el);
    assert.deepEqual(
      claves,
      ORDEN_CANONICO.filter((k) => claves.includes(k)),
      `${el.ref}: las claves salen en el orden canónico de §2.1 (determinismo del JSON, PC9 de fb-017-001)`,
    );
    if ('context' in el) assert.ok(el.context.length > 0, `${el.ref}: \`context\` nunca se emite vacío (I-2)`);
    if ('options' in el) assert.ok(el.options.length > 0, `${el.ref}: \`options\` nunca se emite vacío (I-2)`);
    if ('clickable' in el) assert.equal(el.clickable, true, `${el.ref}: \`clickable\` nunca se emite false (I-2)`);
  }
});

test('P19 (I-C): la decisión de promover es independiente del viewport — con stub de layout, sin él, y con los rects desplazados', () => {
  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    '<table><tbody><tr><td>WH/IN/00001</td><td>Azure Interior</td></tr></tbody></table>' +
    '<div class="card"><h3>Ropa</h3><p>Varios colores</p></div></main>';

  /**
   * Stub de layout con offset constante. jsdom NO implementa window.scrollTo y
   * pinea scrollY en 0 (medido): assertear sobre scroll real sería verde vacua
   * (G-2 del audit), así que el desplazamiento se modela desplazando el
   * conjunto de rects, que es lo observable equivalente.
   */
  function conLayout(offset) {
    const doc = makeDom(html);
    const win = doc.defaultView;
    Object.defineProperty(win, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
    let i = 0;
    win.Element.prototype.getBoundingClientRect = function () {
      const top = offset + (i++ % 5) * 60;
      return { x: 10, y: top, width: 200, height: 40, left: 10, top, right: 210, bottom: top + 40, toJSON() {} };
    };
    doc.elementFromPoint = () => null;
    return serializeFrame(doc.body, {});
  }

  const crudo = serializeFrame(makeDom(html).body, {});
  const conStub = conLayout(0);
  const desplazado = conLayout(4000);

  const refsCrudo = refsPromovidos(crudo);
  assert.ok(refsCrudo.size > 0, 'no-vacuidad: sin stub de layout ya hay elementos promovidos');
  assert.equal(refsCrudo.size, 2, 'la celda de la fila y la tarjeta (§2.7: la pasada de promoción no lee geometría)');

  assert.deepEqual(
    [...refsPromovidos(conStub)].sort(),
    [...refsCrudo].sort(),
    'el conjunto de refs promovidos no cambia al haber layout (igualdad de CONJUNTOS, no de payload)',
  );
  assert.deepEqual(
    [...refsPromovidos(desplazado)].sort(),
    [...refsCrudo].sort(),
    'ni al desplazar todos los rects por un offset constante: la promoción es función pura del DOM (I-C)',
  );
});

test('P20 (I-C extendida): el fingerprint cambia con context/options/clickable y no cambia con page/roles/namedOnly/maxElementsPerPage', () => {
  const base =
    '<main>' +
    '<div class="card"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '<select aria-label="Diario"><option>Banco</option><option selected>Efectivo</option></select>' +
    '<button>Guardar</button></main>';

  // Testigo `clickable`: el DOM sólo difiere en la regla de presentación.
  const sinCorrida = serialized('<style>.card { cursor: auto; }</style>' + base);
  const conCorrida = serialized('<style>.card { cursor: pointer; }</style>' + base);
  assert.equal(typeof sinCorrida.fingerprint, 'string', 'precondición: serializeFrame devuelve la huella');
  assert.equal(clickables(sinCorrida).length, 0, 'precondición: sin corrida de cursor no hay promoción');
  assert.equal(clickables(conCorrida).length, 1, 'no-vacuidad: con la corrida sí la hay');
  assert.notEqual(
    conCorrida.fingerprint,
    sinCorrida.fingerprint,
    'la aparición de `clickable` es un cambio observable del contrato ⇒ la huella tiene que moverse (I-B)',
  );

  // Testigo `options`: agregar una <option> cambia el contenido asociado.
  const masOpciones = serialized(
    '<style>.card { cursor: pointer; }</style>' +
      base.replace('<option>Banco</option>', '<option>Banco</option><option>Cheque</option>'),
  );
  assert.notEqual(masOpciones.fingerprint, conCorrida.fingerprint, 'un cambio en `options` mueve la huella');

  // Testigo `context`: cambiar el nombre accesible de la fila cambia el context.
  const tabla = '<main><table><tbody><tr><td>WH/IN/00001</td><td>%S%</td></tr></tbody></table></main>';
  const ctxA = serialized(tabla.replace('%S%', 'Azure Interior'));
  const ctxB = serialized(tabla.replace('%S%', 'Deco Addict'));
  assert.equal(celdas(ctxA).length, 1, 'no-vacuidad: hay celda promovida con context');
  assert.notEqual(ctxB.fingerprint, ctxA.fingerprint, 'un cambio en `context` mueve la huella');

  // Independencia de la query (lista cerrada de §2.3 de fb-018-001, patrón P5b).
  const doc = makeDom('<style>.card { cursor: pointer; }</style>' + base);
  const referencia = serializeFrame(doc.body, {}).fingerprint;
  const variantes = [
    { page: 1 },
    { page: 2, maxElementsPerPage: 1 },
    { maxElementsPerPage: 1 },
    { roles: ['button'] },
    { namedOnly: true },
    { page: 2, maxElementsPerPage: 2, roles: ['button'], namedOnly: true },
  ];
  for (const opciones of variantes) {
    assert.equal(
      serializeFrame(doc.body, opciones).fingerprint,
      referencia,
      `ninguna opción de query puede mover la huella, tampoco con las claves nuevas: ${JSON.stringify(opciones)}`,
    );
  }
});

test('P20b (I-C, hueco de la lista cerrada): el fingerprint no cambia al variar maxValueLength ni ninguna otra opción de forma', () => {
  // El `name` de un elemento promovido se DERIVA (§2.4.3) y se trunca a
  // `maxValueLength`. Si la huella se computa sobre el `name` ya truncado, una
  // opción de QUERY termina moviendo el fingerprint sin que cambie nada del
  // contenido observable: `changedSinceLast` daría true y el agente releería un
  // mapa idéntico. Es la falla H5 que fb-018-001 vino a arreglar.
  //
  // P20 enumera page/roles/namedOnly/maxElementsPerPage siguiendo el spec, que
  // tenía la lista incompleta: I-C dice "independiente de la QUERY" y
  // `maxValueLength` es una opción de query como cualquier otra. P20b cierra el
  // hueco con la lista cerrada COMPLETA de §2.3 de fb-018-001 (misma que pinea
  // payload-efficiency P5b), sobre un DOM donde el truncado efectivamente muerde.
  const largoCelda = 'Recepcion-'.repeat(40); // 400 chars
  const largoTarjeta = 'Ropa-'.repeat(80); // 400 chars
  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    `<table><tbody><tr><td>${largoCelda}</td><td>Azure Interior</td></tr></tbody></table>` +
    `<div class="card"><h3>${largoTarjeta}</h3></div>` +
    '<button>Guardar</button></main>';
  const doc = makeDom(html);
  const root = doc.body;

  const base = serializeFrame(root, {});
  assert.equal(typeof base.fingerprint, 'string', 'precondición: serializeFrame devuelve la huella');

  // Guardas de no-vacuidad — LAS DOS familias de `name` derivado, que pueden
  // tener caminos distintos: celda de grid promovida y elemento promovido por
  // presentación. Sin estas guardas el test sería verde vacuo.
  const celda = celdas(base)[0];
  assert.ok(celda, 'no-vacuidad: hay una celda de grid promovida');
  assert.equal(celda.name.length, 301, 'no-vacuidad: el name derivado de la celda se trunca con el default (300 + U+2026)');
  const tarjeta = clickables(base)[0];
  assert.ok(tarjeta, 'no-vacuidad: hay un elemento promovido por presentación');
  assert.equal(tarjeta.name.length, 301, 'no-vacuidad: el name derivado de la tarjeta se trunca con el default');

  const corto = serializeFrame(root, { maxValueLength: 50 });
  assert.equal(
    celdas(corto)[0].name.length,
    51,
    'no-vacuidad: con maxValueLength:50 el truncado MUERDE sobre la celda (50 + U+2026)',
  );
  assert.equal(
    clickables(corto)[0].name.length,
    51,
    'no-vacuidad: y también sobre el elemento promovido por presentación',
  );

  // El testigo directo del defecto.
  assert.equal(
    corto.fingerprint,
    base.fingerprint,
    'I-C: `maxValueLength` es forma de la QUERY, no contenido del DOM. Si mueve la huella, ' +
      '`changedSinceLast` da true sobre un mapa idéntico (falla H5 de fb-018-001)',
  );

  // Lista cerrada COMPLETA de opciones de §2.3 (fb-018-001), sobre un DOM donde
  // los `name` derivados están truncados: ninguna puede mover la huella.
  const variantes = [
    { page: 1 },
    { page: 2, maxElementsPerPage: 1 },
    { maxElementsPerPage: 1 },
    { include: 'both' },
    { include: 'sections' },
    { roles: ['button'] },
    { namedOnly: true },
    { maxValueLength: 1 },
    { maxValueLength: 50 },
    { maxValueLength: 10000 },
    { maxReadFragmentLength: 1 },
    { maxReadEntries: 1 },
    { page: 2, maxElementsPerPage: 1, roles: ['button'], namedOnly: true, maxValueLength: 2 },
  ];
  for (const opciones of variantes) {
    assert.equal(
      serializeFrame(root, opciones).fingerprint,
      base.fingerprint,
      `ninguna opción de la lista cerrada puede influir la huella, tampoco con name derivado y truncado: ${JSON.stringify(opciones)}`,
    );
  }
});

test('P20c (I-C, cuantificación total): el fingerprint no cambia al variar NINGUNA opción de query, incluidas las cinco que agrega esta feature', () => {
  // P20 enumeró page/roles/namedOnly/maxElementsPerPage y se coló maxValueLength
  // (P20b). P20b cuantificó sobre "la lista cerrada de §2.3 de fb-018-001", que
  // por construcción EXCLUYE las cinco opciones que agrega esta feature, y se
  // colaron maxOptions y maxPromotedClickables. Enumerar —a cualquier nivel— es
  // la construcción frágil: I-C dice "independiente de la QUERY", sin lista.
  //
  // P20c recorre TODA opción de query que el serializer lee de `options`, vieja
  // y nueva, y exige de cada una una GUARDA DE NO-VACUIDAD: la opción tiene que
  // MORDER sobre el fixture (cambiar algo observable del payload) antes de que
  // comparar huellas signifique algo. Sin esa guarda, una opción que no muerde
  // da verde vacuo y la clase se vuelve a abrir por cuarta vez.
  const largo = 'Recepcion-'.repeat(40); // 400 chars: muerde maxValueLength
  const encabezadoLargo = 'Encabezado de fila muy largo '.repeat(6); // 174 chars: muerde maxContextLength
  let filas = '';
  for (let i = 0; i < 4; i++) {
    const th = i === 0 ? encabezadoLargo : `Fila ${i}`;
    const celda0 = i === 0 ? largo : `v${i}0`;
    filas += `<tr><th scope="row">${th}</th><td>${celda0}</td><td>v${i}1</td><td>v${i}2</td></tr>`;
  }
  let tarjetas = '';
  for (let i = 0; i < 12; i++) {
    const texto = i === 0 ? largo : `Tarjeta ${i} con su bajada de texto`;
    tarjetas += `<div class="card"><h3>${texto}</h3></div>`;
  }
  let opciones = '';
  for (let i = 0; i < 60; i++) opciones += `<option>Opcion-${i}</option>`;

  const html =
    '<style>.card { cursor: pointer; }</style><main>' +
    // Tabla CRUZADA (th[scope=row] + th de columna): es la única forma en que
    // `maxPromotedCells` puede morder — §2.7 la declara "por tabla cruzada", así
    // que sobre una tabla simple la cota no se activa NUNCA y el OK sería vacuo.
    '<table><thead><tr><th></th><th>Ene</th><th>Feb</th><th>Mar</th></tr></thead>' +
    `<tbody>${filas}</tbody></table>` +
    `<div role="group" aria-label="Tarjetas de escenario">${tarjetas}</div>` +
    `<select aria-label="Diario">${opciones}</select>` +
    '<button>Guardar</button>' +
    // Sin label/aria-label/placeholder: su `name` es "" y es lo único que
    // `namedOnly` puede recortar sobre este fixture (sin esto, la opción no
    // muerde porque todo lo demás tiene nombre).
    '<input>' +
    `<p>${largo}</p><p>fragmento suelto uno</p><p>fragmento suelto dos</p><p>fragmento suelto tres</p>` +
    '</main>';

  const doc = makeDom(html);
  const root = doc.body;
  const base = serializeFrame(root, {});
  assert.equal(typeof base.fingerprint, 'string', 'precondición: serializeFrame devuelve la huella');

  const maxLargoDe = (frame, clave) =>
    Math.max(0, ...allElements(frame).map((e) => (Array.isArray(e[clave]) ? Math.max(0, ...e[clave].map((s) => s.length)) : 0)));
  const maxCardinalidadDe = (frame, clave) =>
    Math.max(0, ...allElements(frame).map((e) => (Array.isArray(e[clave]) ? e[clave].length : 0)));
  const maxNombre = (frame) => Math.max(0, ...allElements(frame).map((e) => String(e.name || '').length));
  const maxFragmento = (frame) => Math.max(0, ...(frame.read || []).map((s) => String(s).length));

  const casos = [
    // ── lista cerrada de §2.3 de fb-018-001 ─────────────────────────────────
    { nombre: 'page', opciones: { page: 2, maxElementsPerPage: 3 }, medir: (f) => allRefs(f).join('|') },
    { nombre: 'maxElementsPerPage', opciones: { maxElementsPerPage: 3 }, medir: (f) => allRefs(f).length },
    { nombre: 'include', opciones: { include: 'both' }, medir: (f) => ('do' in f ? 1 : 0) },
    { nombre: 'roles', opciones: { roles: ['button'] }, medir: (f) => allRefs(f).length },
    { nombre: 'namedOnly', opciones: { namedOnly: true }, medir: (f) => allRefs(f).length },
    { nombre: 'maxValueLength', opciones: { maxValueLength: 50 }, medir: maxNombre },
    { nombre: 'maxReadFragmentLength', opciones: { maxReadFragmentLength: 20 }, medir: maxFragmento },
    { nombre: 'maxReadEntries', opciones: { maxReadEntries: 2 }, medir: (f) => (f.read || []).length },
    // ── las CINCO que agrega fb-018-005 (§2.7) ──────────────────────────────
    { nombre: 'maxOptions', opciones: { maxOptions: 10 }, medir: (f) => maxCardinalidadDe(f, 'options') },
    { nombre: 'maxPromotedCells', opciones: { maxPromotedCells: 5 }, medir: (f) => celdas(f).length },
    { nombre: 'maxPromotedClickables', opciones: { maxPromotedClickables: 2 }, medir: (f) => clickables(f).length },
    { nombre: 'maxContextEntries', opciones: { maxContextEntries: 1 }, medir: (f) => maxCardinalidadDe(f, 'context') },
    { nombre: 'maxContextLength', opciones: { maxContextLength: 20 }, medir: (f) => maxLargoDe(f, 'context') },
  ];

  // Las dos condiciones se evalúan de forma INDEPENDIENTE y se reportan juntas:
  // si la guarda cortara antes, una corrida no mostraría la lista de violaciones
  // y haría falta un ida y vuelta por cada opción.
  const noMuerden = [];
  const violan = [];
  for (const caso of casos) {
    const variante = serializeFrame(root, caso.opciones);
    if (caso.medir(base) === caso.medir(variante)) {
      noMuerden.push(`${caso.nombre} (medida sin cambio: ${JSON.stringify(caso.medir(base))})`);
    }
    if (variante.fingerprint !== base.fingerprint) violan.push(caso.nombre);
  }

  assert.deepEqual(
    { noMuerden, violan },
    { noMuerden: [], violan: [] },
    'Dos condiciones, reportadas juntas:\n' +
      '  • `noMuerden`: la opción no cambia NADA observable del payload sobre este fixture, así que compararle la ' +
      'huella no probaría nada (verde vacuo). O el fixture no la ejercita, o la cota de §2.7 no está aplicada.\n' +
      '  • `violan`: I-C roto — la opción de QUERY mueve el `fingerprint` sin que cambie el DOM, así que ' +
      '`changedSinceLast` daría true sobre un mapa idéntico (falla H5 de fb-018-001). La huella tiene que computarse ' +
      'ANTES de aplicar cualquier recorte por opción, sin excepción y sin lista de opciones.',
  );
});

test('P21 (cota de getComputedStyle, contador — patrón de inert-generico.test.js:821)', () => {
  function medir(html) {
    const doc = makeDom(html);
    const win = doc.defaultView;
    const original = win.getComputedStyle.bind(win);
    let llamadas = 0;
    win.getComputedStyle = function (...args) {
      llamadas++;
      return original(...args);
    };
    const frame = serializeFrame(doc.body, {});
    return { llamadas, frame, doc };
  }

  // Los dos DOM son ESTRUCTURALMENTE idénticos: sólo cambia el valor de la
  // declaración `cursor`. Eso hace que la diferencia de llamadas sea atribuible
  // exclusivamente a la pasada de promoción por presentación.
  const sin = medir(htmlTarjetas(4, 'auto'));
  const con = medir(htmlTarjetas(4, 'pointer'));

  assert.equal(clickables(con.frame).length, 4, 'no-vacuidad: la pasada de promoción por presentación corrió');
  assert.equal(clickables(sin.frame).length, 0, 'precondición: sin corrida de cursor no se promueve nada');

  // K = elementos no candidatos fuera de subárboles de tabla (§2.7).
  const K = Array.from(con.doc.querySelectorAll('*')).filter(
    (e) => !e.matches('a[href],button,input,select,textarea,[role]') && !e.closest('table'),
  ).length;
  assert.ok(K >= 12, `precondición: el fixture tiene suficientes no-candidatos para que la cota muerda (K=${K})`);

  const delta = con.llamadas - sin.llamadas;
  assert.ok(delta >= 0, `la promoción no puede AHORRAR llamadas (delta=${delta})`);
  assert.ok(
    delta <= 2 * K,
    `(b) ≤ 2 getComputedStyle por elemento no candidato fuera de tablas (el propio y el del padre): delta=${delta}, cota=${2 * K}`,
  );
  assert.ok(
    sin.llamadas <= con.llamadas,
    `(a) el DOM sin ninguna corrida de cursor nunca cuesta MÁS que el que sí la tiene: ${sin.llamadas} vs ${con.llamadas}`,
  );
});

test('P22 (maxPromotedClickables): se emiten exactamente maxPromotedClickables, sin marcador, y el resto sigue en read[]', () => {
  const html = htmlTarjetas(5, 'pointer');
  const completo = serialized(html);
  assert.equal(clickables(completo).length, 5, 'no-vacuidad: con la cota por default se promueven las 5 tarjetas');

  const acotado = serialized(html, { maxPromotedClickables: 2 });
  const promovidos = clickables(acotado);
  assert.equal(promovidos.length, 2, 'al superarse la cota se dejan de promover (§2.7)');
  assert.deepEqual(
    promovidos.map((e) => e.name),
    ['Ropa0 Varios colores', 'Ropa1 Varios colores'],
    'se promueven las primeras en orden de documento',
  );
  // Degradación SILENCIOSA declarada: sin marcador, a diferencia de read[]/options.
  assert.ok(
    !allElements(acotado).some((e) => /truncado/.test(String(e.name || '')) || /truncado/.test(String(e.ref || ''))),
    'no se emite marcador dentro de sections[].elements[]: toda entrada ahí tiene que ser un elemento con ref resoluble (§2.7)',
  );
  const texto = readText(acotado);
  for (const frag of ['Ropa2', 'Ropa3', 'Ropa4']) {
    assert.ok(texto.includes(frag), `el texto de la tarjeta no promovida "${frag}" sigue en read[] (I-A)`);
  }
});

// ── Orden de emisión (§2.7, enmienda 9) ─────────────────────────────────────

/**
 * Fixture de P23. Mezcla LAS TRES puertas de entrada y —deliberadamente— pone
 * las que hoy se anexan a la cola (celdas de grid, clickables) ANTES en el
 * documento que un candidato del loop principal. Sin esa disposición el test
 * sería verde vacuo: con las promociones anexadas al final, un DOM cuyas
 * promociones ya estuvieran últimas en orden de documento pasaría por
 * coincidencia.
 *
 * SIN SHADOW ROOT, por D-10: a través de un límite de shadow
 * `compareDocumentPosition` devuelve DISCONNECTED/IMPLEMENTATION_SPECIFIC y la
 * comparación no significa nada. El orden de los elementos de shadow es el que
 * induce `queryAllDeep` (D2) y esta enmienda no lo cambia.
 */
const HTML_ORDEN_MIXTO =
  '<style>.card { cursor: pointer; }</style><main>' +
  // 1) candidato del loop principal, temprano
  '<button>Alfa</button>' +
  // 2) tarjetas promovidas por corrida de cursor. Van ANTES de la tabla a
  //    propósito: hoy `computeClickablePromotions` corre DESPUÉS de
  //    `computeGridPromotions`, así que en la cola los clickables quedan
  //    detrás de las celdas. Con las tarjetas primero en el documento, una
  //    implementación que ordenara sólo las celdas y siguiera anexando los
  //    clickables al final NO pasaría este test.
  '<div class="card"><h3>Tarjeta A</h3></div>' +
  '<div class="card"><h3>Tarjeta B</h3></div>' +
  // 3) tabla simple: sus celdas promovidas van hoy a la cola de children
  '<table><thead><tr><th>Ref</th><th>Socio</th></tr></thead><tbody>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td></tr>' +
  '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td></tr>' +
  '</tbody></table>' +
  // 4) candidatos del loop principal, TARDE: son los que hoy se emiten ANTES
  //    que las promociones de arriba, violando el orden de documento.
  '<a href="/omega">Omega</a>' +
  '<input aria-label="Ultimo">' +
  '</main>';

test('P23 (§2.7 enmienda 9): el payload se emite en ORDEN DE DOCUMENTO, promociones incluidas (pairwise, sin enumerar refs)', () => {
  const doc = makeDom(HTML_ORDEN_MIXTO);
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const elementos = allElements(frame);

  // ── Guardas de no-vacuidad: las TRES puertas de entrada tienen que estar
  // representadas, o la aserción pairwise no probaría nada sobre el orden.
  assert.ok(celdas(frame).length >= 2, `no-vacuidad: hay celdas promovidas por §2.2 (${celdas(frame).length})`);
  assert.ok(clickables(frame).length >= 2, `no-vacuidad: hay clickables promovidos por §2.4.2 (${clickables(frame).length})`);
  const candidatosPlanos = elementos.filter((e) => ['button', 'a', 'input'].includes(e.tag));
  assert.ok(
    candidatosPlanos.length >= 3,
    `no-vacuidad: hay candidatos del loop principal (${candidatosPlanos.length})`,
  );
  // El fixture entra entero en una página: si no, el orden se mediría sobre un
  // recorte y el test hablaría de otra cosa.
  assert.equal(frame.totalPages ?? 1, 1, 'precondición: el fixture cabe en una sola página');

  const FOLLOWING = doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING;
  const nodos = elementos.map((e) => ({ ref: e.ref, nodo: resolveRef(e.ref, root) }));
  const noResuelven = nodos.filter((n) => !n.nodo).map((n) => n.ref);
  assert.deepEqual(noResuelven, [], 'precondición: todo ref emitido resuelve (si no, el orden no es comparable)');

  const violaciones = [];
  for (let i = 0; i + 1 < nodos.length; i++) {
    const a = nodos[i];
    const b = nodos[i + 1];
    const rel = a.nodo.compareDocumentPosition(b.nodo);
    if (!(rel & FOLLOWING)) {
      violaciones.push({ i, antes: a.ref, despues: b.ref });
    }
  }

  assert.deepEqual(
    violaciones.slice(0, 10),
    [],
    `Orden de emisión roto en ${violaciones.length} pares consecutivos de ${nodos.length} elementos. ` +
      '§2.7 (enmienda 9): la puerta por la que un elemento entró al mapa NO determina su posición en la respuesta; ' +
      'candidato del loop principal, celda promovida (§2.2) y clickable (§2.4.2) se intercalan por POSICIÓN EN EL ÁRBOL. ' +
      'Se ordena `responsePool` (después de las cotas), nunca `children` — la huella no se mueve (P23c). ' +
      '(Se muestran los primeros 10 pares en los que E[i+1] NO sigue a E[i] en orden de documento.)',
  );
});

test('P23b (§2.7 enmienda 9): con candidatos por encima de maxElementsPerPage, la lectura SIN `page` trae al menos un elemento con context de la tabla', () => {
  // ── Premisa del fixture (enmienda 9b, citada del spec §3 P23b) ────────────
  //   «Dado un DOM cuyos elementos CANDIDATOS (sin contar promociones) ya
  //    SUPERAN `maxElementsPerPage`, que contiene una tabla de datos simple, y
  //    EN EL QUE LOS CANDIDATOS EXCEDENTES NO ESTÁN TODOS AGUAS ARRIBA DE LA
  //    TABLA EN ORDEN DE DOCUMENTO».
  //
  // La cláusula en mayúsculas es OBLIGATORIA y no se puede "simplificar"
  // volviendo a poner los 8 botones antes de la tabla: con k >= CORTE
  // candidatos precediendo a la tabla en orden de árbol, la página 1 es
  // exactamente esos candidatos —aritmética de la paginación, no una decisión
  // de implementación— y P23 (orden de documento) y P23b se contradicen sobre
  // esa clase de DOM. Ésa fue la redacción anterior de P23b y era insatisfacible.
  //
  // La premisa enmendada es la que cumple el caso real que motivó todo esto: en
  // la lista de Contactos de Odoo los checkboxes y los botones de actividad de
  // cada fila viven DENTRO de los <tr>, así que candidatos y celdas promovidas
  // se intercalan. Acá se modela con 2 botones antes de la tabla y 6 después.
  //
  // POR QUÉ EL TEST SIGUE DISCRIMINANDO EL DEFECTO ORIGINAL (no se debilitó
  // para que pase): bajo el anexado de las promociones a la COLA de la lista de
  // respuesta, la página 1 son los 5 primeros candidatos del loop principal
  // (`main>button:1..2` + los 3 checkboxes) y NINGUNA celda promovida — todas
  // las promociones quedaban al final, o sea en la página 2. El test es rojo
  // contra la implementación anterior a la enmienda 9 y verde sólo si
  // `responsePool` se ordena por posición en el árbol.
  let botonesAntes = '';
  for (let i = 0; i < 2; i++) botonesAntes += `<button>Accion ${i}</button>`;
  let botonesDespues = '';
  for (let i = 2; i < 8; i++) botonesDespues += `<button>Accion ${i}</button>`;
  const html =
    '<main>' +
    botonesAntes +
    '<table><thead><tr><th>Ref</th><th>Socio</th></tr></thead><tbody>' +
    '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td></tr>' +
    '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td></tr>' +
    '<tr><td><input type="checkbox"></td><td>WH/IN/00003</td></tr>' +
    '</tbody></table>' +
    botonesDespues +
    '</main>';
  const CORTE = 5;

  // Guarda de no-vacuidad 1: los CANDIDATOS solos (sin contar promociones) ya
  // superan el corte. Es la premisa literal de P23b: sin ella, la página 1
  // entraría entera y el test no distinguiría nada.
  const doc = makeDom(html);
  const candidatos = doc.querySelectorAll('a[href],button,input,select,textarea,[role]').length;
  assert.ok(candidatos > CORTE, `precondición: ${candidatos} candidatos superan maxElementsPerPage=${CORTE}`);

  // Guarda de no-vacuidad 2: las celdas con context EXISTEN en el mapa. Sin
  // esto, un fallo sería ambiguo entre "la promoción no corrió" y "la lectura
  // por defecto es ciega a la clase entera" — que es lo que P23b mide.
  const completo = serializeFrame(makeDom(html).body, {});
  const conContextoEnTodoElMapa = allElements(completo).filter(
    (e) => e.tag === 'td' && Array.isArray(e.context) && e.context.length > 0,
  );
  assert.equal(conContextoEnTodoElMapa.length, 3, 'precondición: sin corte, la tabla aporta 3 celdas con context');

  // La lectura por defecto: SIN argumento `page` (§5 criterio 2 — es exactamente
  // la llamada que hace el SKILL; pedir la página 2 a mano está prohibido).
  const porDefecto = serializeFrame(makeDom(html).body, { maxElementsPerPage: CORTE });
  const conContexto = allElements(porDefecto).filter(
    (e) => e.tag === 'td' && Array.isArray(e.context) && e.context.length > 0,
  );

  assert.ok(
    conContexto.length >= 1,
    'La lectura por defecto (sin `page`) devolvió CERO celdas con context, teniendo la tabla en el DOM. ' +
      'Es la anti-regresión directa del E2E de ronda 3: medido sobre la lista de Contactos de Odoo 19, las 80 celdas ' +
      'con context quedaban en las posiciones 91-170 de la PÁGINA 2 y el agente veía una lista sin filas ' +
      'direccionables — indistinguible del sobre-filtrado que las enmiendas 6 y 8 corrigieron. ' +
      `Emitidos en la página por defecto: ${JSON.stringify(allRefs(porDefecto))}. ` +
      'P23b NO pide que TODAS las celdas sean alcanzables sin `page` (eso sería falso: la paginación sigue siendo ' +
      'paginación, PC7); pide que la lectura por defecto no sea ciega a la clase entera de elementos promovidos. ' +
      'Premisa del fixture (enmienda 9b): los candidatos excedentes NO están todos aguas arriba de la tabla ' +
      '(2 botones antes, 6 después) — con todos adelante, P23b sería falsa BAJO P23 y no habría implementación posible.',
  );
});

test('P23c(a) (§2.7 enmienda 9): sobre un DOM CON promociones, variar page/maxElementsPerPage no mueve el fingerprint', () => {
  const root = makeDom(HTML_ORDEN_MIXTO).body;
  const base = serializeFrame(root, {});

  // No-vacuidad: hay promociones de los dos mecanismos (si no, el test no dice
  // nada sobre la reordenación del payload).
  assert.ok(celdas(base).length >= 2, 'no-vacuidad: hay celdas promovidas');
  assert.ok(clickables(base).length >= 2, 'no-vacuidad: hay clickables promovidos');
  assert.equal(typeof base.fingerprint, 'string', 'precondición: serializeFrame devuelve la huella');

  const variantes = [
    { nombre: 'maxElementsPerPage', opciones: { maxElementsPerPage: 3 } },
    { nombre: 'page', opciones: { page: 2, maxElementsPerPage: 3 } },
  ];
  const noMuerden = [];
  const violan = [];
  for (const v of variantes) {
    const frame = serializeFrame(root, v.opciones);
    if (allRefs(frame).join('|') === allRefs(base).join('|')) noMuerden.push(v.nombre);
    if (frame.fingerprint !== base.fingerprint) violan.push(v.nombre);
  }

  assert.deepEqual(
    { noMuerden, violan },
    { noMuerden: [], violan: [] },
    'El ORDEN es una propiedad del PAYLOAD; la huella se computa sobre `children`, que NO se ordena (§2.7, I-C). ' +
      'Si `violan` no está vacío, la reordenación se coló en el conjunto de la huella y `changedSinceLast` daría ' +
      'true sobre un DOM idéntico. Si `noMuerden` no está vacío, la opción no recorta nada sobre el fixture y ' +
      'comparar huellas sería verde vacuo.',
  );
});

test('P23c(b) (§2.7 enmienda 9): sobre un DOM SIN ninguna promoción, la secuencia de refs emitidos es la de antes de la enmienda (no-op)', () => {
  // Ni tabla, ni cursor:pointer: ninguna de las dos vías de promoción aplica,
  // así que la enmienda 9 tiene que ser literalmente un no-op. Es la propiedad
  // que sostiene que los 157 tests existentes no cambian (se apoya en que
  // `queryAllDeep` induce el mismo orden relativo con cualquier selector).
  const html =
    '<main>' +
    '<button>Alfa</button>' +
    '<div role="group" aria-label="Grupo"><a href="/x">Beta</a><input aria-label="Gamma"></div>' +
    '<select aria-label="Delta"><option>Uno</option><option selected>Dos</option></select>' +
    '<textarea aria-label="Epsilon">nota</textarea>' +
    '<button>Zeta</button>' +
    '</main>';
  const frame = serialized(html);

  // Guarda de no-vacuidad: el DOM efectivamente no tiene promociones (si las
  // tuviera, el pin de abajo estaría midiendo otra cosa).
  assert.equal(celdas(frame).length, 0, 'precondición: sin tabla no hay celdas promovidas');
  assert.equal(clickables(frame).length, 0, 'precondición: sin cursor:pointer no hay clickables promovidos');

  assert.deepEqual(
    allRefs(frame),
    [
      'main>button:1',
      'main>div',
      'main>div>a',
      'main>div>input',
      'main>select',
      'main>textarea',
      'main>button:2',
    ],
    'PIN de la secuencia de refs previa a la enmienda 9: sobre un DOM sin promociones, ordenar `responsePool` no ' +
      'puede cambiar NADA. Si esto falla, la reordenación alteró el orden de los candidatos del loop principal y ' +
      'la enmienda dejó de ser un no-op — el supuesto que sostiene que la suite existente no se toca (§9).',
  );
});

// ── Sub-fase 3.4 — PROPERTY TEST del invariante I-5 (§4 del spec) ───────────

/**
 * Fragmentos de DOM que se combinan para generar los frames. El spec (§4, I-5)
 * pide que la property barra al menos: tabla simple, tabla cruzada, elementos
 * promovidos por presentación, diálogo activo y shadow root.
 *
 * Se enumeran TODAS las combinaciones (2^6 = 64) por dos motivos: es
 * determinista —reproducible en CI sin depender de una semilla— y garantiza que
 * cada mecanismo aparezca tanto solo como cruzado con los otros cinco, que es
 * donde viven las interacciones (p. ej. tarjeta con `cursor:pointer` DENTRO de
 * una tabla, o celda promovida DENTRO del diálogo activo).
 */
const FRAGMENTOS_I5 = [
  [
    'tabla-simple',
    '<table><thead><tr><th>Ref</th><th>Socio</th></tr></thead><tbody>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00001</td><td>Azure Interior</td></tr>' +
      '<tr><td><input type="checkbox"></td><td>WH/IN/00002</td><td>Deco Addict</td></tr>' +
      '</tbody></table>',
  ],
  [
    'tabla-cruzada',
    // D-4: dom-accessibility-api devuelve `columnheader` para th[scope="row"].
    // La property NO deriva expectativas de ahí: compara contra el MISMO getRole
    // que el contrato usa, así que la rareza de la librería no la afecta.
    '<table><thead><tr><th></th><th>Ene</th><th>Feb</th></tr></thead><tbody>' +
      '<tr><th scope="row">Ropa</th><td>10</td><td>20</td></tr>' +
      '<tr><th scope="row">Muebles</th><td>30</td><td>40</td></tr>' +
      '</tbody></table>',
  ],
  [
    'tarjetas-cursor',
    '<div class="card"><h3>Ropa</h3><p>Varios colores</p></div>' +
      '<div class="card"><h3>Muebles</h3><p>De roble</p></div>' +
      '<div class="card"><h3>Con botón</h3><button>Elegir</button></div>',
  ],
  [
    'promotables',
    '<div tabindex="0"><h3>Focusable</h3><p>bajada</p></div>' +
      '<div onclick="void 0">Con onclick</div>' +
      '<div contenteditable="true">Nota libre</div>',
  ],
  [
    'controles',
    '<select aria-label="Diario"><option>Banco</option><option selected>Efectivo</option></select>' +
      '<input aria-label="Proveedor" value="ACME"><textarea>texto</textarea>' +
      '<button>Guardar</button><button></button><a href="/x">Ir</a><input>' +
      '<div role="tab" aria-selected="true">Pestaña</div>' +
      '<div role="combobox" aria-expanded="false">Combo</div>' +
      '<div role="checkbox" aria-checked="mixed">Parcial</div>' +
      '<div role="group" aria-label="Grupo con nombre"><button>Adentro</button></div>',
  ],
  [
    'dialogo',
    // Advertencia de fixture de §3: sin `elementFromPoint`, `isBlocking` da true
    // y todo lo de afuera sale inert:true. Es ortogonal a I-5 (inert no toca el
    // `role`), pero se deja constancia de que es esperado y no un artefacto.
    '<div role="dialog"><h4>Operación no válida</h4>' +
      '<div role="alert">Falta el diario.</div>' +
      '<table><tbody><tr><td>Celda en diálogo</td><td>otra</td></tr></tbody></table>' +
      '<button>Cerrar</button></div>',
  ],
];

test('I-5 (property, §4): para TODO elemento emitido, role === (getRole(resolveRef(ref, root)) || "")', () => {
  const contraejemplos = [];
  let framesGenerados = 0;
  let elementosVerificados = 0;

  for (let mascara = 0; mascara < (1 << FRAGMENTOS_I5.length); mascara++) {
    for (const conShadow of [false, true]) {
      const activos = FRAGMENTOS_I5.filter((_, i) => (mascara >> i) & 1);
      if (activos.length === 0 && !conShadow) continue;
      const etiqueta = [...activos.map(([n]) => n), ...(conShadow ? ['shadow'] : [])].join('+') || 'vacío';

      const html =
        '<style>.card { cursor: pointer; } tr { cursor: pointer; }</style><main>' +
        activos.map(([, h]) => h).join('') +
        (conShadow ? '<div id="host-i5"></div>' : '') +
        '</main>';
      const doc = makeDom(html);
      if (conShadow) {
        // Los shadow roots no se pueden crear por innerHTML: se adjuntan.
        const host = doc.getElementById('host-i5');
        host.attachShadow({ mode: 'open' }).innerHTML =
          '<button>En shadow</button><textarea>sombra</textarea>' +
          '<table><tbody><tr><td>Celda en shadow</td><td>otra</td></tr></tbody></table>' +
          '<div class="card"><h3>Tarjeta en shadow</h3></div>';
      }
      const root = doc.body;
      const frame = serializeFrame(root, { include: 'both' });
      framesGenerados++;

      for (const el of allElements(frame)) {
        elementosVerificados++;
        const nodo = resolveRef(el.ref, root);
        if (!nodo) {
          contraejemplos.push({
            dom: etiqueta,
            ref: el.ref,
            roleEmitido: el.role,
            roleResuelto: '(el ref NO resuelve: resolveRef devolvió null)',
          });
          continue;
        }
        const esperado = getRole(nodo) || '';
        if (el.role !== esperado) {
          contraejemplos.push({ dom: etiqueta, ref: el.ref, roleEmitido: el.role, roleResuelto: esperado });
        }
      }
    }
  }

  // Guardas de no-vacuidad: sin ellas la property sería verde vacua si el
  // generador dejara de producir alguno de los mecanismos que el spec exige.
  assert.equal(framesGenerados, 127, 'precondición: se generaron las 2^6 combinaciones × {con, sin} shadow, menos el DOM vacío');
  assert.ok(
    elementosVerificados > 2000,
    `precondición: la property tiene que barrer un volumen real de elementos (verificados: ${elementosVerificados})`,
  );

  assert.deepEqual(
    contraejemplos.slice(0, 10),
    [],
    `I-5 roto en ${contraejemplos.length} de ${elementosVerificados} elementos. ` +
      'Es el invariante que justifica emitir la CELDA y no la fila (§2.2): un elemento con `role:"row"` cuyo `ref` ' +
      'apunta a un <td> rompería la correspondencia y obligaría a `act` a conocer una regla de despacho indirecto. ' +
      '(Se muestran los primeros 10 contraejemplos, con dom / ref / role emitido / role del nodo resuelto.)',
  );
});

// ── P6c (generalizada) + fb-017-003 PC2 ─────────────────────────────────────
// RED de la enmienda 10: una celda PROMOTABLE-pero-no-CANDIDATE se emite DOS
// VECES con el MISMO ref.
//
// P6c dice "un solo `ref` por celda" para la celda candidata por mérito propio
// (`role="gridcell"`), y fb-017-003 PC2 lo dice para TODO el payload: dos
// elementos distintos nunca comparten `ref`. Medido sobre una tabla simple de
// una fila con dos celdas (jsdom, sin stubs):
//
//   td tabindex="0"            → 2 elementos, ref duplicado
//   td onclick="x()"           → 2 elementos, ref duplicado
//   td contenteditable="true"  → 2 elementos, ref duplicado
//   td tabindex="-1"           → 1 elemento  (enmienda 8, correcto)
//   td role="gridcell"         → 1 elemento  (candidata, no promovida — P6c)
//
// La celda entra por el loop principal (matchea PROMOTABLE_SELECTOR) Y la
// promueve el camino de grid: la exclusión de §2.4.1 sólo se activa con
// `tabindex="-1"`, y la elegibilidad de §2.2.1 sólo excluye a las celdas que
// matchean CANDIDATE_SELECTOR. Consecuencias: rompe fb-017-003 PC2, desmiente
// P6c, viola P23 por construcción (`compareDocumentPosition` entre el nodo y
// sí mismo devuelve 0, sin DOCUMENT_POSITION_FOLLOWING) e infla
// `totalElements`, `do[]` y el `fingerprint`. Para el agente son dos acciones
// indistinguibles sobre el mismo nodo.
//
// Ningún fixture de la suite tenía una celda PROMOTABLE-pero-no-CANDIDATE: los
// tres casos del spec son `tabindex="-1"` (P6b/P6d) y `role="gridcell"` (P6c).
// Es la MISMA forma de hueco de fixture que dejó pasar el falso negativo de la
// enmienda 8 con la suite entera en verde.
//
// GUARDA DE NO-VACUIDAD, esencial: la solución EQUIVOCADA a este defecto es
// hacer desaparecer el elemento del mapa, que reabriría la clase de defecto de
// las enmiendas 6 y 8 (I-B, y el principio de producto de §2.4.1: "el código de
// Vulpo no debe filtrar de más"). Por eso la aserción es `=== 1`, no
// `<= 1`: el test es rojo tanto por duplicar como por borrar.
test('P6c + fb-017-003 PC2: una celda PROMOTABLE-pero-no-CANDIDATE se emite UNA sola vez (ni duplicada ni borrada)', () => {
  const casos = [
    // Las tres puertas de PROMOTABLE_SELECTOR (§2.4.1) que hoy fallan.
    { etiqueta: 'td tabindex="0"', attr: 'tabindex="0"' },
    { etiqueta: 'td onclick', attr: 'onclick="window.__fb_noop=1"' },
    { etiqueta: 'td contenteditable="true"', attr: 'contenteditable="true"' },
    // Controles que hoy están BIEN: van en el mismo test para que la corrección
    // tenga que discriminar entre puertas y no pueda apagar el mecanismo entero.
    { etiqueta: 'td tabindex="-1" (control, enmienda 8)', attr: 'tabindex="-1"' },
    { etiqueta: 'td role="gridcell" (control, P6c literal)', attr: 'role="gridcell"' },
  ];

  const fallas = [];
  for (const caso of casos) {
    const html =
      '<main><table><tbody>' +
      `<tr><td ${caso.attr}>WH/IN/00001</td><td>Azure Interior</td></tr>` +
      '</tbody></table></main>';
    const doc = makeDom(html);
    const root = doc.body;
    const celdaGate = doc.querySelector('td');
    const frame = serializeFrame(root, {});
    const elementos = allElements(frame);

    // (a) Identidad de NODO, no de string: cuántos elementos emitidos resuelven
    // a la celda en cuestión. 1 es el contrato; 0 = borrada (I-B); ≥2 = ref
    // duplicado. Un Set de refs NO detectaría el duplicado —los dos comparten
    // literalmente el mismo string— así que se cuentan OCURRENCIAS.
    const apuntanALaCelda = elementos.filter((e) => resolveRef(e.ref, root) === celdaGate);
    if (apuntanALaCelda.length !== 1) {
      fallas.push({
        caso: caso.etiqueta,
        problema: apuntanALaCelda.length === 0 ? 'BORRADA del mapa (I-B)' : 'ref DUPLICADO',
        elementosQueApuntanALaCelda: apuntanALaCelda,
      });
      // Sin `continue`: (b) tiene que evaluarse IGUAL en el caso que falla. Si
      // (a) cortocircuitara, la unicidad global de PC2 quedaría verificada sólo
      // sobre los controles —donde nada se duplica— y sería verde vacua
      // (misma forma que la guarda de P20c).
    }

    // (b) Unicidad de `ref` sobre TODO el payload (fb-017-003 PC2 es global, no
    // sólo sobre las celdas): ningún ref emitido aparece más de una vez.
    const conteo = new Map();
    for (const el of elementos) conteo.set(el.ref, (conteo.get(el.ref) || 0) + 1);
    const repetidos = [...conteo.entries()].filter(([, n]) => n > 1);
    if (repetidos.length > 0) {
      fallas.push({
        caso: caso.etiqueta,
        problema: 'fb-017-003 PC2: refs repetidos en el payload',
        refsRepetidos: repetidos.map(([ref, n]) => `${ref} ×${n}`),
      });
    }
  }

  assert.deepEqual(
    fallas,
    [],
    'Cada celda tiene que aparecer EXACTAMENTE UNA vez en el payload (P6c "un solo ref por celda"; ' +
      'fb-017-003 PC2 "dos elementos distintos nunca comparten ref"). Fallas: ' +
      JSON.stringify(fallas, null, 2),
  );
});

// ── P10 / §2.3 a través de una frontera de SHADOW ───────────────────────────
// RED: exposición nueva. Hasta el commit anterior la promoción por presentación
// no visitaba shadow roots en absoluto; al hacerla usar el recorrido común (que
// sí los cruza), quedó al descubierto el punto ciego de la comprobación "¿estoy
// dentro de una tabla?": esa comprobación sube por la cadena de ancestros y NO
// cruza la frontera de shadow, así que un elemento cuyo host vive dentro de un
// <td> se cree fuera de toda tabla y se promueve. Medido, sin stubs:
//
//   host FUERA de tabla   → clickables: 1  ['main>div::shadow>div']
//   host DENTRO de un <td> → clickables: 1  ['main>table>tbody>tr>td>div::shadow>div']  ← VIOLA §2.3
//
// §2.3 es explícito y no admite excepción por puerta de entrada: «Dentro del
// subárbol de un table/grid/treegrid, la promoción por presentación (§2.4) NO se
// aplica», y la promoción de grid tiene precedencia contractual sobre la de
// cursor. P10 lo pide para un elemento con cursor:pointer dentro de un <table>
// «ni siquiera cuando es raíz de corrida». El shadow root no es una tabla nueva:
// el <td> sigue siendo un ancestro del elemento en el árbol compuesto.
//
// POR QUÉ EL CONTROL POSITIVO ES OBLIGATORIO — que nadie lo "simplifique".
// jsdom NO aplica las hojas de estilo declaradas dentro de un shadow root al
// getComputedStyle de sus elementos. La primera sonda usó
// `<style>.card{cursor:pointer}</style>` DENTRO del shadow: el control positivo
// dio 0 clickables y el defecto pareció no existir. Por eso el `cursor:pointer`
// va INLINE en el elemento (`style="cursor: pointer"`), y por eso el caso de
// control vive en el mismo test: sin él, "0 clickables en el negativo" es verde
// vacuo — se cumple igual si el mecanismo simplemente no corrió.
//
// Y por eso el control promueve TAMBIÉN desde dentro de un shadow root, con
// contenido de shadow idéntico al del negativo: los dos fixtures difieren
// ÚNICAMENTE en dónde está el host. Así el test rechaza el arreglo equivocado
// —apagar la promoción por presentación dentro de shadow roots— que dejaría el
// negativo en verde y el control en rojo. El único arreglo que pone los tres
// casos en verde es que la comprobación de ancestros CRUCE la frontera de
// shadow, que es el defecto real.
//
// GUARDA DE NO-VACUIDAD adicional (traversal): el <button> hermano de la tarjeta
// dentro del mismo shadow root tiene que estar emitido en los tres casos. Si el
// arreglo dejara de descender a los shadow roots bajo una tabla, el negativo
// daría 0 clickables por la razón equivocada y este testigo lo delata.
test('P10 (§2.3): la precedencia de grid vale a TRAVÉS de la frontera de shadow — un host dentro de un <td> no promueve por presentación', () => {
  // `cursor:pointer` INLINE, no por hoja de estilo: ver el recuadro de arriba.
  const CONTENIDO_SHADOW =
    '<div class="card" style="cursor: pointer"><h3>Ropa</h3><p>Varios colores</p></div>' +
    '<button>En shadow</button>';

  const casos = [
    {
      etiqueta: 'CONTROL POSITIVO: host FUERA de toda tabla',
      html: '<main><div id="host"></div></main>',
      esperaPromocion: true,
    },
    {
      etiqueta: 'host DENTRO de un <td> (§2.3: la promoción por presentación no se aplica)',
      html:
        '<main><table><tbody>' +
        '<tr><td><div id="host"></div></td><td>Azure Interior</td></tr>' +
        '</tbody></table></main>',
      esperaPromocion: false,
    },
    {
      // Misma regla de §2.3, sin apoyarse en semántica de raíz de corrida a
      // través del límite de shadow (que el spec no define): acá el propio host
      // lleva la corrida y está dentro del <td>.
      etiqueta: 'host DENTRO de un <td> y con cursor:pointer propio',
      html:
        '<main><table><tbody>' +
        '<tr><td><div id="host" style="cursor: pointer"></div></td><td>Azure Interior</td></tr>' +
        '</tbody></table></main>',
      esperaPromocion: false,
    },
  ];

  const fallas = [];
  for (const caso of casos) {
    const doc = makeDom(caso.html);
    const root = doc.body;
    // Los shadow roots no se pueden crear por innerHTML: se adjuntan (mismo
    // patrón que el generador de la property de I-5).
    const host = doc.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = CONTENIDO_SHADOW;
    const tarjeta = shadow.querySelector('div.card');

    const frame = serializeFrame(root, {});
    const promovidos = clickables(frame);

    // (a) Guarda de no-vacuidad de traversal: el <button> del shadow root está
    // emitido, o sea el recorrido cruzó la frontera en este fixture.
    if (!byName(frame, 'En shadow')) {
      fallas.push({
        caso: caso.etiqueta,
        problema:
          'el <button> del shadow root NO está emitido: el recorrido dejó de cruzar la frontera de shadow. ' +
          'Sin este testigo, "0 clickables" sería verde vacuo (y sería I-B violado).',
        refsEmitidos: allRefs(frame),
      });
    }

    // (b) La postcondición.
    if (caso.esperaPromocion) {
      if (promovidos.length !== 1) {
        fallas.push({
          caso: caso.etiqueta,
          problema:
            'el control positivo tiene que promover EXACTAMENTE 1 elemento. Si da 0, el mecanismo no corrió ' +
            'sobre este fixture y el caso negativo no discrimina nada (trampa medida: cursor por <style> dentro ' +
            'del shadow root no lo aplica jsdom — por eso va inline).',
          clickablesEmitidos: promovidos,
        });
      } else if (resolveRef(promovidos[0].ref, root) !== tarjeta) {
        fallas.push({
          caso: caso.etiqueta,
          problema: 'el ref promovido no resuelve al div.card del shadow root (identidad de nodo, patrón de P8)',
          refPromovido: promovidos[0].ref,
        });
      }
    } else if (promovidos.length !== 0) {
      fallas.push({
        caso: caso.etiqueta,
        problema:
          '§2.3 / P10: dentro del subárbol de un table/grid/treegrid la promoción por presentación NO se aplica, ' +
          'cualquiera sea la puerta de entrada. La comprobación de "estoy dentro de una tabla" sube por ancestros ' +
          'y no cruza la frontera de shadow, así que el elemento se cree fuera de toda tabla.',
        clickablesEmitidos: promovidos,
      });
    }
  }

  assert.deepEqual(
    fallas,
    [],
    'P10 / §2.3 a través de shadow. Fallas: ' + JSON.stringify(fallas, null, 2),
  );
});
