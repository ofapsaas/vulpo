/**
 * campo-selector-expands.test.js — fb-020-009-campo-de-seleccion (sub-fase RED).
 *
 * Verifica P1–P8 de docs/specs/fb-020-009-campo-de-seleccion/spec.md §3
 * (P9 es Go unit sobre la descripción de vlp_getFrame, P10 es grep del
 * SKILL de Odoo, P11 es campo — ninguna de las tres vive en este archivo).
 *
 * Escrito SOLO contra el contrato del spec §2: el test-writer NO leyó
 * serializer.js, resolver.js, index.js ni ningún módulo de implementación.
 * `serializeFrame` (serializer.js) y `resolveRef` (resolver.js) ya existen y
 * son el oráculo observable, igual que en validez-perfil-sitio.test.js.
 *
 * ── Fixtures ──────────────────────────────────────────────────────────────
 * El markup real de §1.3 (Odoo) es:
 *   <div class="o-dropdown dropdown-toggle" aria-expanded="false">
 *     <input type="text" class="o_select_menu_toggler" id="...">
 *   </div>
 * Los fixtures de acá usan una clase genérica ("dropdown-toggle", sin
 * prefijo "o_" / "o-") a propósito: la señal que importa es el atributo ARIA
 * `aria-expanded`, no ninguna clase de Odoo (§1.3 "primero genérico"; I-1).
 *
 * ── Naturaleza RED esperada ──────────────────────────────────────────────
 *  · FALLAN por AssertionError (la clave `expands` no existe todavía):
 *    P1, P2, P3, P4, P6, P7.
 *  · PIN / anti-regresión — se espera que PASE ya en RED:
 *    P5 (golden byte-a-byte del build vigente sobre un DOM SIN ningún
 *    aria-expanded: hoy pasa porque el output de ese DOM no cambia con esta
 *    feature; su trabajo de verificación empieza en GREEN) y P8 (grep de
 *    generalidad: hoy serializer.js no tiene ningún código de `expands`
 *    todavía, así que no puede haber colisión de literales; sigue debiendo
 *    pasar después de GREEN).
 *
 * ── GOLDEN_P5 — de dónde sale ─────────────────────────────────────────────
 * Capturado (2026-09-18) corriendo el build PRE-feature real con
 * `npx --yes --no-install node --test` sobre un archivo temporal que hacía
 * `serializeFrame(root, {})` con el fixture de abajo (formulario con dos
 * <input> con <label for> y un <button>, sin ningún `aria-expanded` en el
 * árbol) y volcaba `JSON.stringify(frame)` + `frame.fingerprint` por
 * console.log. El archivo temporal se borró antes de commitear; NO queda en
 * el árbol. Coincide byte a byte con GOLDEN_GATING de
 * validez-perfil-sitio.test.js (mismo fixture salvo por dos atributos
 * `class`/`data-*` de OTRA feature, que no aportan a ningún ref/name/value
 * emitido — PC6: los refs son tag+nth-of-type, sin id/class/data — así que
 * quitarlos no mueve ni un byte del frame ni de la huella). Este archivo NO
 * re-captura el golden en GREEN: si cambia, la feature movió la salida de un
 * DOM sin `aria-expanded`, que es exactamente lo que I-2 prohíbe.
 *
 * ── Ambigüedades del spec halladas en RED (informadas al orquestador) ─────
 *  (1) §2.1 no dice qué pasa con un `aria-expanded` cuyo valor no es
 *      literalmente "true" ni "false" (ausente del todo, "", u otro string).
 *      No se escribe un test para ese caso: ninguna postcondición P1–P8 lo
 *      pide, y sería sobre-especificar (hardening, no RED). Queda para el
 *      implementer decidir con criterio conservador (ninguno de los dos
 *      ⇒ ausencia de la clave, análogo a I-6 del resto del frame) y, si el
 *      dueño del proceso lo quiere fijado, amerita su propia postcondición.
 *  (2) §2.2 dice "inmediatamente después de `role`". Se interpreta LITERAL
 *      (adyacencia estricta con `role`, antes incluso de `name`/`tag`), no
 *      "en algún punto antes de `value`" — la formulación con dos anclas
 *      ("después de role Y antes de value") sólo es informativa sobre dónde
 *      cae el tramo si se toma la adyacencia estricta con `role`; P6 lo
 *      verifica con `assertTramoContiguo(['role','expands','name'])`.
 *  (3) HALLAZGO (no ambigüedad de redacción, sí un hueco): el frame YA tiene
 *      una clave `expanded` (fb-018-002-estado-observable §3, singular
 *      participio) que mapea DIRECTO el `aria-expanded` PROPIO del elemento
 *      (confirmado corriendo P4 en RED: un `<input aria-expanded="true">`
 *      sin ningún perfil de esta feature ya emite `"expanded":true` HOY). El
 *      spec de esta feature no menciona esa clave preexistente en absoluto.
 *      Para un elemento con `aria-expanded` PROPIO (caso P4), las dos claves
 *      van a coexistir con el MISMO valor booleano (`expanded` y `expands`
 *      ambas `true`/`false` en simultáneo) — no hay contradicción de datos,
 *      pero sí un riesgo real de confusión para el agente/lector (`expanded`
 *      = mi propio estado ARIA; `expands` = hay que abrirme, mirando también
 *      mis ancestros). No se escribe ningún test sobre esa coexistencia
 *      (ninguna postcondición P1–P8 la pide), pero queda reportado al
 *      orquestador para que decida si amerita una nota en la spec o en el
 *      SKILL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

// ── Helpers (patrón de validez-perfil-sitio.test.js) ────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function ser(root, options = {}) {
  return serializeFrame(root, options);
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
/** Guarda de no-vacuidad de la huella (patrón payload-efficiency.test.js / validez-perfil-sitio.test.js). */
function assertHuella(frame, etiqueta) {
  assert.equal(
    typeof frame.fingerprint,
    'string',
    `${etiqueta}: serializeFrame debe devolver \`fingerprint\` como string. Sin esta guarda, una comparación ` +
      'de huellas sería undefined !== undefined (verde vacuo, rojo por canal faltante y no por contrato).',
  );
  assert.ok(frame.fingerprint.length > 0, `${etiqueta}: la huella no puede ser el string vacío`);
  return frame.fingerprint;
}
/** Tramo contiguo de claves de nivel de ELEMENTO, en el orden exacto dado (§2.2). */
function assertTramoContiguo(objeto, tramo, etiqueta) {
  const claves = Object.keys(objeto);
  assert.deepEqual(
    tramo.filter((k) => claves.includes(k)),
    tramo,
    `${etiqueta} (§2.2): faltan claves del tramo esperado ${JSON.stringify(tramo)}; orden real=${JSON.stringify(claves)}`,
  );
  const posiciones = tramo.map((k) => claves.indexOf(k));
  for (let i = 1; i < tramo.length; i++) {
    assert.equal(
      posiciones[i],
      posiciones[i - 1] + 1,
      `${etiqueta} (§2.2): '${tramo[i]}' debe ir INMEDIATAMENTE después de '${tramo[i - 1]}'; ` +
        `orden real=${JSON.stringify(claves)}`,
    );
  }
}

