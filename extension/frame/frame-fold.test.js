/**
 * frame-fold.test.js — fb-020-008-act-frame-fold (sub-fase RED).
 *
 * Verifica P6, P7, P8, P9, P10, P12, P13, P14, P15, P16, P17, P18, P19, P20 y
 * P23 del spec docs/specs/fb-020-008-act-frame-fold/spec.md §3, más los
 * invariantes I-1 (equivalencia del mapeo de opciones) e I-2 (opt-in total) en
 * forma TABULAR sobre el vocabulario completo de §2.1.1.
 * (P11, P21 y P22 están RETIRADAS en el spec; P1–P5 son Go unit; P24–P29 E2E;
 * P30 T-doc.)
 *
 * Escrito SOLO contra el contrato del spec: el test-writer no leyó
 * background.js ni frame-serializer.js. El único módulo de implementación que
 * el test importa es `serializer.js`, que YA existe y es el oráculo
 * independiente del mapa (precedente payload-efficiency.test.js / settle.test.js).
 *
 * Vive en extension/frame/ por el runner (package.json con node --test *.test.js
 * y jsdom); importa el módulo del pliegue por ruta relativa (precedente
 * extension/odoo/nav-core.test.js, que testea extension/nav-guard.js).
 *
 * ── Interfaz declarada por test-writer para el implementer ──────────────────
 * Módulo NUEVO: extension/frame-fold.js (ESM, mundo BACKGROUND, dependencias
 * inyectadas). Motivo: background.js no es importable en node (spec de
 * fb-018-006 §8, settle.test.js:32), y §6 de este spec manda verificar en JS
 * unit el orden de las esperas, el valor de la espera declarada, el sembrado de
 * la marca antes de la lectura y la degradación a `frameError` — nada de eso es
 * observable desde el harness. La extracción es la misma maniobra que
 * fb-020-007 hizo con extension/nav-guard.js.
 *
 * export const FRAME_FOLD_KEYS
 *   Las 8 claves aceptadas de §2.1.1 (`omitIfUnchanged` NO está: §9.1).
 *
 * export function frameReadOptions(frameArg) → { settle, waitMs, quietMs, serializerOptions }
 *   Mapeo ÚNICO de `frame` a los parámetros de la lectura (I-1: el pliegue y
 *   getFrame usan este mismo mapeo; no hay una segunda ruta).
 *   - settle: default true (§2.1.2), waitMs: 5000, quietMs: 300.
 *   - serializerOptions: SOLO las claves de acotamiento PRESENTES en frameArg
 *     (page, maxElementsPerPage, include, roles, namedOnly), verbatim. Las
 *     ausentes NO aparecen (ni como null/undefined): ningún filtro por default
 *     (§2.1.1/P8). Nunca lleva settle/waitMs/quietMs (viven en la espera).
 *
 * export function declaredFoldWait({ actionWaitMs, frameWaitMs }) → number
 *   §2.3.1/§2.3.2 (P14): actionWaitMs + 2·frameWaitMs. `actionWaitMs` es 0 para
 *   click/focus/select (no hay observación de campo escrito).
 *
 * export async function actWithFold({ params, performAction, readFrame, lastFrameByTab, declareWait }) → respuesta de la tool
 *   - params: los params del wire ({tabId, ref, action, value?, waitMs?, quietMs?, frame?}).
 *   - performAction({ declaredWaitMs }) → Promise<respuesta de la acción>:
 *     despacha la acción Y corre la observación del campo escrito hasta su
 *     desenlace (§2.3 paso 2). Puede rechazar (error de la acción o del gate).
 *   - readFrame({ tabId, options, settle, waitMs, quietMs, kind }) → Promise<{ frame, settled?, waitedMs? }>:
 *     la lectura del mapa (§2.3 paso 3). `kind` DEBE ser 'wait' (§2.7/P13).
 *     `frame` incluye `fingerprint`. Puede rechazar, o resolver frame null /
 *     resolver sin resultado ⇒ degradación a `frameError` (§2.7/P12).
 *   - lastFrameByTab: Map<tabId, fingerprint> — el marcador de
 *     `changedSinceLast` (§2.5/P9/P10/I-4).
 *   - declareWait(totalMs): reporta al watchdog/hub la espera declarada
 *     (§2.3.2/P14). Se llama ANTES de despachar la acción.
 *   Devuelve la respuesta de la acción INTACTA más exactamente una de
 *   `frame`/`frameError` cuando el pliegue corrió (I-3), o la respuesta tal
 *   cual cuando no corrió (sin `frame` ni `frameError`, §2.4/P15/P16).
 *   El `frame` devuelto es el mapa serializado SIN `fingerprint` (§2.2) más
 *   `invalidation: { changedSinceLast, [settled, waitedMs], [navigating] }`
 *   (presencia ⇔ pedidos; `navigating` present-only).
 *
 * export async function navigateWithFold({ params, navigateTab, replacesDocument, seedNavigating, waitForNavCommit, readFrame, lastFrameByTab, declareWait }) → respuesta de la tool
 *   - params: {tabId, url, frame?}.
 *   - navigateTab({ tabId, url }) → Promise<{success:true, tabId, url}> (vigente).
 *   - replacesDocument(...) → boolean (§2.6: falso ⇒ solo fragmento).
 *   - seedNavigating(tabId): siembra la marca; con pliegue va ANTES de
 *     cualquier lectura (§2.6/P18).
 *   - waitForNavCommit({ tabId, waitMs }) → Promise<{ committed: boolean }>:
 *     la ÚNICA ruta de espera de commit (reuso, §2.6/P18). committed:false ⇒
 *     techo vencido ⇒ settled:false + navigating:true (I-5).
 *
 * ── Guard pattern de RED ────────────────────────────────────────────────────
 * `extension/frame-fold.js` NO existe todavía: import dinámico con catch → null
 * y CADA test abre con assert.ok(...) — hoy TODOS fallan por AssertionError (el
 * comportamiento no existe), nunca por error de carga del archivo.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 * Los 22 tests de este archivo FALLAN hoy por el guard de módulo. No hay pines
 * verdes: el pliegue es funcionalidad nueva completa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';

const FOLD_URL = new URL('../frame-fold.js', import.meta.url);

let mod = null;
try {
  mod = await import(FOLD_URL.href);
} catch {
  mod = null; // RED: el módulo lo crea el implementer en GREEN.
}
const frameReadOptions = mod?.frameReadOptions ?? null;
const declaredFoldWait = mod?.declaredFoldWait ?? null;
const actWithFold = mod?.actWithFold ?? null;
const navigateWithFold = mod?.navigateWithFold ?? null;
const FRAME_FOLD_KEYS = mod?.FRAME_FOLD_KEYS ?? null;

const GUARD = (id, nombre) =>
  `extension/frame-fold.js debe existir y exportar ${nombre} (${id}) — RED de fb-020-008`;

// ── Fixtures ────────────────────────────────────────────────────────────────

const HTML_RICO =
  '<main aria-label="panel">' +
  '<h1>Presupuesto</h1>' +
  '<div><label for="a">Cliente</label><input id="a" value="uno"></div>' +
  '<div><label for="b">Referencia</label><input id="b" value="dos"></div>' +
  '<div><label for="c">Notas</label><textarea id="c">libre</textarea></div>' +
  '<button>Guardar</button><button>Descartar</button>' +
  '<p>texto de contexto</p>' +
  '</main>';

function makeDom(html = HTML_RICO) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

function allElements(frame) {
  if (!Array.isArray(frame?.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}

/**
 * Harness de `act`: traza el ORDEN de invocación de las esperas inyectadas
 * (P6/P17) y cuenta las lecturas (P15/P16). Sin mocks de plumbing: cada
 * dependencia es una frontera de comportamiento declarada en la interfaz.
 */
