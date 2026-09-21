/**
 * validez-perfil-sitio.test.js — fb-020-005-odoo-form-validity (sub-fase RED).
 *
 * Verifica P1–P14 de docs/specs/fb-020-005-odoo-form-validity/spec.md §5
 * (spec v1.1: §10 ratifica las resoluciones de RED y §10.4 suma la aserción de
 * orden canónico de las claves de NIVEL SUPERIOR, que vive en el segundo test
 * de P5 — P5 y P14 son las dos postcondiciones que ocupan dos tests).
 * (P15, P16, P21 son E2E del dev-harness; P17 es Go unit; P18/P19 son grep de
 * skills; P20 es campo — ninguna de ésas vive en este archivo.)
 *
 * Escrito SOLO contra el contrato del spec: el test-writer NO leyó
 * serializer.js, resolver.js, index.js ni ningún módulo de implementación. Los
 * módulos que el archivo importa (serializer.js, resolver.js, index.js) ya
 * existen y son el oráculo observable, igual que en payload-efficiency.test.js
 * y settle.test.js.
 *
 * ── Perfil de PRUEBA (por qué no se usa el de Odoo) ─────────────────────────
 * Los literales del perfil de Odoo (firma de raíz, clases) viven en
 * `profiles/odoo.js` — implementación, fuera del alcance del test-writer, y
 * deliberadamente ausentes del spec. Este archivo define su PROPIO perfil
 * (`PERFIL_DEMO`, selectores inventados y genéricos) e inyecta el registro. Eso
 * es más fuerte que usar el de Odoo: demuestra que el mecanismo es una
 * convención inyectada como dato y no una heurística de sitio (§2 opción C,
 * I-2). Donde el spec dice "el perfil detectado", acá se lee "PERFIL_DEMO".
 *
 * ── Interfaz declarada por test-writer para el implementer ──────────────────
 * El spec (§3.1, §3.7) fija la FORMA del perfil y DÓNDE vive cada pieza, pero
 * no nombra los símbolos. Esta suite los declara; si el implementer prefiere
 * otros nombres, es una renegociación de interfaz, no una licencia para
 * cambiar el test por su cuenta.
 *
 *   serializer.js
 *     export function serializeFrame(root, options)
 *       `options.validityProfiles` — array de perfiles §3.1 (el REGISTRO
 *       inyectado). Ausente ⇒ el núcleo no reconoce ninguna convención de
 *       sitio (P14). Se evalúa `detect(doc)` una vez por serialización y gana
 *       el primer perfil del array que detecte (§3.1).
 *       El frame gana, en la posición canónica de §3.3 (inmediatamente después
 *       de `invalidCount`, antes de `totalElements`), las claves present-only
 *       `invalidElements` e `invalidProfile`.
 *
 *   validity-profiles.js  (núcleo, sin literales de producto — MÓDULO NUEVO)
 *       El contrato del perfil y el registro genérico. No se le exige acá
 *       ninguna firma: ninguna postcondición P1–P14 la observa directamente.
 *       Sí se le exige EXISTIR, porque P14/I-1 lo nombra entre los archivos
 *       que el grep de generalidad audita.
 *
 *   profiles/odoo.js  (capa de producto — MÓDULO NUEVO)
 *       El perfil de Odoo. El test nunca lo lee con sus ojos: el grep de P14 lo
 *       lee en RUNTIME con `fs`, le extrae sus literales y exige que ninguno
 *       aparezca en los literales del núcleo. Así el chequeo audita los
 *       literales REALES sin que el test-writer los conozca (un grep con
 *       literales inventados no podría fallar nunca: sería vacuo).
 *
 *   index.js  (entry del bundle VulpoFrame, composición — I-9)
 *       export const VALIDITY_PROFILES   ← NOMBRE INVENTADO POR EL TEST-WRITER
 *         El registro que la composición inyecta. Se agrega a la superficie
 *         actual del módulo (hoy re-exporta serializeFrame, resolveRef, etc.).
 *       export function serializeFrame(root, options)
 *         Sigue siendo el serializer, ya compuesto con el registro: el test de
 *         composición ejerce ESTE camino, no un cableado armado a mano (I-9).
 *
 * ── Naturaleza RED esperada ────────────────────────────────────────────────
 *  · FALLAN por AssertionError (la funcionalidad no existe): P1, P2, P5, P6,
 *    P5 (orden de nivel superior, §10.4), P6,
 *    P7, P8, P9, P10, P11, P12, P13, P14 (mitad grep: falta profiles/odoo.js;
 *    la mitad unit es un PIN), y el test de composición (I-9).
 *  · MIXTO, declarado para que la auditoría de mapeo test↔postcondición no lea
 *    "rojo entero" donde no lo es: P13. Su mitad de AUSENCIA (invalidez sólo
 *    estándar ⇒ sin `invalidProfile`) se cumple HOY de hecho, porque la clave
 *    todavía no existe; el rojo lo lleva su espejo de no-vacuidad (el mismo DOM
 *    más un marcador del perfil ⇒ `invalidProfile:"demo"`). Es el mismo patrón
 *    pin/RED que invalid-frame.test.js usó para `invalidCount`.
 *  · PINES / anti-regresión — se espera que PASEN ya en RED:
 *    P3 (golden byte-a-byte del build vigente: hoy pasa porque la feature no
 *    existe, y su trabajo empieza en GREEN), P4 (el camino estándar de
 *    fb-020-004 ya está implementado y NO debe moverse) y la mitad unit de P14
 *    (sin registro no hay convención: hoy se cumple de hecho).
 *    Si alguno de esos tres falla HOY, es un defecto real ya presente.
 *
 * ── Ambigüedades del spec halladas en RED (informadas al orquestador) ───────
 *  (1) P3 ancla la no-regresión al "pin de huella vigente de
 *      payload-efficiency.test.js". Ese archivo NO tiene ningún pin literal de
 *      huella: todos sus pines son RELACIONALES (la huella es un string no
 *      vacío; es invariante ante la lista cerrada de opciones). Un serializer
 *      que cambiara la salida para TODOS los sitios los pasaría todos, que es
 *      exactamente lo que §9.4 punto 2 quiere impedir. Resuelto capturando un
 *      GOLDEN LITERAL (huella + JSON completo) del build PRE-feature, sin
 *      editar payload-efficiency.test.js. Ver GOLDEN_GATING.
 *  (2) §3.2 afirma que el `<input>` de una celda de lista "ya trae
 *      context: [fila, encabezado de columna]", y P2 pide que lo CONSERVE.
 *      Medido en el build vigente: un `<input>` dentro de un `<td>` NO lleva
 *      `context` — ni en tabla simple ni en tabla cruzada; el `context` lo
 *      lleva la CELDA PROMOVIDA, y la celda con input no se promueve (§3.2 lo
 *      dice). P2 se escribe entonces en su forma verificable y no
 *      sobre-especificada: el `context` del portador es EXACTAMENTE el mismo
 *      con y sin el marcador (esta feature no lo toca). Si el dueño del proceso
 *      quiere además que el input GANE `context`, es alcance nuevo y necesita
 *      una postcondición propia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';
import * as entry from './index.js';

// ── Perfil de prueba y helpers ──────────────────────────────────────────────

/** Perfil §3.1 con selectores inventados: nada de Odoo entra a este archivo. */
const PERFIL_DEMO = {
  id: 'demo',
  detect: (doc) => !!doc.querySelector('[data-suite-root="demo"]'),
  invalidMarkerSelector: '.demo-invalid-marker',
  fieldNameAttribute: 'data-demo-field',
};