// ── P1 — ancestro cerrado (§2.1) ────────────────────────────────────────────

test('P1: un <input> dentro de un ancestro con aria-expanded="false" lleva expands:false; el mismo input SIN ese ancestro no lleva la clave', () => {
  const doc = makeDom(
    '<form>' +
      '<div class="dropdown-toggle" aria-expanded="false"><label for="a">Campo</label><input id="a"></div>' +
      '<div><label for="b">Otro</label><input id="b"></div>' +
      '</form>',
  );
  const root = doc.body;
  const frame = ser(root);

  const conAncestro = emitidoPara(frame, root, doc.getElementById('a'), 'input dentro del ancestro cerrado');
  const sinAncestro = emitidoPara(frame, root, doc.getElementById('b'), 'input sin ancestro con aria-expanded');

  assert.equal(
    conAncestro.expands,
    false,
    `P1: el input dentro del ancestro con aria-expanded="false" lleva expands:false; recibido ${JSON.stringify(conAncestro)}`,
  );
  assert.equal(
    'expands' in sinAncestro,
    false,
    `P1 (present-only §2.1): sin ningún aria-expanded en la cadena, la clave expands está AUSENTE; recibido ${JSON.stringify(sinAncestro)}`,
  );
});

// ── P2 — ancestro abierto (§2.1) ────────────────────────────────────────────