function actHarness({
  doc = makeDom(),
  params = {},
  actionResponse = { ok: true },
  actionThrows = null,
  read = null,
  settleOutcome = { settled: true, waitedMs: 120 },
  lastFrameByTab = new Map(),
} = {}) {
  const trace = [];
  const reads = [];
  const declared = [];

  const performAction = async (args) => {
    trace.push('accion:despacho');
    await new Promise((r) => setTimeout(r, 5)); // observación del campo escrito
    trace.push('accion:desenlace');
    if (actionThrows) throw actionThrows;
    return actionResponse;
  };

  const readFrame =
    read ??
    (async (args) => {
      trace.push('lectura:inicio');
      reads.push(args);
      const frame = serializeFrame(doc.body, args.options ?? {});
      const salida = { frame };
      if (args.settle) {
        salida.settled = settleOutcome.settled;
        salida.waitedMs = settleOutcome.waitedMs;
      }
      trace.push('lectura:fin');
      return salida;
    });

  const readSpy = async (args) => {
    if (read) {
      trace.push('lectura:inicio');
      reads.push(args);
      try {
        return await read(args);
      } finally {
        trace.push('lectura:fin');
      }
    }
    return readFrame(args);
  };

  return {
    doc,
    trace,
    reads,
    declared,
    lastFrameByTab,
    deps: {
      params: { tabId: 7, ref: 'main>button:1', action: 'click', ...params },
      performAction,
      readFrame: readSpy,
      lastFrameByTab,
      declareWait: (ms) => declared.push(ms),
    },
  };
}

/** Harness de `navigate`. */
function navHarness({
  doc = makeDom(),
  params = {},
  replaces = true,
  committed = true,
  read = null,
  settleOutcome = { settled: true, waitedMs: 90 },
  lastFrameByTab = new Map(),
} = {}) {
  const trace = [];
  const reads = [];
  const commits = [];
  const seeds = [];
  const declared = [];

  const readSpy = async (args) => {
    trace.push('lectura:inicio');
    reads.push(args);
    if (read) return read(args);
    const frame = serializeFrame(doc.body, args.options ?? {});
    const salida = { frame };
    if (args.settle) {
      salida.settled = settleOutcome.settled;
      salida.waitedMs = settleOutcome.waitedMs;
    }
    return salida;
  };

  return {
    doc,
    trace,
    reads,
    commits,
    seeds,
    declared,
    lastFrameByTab,
    deps: {
      params: { tabId: 7, url: 'http://local/destino', ...params },
      navigateTab: async ({ tabId, url }) => {
        trace.push('navigate:despacho');
        return { success: true, tabId, url };
      },
      replacesDocument: () => replaces,
      seedNavigating: (tabId) => {
        trace.push('seed');
        seeds.push(tabId);
      },
      waitForNavCommit: async (args) => {
        trace.push('commit:inicio');
        commits.push(args);
        await new Promise((r) => setTimeout(r, 5));
        trace.push('commit:fin');
        return { committed };
      },
      readFrame: readSpy,
      lastFrameByTab,
      declareWait: (ms) => declared.push(ms),
    },
  };
}

// ── §2.1.1 / P7 / P8 / I-1: mapeo de opciones ───────────────────────────────

test('P7 (§2.1.1/§2.1.2): frame:{} ⇒ settle true por default, waitMs 5000, quietMs 300 y CERO opciones de acotamiento', () => {
  assert.ok(frameReadOptions, GUARD('P7', 'frameReadOptions'));
  const o = frameReadOptions({});
  assert.equal(o.settle, true, 'P7: dentro del pliegue el default de settle se invierte respecto de getFrame (§2.1.2)');
  assert.equal(o.waitMs, 5000, 'P7: default waitMs 5000 (§2.1.1)');
  assert.equal(o.quietMs, 300, 'P7: default quietMs 300 (§2.1.1)');
  assert.deepEqual(
    o.serializerOptions,
    {},
    'P8: sin claves de acotamiento en el request, NINGUNA viaja al serializer — ni como null: ningún filtro por default (§2.1.1)',
  );
});

test('P7 (settle:false): frame:{settle:false} ⇒ settle efectivo false y los techos siguen siendo los defaults', () => {
  assert.ok(frameReadOptions, GUARD('P7', 'frameReadOptions'));
  const o = frameReadOptions({ settle: false });
  assert.equal(o.settle, false, 'P7: settle:false sigue disponible para una lectura barata e inmediata (§2.1.2)');
  assert.equal(o.waitMs, 5000, 'P7: waitMs conserva su default');
  assert.equal(o.quietMs, 300, 'P7: quietMs conserva su default');
});