/** Igual pero sin `fieldNameAttribute` (la clave es opcional en §3.1). */
const PERFIL_SIN_ATRIBUTO = {
  id: 'demo',
  detect: PERFIL_DEMO.detect,
  invalidMarkerSelector: PERFIL_DEMO.invalidMarkerSelector,
};

const REGISTRO = [PERFIL_DEMO];

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
/** Envuelve el markup en la firma de raíz del perfil (⇒ `detect` da true). */
function conFirma(html) {
  return `<div data-suite-root="demo">${html}</div>`;
}
function serPerfil(root, options = {}, registro = REGISTRO) {
  return serializeFrame(root, { validityProfiles: registro, ...options });
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
/** Guarda de no-vacuidad de la huella (patrón payload-efficiency.test.js). */
function assertHuella(frame, etiqueta) {
  assert.equal(
    typeof frame.fingerprint,
    'string',
    `${etiqueta}: serializeFrame debe devolver \`fingerprint\` como string. Sin esta guarda, ` +
      'una comparación de huellas sería undefined !== undefined (rojo por canal faltante, no por contrato).',
  );
  assert.ok(frame.fingerprint.length > 0, `${etiqueta}: la huella no puede ser el string vacío`);
  return frame.fingerprint;
}
/** Nodos a los que resuelven las entradas del resumen, en orden de la lista. */
function nodosDe(frame, root) {
  return (frame.invalidElements || []).map((e) => resolveRef(e.ref, root));
}

// ── P1 — portador por marcador ancestro (§3.2) ──────────────────────────────

test('P1: con el perfil detectado, el input dentro de un widget marcado lleva invalid:true; sin marcador ancestro, la clave está ausente', () => {
  const doc = makeDom(
    conFirma(
      '<form>' +
        '<div class="demo-invalid-marker" data-demo-field="alfa"><label for="a">Alfa</label><input id="a"></div>' +
        '<div><label for="b">Beta</label><input id="b"></div>' +
        '</form>',
    ),
  );
  const root = doc.body;
  const frame = serPerfil(root);

  const marcado = emitidoPara(frame, root, doc.getElementById('a'), 'input marcado');
  const limpio = emitidoPara(frame, root, doc.getElementById('b'), 'input sin marcador');

  assert.equal(
    marcado.invalid,
    true,
    `P1: el input dentro del marcador lleva invalid:true; recibido ${JSON.stringify(marcado)}`,
  );
  assert.equal(
    'invalid' in limpio,
    false,
    `P1 (I-6): el input sin marcador ancestro NO lleva la clave invalid; recibido ${JSON.stringify(limpio)}`,
  );
});

// ── P2 — celda de lista en modo edición (§3.2) ──────────────────────────────

const HTML_LINEA_EDICION =
  '<table><tbody>' +
  '<tr><td>Linea uno</td>' +
  '<td class="demo-invalid-marker" data-demo-field="cantidad"><input aria-label="Cantidad"></td>' +
  '</tr>' +
  '</tbody></table>';

test('P2: con la fila en modo edición, el input de la celda marcada lleva invalid:true y su `context` no cambia por esta feature', () => {
  const doc = makeDom(conFirma(HTML_LINEA_EDICION));
  const root = doc.body;
  const input = doc.querySelector('td.demo-invalid-marker input');
  const frame = serPerfil(root);
  const el = emitidoPara(frame, root, input, 'input de la celda');

  assert.equal(
    el.invalid,
    true,
    `P2: el input de la celda marcada lleva invalid:true; recibido ${JSON.stringify(el)}`,
  );

  // La mitad "conserva su context": se compara contra el MISMO DOM sin la clase
  // marcadora — única diferencia, así que los refs no se corren (medido).
  // Ver ambigüedad (2) del encabezado: hoy este input no lleva `context` en
  // absoluto, y P2 no puede exigirle uno sin inventar alcance.
  const docLimpio = makeDom(conFirma(HTML_LINEA_EDICION.replace(' class="demo-invalid-marker"', '')));
  const rootLimpio = docLimpio.body;
  const inputLimpio = docLimpio.querySelector('td input');
  const elLimpio = emitidoPara(serPerfil(rootLimpio), rootLimpio, inputLimpio, 'input sin marcador');

  assert.equal(
    'context' in el,
    'context' in elLimpio,
    'P2: el marcador no puede agregar ni quitar la clave `context` del portador',
  );
  assert.deepEqual(
    el.context,
    elLimpio.context,
    'P2 (§3.3): el portador conserva EXACTAMENTE el `context` que lleva en el mapa',
  );

  // GUARDA DE NO-VACUIDAD de la cláusula anterior. Medido: hoy el input NO
  // lleva `context`, así que la comparación de arriba es undefined vs undefined
  // — verde vacuo. La celda hermana PROMOVIDA de la misma fila sí lo lleva, y
  // §3.3 dice lo mismo de ella: el `context` que un elemento tiene en el mapa
  // no lo toca esta feature. Sin este bloque, la mitad "conserva su context"
  // de P2 no podría fallar nunca.
  const celdaFila = allElements(serPerfil(root)).find((e) => e.tag === 'td');
  assert.ok(celdaFila, `no-vacuidad: la fila promueve su celda identificatoria; refs=${JSON.stringify(allRefs(frame))}`);
  assert.ok(
    Array.isArray(celdaFila.context) && celdaFila.context.length > 0,
    `no-vacuidad: la celda promovida lleva un context no vacío; recibido ${JSON.stringify(celdaFila)}`,
  );
  const celdaLimpia = allElements(serPerfil(rootLimpio)).find((e) => e.tag === 'td');
  assert.deepEqual(
    celdaFila.context,
    celdaLimpia.context,
    'P2 (§3.3, I-4): el marcador tampoco altera el `context` de la celda promovida de la misma fila',
  );
});

// ── P3 — gating / no-regresión (§3.5, I-3) ──────────────────────────────────

/**
 * DOM que usa las CLASES del perfil pero NO su firma de raíz ⇒ `detect` da
 * false ⇒ sin convención de sitio.
 */
const HTML_GATING =
  '<main aria-label="Panel">' +
  '<form>' +
  '<div class="demo-invalid-marker" data-demo-field="alfa"><label for="a">Alfa</label><input id="a"></div>' +
  '<div><label for="b">Beta</label><input id="b"></div>' +
  '<button>Guardar</button>' +
  '</form>' +
  '</main>';

/**
 * GOLDEN capturado del build PRE-feature (2026-09-18, `node --test` sobre
 * HTML_GATING con `serializeFrame(body, {})`). Ver ambigüedad (1) del
 * encabezado: payload-efficiency.test.js no tiene ningún pin literal de huella,
 * así que anclarse "a su pin" exige materializarlo acá. Este literal NO se
 * re-captura en GREEN: si cambia, la feature rompió la salida de todos los
 * sitios y eso es precisamente lo que I-3 prohíbe.
 */
const HUELLA_GATING = 'd10c3cc0a9dcbe04';
const GOLDEN_GATING =
  '{"page":1,"totalPages":1,"sections":[{"title":"form","elements":[' +
  '{"ref":"main>form>div:1>input","role":"textbox","name":"Alfa","tag":"input","disabled":false,"visible":true,"value":""},' +
  '{"ref":"main>form>div:2>input","role":"textbox","name":"Beta","tag":"input","disabled":false,"visible":true,"value":""},' +
  '{"ref":"main>form>button","role":"button","name":"Guardar","tag":"button","disabled":false,"visible":true}' +
  ']}],"read":[],"fingerprint":"d10c3cc0a9dcbe04"}';

test('P3 (I-3): un DOM con las clases del perfil pero sin su firma de raíz produce el frame byte-idéntico al del build vigente', () => {
  const root = makeDom(HTML_GATING).body;
  const frame = serPerfil(root);

  assert.equal(
    frame.fingerprint,
    HUELLA_GATING,
    'P3: la huella del build vigente no se mueve cuando el perfil no detecta (§9.4 punto 2: la línea de base ' +
      'es el pin vigente, no el build nuevo contra sí mismo)',
  );
  assert.equal(
    JSON.stringify(frame),
    GOLDEN_GATING,
    'P3 (I-3): el frame es byte-idéntico al del build vigente, incluido el caso en que el DOM usa por ' +
      'casualidad las clases del perfil',
  );
  // Redundante con el golden, pero deja el mensaje explícito de la postcondición.
  for (const clave of ['invalidCount', 'invalidElements', 'invalidProfile']) {
    assert.equal(clave in frame, false, `P3: sin perfil detectado no existe la clave ${clave}`);
  }
  assert.ok(
    allElements(frame).every((e) => !('invalid' in e)),
    'P3: sin perfil detectado ningún elemento lleva `invalid`',
  );
});

// ── P4 — el camino estándar no cambia (§3.2) ────────────────────────────────

test('P4: aria-invalid propio marca; aria-invalid en un ANCESTRO no marca a sus descendientes (la propagación es sólo del perfil)', () => {
  const doc = makeDom(
    conFirma(
      '<form>' +
        '<input id="a" aria-label="Alfa" aria-invalid="true">' +
        '<div aria-invalid="true"><label for="b">Beta</label><input id="b"></div>' +
        '</form>',
    ),
  );
  const root = doc.body;
  const frame = serPerfil(root);

  const propio = emitidoPara(frame, root, doc.getElementById('a'), 'aria-invalid propio');
  assert.equal(propio.invalid, true, `P4: aria-invalid="true" propio ⇒ invalid:true; recibido ${JSON.stringify(propio)}`);

  const descendiente = emitidoPara(frame, root, doc.getElementById('b'), 'descendiente de aria-invalid');
  assert.equal(
    'invalid' in descendiente,
    false,
    'P4: el camino estándar se evalúa POR ELEMENTO — un aria-invalid ancestro no puede marcar al descendiente. ' +
      `Recibido ${JSON.stringify(descendiente)}`,
  );
});

// ── P5 — forma del resumen (§3.3, I-6) ──────────────────────────────────────

/** Orden canónico de las claves de una entrada (§3.3, determinismo PC9). */
const ORDEN_ENTRADA = ['ref', 'name', 'context', 'field', 'notInMap'];

/** Fixture de P5: dos portadores del perfil más un botón. */
const HTML_P5 =
  '<form>' +
  '<div class="demo-invalid-marker"><label for="a">Alfa</label><input id="a"></div>' +
  '<div class="demo-invalid-marker"><label for="b">Beta</label><input id="b"></div>' +
  '<button>Guardar</button>' +
  '</form>';

/**
 * §3.3 fija la POSICIÓN CANÓNICA de las claves nuevas de nivel superior:
 * `… invalidCount, invalidElements, invalidProfile, totalElements, …` — las dos
 * nuevas van INMEDIATAMENTE después de `invalidCount` y antes de
 * `totalElements`. Se verifica el orden REAL de `Object.keys`, no la mera
 * presencia: es determinismo de contrato (PC9 de fb-017-001), así que insertar
 * una clave en otro lugar tiene que romper.
 *
 * Deliberadamente NO se pinea la secuencia completa del frame (page,
 * totalPages, sections, read, …): esta feature no la fija y pinearla entera
 * sería sobre-especificar. Se exige exactamente lo que §3.3 declara: que el
 * tramo sea CONTIGUO y en ese orden.
 */
function assertTramoContiguo(frame, tramo, etiqueta) {
  const claves = Object.keys(frame);
  assert.deepEqual(
    tramo.filter((k) => claves.includes(k)),
    tramo,
    `${etiqueta} (§3.3): faltan claves del tramo esperado ${JSON.stringify(tramo)}; orden real=${JSON.stringify(claves)}`,
  );
  const posiciones = tramo.map((k) => claves.indexOf(k));
  for (let i = 1; i < tramo.length; i++) {
    assert.equal(
      posiciones[i],
      posiciones[i - 1] + 1,
      `${etiqueta} (§3.3): '${tramo[i]}' debe ir INMEDIATAMENTE después de '${tramo[i - 1]}'; ` +
        `orden real=${JSON.stringify(claves)}`,
    );
  }
}

test('P5 (§3.3): las claves nuevas de NIVEL SUPERIOR van en su posición canónica — invalidCount, invalidElements, invalidProfile, totalElements, contiguas y en ese orden', () => {
  const root = makeDom(conFirma(HTML_P5)).body;

  // (a) Con perfil y sin recortes: las tres claves nuevas, contiguas.
  //     `totalElements` no viaja acá (página única, sin filtro — P7d de
  //     fb-018-001), así que el tramo se verifica sin ella.
  assertTramoContiguo(
    serPerfil(root),
    ['invalidCount', 'invalidElements', 'invalidProfile'],
    'P5 orden (a) sin recortes',
  );

  // (b) Con un filtro que hace viajar `totalElements`: el tramo COMPLETO de
  //     §3.3, que es donde se ve que las dos nuevas se intercalan entre
  //     `invalidCount` y `totalElements` y no al final del objeto.
  const filtrado = serPerfil(root, { roles: ['button'] });
  assert.equal(
    filtrado.totalElements,
    3,
    `P5 orden (b): precondición — el filtro hace viajar totalElements; claves=${JSON.stringify(Object.keys(filtrado))}`,
  );
  assertTramoContiguo(
    filtrado,
    ['invalidCount', 'invalidElements', 'invalidProfile', 'totalElements'],
    'P5 orden (b) con filtro',
  );

  // (c) PIN de present-only: con invalidez exclusivamente estándar la clave
  //     `invalidProfile` está ausente (§3.5) y su ausencia NO descoloca a las
  //     demás — el tramo se cierra sin hueco.
  const estandar = serPerfil(
    makeDom(conFirma('<form><input aria-label="Alfa" aria-invalid="true"><button>Guardar</button></form>')).body,
    { roles: ['button'] },
  );
  assert.equal(
    'invalidProfile' in estandar,
    false,
    `P5 orden (c): precondición — sin entradas del perfil, invalidProfile está ausente; claves=${JSON.stringify(Object.keys(estandar))}`,
  );
  assertTramoContiguo(
    estandar,
    ['invalidCount', 'invalidElements', 'totalElements'],
    'P5 orden (c) sin invalidProfile',
  );
});

test('P5: con ≥1 inválido el frame trae invalidElements (objetos con ref y name) e invalidCount = total; sin inválidos no existe ninguna de las dos claves', () => {
  const doc = makeDom(conFirma(HTML_P5));
  const root = doc.body;
  const frame = serPerfil(root);

  assert.equal(frame.invalidCount, 2, `P5: invalidCount es el total; claves=${JSON.stringify(Object.keys(frame))}`);
  assert.ok(Array.isArray(frame.invalidElements), 'P5: invalidElements es un array');
  assert.equal(frame.invalidElements.length, 2, 'P5: una entrada por portador');
  for (const entrada of frame.invalidElements) {
    assert.equal(typeof entrada.ref, 'string', `P5: cada entrada trae \`ref\`; recibido ${JSON.stringify(entrada)}`);
    assert.ok(entrada.ref.length > 0, 'P5: el ref no puede ser el string vacío');
    assert.equal(typeof entrada.name, 'string', `P5: cada entrada trae \`name\`; recibido ${JSON.stringify(entrada)}`);
    // §3.3: orden de claves fijo dentro de la entrada (present-only, subconjunto).
    const claves = Object.keys(entrada);
    assert.deepEqual(
      claves,
      ORDEN_ENTRADA.filter((k) => claves.includes(k)),
      `P5 (§3.3): las claves de la entrada van en el orden canónico ${JSON.stringify(ORDEN_ENTRADA)}; recibido ${JSON.stringify(claves)}`,
    );
  }
  assert.deepEqual(
    frame.invalidElements.map((e) => e.name),
    ['Alfa', 'Beta'],
    'P5: `name` es el nombre accesible del portador',
  );

  const sano = serPerfil(makeDom(conFirma('<form><input aria-label="Alfa"><button>Guardar</button></form>')).body);
  assert.ok(allRefs(sano).length >= 2, 'no-vacuidad: el DOM sano igual emite sus elementos');
  for (const clave of ['invalidCount', 'invalidElements']) {
    assert.equal(clave in sano, false, `P5 (I-6): sin inválidos la clave ${clave} está AUSENTE (nunca 0 ni [])`);
  }
});

// ── P6 — alcanzabilidad: la trampa (§3.3, I-5) ──────────────────────────────

/**
 * Tres inválidos de DOS naturalezas, para que las tres vías de recorte muerdan
 * de verdad: dos `<input>` (elementos del mapa por el loop principal, que
 * `roles` y la paginación recortan) y una CELDA de una tabla CRUZADA
 * (`th[scope="row"]` por fila, patrón de contenido-asociado.test.js §2.2.2),
 * marcada inválida con texto propio.
 *
 * Review §3 (mayor 3): el cap de promoción sólo degrada tablas cruzadas, y
 * `0` es falsy para el parsing `(options && options.maxPromotedCells) ||
 * DEFAULT` del serializer (D-9, preexistente de fb-018-005, no se toca acá).
 * Por eso la tabla es 2×2 (4 celdas de dato: Ene/Feb × Ropa/Muebles) y el cap
 * usado es `3` —no `0`—: con la cota por default se promueven las 4 celdas
 * (medido en contenido-asociado.test.js P7); `maxPromotedCells:3` hace que la
 * tabla degrade a una celda por fila (la primera elegible), que es
 * EXACTAMENTE lo que saca de `sections` a la celda marcada ("Feb" de "Ropa",
 * la segunda de su fila) sin sacar a la primera ("Ene" de cada fila).
 */
const HTML_TRES_INVALIDOS =
  '<form>' +
  '<div class="demo-invalid-marker" data-demo-field="alfa"><label for="a">Alfa</label><input id="a"></div>' +
  '<div class="demo-invalid-marker" data-demo-field="beta"><label for="b">Beta</label><input id="b"></div>' +
  '<table><thead><tr><th></th><th>Ene</th><th>Feb</th></tr></thead><tbody>' +
  '<tr><th scope="row">Ropa</th><td>10</td><td id="c" class="demo-invalid-marker" data-demo-field="febRopa">20</td></tr>' +
  '<tr><th scope="row">Muebles</th><td>30</td><td>40</td></tr>' +
  '</tbody></table>' +
  '<button>Guardar</button><button>Descartar</button>' +
  '</form>';

test('P6 (I-5, la trampa): con roles + paginación + cap de promoción de tabla cruzada a la vez —cero inválidos en sections— el resumen igual trae los 3, y cada ref resuelve al nodo correcto', () => {
  const doc = makeDom(conFirma(HTML_TRES_INVALIDOS));
  const root = doc.body;
  const esperados = ['a', 'b', 'c'].map((id) => doc.getElementById(id));
  assert.equal(new Set(esperados).size, 3, 'precondición: los tres nodos inválidos son distintos');

  // Precondición estructural: SIN recortes, los tres inválidos son elementos
  // del mapa —incluida la celda, que entra por la promoción de grid—. Es lo que
  // le da mordida al tercer recorte: con el cap de promoción la celda deja de
  // estar en `sections` y el resumen tiene que traerla igual, y como PORTADOR
  // (no como marcador sin portador), porque I-5 computa antes de los caps.
  const base = serPerfil(root);
  const nodosBase = allElements(base).map((e) => resolveRef(e.ref, root));
  for (const nodo of esperados) {
    assert.ok(
      nodosBase.includes(nodo),
      `precondición: sin recortes, el nodo inválido <${nodo.tagName.toLowerCase()}#${nodo.id}> es elemento del mapa; ` +
        `refs=${JSON.stringify(allRefs(base))}`,
    );
  }

  // Precondición (review §3, mayor 3): el CAP MUERDE DE VERDAD por sí solo,
  // sin `roles` ni paginación de por medio — si no, la pata volvería a ser
  // inerte sin que nadie se entere, que es exactamente el defecto que se
  // corrige acá. Con SÓLO `maxPromotedCells:3` la celda marcada ("Feb" de
  // "Ropa") sale de `sections` porque la tabla cruzada degrada a una celda
  // por fila; los dos `<input>`, ajenos a la promoción de grid, no se ven
  // afectados por el cap.
  const soloCap = serPerfil(root, { maxPromotedCells: 3 });
  const nodosSoloCap = allElements(soloCap).map((e) => resolveRef(e.ref, root));
  assert.ok(
    !nodosSoloCap.includes(esperados[2]),
    `precondición (el cap muerde solo): con maxPromotedCells:3 la celda cruzada marcada sale de sections; ` +
      `refs=${JSON.stringify(allRefs(soloCap))}`,
  );
  assert.ok(
    nodosSoloCap.includes(esperados[0]) && nodosSoloCap.includes(esperados[1]),
    'precondición (el cap muerde solo): los dos inputs no se ven afectados por el cap de promoción de celdas',
  );

  const frame = serPerfil(root, {
    roles: ['button'],
    maxElementsPerPage: 1,
    maxPromotedCells: 3,
  });

  // No-vacuidad: `sections` NO puede estar vacío, o "cero inválidos en
  // sections" se cumpliría por un frame vacío (verde vacuo).
  const elementos = allElements(frame);
  assert.ok(
    elementos.length >= 1,
    `precondición: el recorte deja algo en sections (el botón); frame=${JSON.stringify(frame)}`,
  );
  assert.ok(
    elementos.every((e) => e.role === 'button'),
    'precondición: roles:["button"] recortó todo lo demás',
  );
  // Las tres vías de recorte, verificadas por identidad de nodo (no por conteo).
  const nodosEnSections = elementos.map((e) => resolveRef(e.ref, root));
  for (const nodo of esperados) {
    assert.ok(
      !nodosEnSections.includes(nodo),
      'precondición de la trampa: CERO elementos inválidos aparecen en sections',
    );
  }
  assert.ok(
    elementos.every((e) => !('invalid' in e)),
    'precondición de la trampa: ningún elemento de sections lleva `invalid`',
  );

  // La postcondición: el resumen se computa ANTES de filtrar, paginar y acotar.
  assert.equal(
    frame.invalidCount,
    3,
    `P6: invalidCount es 3 pese al triple recorte; frame=${JSON.stringify(frame)}`,
  );
  assert.ok(Array.isArray(frame.invalidElements), 'P6: invalidElements existe bajo el triple recorte');
  assert.equal(frame.invalidElements.length, 3, 'P6: las 3 entradas viajan pese al triple recorte');

  const resueltos = nodosDe(frame, root);
  for (const [i, nodo] of resueltos.entries()) {
    assert.ok(
      nodo,
      `P6 (I-7): la entrada ${i} debe resolver con resolveRef; ref=${frame.invalidElements[i].ref}`,
    );
  }
  assert.deepEqual(
    new Set(resueltos),
    new Set(esperados),
    'P6 (I-7): cada ref resuelve EXACTAMENTE al nodo inválido esperado (identidad de nodo, no coincidencia de string)',
  );
  assert.ok(
    frame.invalidElements.every((e) => !('notInMap' in e)),
    'P6 (I-5): los tres son PORTADORES —la celda incluida—, porque el resumen se computa antes del cap de ' +
      `promoción. Un resumen armado después del cap la degradaría a notInMap. Recibido ${JSON.stringify(frame.invalidElements)}`,
  );
});

// ── P7 — sin doble conteo jerárquico (§3.2, I-4) ────────────────────────────

test('P7 (§3.2): un widget marcado que contiene dos celdas marcadas con input produce invalidCount 2 y las dos entradas son los inputs (no 3, no 5)', () => {
  const doc = makeDom(
    conFirma(
      '<div class="demo-invalid-marker" data-demo-field="lineas">' +
        '<table><tbody>' +
        '<tr><td class="demo-invalid-marker"><input aria-label="Cantidad uno"></td></tr>' +
        '<tr><td class="demo-invalid-marker"><input aria-label="Cantidad dos"></td></tr>' +
        '</tbody></table>' +
        '</div>' +
        '<button>Guardar</button>',
    ),
  );
  const root = doc.body;
  const inputs = Array.from(doc.querySelectorAll('td input'));
  assert.equal(inputs.length, 2, 'precondición del fixture: dos inputs');

  const frame = serPerfil(root);

  assert.equal(
    frame.invalidCount,
    2,
    `P7: sólo los portadores más internos cuentan — ni el widget ni las celdas aportan entrada propia. frame=${JSON.stringify(frame)}`,
  );
  assert.equal((frame.invalidElements || []).length, 2, 'P7: dos entradas');
  assert.deepEqual(
    new Set(nodosDe(frame, root)),
    new Set(inputs),
    'P7: las dos entradas son los dos <input>, no el widget ni los <td>',
  );

  // I-4: el CONJUNTO de elementos de sections no cambia por esta feature.
  const sinMarcadores = makeDom(
    conFirma(
      '<div data-demo-field="lineas">' +
        '<table><tbody>' +
        '<tr><td><input aria-label="Cantidad uno"></td></tr>' +
        '<tr><td><input aria-label="Cantidad dos"></td></tr>' +
        '</tbody></table>' +
        '</div>' +
        '<button>Guardar</button>',
    ),
  ).body;
  assert.deepEqual(
    allRefs(frame),
    allRefs(serPerfil(sinMarcadores)),
    'P7 (I-4): el conjunto de elementos de sections es el mismo con y sin los marcadores',
  );
});

// ── P8 — marcador sin portador (§3.2, §3.3, I-4) ────────────────────────────

/** Celda sin descendiente interactivo y sin texto propio; `%MARCA%` se sustituye. */
const HTML_SIN_PORTADOR =
  '<table><tbody>' +
  '<tr><td>Linea uno</td><td%MARCA% data-demo-field="cantidad"></td></tr>' +
  '</tbody></table><button>Guardar</button>';

test('P8 (§3.2, I-4): una celda marcada sin portador aporta EXACTAMENTE una entrada con notInMap:true, y el conjunto de sections es idéntico al del mismo DOM sin el marcador', () => {
  const docCon = makeDom(conFirma(HTML_SIN_PORTADOR.replace('%MARCA%', ' class="demo-invalid-marker"')));
  const rootCon = docCon.body;
  const celda = docCon.querySelector('td.demo-invalid-marker');
  assert.ok(celda, 'precondición del fixture: existe la celda marcada');

  const conMarca = serPerfil(rootCon);

  assert.equal(
    conMarca.invalidCount,
    1,
    `P8: la celda sin portador aporta exactamente una entrada; frame=${JSON.stringify(conMarca)}`,
  );
  assert.equal((conMarca.invalidElements || []).length, 1, 'P8: exactamente una entrada');
  const entrada = conMarca.invalidElements[0];
  assert.equal(entrada.notInMap, true, `P8: la entrada se marca notInMap:true; recibido ${JSON.stringify(entrada)}`);
  assert.ok(
    'name' in entrada,
    `P8 (§12.1): la entrada notInMap tiene la clave name; recibido ${JSON.stringify(entrada)}`,
  );
  assert.equal(typeof entrada.name, 'string', 'P8 (§12.1): name es string (puede ser "")');
  assert.equal(
    resolveRef(entrada.ref, rootCon),
    celda,
    'P8 (I-7): el ref de la entrada resuelve al propio <td> marcado',
  );

  // I-4: el conjunto de elementos de sections no cambia — el marcador sin
  // portador NO se agrega a sections. Único delta entre los dos DOM: la clase.
  const rootSin = makeDom(conFirma(HTML_SIN_PORTADOR.replace('%MARCA%', ''))).body;
  const sinMarca = serPerfil(rootSin);
  assert.ok(allRefs(sinMarca).length >= 2, 'no-vacuidad: el DOM de referencia emite sus elementos');
  assert.deepEqual(
    allRefs(conMarca),
    allRefs(sinMarca),
    'P8 (I-4): el marcador sin portador no agrega (ni quita) ningún elemento de sections',
  );
  assert.ok(
    allElements(conMarca).every((e) => !('invalid' in e)),
    'P8: ningún elemento del mapa lleva `invalid`: el marcador no tiene portador',
  );
});

// ── P9 — huella (§3.4) ──────────────────────────────────────────────────────

test('P9 (§3.4): pasar de válido a inválido cambia fingerprint — (a) con portador y (b) con marcador SIN portador', () => {
  // (a) marcador con portador
  {
    const doc = makeDom(
      conFirma('<form><div id="w"><label for="a">Alfa</label><input id="a"></div><button>Guardar</button></form>'),
    );
    const root = doc.body;
    const antes = assertHuella(serPerfil(root), '(a) antes');
    doc.getElementById('w').classList.add('demo-invalid-marker');
    const despues = assertHuella(serPerfil(root), '(a) después');
    assert.notEqual(despues, antes, 'P9(a): el `invalid` del portador participa de la huella');
  }
  // (b) marcador SIN portador — el caso que evita un falso changedSinceLast:false
  {
    const doc = makeDom(conFirma(HTML_SIN_PORTADOR.replace('%MARCA%', ' id="celda"')));
    const root = doc.body;
    const antes = assertHuella(serPerfil(root), '(b) antes');
    const celda = doc.getElementById('celda');
    assert.ok(celda, 'precondición del fixture: existe la celda');
    celda.classList.add('demo-invalid-marker');
    const despues = assertHuella(serPerfil(root), '(b) después');
    assert.notEqual(
      despues,
      antes,
      'P9(b) (§3.4): un marcador SIN portador también participa de la huella; sin esto el pliegue de `act` ' +
        'diría changedSinceLast:false justo cuando el agente necesita mirar',
    );
  }
});

// ── P10 — `field` desde el atributo del perfil (§3.3) ───────────────────────

test('P10 (§3.3): `field` sale del atributo declarado por el perfil en el marcador MÁS CERCANO que lo tenga; si ninguno lo tiene, la clave está ausente', () => {
  const doc = makeDom(
    conFirma(
      '<form>' +
        // (a) el propio marcador lleva el atributo
        '<div class="demo-invalid-marker" data-demo-field="alfa"><label for="a">Alfa</label><input id="a"></div>' +
        // (b) marcador interno SIN el atributo, dentro de uno que sí lo tiene
        '<div class="demo-invalid-marker" data-demo-field="lineas">' +
        '<div class="demo-invalid-marker"><label for="b">Beta</label><input id="b"></div>' +
        '</div>' +
        // (c) ningún marcador de la cadena lleva el atributo
        '<div class="demo-invalid-marker"><label for="c">Gama</label><input id="c"></div>' +
        '</form>',
    ),
  );
  const root = doc.body;
  const frame = serPerfil(root);

  const porNodo = new Map((frame.invalidElements || []).map((e) => [resolveRef(e.ref, root), e]));
  assert.equal(frame.invalidCount, 3, `P10: precondición — tres portadores; frame=${JSON.stringify(frame)}`);

  const a = porNodo.get(doc.getElementById('a'));
  assert.ok(a, 'P10: hay entrada para el portador (a)');
  assert.equal(a.field, 'alfa', `P10(a): field del marcador propio; recibido ${JSON.stringify(a)}`);

  const b = porNodo.get(doc.getElementById('b'));
  assert.ok(b, 'P10: hay entrada para el portador (b)');
  assert.equal(
    b.field,
    'lineas',
    `P10(b): con el marcador interno sin el atributo, gana el marcador MÁS CERCANO que lo tenga; recibido ${JSON.stringify(b)}`,
  );

  const c = porNodo.get(doc.getElementById('c'));
  assert.ok(c, 'P10: hay entrada para el portador (c)');
  assert.equal(
    'field' in c,
    false,
    `P10(c) (I-6): sin ningún marcador con el atributo, la clave field está AUSENTE; recibido ${JSON.stringify(c)}`,
  );

  // Perfil SIN `fieldNameAttribute` (clave opcional de §3.1): nunca hay `field`.
  const sinAtributo = serPerfil(root, {}, [PERFIL_SIN_ATRIBUTO]);
  assert.equal(sinAtributo.invalidCount, 3, 'no-vacuidad: el perfil sin fieldNameAttribute igual detecta los 3');
  assert.ok(
    (sinAtributo.invalidElements || []).every((e) => !('field' in e)),
    'P10: un perfil que no declara fieldNameAttribute nunca produce la clave field',
  );
});

// ── P11 — marcador oculto (§3.2) ────────────────────────────────────────────

test('P11 (§3.2): un marcador oculto no aporta entrada ni suma a invalidCount; el visible del mismo DOM sí', () => {
  const doc = makeDom(
    conFirma(
      '<form>' +
        '<div class="demo-invalid-marker" style="display:none"><label for="a">Alfa</label><input id="a"></div>' +
        '<div class="demo-invalid-marker"><label for="b">Beta</label><input id="b"></div>' +
        '<button>Guardar</button>' +
        '</form>',
    ),
  );
  const root = doc.body;
  const frame = serPerfil(root);

  // No-vacuidad: el marcador VISIBLE sí aporta — sin esto, "el oculto no aporta"
  // sería verde vacuo si el mecanismo entero estuviera apagado.
  assert.equal(
    frame.invalidCount,
    1,
    `P11: sólo el marcador visible cuenta (el oculto por display:none no); frame=${JSON.stringify(frame)}`,
  );
  assert.equal((frame.invalidElements || []).length, 1, 'P11: exactamente una entrada');
  assert.equal(
    resolveRef(frame.invalidElements[0].ref, root),
    doc.getElementById('b'),
    'P11: la única entrada es la del marcador visible',
  );
});

// ── P12 — cota de payload (§3.3, §9.2) ──────────────────────────────────────

test('P12 (§3.3): con 25 inválidos, invalidElements trae 20 entradas e invalidCount es 25', () => {
  let campos = '';
  for (let i = 1; i <= 25; i++) {
    campos += `<div class="demo-invalid-marker"><input aria-label="Campo ${i}"></div>`;
  }
  const root = makeDom(conFirma(`<form>${campos}<button>Guardar</button></form>`)).body;
  const frame = serPerfil(root);

  assert.equal(frame.invalidCount, 25, `P12: invalidCount NO se acota; frame keys=${JSON.stringify(Object.keys(frame))}`);
  assert.equal(
    (frame.invalidElements || []).length,
    20,
    `P12: invalidElements se acota a 20 entradas; recibido ${(frame.invalidElements || []).length}`,
  );
});

// ── P13 — declaración del perfil activo (§3.5) ──────────────────────────────

test('P13 (§3.5): invalidProfile aparece sólo si ≥1 entrada vino del perfil; con invalidez exclusivamente estándar la clave está ausente aunque el perfil esté detectado', () => {
  // (a) invalidez SÓLO estándar, con el perfil DETECTADO (la firma está).
  const soloEstandar = makeDom(
    conFirma('<form><input id="a" aria-label="Alfa" aria-invalid="true"><button>Guardar</button></form>'),
  ).body;
  const frameEstandar = serPerfil(soloEstandar);
  assert.equal(
    frameEstandar.invalidCount,
    1,
    `no-vacuidad: el resumen corrió sobre la invalidez estándar; frame=${JSON.stringify(frameEstandar)}`,
  );
  assert.equal(
    'invalidProfile' in frameEstandar,
    false,
    `P13 (I-6): con invalidez exclusivamente estándar la clave invalidProfile está AUSENTE; ` +
      `claves=${JSON.stringify(Object.keys(frameEstandar))}`,
  );

  // (b) espejo de no-vacuidad: el MISMO DOM más un marcador del perfil sí la trae.
  const conPerfil = makeDom(
    conFirma(
      '<form><input id="a" aria-label="Alfa" aria-invalid="true">' +
        '<div class="demo-invalid-marker"><label for="b">Beta</label><input id="b"></div>' +
        '<button>Guardar</button></form>',
    ),
  ).body;
  const frameConPerfil = serPerfil(conPerfil);
  assert.equal(
    frameConPerfil.invalidProfile,
    'demo',
    `P13: con ≥1 entrada del perfil, invalidProfile nombra su id; frame=${JSON.stringify(frameConPerfil)}`,
  );
  assert.equal(frameConPerfil.invalidCount, 2, 'P13: el conteo suma las dos vías (estándar + perfil)');
});

// ── P14 — generalidad (I-1, I-2) ────────────────────────────────────────────

const NUCLEO = ['serializer.js', 'dialog.js', 'act.js', 'resolver.js', 'validity-profiles.js'];
const MODULO_PERFIL = 'profiles/odoo.js';

/** Tokens demasiado genéricos para ser "literal de producto". */
const GENERICOS = new Set([
  '', 'use strict', 'name', 'id', 'class', 'div', 'span', 'input', 'true', 'false',
  'null', 'undefined', 'string', 'object', 'function', 'detect', 'data', 'value', 'type',
]);

function leer(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/**
 * Literales de string de un módulo, tokenizados. NO se leen con los ojos: el
 * test los extrae en runtime. Comparar literal-contra-literal (y no contra el
 * archivo entero) evita falsos positivos por COMENTARIOS que mencionen el
 * producto: I-1 habla de literales de código, no de prosa.
 */
function literalesDe(src) {
  const out = new Set();
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const crudo of m[2].split(/[\s,>+~]+/)) {
      const tok = crudo.trim();
      if (!tok || tok.includes('/') || tok.endsWith('.js')) continue; // rutas de import
      for (const cand of [tok, tok.replace(/^[.#[]+/, '').replace(/[\]]+$/, '')]) {
        if (cand.length >= 3 && !GENERICOS.has(cand.toLowerCase())) out.add(cand);
      }
    }
  }
  return out;
}

test('P14 (I-1, grep): ningún literal del perfil de producto aparece en los literales del núcleo', () => {
  let fuentePerfil = null;
  try {
    fuentePerfil = leer(`./${MODULO_PERFIL}`);
  } catch (e) {
    assert.fail(
      `P14: ${MODULO_PERFIL} debe existir (§3.7: los literales del perfil viven en la capa de producto, ` +
        `no en el núcleo) — RED de fb-020-005. Error de lectura: ${e.message}`,
    );
  }
  const delPerfil = literalesDe(fuentePerfil);
  assert.ok(
    delPerfil.size > 0,
    'no-vacuidad: el módulo del perfil tiene que declarar literales (firma de raíz y selectores); ' +
      'sin esto el grep no podría fallar nunca y sería una verificación vacua',
  );

  for (const archivo of NUCLEO) {
    let fuente = null;
    try {
      fuente = leer(`./${archivo}`);
    } catch (e) {
      assert.fail(`P14: ${archivo} debe existir (I-1 lo nombra entre los archivos auditados). Error: ${e.message}`);
    }
    const compartidos = [...literalesDe(fuente)].filter((t) => delPerfil.has(t));
    assert.deepEqual(
      compartidos,
      [],
      `P14 (I-1): ${archivo} no puede contener ningún literal del perfil de producto; compartidos=${JSON.stringify(compartidos)}`,
    );
  }
});

test('P14 (unit, PIN): serializeFrame invocado SIN registro no reconoce ninguna convención de sitio', () => {
  // Mismo DOM que P1 (firma de raíz + marcadores), pero sin `validityProfiles`.
  const doc = makeDom(
    conFirma(
      '<form>' +
        '<div class="demo-invalid-marker" data-demo-field="alfa"><label for="a">Alfa</label><input id="a"></div>' +
        '<button>Guardar</button>' +
        '</form>',
    ),
  );
  const root = doc.body;
  const frame = serializeFrame(root, {});

  // No-vacuidad: el frame sí se produjo y sí contiene el input marcado.
  const el = emitidoPara(frame, root, doc.getElementById('a'), 'input marcado, sin registro');
  assert.equal('invalid' in el, false, `P14: sin registro el elemento no lleva invalid; recibido ${JSON.stringify(el)}`);
  for (const clave of ['invalidCount', 'invalidElements', 'invalidProfile']) {
    assert.equal(clave in frame, false, `P14 (I-2): sin registro no existe la clave ${clave}`);
  }
});

// ── P22 — marcador anidado con celdas identificatorias (§11.1) ──────────────

/**
 * El caso Odoo literal que P7 no desambigua: el marcador EXTERNO envuelve la
 * lista entera, así que adentro caen también las CELDAS PROMOVIDAS
 * IDENTIFICATORIAS de cada fila (la que muestra el nombre de la línea). Por la
 * letra de §3.2 serían portadores; por el ejemplo de §3.2 ("dos entradas, no
 * cinco") no. §11.1 elige: cuando un marcador contiene otros marcadores, los
 * portadores son SÓLO los de los marcadores internos.
 *
 * `td:1` de cada fila tiene texto propio y ningún candidato adentro ⇒ se
 * promueve (camino de grid) ⇒ es elemento del mapa dentro del marcador externo
 * y FUERA de todo marcador interno. `td:2` contiene un `<input>` ⇒ no se
 * promueve, y su input es el portador del marcador interno.
 */
const HTML_P22 =
  '<div class="demo-invalid-marker" data-demo-field="lineas">' +
  '<table><tbody>' +
  '<tr><td>Linea uno</td><td class="demo-invalid-marker"><input aria-label="Cantidad uno"></td></tr>' +
  '<tr><td>Linea dos</td><td class="demo-invalid-marker"><input aria-label="Cantidad dos"></td></tr>' +
  '</tbody></table>' +
  '</div>' +
  '<button>Guardar</button>';

test('P22 (§11.1): con marcadores anidados, los portadores son sólo los de los marcadores INTERNOS — las celdas identificatorias del externo no aportan entrada ni llevan `invalid`', () => {
  const doc = makeDom(conFirma(HTML_P22));
  const root = doc.body;
  const inputs = Array.from(doc.querySelectorAll('td input'));
  const etiquetas = Array.from(doc.querySelectorAll('tbody tr')).map((tr) => tr.querySelectorAll('td')[0]);
  const externo = doc.querySelector('div.demo-invalid-marker');
  assert.equal(inputs.length, 2, 'precondición del fixture: dos inputs, uno por marcador interno');
  assert.equal(etiquetas.length, 2, 'precondición del fixture: dos celdas identificatorias');

  const frame = serPerfil(root);

  // GUARDA DE NO-VACUIDAD, la que hace al test: las celdas identificatorias
  // TIENEN que ser elementos del mapa. Si no se promovieran, "ninguna entrada
  // apunta a una etiqueta" sería verde vacuo y P22 no probaría nada.
  const nodosEnSections = allElements(frame).map((e) => resolveRef(e.ref, root));
  for (const celda of etiquetas) {
    assert.ok(
      nodosEnSections.includes(celda),
      `no-vacuidad: la celda identificatoria "${celda.textContent}" tiene que estar en sections (promoción de ` +
        `grid) para que el caso de §11.1 exista; refs=${JSON.stringify(allRefs(frame))}`,
    );
  }

  // ── Consecuencia A de §11.1: la marca POR ELEMENTO sigue la misma regla ────
  // Ser portador es la ÚNICA definición de invalidez por perfil, y vale para
  // las DOS superficies: el resumen y `invalid` dentro de `sections`. Sacar las
  // celdas sólo del resumen dejaría el frame contradiciéndose —el agente vería
  // una celda marcada inválida que el resumen no menciona, sin forma de saber
  // cuál de las dos afirmaciones vale— y la contradicción se propagaría a la
  // huella (§3.4) y por lo tanto a `changedSinceLast`.
  //
  // Va ANTES de las aserciones del resumen a propósito: son hechos
  // independientes sobre `sections`, y puestas después quedarían sombreadas por
  // el primer fallo del resumen, sin dejar evidencia propia en el ledger RED.
  for (const celda of etiquetas) {
    const el = emitidoPara(frame, root, celda, `celda identificatoria "${celda.textContent}"`);
    assert.equal(
      'invalid' in el,
      false,
      `P22 (§11.1 consecuencia A, I-6): la celda identificatoria NO es portador, así que la clave \`invalid\` ` +
        `está AUSENTE de su elemento en sections (present-only: nunca \`invalid:false\`). ` +
        `Recibido ${JSON.stringify(el)} — invalidCount=${JSON.stringify(frame.invalidCount)}, ` +
        `invalidElements=${JSON.stringify(frame.invalidElements)}`,
    );
  }
  for (const input of inputs) {
    const el = emitidoPara(frame, root, input, 'input portador');
    assert.equal(
      el.invalid,
      true,
      `P22 (§11.1 consecuencia A): el portador del marcador interno SÍ lleva invalid:true — sin esta mitad, ` +
        `"ninguna celda lleva invalid" se cumpliría apagando la marca para todos. Recibido ${JSON.stringify(el)}`,
    );
  }
  // El camino ESTÁNDAR no entra en esta fixture a propósito: un elemento con
  // `aria-invalid` propio sumaría un portador y rompería el `invalidCount:2`
  // que es el corazón de P22. Esa mitad del contrato la cubre P4, que ya
  // verifica `aria-invalid` propio con el registro inyectado y sin relación con
  // ningún marcador.

  assert.equal(
    frame.invalidCount,
    2,
    `P22 (§11.1): sólo los portadores de los marcadores internos cuentan — las dos celdas identificatorias ` +
      `del marcador externo NO son portadores. frame=${JSON.stringify(frame)}`,
  );
  assert.equal((frame.invalidElements || []).length, 2, 'P22: exactamente dos entradas');

  const resueltos = nodosDe(frame, root);
  assert.deepEqual(
    new Set(resueltos),
    new Set(inputs),
    'P22: las dos entradas son los dos <input> de los marcadores internos',
  );
  for (const celda of etiquetas) {
    assert.ok(
      !resueltos.includes(celda),
      `P22 (§11.1): ninguna entrada puede apuntar a una celda de etiqueta ("${celda.textContent}") — no es ` +
        'un campo corregible, es contexto',
    );
  }
  assert.ok(
    !resueltos.includes(externo),
    'P22 (§11.1): el marcador EXTERNO no aporta entrada propia; ya la aportan los internos',
  );
  assert.ok(
    (frame.invalidElements || []).every((e) => !('notInMap' in e)),
    `P22 (§11.1): notInMap sigue aplicando sólo a marcadores SIN marcadores internos; acá los dos internos ` +
      `tienen portador. Recibido ${JSON.stringify(frame.invalidElements)}`,
  );

  // El marcador externo sigue aportando DATO (el nombre del campo, §3.3: el
  // marcador más cercano que tenga el atributo), aunque no aporte ENTRADA. Es
  // exactamente la distinción que hace el ruling.
  for (const entrada of frame.invalidElements) {
    assert.equal(
      entrada.field,
      'lineas',
      `P22: el marcador externo aporta el nombre del campo sin aportar entrada; recibido ${JSON.stringify(entrada)}`,
    );
  }
});

// ── P22b — marcador anidado SIN ningún elemento del mapa adentro (§11.1-B) ──

/**
 * Fixture hermana de P22 (review.md §1: "el hueco de cobertura es parte del
 * hallazgo"). §11.1 Consecuencia B fija DOS condiciones conjuntivas para que
 * un marcador aporte entrada `notInMap`: que no tenga marcadores internos Y
 * que no tenga elementos del mapa adentro. P22 sólo ejerce la SEGUNDA: su
 * marcador externo queda suprimido porque tiene portadores (los inputs)
 * adentro, nunca porque tenga un marcador interno per se. Esta fixture aísla
 * la PRIMERA: externo con un interno adentro, y CERO elementos del mapa en
 * todo el árbol — ni celdas con texto, ni controles, ni nada. Así, la única
 * razón posible para que el externo no aporte entrada es "contiene un
 * marcador interno", no "tiene portadores adentro".
 */
const HTML_P22B =
  '<form>' +
  '<div class="demo-invalid-marker" data-demo-field="lineas">' +
  '<div class="demo-invalid-marker" data-demo-field="precio"></div>' +
  '</div>' +
  '<button>Guardar</button>' +
  '</form>';

test('P22b (§11.1 consecuencia B, primera cláusula): un marcador externo que contiene un marcador interno SIN ningún elemento del mapa adentro no aporta entrada propia — sólo cuenta el interno', () => {
  const doc = makeDom(conFirma(HTML_P22B));
  const root = doc.body;
  const externo = doc.querySelector('div.demo-invalid-marker');
  const interno = externo.querySelector('div.demo-invalid-marker');

  // Precondiciones del fixture: la estructura es la que el hallazgo exige.
  assert.ok(externo, 'precondición del fixture: existe el marcador externo');
  assert.ok(interno, 'precondición del fixture: existe un marcador interno DENTRO del externo');
  assert.notEqual(interno, externo, 'precondición del fixture: interno y externo son nodos distintos');
  assert.ok(
    externo.contains(interno),
    'precondición del fixture: el marcador interno está anidado dentro del externo',
  );
  assert.equal(
    externo.textContent.trim(),
    '',
    'precondición del fixture: el árbol entero (externo + interno) no tiene texto propio',
  );
  assert.equal(
    externo.querySelectorAll('input, button, a, select, textarea, [role]').length,
    0,
    'precondición del fixture: ningún elemento del mapa (control interactivo) cae dentro del externo — ' +
      'el único candidato del DOM es el <button> Guardar, que está FUERA de ambos marcadores',
  );

  const frame = serPerfil(root);

  assert.equal(
    frame.invalidCount,
    1,
    `P22b (§11.1-B): sólo el marcador MÁS INTERNO aporta entrada — el externo, aunque también carece de ` +
      `portadores y de elementos del mapa adentro, no cuenta porque CONTIENE un marcador interno. ` +
      `frame=${JSON.stringify(frame)}`,
  );
  assert.equal((frame.invalidElements || []).length, 1, 'P22b: exactamente una entrada');

  const entrada = frame.invalidElements[0];
  assert.equal(
    entrada.notInMap,
    true,
    `P22b: la única entrada es un marcador sin portador; recibido ${JSON.stringify(entrada)}`,
  );
  assert.equal(
    resolveRef(entrada.ref, root),
    interno,
    `P22b (I-7, identidad de nodo): el ref de la entrada resuelve al marcador INTERNO — no al externo — ` +
      `comparado por identidad de nodo con resolveRef, no por igualdad de strings; ref=${entrada.ref}`,
  );
  assert.notEqual(
    resolveRef(entrada.ref, root),
    externo,
    'P22b: la entrada NO resuelve al marcador externo (el doble conteo jerárquico que §3.2 prohíbe)',
  );
});

// ── Composición (I-9, §3.7) ─────────────────────────────────────────────────

test('I-9 (§3.7): el entry del bundle inyecta el registro y su serializeFrame es el camino real de la extensión', () => {
  const registro = entry.VALIDITY_PROFILES;
  assert.ok(
    Array.isArray(registro),
    'I-9: index.js debe exportar VALIDITY_PROFILES —el registro que la composición inyecta— para que el test ' +
      `ejerza la MISMA composición que corre la extensión; exports=${JSON.stringify(Object.keys(entry))}`,
  );
  assert.ok(registro.length >= 1, 'I-9: el registro compuesto trae al menos un perfil');
  for (const perfil of registro) {
    assert.equal(typeof perfil.id, 'string', `§3.1: cada perfil declara un id string; recibido ${JSON.stringify(perfil)}`);
    assert.ok(perfil.id.length > 0, '§3.1: el id no puede ser vacío');
    assert.equal(typeof perfil.detect, 'function', `§3.1: cada perfil declara detect(doc); perfil ${perfil.id}`);
    assert.equal(
      typeof perfil.invalidMarkerSelector,
      'string',
      `§3.1: cada perfil declara invalidMarkerSelector; perfil ${perfil.id}`,
    );
  }
  // Los literales del perfil de Odoo no están en el spec a propósito, así que la
  // DETECCIÓN real no es observable desde acá (cae en P16/P20, dev-harness y
  // campo). Lo que sí se ejerce es que el serializeFrame del entry es el camino
  // real y toma el registro como DATO: con el registro de prueba, resuelve.
  const doc = makeDom(conFirma('<form><div class="demo-invalid-marker"><label for="a">Alfa</label><input id="a"></div></form>'));
  const root = doc.body;
  const frame = entry.serializeFrame(root, { validityProfiles: REGISTRO });
  assert.equal(
    frame.invalidCount,
    1,
    `I-9: el serializeFrame del entry aplica el registro inyectado; frame=${JSON.stringify(frame)}`,
  );
});