test('P2: con aria-expanded="true" en el ancestro, el input lleva expands:true', () => {
  const doc = makeDom(
    '<form>' +
      '<div class="dropdown-toggle" aria-expanded="true"><label for="a">Campo</label><input id="a"></div>' +
      '</form>',
  );
  const root = doc.body;
  const frame = ser(root);

  const el = emitidoPara(frame, root, doc.getElementById('a'), 'input dentro del ancestro abierto');
  assert.equal(
    el.expands,
    true,
    `P2: el input dentro del ancestro con aria-expanded="true" lleva expands:true; recibido ${JSON.stringify(el)}`,
  );
});

// ── P3 — ancestro MÁS CERCANO gana (§2.1) ───────────────────────────────────

test('P3: con dos ancestros de aria-expanded distintos, gana el INTERIOR (más cercano) — no el que se encuentra primero subiendo desde la raíz', () => {
  const doc = makeDom(
    '<form>' +
      '<div class="dropdown-toggle-externo" aria-expanded="true">' +
      '<div class="dropdown-toggle-interno" aria-expanded="false">' +
      '<label for="a">Campo</label><input id="a">' +
      '</div>' +
      '</div>' +
      '</form>',
  );
  const root = doc.body;
  const frame = ser(root);

  const el = emitidoPara(frame, root, doc.getElementById('a'), 'input con dos ancestros de valores opuestos');
  assert.equal(
    el.expands,
    false,
    'P3: el ancestro MÁS CERCANO (interno, aria-expanded="false") gana sobre el externo ("true"); ' +
      `un bug que tomara el primero subiendo desde la raíz daría true. Recibido ${JSON.stringify(el)}`,
  );
});

// ── P4 — aria-expanded PROPIO, sin ancestro (§2.1, ajustado por §8.1) ───────

// §8.1 (spec v1.1, decisión HITL post-RED): el caso del atributo PROPIO ya lo
// cubre la clave preexistente `expanded` (fb-018-002 §3) — el RED de este
// archivo lo encontró corriendo el build real. `expands` (nueva) se emite
// SÓLO cuando el elemento NO lleva `aria-expanded` propio y es su ENVOLTORIO
// el que lo declara (P1-P3). Las dos claves nunca coexisten en el mismo
// elemento. Edición de test autorizada por §8.1 (única en este pase): P4
// pasa de esperar `expands:true` a esperar `expanded:true`.
test('P4: un elemento con aria-expanded PROPIO lleva `expanded` (clave preexistente, §8.1) — no necesita ningún ancestro, y no es `expands`', () => {
  const doc = makeDom('<form><label for="a">Campo</label><input id="a" aria-expanded="true"></form>');
  const root = doc.body;
  const frame = ser(root);

  const el = emitidoPara(frame, root, doc.getElementById('a'), 'input con aria-expanded propio');
  assert.equal(
    el.expanded,
    true,
    `P4 (§8.1): aria-expanded="true" PROPIO (sin ancestro) ⇒ expanded:true — la clave PREEXISTENTE de ` +
      `fb-018-002 §3, no la nueva \`expands\` (que sólo aplica cuando el envoltorio lo declara, P1-P3). ` +
      `Recibido ${JSON.stringify(el)}`,
  );
});

// ── P5 — no-regresión (I-2), golden literal ─────────────────────────────────

const HTML_SIN_ARIA_EXPANDED =
  '<main aria-label="Panel">' +
  '<form>' +
  '<div><label for="a">Alfa</label><input id="a"></div>' +
  '<div><label for="b">Beta</label><input id="b"></div>' +
  '<button>Guardar</button>' +
  '</form>' +
  '</main>';

/** Golden capturado del build PRE-feature — ver cabecera del archivo. */
const HUELLA_P5 = 'd10c3cc0a9dcbe04';
const GOLDEN_P5 =
  '{"page":1,"totalPages":1,"sections":[{"title":"form","elements":[' +
  '{"ref":"main>form>div:1>input","role":"textbox","name":"Alfa","tag":"input","disabled":false,"visible":true,"value":""},' +
  '{"ref":"main>form>div:2>input","role":"textbox","name":"Beta","tag":"input","disabled":false,"visible":true,"value":""},' +
  '{"ref":"main>form>button","role":"button","name":"Guardar","tag":"button","disabled":false,"visible":true}' +
  ']}],"read":[],"fingerprint":"d10c3cc0a9dcbe04"}';