test('P8 / I-1 (tabular sobre el vocabulario completo de §2.1.1): cada clave se mapea a su ámbito y NINGUNA ausente aparece', () => {
  assert.ok(frameReadOptions, GUARD('P8/I-1', 'frameReadOptions'));
  assert.ok(Array.isArray(FRAME_FOLD_KEYS), GUARD('P8/I-1', 'FRAME_FOLD_KEYS'));

  // El vocabulario son OCHO claves, no nueve: `omitIfUnchanged` fue retirada
  // del contrato (§2.1.1/§9.1) y no puede reaparecer como clave aceptada.
  assert.deepEqual(
    [...FRAME_FOLD_KEYS].sort(),
    ['include', 'maxElementsPerPage', 'namedOnly', 'page', 'quietMs', 'roles', 'settle', 'waitMs'],
    'P8: el vocabulario aceptado es exactamente el de §2.1.1 — 8 claves, sin `omitIfUnchanged` (§9.1)',
  );

  const ACOTAMIENTO = { page: 3, maxElementsPerPage: 7, include: 'both', roles: ['textbox'], namedOnly: true };
  const ESPERA = { settle: false, waitMs: 1234, quietMs: 56 };

  // (a) Una clave a la vez: la de acotamiento llega al serializer verbatim y
  // SOLA; la de espera nunca entra al serializer (I-1: mismo mapeo que
  // getFrame, donde settle/waitMs/quietMs viven en la capa de espera —
  // settle.test.js "I-C").
  for (const [clave, valor] of Object.entries(ACOTAMIENTO)) {
    const o = frameReadOptions({ [clave]: valor });
    assert.deepEqual(
      o.serializerOptions,
      { [clave]: valor },
      `P8 (${clave}): la clave presente viaja verbatim y sola; las ausentes NO aparecen (ni como null)`,
    );
  }
  for (const [clave, valor] of Object.entries(ESPERA)) {
    const o = frameReadOptions({ [clave]: valor });
    assert.deepEqual(
      o.serializerOptions,
      {},
      `P8/I-1 (${clave}): los parámetros de espera jamás entran a serializeFrame`,
    );
    assert.equal(o[clave], valor, `P8 (${clave}): el parámetro de espera se conserva verbatim en su propio ámbito`);
  }

  // (b) El vocabulario completo junto: acotamiento completo y espera completa,
  // cada uno en su ámbito, sin mezcla.
  const todo = { ...ACOTAMIENTO, ...ESPERA };
  const o = frameReadOptions(todo);
  assert.deepEqual(o.serializerOptions, ACOTAMIENTO, 'P8: con el vocabulario completo, el serializer recibe exactamente las 5 de acotamiento');
  assert.equal(o.settle, false);
  assert.equal(o.waitMs, 1234);
  assert.equal(o.quietMs, 56);
  for (const k of ['settle', 'waitMs', 'quietMs', 'omitIfUnchanged']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(o.serializerOptions, k),
      false,
      `P8/I-1: serializerOptions no puede llevar ${k}`,
    );
  }
});

// Nota de alcance (I-1, mitad no testeable en unit): la equivalencia exige que
// getFrame use ESTE mismo mapeo. El handler de getFrame vive en background.js,
// que no es importable en node (settle.test.js:32), así que desde acá solo se
// puede pinear que el pliegue tiene UNA sola ruta de mapeo (este test) y que su
// mapa es el de serializeFrame con esas opciones (P6). La otra mitad —que
// getFrame no tenga un mapeo propio divergente— queda cubierta por E2E P25 y
// por code review del handler. Limitación declarada, no omisión.
// No se agrega infraestructura de property testing: el repo no la tiene
// (frame/package.json: jsdom + esbuild), así que I-1/I-2 se verifican en forma
// TABULAR sobre el vocabulario completo, que es exhaustivo para 8 claves.

test('P14 (§2.3.1/§2.3.2): la espera declarada es la SUMA de los techos — act type suma el techo del campo, el resto no', () => {
  assert.ok(declaredFoldWait, GUARD('P14', 'declaredFoldWait'));
  assert.equal(
    declaredFoldWait({ actionWaitMs: 5000, frameWaitMs: 5000 }),
    15000,
    'P14: act type + pliegue con defaults ⇒ 5000 + 2·5000 = 15000 (§2.3.1)',
  );
  assert.equal(
    declaredFoldWait({ actionWaitMs: 0, frameWaitMs: 5000 }),
    10000,
    'P14: click/focus/select + pliegue ⇒ 2·5000 = 10000 (§2.3.1)',
  );
  assert.equal(
    declaredFoldWait({ actionWaitMs: 1000, frameWaitMs: 30000 }),
    61000,
    'P14: un frame.waitMs alto tiene que verse en la espera DECLARADA, o el hub corta con command_timeout mientras el pliegue esperaba legítimamente (§2.3.2)',
  );
});

// ── act: el mecanismo del pliegue ───────────────────────────────────────────

test('P6 (§2.3/§2.2): con ok:true la lectura corre DESPUÉS del desenlace de la acción; el mapa es el de serializeFrame con esas opciones, sin fingerprint, y las claves de la acción quedan intactas', async () => {
  assert.ok(actWithFold, GUARD('P6', 'actWithFold'));
  const h = actHarness({
    params: { frame: { roles: ['textbox'] } },
    actionResponse: { ok: true, ref: 'main>button:1', action: 'click' },
  });
  const res = await actWithFold(h.deps);

  // Orden: la lectura arranca después del desenlace de la acción (§2.3).
  assert.deepEqual(
    h.trace.slice(0, 3),
    ['accion:despacho', 'accion:desenlace', 'lectura:inicio'],
    `P6: la lectura no puede arrancar antes del desenlace de la acción; traza=${JSON.stringify(h.trace)}`,
  );
  assert.equal(h.reads.length, 1, 'P6: exactamente una lectura por pliegue');

  // Las claves de la acción, intactas.
  assert.equal(res.ok, true, 'P6: la respuesta de la acción no cambia en ninguna de sus claves actuales (§2.2)');
  assert.equal(res.ref, 'main>button:1');
  assert.equal(res.action, 'click');

  // El mapa: oráculo independiente = serializeFrame con las mismas opciones.
  const esperado = serializeFrame(h.doc.body, frameReadOptions({ roles: ['textbox'] }).serializerOptions);
  assert.ok(typeof esperado.fingerprint === 'string' && esperado.fingerprint.length > 0,
    'precondición: el oráculo produce huella (si no, la aserción de ausencia sería vacua)');
  assert.ok(res.frame, 'P6: con ok:true y `frame` pedido, el pliegue devuelve el mapa');
  assert.equal(
    Object.prototype.hasOwnProperty.call(res.frame, 'fingerprint'),
    false,
    'P6/§2.2: la huella NO viaja al cliente, igual que hoy en getFrame',
  );
  const sinInvalidation = { ...res.frame };
  delete sinInvalidation.invalidation;
  const oraculo = { ...esperado };
  delete oraculo.fingerprint;
  assert.deepEqual(
    sinInvalidation,
    oraculo,
    'P6: clave por clave, el mapa plegado es el mapa serializado con las opciones de frameReadOptions — el pliegue no recorta, ' +
      'no reordena ni agrega nada más que `invalidation` (la mitad getFrame de I-1 no es unit-verificable: ver nota de alcance)',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(res, 'frameError'),
    false,
    'I-3: exactamente una de frame/frameError',
  );
});