test('P5 (I-2, no-regresión): sobre un DOM SIN ningún aria-expanded, el frame es byte-idéntico al del build vigente', () => {
  const root = makeDom(HTML_SIN_ARIA_EXPANDED).body;
  const frame = ser(root);

  assert.equal(
    frame.fingerprint,
    HUELLA_P5,
    'P5: la huella del build vigente no se mueve cuando no hay ningún aria-expanded en el árbol (I-2: la línea ' +
      'de base es el pin vigente, no el build nuevo contra sí mismo)',
  );
  assert.equal(
    JSON.stringify(frame),
    GOLDEN_P5,
    'P5 (I-2): el frame es byte-idéntico al del build vigente',
  );
  assert.ok(
    allElements(frame).every((e) => !('expands' in e)),
    'P5: sin aria-expanded en el árbol, ningún elemento lleva la clave expands',
  );
});

// ── P6 — orden canónico (§2.2), test HERMANO para no quedar sombreado ───────

test('P6 (§2.2): expands va INMEDIATAMENTE después de role y antes de name/tag/value, verificado sobre Object.keys', () => {
  const doc = makeDom(
    '<form><div class="dropdown-toggle" aria-expanded="false"><label for="a">Campo</label><input id="a"></div></form>',
  );
  const root = doc.body;
  const frame = ser(root);
  const el = emitidoPara(frame, root, doc.getElementById('a'), 'input con expands');

  // No-vacuidad: la clave tiene que estar, o el tramo se cumpliría vacío.
  assert.ok('expands' in el, `no-vacuidad: el elemento debe llevar la clave expands; recibido ${JSON.stringify(el)}`);

  assertTramoContiguo(el, ['role', 'expands', 'name'], 'P6 orden');
});

// ── P7 — huella (§2.1 análogo a §3.4 de fb-020-005) ─────────────────────────

test('P7: abrir el desplegable (expands false→true) cambia el fingerprint', () => {
  // El aria-expanded va en el <div> ANCESTRO, NUNCA en el <input> mismo, a
  // propósito — no "simplificar" esto. El frame YA tiene una clave `expanded`
  // preexistente (fb-018-002 §3) que mapea DIRECTO el aria-expanded PROPIO de
  // un elemento: si el atributo estuviera en el <input>, la huella cambiaría
  // HOY por esa clave vieja, sin que exista todavía ni una línea de `expands`,
  // y el test pasaría en rojo por la razón EQUIVOCADA (vacuo respecto de esta
  // feature). El <div> no es un candidato del mapa (no tiene role/tabindex/
  // onclick), así que hoy su aria-expanded no se refleja en NINGÚN lado del
  // frame — de ahí que la huella sea idéntica antes/después en este RED.
  const doc = makeDom(
    '<form><div class="dropdown-toggle" aria-expanded="false"><label for="a">Campo</label><input id="a"></div></form>',
  );
  const root = doc.body;

  const antes = assertHuella(ser(root), 'antes (expands:false)');
  doc.querySelector('[aria-expanded]').setAttribute('aria-expanded', 'true');
  const despues = assertHuella(ser(root), 'después (expands:true)');

  assert.notEqual(
    despues,
    antes,
    'P7: pasar de false a true (abrir el desplegable) tiene que cambiar la huella — de lo contrario el pliegue ' +
      'de act (changedSinceLast) no vería la apertura',
  );
});

// ── P8 — generalidad (I-1, grep) ────────────────────────────────────────────

const NUCLEO = ['serializer.js', 'resolver.js', 'dialog.js', 'act.js', 'validity-profiles.js'];
const MODULO_PERFIL_ODOO = 'profiles/odoo.js';

/** Tokens demasiado genéricos para ser "literal de producto" (mismo criterio que validez-perfil-sitio.test.js). */
const GENERICOS = new Set([
  '', 'use strict', 'name', 'id', 'class', 'div', 'span', 'input', 'true', 'false',
  'null', 'undefined', 'string', 'object', 'function', 'detect', 'data', 'value', 'type',
]);

function leer(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/**
 * Literales de string de un módulo, tokenizados en RUNTIME (nunca leídos "con
 * los ojos"): evita falsos positivos por comentarios que mencionen el
 * producto — I-1 habla de literales de código, no de prosa.
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

/**
 * Familia de clases de producto de Odoo TAL COMO aparecen en el markup real
 * de §1.3 del spec: "o-dropdown", "o_select_menu_toggler",
 * "o_select_menu_caret". Ninguna vive hoy en `profiles/odoo.js` (que trae los
 * marcadores de OTRA feature, invalidez — `.o_field_invalid` y afines), así
 * que el chequeo de intersección de más abajo (heredado de
 * validez-perfil-sitio.test.js P14) NO puede detectar el riesgo específico de
 * ESTA feature: que el implementer copie un literal de §1.3 directo al
 * núcleo. Se lo audita aparte, por prefijo, sin necesidad de leer ningún
 * archivo de implementación con los ojos (extraído en runtime, igual que
 * `literalesDe`). Confirmado (RED, este mismo archivo corrido aislado con
 * `npx --yes --no-install node --test`) que hoy NINGÚN archivo de NUCLEO trae
 * un literal `o_`/`o-`: el chequeo no es vacuo por casualidad del build
 * actual, y si algún día lo fuera dejaría de discriminar nada — por eso va
 * ACOTADO a la familia de §1.3, no a cualquier prefijo `o_`/`o-` genérico que
 * pudiera aparecer por una razón ajena a esta feature.
 */
const LITERALES_S1_3 = ['o-dropdown', 'o_select_menu_toggler', 'o_select_menu_caret'];

test('P8 (I-1, grep): ningún literal de producto (perfil de Odoo, incluidos los de §1.3) aparece en los literales del núcleo por causa de esta feature', () => {
  let fuentePerfil = null;
  try {
    fuentePerfil = leer(`./${MODULO_PERFIL_ODOO}`);
  } catch (e) {
    assert.fail(
      `P8: ${MODULO_PERFIL_ODOO} debe existir (ya lo creó fb-020-005; se reusa acá como catálogo de literales ` +
        `de producto para el grep de generalidad). Error de lectura: ${e.message}`,
    );
  }
  const delPerfil = literalesDe(fuentePerfil);
  assert.ok(
    delPerfil.size > 0,
    'no-vacuidad: el módulo del perfil de Odoo tiene que declarar literales; sin esto el grep no podría fallar ' +
      'nunca y sería una verificación vacua',
  );

  for (const archivo of NUCLEO) {
    let fuente = null;
    try {
      fuente = leer(`./${archivo}`);
    } catch (e) {
      assert.fail(`P8: ${archivo} debe existir. Error: ${e.message}`);
    }
    const literales = literalesDe(fuente);

    // (a) intersección contra el catálogo de profiles/odoo.js (patrón P14 de
    //     validez-perfil-sitio.test.js) — cubre reutilizar UNO DE ESOS literales.
    const compartidos = [...literales].filter((t) => delPerfil.has(t));
    assert.deepEqual(
      compartidos,
      [],
      `P8a (I-1): ${archivo} no puede contener ningún literal de producto de Odoo (catálogo profiles/odoo.js) ` +
        `por causa de esta feature; compartidos=${JSON.stringify(compartidos)}`,
    );

    // (b) los literales LITERALES del markup de §1.3 (el riesgo real de ESTA
    //     feature: copiar directo "o-dropdown"/"o_select_menu_toggler"/
    //     "o_select_menu_caret" al núcleo en vez de leer sólo aria-expanded).
    const deS13 = [...literales].filter((t) => LITERALES_S1_3.includes(t));
    assert.deepEqual(
      deS13,
      [],
      `P8b (I-1, §1.3): ${archivo} no puede contener ninguno de los literales del markup de ejemplo de Odoo ` +
        `(${JSON.stringify(LITERALES_S1_3)}) — la señal genérica es sólo aria-expanded; compartidos=${JSON.stringify(deS13)}`,
    );
  }
});