test('P7 (pliegue): frame:{} ⇒ invalidation con changedSinceLast+settled+waitedMs; frame:{settle:false} ⇒ cero espera de documento e invalidation SOLO con changedSinceLast', async () => {
  assert.ok(actWithFold, GUARD('P7', 'actWithFold'));

  const conSettle = actHarness({ params: { frame: {} }, settleOutcome: { settled: true, waitedMs: 120 } });
  const res1 = await actWithFold(conSettle.deps);
  assert.equal(conSettle.reads[0].settle, true, 'P7: frame:{} pide quiescencia (settle efectivo true, §2.1.2)');
  assert.equal(conSettle.reads[0].waitMs, 5000, 'P7: el techo del documento es frame.waitMs (default 5000)');
  assert.equal(conSettle.reads[0].quietMs, 300, 'P7: la ventana de quietud es frame.quietMs (default 300)');
  assert.deepEqual(
    Object.keys(res1.frame.invalidation).sort(),
    ['changedSinceLast', 'settled', 'waitedMs'],
    'P7: con settle, invalidation trae changedSinceLast, settled y waitedMs (presencia ⇔ pedidos, §2.2)',
  );
  assert.equal(res1.frame.invalidation.settled, true);
  assert.equal(res1.frame.invalidation.waitedMs, 120);

  const sinSettle = actHarness({ params: { frame: { settle: false } } });
  const res2 = await actWithFold(sinSettle.deps);
  assert.equal(sinSettle.reads[0].settle, false, 'P7: settle:false ⇒ CERO espera de documento');
  assert.deepEqual(
    Object.keys(res2.frame.invalidation),
    ['changedSinceLast'],
    'P7: sin settle, invalidation trae SOLO changedSinceLast — ni settled ni waitedMs (present-only, I-2)',
  );
});

test('P8 (acotamiento efectivo): con roles:["textbox"] el mapa plegado tiene estrictamente MENOS elementos que sin filtro sobre el mismo DOM', async () => {
  assert.ok(actWithFold, GUARD('P8', 'actWithFold'));
  const doc = makeDom();
  const sinFiltro = actHarness({ doc, params: { frame: {} } });
  const conFiltro = actHarness({ doc, params: { frame: { roles: ['textbox'] } } });
  const res1 = await actWithFold(sinFiltro.deps);
  const res2 = await actWithFold(conFiltro.deps);

  const n1 = allElements(res1.frame).length;
  const n2 = allElements(res2.frame).length;
  assert.ok(n1 > 0, 'precondición: el fixture emite elementos (si no, "menos elementos" sería vacuo)');
  assert.ok(n2 > 0, 'precondición: el filtro no vacía el mapa (hay textbox en el fixture)');
  assert.ok(
    n2 < n1,
    `P8: roles/namedOnly son el requisito que hace útil al ciclo — con roles:["textbox"] el mapa debe acotarse ` +
      `(sin filtro=${n1}, con filtro=${n2}); un pass-through roto devolvería la página 1 SIN FILTRAR (§2.1.1)`,
  );
  assert.deepEqual(
    conFiltro.reads[0].options,
    { roles: ['textbox'] },
    'P8: las opciones de acotamiento llegan al serializer en la misma forma que por getFrame, y solo las presentes',
  );
});

test('P9 / I-4 (marcador): todo pliegue actualiza lastFrameByTab con la huella leída — incluido el camino settle:false', async () => {
  assert.ok(actWithFold, GUARD('P9', 'actWithFold'));
  for (const frameArg of [{}, { settle: false }, { roles: ['textbox'] }]) {
    const marcador = new Map();
    const h = actHarness({ params: { frame: frameArg }, lastFrameByTab: marcador });
    await actWithFold(h.deps);
    const huella = serializeFrame(h.doc.body, frameReadOptions(frameArg).serializerOptions).fingerprint;
    assert.ok(typeof huella === 'string' && huella.length > 0, 'precondición: el oráculo produce huella');
    assert.equal(
      marcador.get(7),
      huella,
      `P9/I-4 (frame:${JSON.stringify(frameArg)}): ninguna ruta de pliegue puede dejar el marcador desactualizado — ` +
        'la siguiente lectura explícita reportaría changedSinceLast con deshonestidad (§2.5)',
    );
  }
});

test('P10 (§2.5): primer pliegue sin huella previa ⇒ changedSinceLast:true; segundo sobre el mismo DOM ⇒ false y el mapa VIAJA IGUAL, completo', async () => {
  assert.ok(actWithFold, GUARD('P10', 'actWithFold'));
  const doc = makeDom();
  const marcador = new Map();
  const primero = await actWithFold(actHarness({ doc, params: { frame: {} }, lastFrameByTab: marcador }).deps);
  assert.equal(
    primero.frame.invalidation.changedSinceLast,
    true,
    'P10: sin huella previa el veredicto es changedSinceLast:true',
  );

  const segundo = await actWithFold(actHarness({ doc, params: { frame: {} }, lastFrameByTab: marcador }).deps);
  assert.equal(
    segundo.frame.invalidation.changedSinceLast,
    false,
    'P10: mismo DOM sin cambios ⇒ changedSinceLast:false',
  );
  const a = { ...primero.frame };
  const b = { ...segundo.frame };
  delete a.invalidation;
  delete b.invalidation;
  assert.ok(allElements(segundo.frame).length > 0, 'P10: el mapa del segundo pliegue no puede venir vacío');
  assert.deepEqual(
    b,
    a,
    'P10/§2.5: con changedSinceLast:false el mapa VIAJA IGUAL y completo — no hay omisión (`omitIfUnchanged` salió del contrato, §9.1/D-6)',
  );
});

test('P12 (§2.7 — divergencia deliberada): una lectura fallida NO propaga: degrada a frameError y la respuesta de la acción queda intacta', async () => {
  assert.ok(actWithFold, GUARD('P12', 'actWithFold'));
  const accion = { ok: true, ref: 'main>button:1', action: 'click' };

  const casos = [
    {
      nombre: 'la función in-page lanza',
      read: async () => {
        throw new Error('serialization failed (inyectado por el test)');
      },
    },
    { nombre: 'el resultado es null', read: async () => ({ frame: null }) },
    { nombre: 'no hay resultado de inyección', read: async () => undefined },
  ];

  for (const c of casos) {
    const h = actHarness({ params: { frame: {} }, actionResponse: accion, read: c.read });
    // Captura directa (no assert.doesNotReject): si actWithFold rechazara, el
    // await falla el test — "no lanza" queda verificado por construcción. Es la
    // divergencia explícita con getFrame(settle), que en el mismo caso SÍ lanza:
    // un implementer que reuse esa función tal cual hereda el throw y rompe §2.7.
    const res = await actWithFold(h.deps);
    assert.equal(res.ok, true, `P12 (${c.nombre}): la respuesta de la acción queda intacta — la acción YA ocurrió`);
    assert.equal(res.ref, accion.ref, `P12 (${c.nombre}): ninguna clave de la acción se pierde`);
    assert.equal(res.action, accion.action);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res, 'frame'),
      false,
      `P12 (${c.nombre}): I-3 — nunca frame y frameError a la vez`,
    );
    assert.ok(res.frameError, `P12 (${c.nombre}): el pliegue corrió y falló ⇒ frameError (§2.7)`);
    const msg = String(res.frameError.error ?? '');
    assert.ok(
      msg.includes('the action completed'),
      `P12 (${c.nombre}): el mensaje debe decir que la acción se completó (si no, el agente reintenta algo ya hecho): ${msg}`,
    );
    assert.ok(
      msg.includes('re-read with getFrame'),
      `P12 (${c.nombre}): el mensaje debe orientar a la acción siguiente (re-read with getFrame): ${msg}`,
    );
  }
});

test('P13 (§2.7): la lectura se vigila con kind "wait" y un rechazo por orfandad de navegación degrada a frameError, nunca a writeOutcomeUnknownError("act")', async () => {
  assert.ok(actWithFold, GUARD('P13', 'actWithFold'));
  const orfandad = Object.assign(new Error('injection rejected: tab navigated'), { navigated: true });
  const h = actHarness({
    params: { frame: {} },
    actionResponse: { ok: true, ref: 'main>button:1', action: 'click' },
    read: async () => {
      throw orfandad;
    },
  });
  const res = await actWithFold(h.deps);

  assert.equal(
    h.reads[0].kind,
    'wait',
    'P13: la inyección del pliegue se vigila con kind "wait", no "act" — ya hay resultado de la acción (§2.7)',
  );
  assert.equal(res.ok, true, 'P13: la respuesta de la acción queda intacta');
  assert.ok(res.frameError, 'P13: el rechazo durante la LECTURA produce frameError');
  const msg = String(res.frameError.error ?? '');
  assert.ok(msg.includes('the action completed'), `P13: el mensaje afirma que la acción se completó: ${msg}`);
  assert.ok(msg.includes('re-read with getFrame'), `P13: el mensaje orienta a releer: ${msg}`);
  for (const prohibido of ['may have been dispatched', 'outcome unknown', 'unknown outcome', 'safe to retry']) {
    assert.equal(
      msg.toLowerCase().includes(prohibido),
      false,
      `P13: el mensaje NO puede ser el de writeOutcomeUnknownError('act') — contiene "${prohibido}": ${msg}`,
    );
  }
});

test('P14 (pliegue): la espera declarada que el pliegue reporta es la SUMA de los techos, no solo la de la acción', async () => {
  assert.ok(actWithFold, GUARD('P14', 'actWithFold'));

  const escribir = actHarness({
    params: { action: 'type', value: 'Cliente X', ref: 'main>input:1', waitMs: 5000, frame: { waitMs: 5000 } },
    actionResponse: { ok: true, value: 'Cliente X', settled: true, waitedMs: 40 },
  });
  await actWithFold(escribir.deps);
  assert.deepEqual(
    escribir.declared,
    [15000],
    `P14: act type + pliegue declara act.waitMs + 2·frame.waitMs = 15000 (§2.3.1/§2.3.2); declarado=${JSON.stringify(escribir.declared)}`,
  );

  const clickear = actHarness({ params: { action: 'click', frame: { waitMs: 3000 } } });
  await actWithFold(clickear.deps);
  assert.deepEqual(
    clickear.declared,
    [6000],
    `P14: click + pliegue declara 2·frame.waitMs = 6000; declarado=${JSON.stringify(clickear.declared)}`,
  );
});

test('P15 (§2.4, no-regresión): con ok:false la lectura se invoca CERO veces y la respuesta es la vigente, sin frame ni frameError', async () => {
  assert.ok(actWithFold, GUARD('P15', 'actWithFold'));
  // Discriminador con P23 (§2.4): el criterio es `ok`, NO la presencia de
  // `nativeDialog`. Un diálogo nativo YA PENDIENTE bloquea la acción ⇒ ok:false
  // ⇒ no hay pliegue (este test). Un click que ABRE el diálogo devuelve ok:true
  // + nativeDialog ⇒ el pliegue SÍ corre, sin esperar (P23).
  const respuestas = [
    { ok: false, stale: true },
    { ok: false, inert: true },
    { ok: false, disabled: true },
    // Forma EXACTA del guard vigente de pregunta pendiente (conjunto
    // {ok, nativeDialog, error}, native-dialog-guard-act.test.js:76-95): usar
    // otra forma dejaría este caso verde sobre un estado que el código nunca
    // produce.
    {
      ok: false,
      nativeDialog: { type: 'confirm', message: '¿Confirmar?', pending: true },
      error: 'native dialog pending',
    },
    { ok: false, error: 'ref not resolved' },
  ];
  for (const vigente of respuestas) {
    const h = actHarness({ params: { frame: {} }, actionResponse: vigente });
    const res = await actWithFold(h.deps);
    assert.equal(
      h.reads.length,
      0,
      `P15 (${JSON.stringify(vigente)}): nada que leer si nada pasó — la lectura se invoca 0 veces`,
    );
    assert.equal(
      JSON.stringify(res),
      JSON.stringify(vigente),
      `P15: la respuesta debe ser byte-idéntica a la vigente (sin frame ni frameError); got ${JSON.stringify(res)}`,
    );
  }
});

test('P16 (§2.4, write gate): una acción rechazada por el gate de plan/build no despierta ninguna lectura', async () => {
  assert.ok(actWithFold, GUARD('P16', 'actWithFold'));

  // Forma (a): el gate devuelve la respuesta de rechazo vigente.
  const rechazo = { ok: false, planMode: true, error: 'plan mode: write blocked' };
  const h = actHarness({ params: { frame: {} }, actionResponse: rechazo });
  const res = await actWithFold(h.deps);
  assert.equal(h.reads.length, 0, 'P16: sin acción no hay pliegue — 0 lecturas');
  assert.equal(JSON.stringify(res), JSON.stringify(rechazo), 'P16: la respuesta del gate viaja tal cual');

  // Forma (b): el gate lanza. El error de la acción manda (§2.7 última cláusula)
  // y tampoco hay lectura.
  const boom = new Error('plan mode: write blocked');
  const h2 = actHarness({ params: { frame: {} }, actionThrows: boom });
  await assert.rejects(
    () => actWithFold(h2.deps),
    (e) => e === boom,
    'P16: si la ACCIÓN falla, su error manda tal cual — el pliegue no lo convierte en otra cosa (§2.7)',
  );
  assert.equal(h2.reads.length, 0, 'P16: la acción que falló no despierta ninguna lectura');
});

test('P17 (§2.3): la observación del campo escrito termina ANTES de que arranque la espera del documento, y los dos settled son independientes', async () => {
  assert.ok(actWithFold, GUARD('P17', 'actWithFold'));

  const casos = [
    { campo: { settled: true, waitedMs: 40 }, doc: { settled: false, waitedMs: 5000 } },
    { campo: { settled: false, waitedMs: 5000 }, doc: { settled: true, waitedMs: 130 } },
  ];
  for (const c of casos) {
    const h = actHarness({
      params: { action: 'type', value: 'Cliente X', ref: 'main>input:1', frame: {} },
      actionResponse: { ok: true, value: 'Cliente X', settled: c.campo.settled, waitedMs: c.campo.waitedMs },
      settleOutcome: c.doc,
    });
    const res = await actWithFold(h.deps);

    const iDesenlace = h.trace.indexOf('accion:desenlace');
    const iLectura = h.trace.indexOf('lectura:inicio');
    assert.ok(iDesenlace >= 0 && iLectura >= 0, `precondición: ambas esperas corrieron; traza=${JSON.stringify(h.trace)}`);
    assert.ok(
      iDesenlace < iLectura,
      `P17: nunca en paralelo, nunca fusionadas — la espera del documento arranca recién tras el desenlace del campo; traza=${JSON.stringify(h.trace)}`,
    );

    assert.equal(res.value, 'Cliente X', 'P17: la respuesta conserva `value` de nivel superior');
    assert.equal(res.settled, c.campo.settled, 'P17: el `settled` de nivel superior sigue cubriendo SOLO el campo escrito (§2.4)');
    assert.equal(res.waitedMs, c.campo.waitedMs, 'P17: el `waitedMs` de nivel superior es el del campo escrito');
    assert.equal(
      res.frame.invalidation.settled,
      c.doc.settled,
      'P17: `frame.invalidation.settled` es el veredicto temporal del DOCUMENTO, con valor independiente del campo',
    );
  }
});

test('P23 (§2.4): con diálogo nativo abierto por la acción (ok:true + nativeDialog) el pliegue serializa SIN esperar quiescencia, devuelve settled:false y no cuelga', async () => {
  assert.ok(actWithFold, GUARD('P23', 'actWithFold'));
  const h = actHarness({
    params: { frame: {} },
    actionResponse: { ok: true, nativeDialog: { type: 'confirm', message: '¿Confirmar?', pending: true } },
    settleOutcome: { settled: true, waitedMs: 999 }, // si el pliegue esperara, este valor se colaría
  });
  const res = await actWithFold(h.deps);

  assert.equal(h.reads.length, 1, 'P23: con ok:true el pliegue corre (el diálogo lo abrió la acción, §2.4)');
  assert.equal(
    h.reads[0].settle,
    false,
    'P23: con diálogo pendiente NO se llama a la espera de quiescencia (cuelga) — regla vigente de getFrame(settle), fb-020-003 §2.3/Q7',
  );
  assert.ok(res.frame, 'P23: el mapa igual viaja');
  assert.equal(
    res.frame.invalidation.settled,
    false,
    'P23: el veredicto temporal es false — se pidió veredicto y no se pudo esperar (I-5: nunca settled:true sobre un documento que no se esperó)',
  );
  assert.equal(res.ok, true, 'P23: la respuesta de la acción queda intacta');
});

// ── navigate ───────────────────────────────────────────────────────────────

test('P18 (§2.6): con documento en recambio se siembra la marca ANTES de la lectura, el techo del commit es frame.waitMs y no se serializa antes del complete', async () => {
  assert.ok(navigateWithFold, GUARD('P18', 'navigateWithFold'));
  const h = navHarness({ params: { frame: { waitMs: 4000 } }, replaces: true, committed: true });
  const res = await navigateWithFold(h.deps);

  assert.deepEqual(
    h.trace,
    ['navigate:despacho', 'seed', 'commit:inicio', 'commit:fin', 'lectura:inicio'],
    `P18: el orden es despacho → sembrado → espera de commit → lectura; traza=${JSON.stringify(h.trace)}`,
  );
  assert.equal(h.commits.length, 1, 'P18: se reusa waitForNavCommit — una sola ruta de espera de commit');
  assert.equal(
    h.commits[0].waitMs,
    4000,
    'P18: el techo del commit es frame.waitMs, no el de la acción',
  );
  assert.equal(res.success, true, 'P18: con pliegue success:true significa que el documento destino existe y se serializó');
  assert.ok(res.frame, 'P18: el mapa del documento destino viaja');
  assert.equal(res.frame.invalidation.settled, true, 'P18: commit cumplido ⇒ el veredicto es el de la lectura');
  assert.equal(
    Object.prototype.hasOwnProperty.call(res.frame.invalidation, 'navigating'),
    false,
    'P18: `navigating` es present-only — sin navegación pendiente no aparece (§2.2)',
  );
});

test('P18 / I-5 (techo del commit vencido): success:true, el mapa igual viaja, settled:false y navigating:true aunque la lectura diga que hubo quietud', async () => {
  assert.ok(navigateWithFold, GUARD('P18/I-5', 'navigateWithFold'));
  const h = navHarness({
    params: { frame: {} },
    replaces: true,
    committed: false, // techo del commit vencido (commitTimedOut)
    settleOutcome: { settled: true, waitedMs: 200 }, // el veredicto in-page dice otra cosa
  });
  const res = await navigateWithFold(h.deps);

  assert.equal(res.success, true, 'P18: vencido el techo, la navegación sigue reportando success:true');
  assert.ok(res.frame, 'P18: el mapa IGUAL viaja (regla commitTimedOut vigente, I-A/I-B de fb-018-006)');
  assert.equal(
    res.frame.invalidation.settled,
    false,
    'I-5: si la marca estaba puesta y el commit no ocurrió dentro del techo, settled es false aunque el veredicto in-page diga true',
  );
  assert.equal(res.frame.invalidation.navigating, true, 'P18: con commit pendiente, navigating:true');
});

test('P19 (§2.6): navegación solo de fragmento ⇒ ni marca ni loading sintético ni espera de commit; la lectura corre de inmediato', async () => {
  assert.ok(navigateWithFold, GUARD('P19', 'navigateWithFold'));
  const h = navHarness({ params: { frame: {} }, replaces: false });
  const res = await navigateWithFold(h.deps);

  assert.deepEqual(h.seeds, [], 'P19: replacesDocument falso ⇒ no se siembra marca ni loading sintético');
  assert.deepEqual(h.commits, [], 'P19: no hay espera de commit para un cambio de fragmento');
  assert.deepEqual(
    h.trace,
    ['navigate:despacho', 'lectura:inicio'],
    `P19: la lectura corre de inmediato (con su espera de quiescencia); traza=${JSON.stringify(h.trace)}`,
  );
  assert.ok(res.frame, 'P19: el mapa viaja igual');
  assert.equal(h.reads[0].settle, true, 'P19: la lectura conserva su espera de quiescencia (frame.settle por default true)');
});

test('P20 / I-2 (no-regresión): navigate SIN frame ⇒ respuesta vigente exacta, 0 lecturas y 0 esperas de commit', async () => {
  assert.ok(navigateWithFold, GUARD('P20', 'navigateWithFold'));
  const h = navHarness({ replaces: true });
  const res = await navigateWithFold(h.deps);

  assert.equal(h.reads.length, 0, 'P20: sin `frame` la lectura se invoca CERO veces');
  assert.deepEqual(h.commits, [], 'P20: sin `frame` no hay espera de commit — la semántica de despacho se conserva');
  assert.equal(
    JSON.stringify(res),
    JSON.stringify({ success: true, tabId: 7, url: 'http://local/destino' }),
    `P20/I-2: la respuesta es la vigente byte-a-byte, sin frame ni frameError; got ${JSON.stringify(res)}`,
  );
});

// ── act + espera de commit de navegación ────────────────────────────────────
//
// Sección agregada después del review (bloqueante §1 de
// docs/specs/fb-020-008-act-frame-fold/review.md, cerrado en el fix 65fc26d).
//
// Por qué no existía: el commit-wait vivía en background.js (el *caller*), que
// no es importable en node, así que NINGÚN unit test del módulo podía ver su
// ausencia — por construcción. El fix lo movió a una dependencia inyectada de
// `actWithFold`, y estos tests la ejercitan para que el agujero no vuelva a ser
// invisible.
//
// Dependencia agregada a `actWithFold` (extiende el bloque de interfaz del
// encabezado de este archivo, que es el registro de la sub-fase RED y no se
// toca):
//
//   waitForNavCommit({ tabId, waitMs }) → Promise<{ committed: boolean }>
//     La MISMA ruta de espera de commit que ya usa `navigateWithFold` (I-1:
//     "el implementer reusa el camino de getFrame — serializer, waitForSettle,
//     waitForNavCommit"; §1.3). `committed:false` ⇒ el techo venció ⇒ el
//     veredicto temporal del documento es `false` aunque la lectura in-page
//     diga otra cosa (I-5).
//
// El harness es NUEVO a propósito: agregarle el doble a `actHarness` cambiaría
// las entradas de los 21 tests vigentes (modificación en sustancia, aunque el
// diff parezca aditivo) y borraría la evidencia del caso "dependencia ausente".

function actCommitHarness({
  doc = makeDom(),
  params = {},
  actionResponse = { ok: true },
  committed = true,
  conCommitDep = true,
  settleOutcome = { settled: true, waitedMs: 120 },
  lastFrameByTab = new Map(),
} = {}) {
  const trace = [];
  const reads = [];
  const commits = [];
  const declared = [];

  const performAction = async () => {
    trace.push('accion:despacho');
    await new Promise((r) => setTimeout(r, 5)); // observación del campo escrito
    trace.push('accion:desenlace');
    return actionResponse;
  };

  const readFrame = async (args) => {
    trace.push('lectura:inicio');
    reads.push(args);
    const frame = serializeFrame(doc.body, args.options ?? {});
    const salida = { frame };
    if (args.settle) {
      salida.settled = settleOutcome.settled;
      salida.waitedMs = settleOutcome.waitedMs;
    }
    trace.push('lectura:fin');
    return salida;
  };

  const deps = {
    params: { tabId: 7, ref: 'main>button:1', action: 'click', ...params },
    performAction,
    readFrame,
    lastFrameByTab,
    declareWait: (ms) => declared.push(ms),
  };
  if (conCommitDep) {
    deps.waitForNavCommit = async (args) => {
      trace.push('commit:inicio');
      commits.push(args);
      await new Promise((r) => setTimeout(r, 5));
      trace.push('commit:fin');
      return { committed };
    };
  }

  return { doc, trace, reads, commits, declared, lastFrameByTab, deps };
}

test('I-5 (act, commit vencido): con settle pedido y el commit NO cumplido, frame.invalidation.settled es false AUNQUE la lectura in-page diga settled:true', async () => {
  assert.ok(actWithFold, GUARD('I-5', 'actWithFold'));
  const h = actCommitHarness({
    params: { frame: {} },
    actionResponse: { ok: true, ref: 'main>button:1', action: 'click' },
    committed: false, // el techo del commit venció (commitTimedOut)
    // El documento VIEJO está quieto (loader animado por CSS ⇒ cero
    // mutaciones): la lectura in-page certifica quietud sobre una pantalla que
    // ya no es la vigente. Es el modo de falla medido en campo (fb-018-006
    // §2.2.7-B) que el review levantó como bloqueante.
    settleOutcome: { settled: true, waitedMs: 200 },
  });
  const res = await actWithFold(h.deps);

  assert.equal(
    h.commits.length,
    1,
    'I-5: la ruta de pliegue de `act` tiene que esperar el commit — si no lo espera, serializa el documento viejo (bloqueante §1 del review)',
  );
  assert.equal(res.ok, true, 'I-5: la respuesta de la acción queda intacta — la acción YA ocurrió (§2.7)');
  assert.ok(res.frame, 'I-5: el mapa igual viaja (regla commitTimedOut vigente, I-A/I-B de fb-018-006)');
  assert.equal(
    res.frame.invalidation.settled,
    false,
    'I-5: nunca settled:true sobre un documento que no se esperó — un veredicto in-page optimista sobre el documento viejo ' +
      'le haría actuar al agente (que por diseño de esta feature ya no relee) sobre una pantalla muerta',
  );
});

test('I-5 (act, camino feliz): con el commit cumplido, el veredicto in-page vale tal cual', async () => {
  assert.ok(actWithFold, GUARD('I-5', 'actWithFold'));
  const h = actCommitHarness({
    params: { frame: {} },
    actionResponse: { ok: true, ref: 'main>button:1', action: 'click' },
    committed: true,
    settleOutcome: { settled: true, waitedMs: 120 },
  });
  const res = await actWithFold(h.deps);

  assert.equal(h.commits.length, 1, 'I-5: la espera de commit corre también en el camino feliz (nada siembra la marca sincrónicamente: la dependencia resuelve rápido cuando no hay navegación en vuelo)');
  assert.ok(res.frame, 'P6: con ok:true y `frame` pedido el mapa viaja');
  assert.equal(
    res.frame.invalidation.settled,
    true,
    'I-5: con el commit cumplido no hay motivo para bajar el veredicto — el de la lectura in-page manda',
  );
  assert.equal(res.frame.invalidation.waitedMs, 120, 'P7: el waitedMs es el de la espera de quiescencia');
});

test('§2.3.1 (orden): la espera del commit ocurre DESPUÉS del desenlace de la acción y ANTES de la lectura', async () => {
  assert.ok(actWithFold, GUARD('§2.3.1', 'actWithFold'));
  const h = actCommitHarness({
    params: { action: 'type', value: 'Cliente X', ref: 'main>input:1', waitMs: 1234, frame: {} },
    actionResponse: { ok: true, value: 'Cliente X', settled: true, waitedMs: 40 },
  });
  await actWithFold(h.deps);

  assert.deepEqual(
    h.trace,
    ['accion:despacho', 'accion:desenlace', 'commit:inicio', 'commit:fin', 'lectura:inicio', 'lectura:fin'],
    `§2.3/§2.3.1: primero el desenlace de la acción con SU techo, después la espera del documento —` +
      ` commit y RECIÉN ENTONCES la lectura; una lectura antes del commit serializa el documento viejo; traza=${JSON.stringify(h.trace)}`,
  );
});

test('§2.3.1 (techo): el techo de la espera de commit es frame.waitMs (con su default), nunca el de la acción', async () => {
  assert.ok(actWithFold, GUARD('§2.3.1', 'actWithFold'));

  // act.waitMs (1234) distinto del techo del documento (3000) y del default
  // (5000): un cableado al techo equivocado no puede coincidir por casualidad.
  const explicito = actCommitHarness({
    params: { action: 'type', value: 'Cliente X', ref: 'main>input:1', waitMs: 1234, frame: { waitMs: 3000 } },
    actionResponse: { ok: true, value: 'Cliente X', settled: true, waitedMs: 40 },
  });
  await actWithFold(explicito.deps);
  assert.equal(explicito.commits.length, 1, '§2.3.1: una sola espera de commit por pliegue');
  assert.equal(
    explicito.commits[0].waitMs,
    3000,
    `§2.3.1: "waitMs acota la espera de commit Y después la de quiescencia" — el waitMs es el de frame, no el del campo escrito (act.waitMs=1234); got ${JSON.stringify(explicito.commits[0])}`,
  );
  assert.equal(explicito.commits[0].tabId, 7, '§2.3.1: la espera de commit es la del tab de la acción');

  const porDefault = actCommitHarness({ params: { action: 'click', waitMs: 1234, frame: {} } });
  await actWithFold(porDefault.deps);
  assert.equal(
    porDefault.commits[0].waitMs,
    5000,
    `§2.1.1: sin frame.waitMs explícito el techo del commit es el default del pliegue, 5000; got ${JSON.stringify(porDefault.commits[0])}`,
  );
});

test('§2.3.1 / P23: no se espera el commit cuando no hay veredicto temporal que dar (settle:false) ni cuando hay diálogo nativo pendiente', async () => {
  assert.ok(actWithFold, GUARD('§2.3.1/P23', 'actWithFold'));

  // (a) settle:false ⇒ lectura barata e inmediata: CERO espera de documento
  // (§2.1.2/P7) — y la de commit es espera de documento.
  const sinSettle = actCommitHarness({ params: { frame: { settle: false } } });
  const res1 = await actWithFold(sinSettle.deps);
  assert.equal(
    sinSettle.commits.length,
    0,
    `§2.1.2/P7: con settle:false no hay espera de documento de ninguna clase; commits=${JSON.stringify(sinSettle.commits)}`,
  );
  assert.equal(sinSettle.reads.length, 1, 'P7: la lectura igual corre, inmediata');
  assert.deepEqual(
    Object.keys(res1.frame.invalidation),
    ['changedSinceLast'],
    'P7: sin settle, invalidation trae SOLO changedSinceLast (present-only)',
  );

  // (b) Diálogo nativo abierto por la acción (ok:true + nativeDialog): el
  // pliegue NO espera quiescencia (cuelga, fb-020-003 §2.3/Q7) — tampoco el
  // commit. Misma forma exacta que usa el test vigente de P23.
  const dialogo = actCommitHarness({
    params: { frame: {} },
    actionResponse: { ok: true, nativeDialog: { type: 'confirm', message: '¿Confirmar?', pending: true } },
    settleOutcome: { settled: true, waitedMs: 999 },
  });
  const res2 = await actWithFold(dialogo.deps);
  assert.equal(
    dialogo.commits.length,
    0,
    `P23: con diálogo nativo pendiente el pliegue no espera — ni quiescencia ni commit, o la llamada cuelga; commits=${JSON.stringify(dialogo.commits)}`,
  );
  assert.equal(dialogo.reads[0].settle, false, 'P23: la lectura corre sin espera de quiescencia');
  assert.equal(res2.frame.invalidation.settled, false, 'P23/I-5: se pidió veredicto y no se pudo esperar ⇒ false');
});

test('§2.7 (dependencia ausente): sin `waitForNavCommit` inyectada el pliegue no explota — corre como antes del fix y el mapa viaja', async () => {
  assert.ok(actWithFold, GUARD('§2.7', 'actWithFold'));
  // La spec no define el caso "dependencia ausente" (ver informe del
  // test-writer): lo que sí manda §2.7/I-3 es que una acción con ok:true NUNCA
  // se convierta en error por causa de la lectura. Este test pinea eso —
  // degradación silenciosa al comportamiento previo al fix— y NO inventa un
  // contrato de throw ni de settled:false. Es además el arreglo que ejercitan
  // los 21 tests vigentes, que construyen sus deps sin esta clave.
  const h = actCommitHarness({
    params: { frame: {} },
    actionResponse: { ok: true, ref: 'main>button:1', action: 'click' },
    conCommitDep: false,
    settleOutcome: { settled: true, waitedMs: 120 },
  });
  const res = await actWithFold(h.deps);

  assert.equal(res.ok, true, '§2.7: la respuesta de la acción queda intacta');
  assert.ok(res.frame, 'I-3: el pliegue corrió ⇒ exactamente una de frame/frameError, y acá es frame');
  assert.equal(
    Object.prototype.hasOwnProperty.call(res, 'frameError'),
    false,
    'I-3: nunca frame y frameError a la vez; la ausencia de la dependencia no es un error de lectura',
  );
  assert.deepEqual(
    Object.keys(res.frame.invalidation).sort(),
    ['changedSinceLast', 'settled', 'waitedMs'],
    '§2.2: la forma de invalidation no cambia por la ausencia de la dependencia (presencia ⇔ pedidos)',
  );
  assert.deepEqual(h.trace, ['accion:despacho', 'accion:desenlace', 'lectura:inicio', 'lectura:fin'],
    `§2.7: sin la dependencia no hay espera de commit y la lectura corre igual; traza=${JSON.stringify(h.trace)}`);
});

test('I-2 (tabular, act): para cualquier request SIN `frame`, la respuesta nunca contiene frame ni frameError y no hay lectura', async () => {
  assert.ok(actWithFold, GUARD('I-2', 'actWithFold'));
  // Tabular en vez de property test: el repo no tiene infraestructura de
  // property testing (frame/package.json: jsdom + esbuild) y no se agrega una
  // dependencia en RED. La tabla recorre las cuatro acciones y los dos
  // desenlaces, que es el espacio completo relevante para I-2.
  const acciones = [
    { action: 'click' },
    { action: 'focus' },
    { action: 'select', value: 'Pivot' },
    { action: 'type', value: 'Cliente X', waitMs: 5000, quietMs: 300 },
  ];
  const desenlaces = [
    { ok: true, value: 'Cliente X', settled: true, waitedMs: 40 },
    { ok: false, stale: true },
  ];
  for (const a of acciones) {
    for (const d of desenlaces) {
      const h = actHarness({ params: a, actionResponse: d });
      const res = await actWithFold(h.deps);
      assert.equal(h.reads.length, 0, `I-2 (${a.action}/${JSON.stringify(d)}): sin \`frame\` no hay lectura ni timing nuevo`);
      assert.equal(
        JSON.stringify(res),
        JSON.stringify(d),
        `I-2 (${a.action}): la respuesta es byte-idéntica a la vigente; ninguna clave del pliegue aparece "por default"`,
      );
    }
  }
});
