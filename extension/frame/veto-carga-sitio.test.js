/**
 * veto-carga-sitio.test.js — fb-024-settle-carga-de-sitio (sub-fase RED).
 *
 * Verifica P1 (a/b/c), P2 (a/b/c/d/e), P3 (a/b), P4 (a/b/c) y P6 del spec
 * docs/specs/fb-024-settle-carga-de-sitio/spec.md §3.2 (v1 enmendada
 * 2026-09-29, commits 331494f + 2bf6442): el veto §2.2.6 de settle.js deja de ser ciego
 * a los marcadores de carga del SITIO, inyectados como dato por
 * `opts.validityProfiles` (misma clave que el serializer, D-3).
 *
 * ── Ledger RED declarado (spec §5, enmienda 2 de 2026-09-29, commit 2bf6442) ──
 * Rojos esperados en RED: P1-a, P1-b, P1-c, P2-d, P2-e, P3-b, P6. PINes
 * verdes-en-RED (comportamiento "sin registro" = estado actual): P2-a/b/c,
 * P3-a, P4.
 * Cada PIN lleva guard de no-vacuidad (el marcador SÍ está en el DOM, el perfil
 * SÍ detectaría la raíz) para que el escape "la opción es ignorada, todo pasa
 * vacuo" no pueda colarse.
 *
 * ── Perfiles de PRUEBA (técnica PERFIL_DEMO de validez-perfil-sitio.test.js) ─
 * Cero literales de Odoo en este archivo (excepto P2-e, único test con
 * literales de campo MEDIDOS como dato de fixture, permitido por I-6): el
 * mecanismo es una convención inyectada como dato, no una heurística de sitio.
 * Los tests que ejercitan el NÚCLEO importan `./settle.js` directamente y
 * inyectan el registro explícito (D-3: el core no tiene default); los de
 * composición ejercitan `./index.js` (I-9 análogo).
 *
 * ── Convenciones (biblia: settle.test.js) ───────────────────────────────────
 * jsdom implementa MutationObserver por ventana; timers REALES cortos
 * (waitMs 400 / quietMs 80 en las formas del veto, precedente P4b de
 * settle.test.js); serializer centinela stubSer() (identidad de frame, I-A:
 * el veto extiende la espera, jamás recorta el mapa); capture directa del
 * await = aserción "jamás throw hacia el caller" (patrón P6/P5b-guard).
 * Suite nueva aditiva: settle.test.js y las suites existentes no se tocan (I-8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { waitForSettle } from './settle.js';
import { serializeFrame } from './serializer.js';
import * as entry from './index.js';

// ── Perfiles de prueba y helpers (sin literales de Odoo) ────────────────────

/** Perfil §3.2 con la clave nueva: marcador de carga '.demo-cargando'. */
const PERFIL_CARGA = {
  id: 'demo',
  detect: (d) => !!d.querySelector('[data-suite-root="demo"]'),
  invalidMarkerSelector: '.demo-invalid-marker',
  loadingMarkerSelector: '.demo-cargando',
};

/** Igual pero SIN la clave nueva (D-2: opcional; ausente = declara cero). */
const PERFIL_SIN_CARGA = {
  id: 'demo',
  detect: (d) => !!d.querySelector('[data-suite-root="demo"]'),
  invalidMarkerSelector: '.demo-invalid-marker',
};

/** Perfil cuyo detect lanza (D-4: aislamiento del detect, obligatoria). */
const PERFIL_QUE_LANZA = {
  id: 'demo-roto',
  detect: () => {
    throw new Error('detect roto (inyectado por el test)');
  },
  invalidMarkerSelector: '.demo-invalid-marker',
};

/** Perfil con loadingMarkerSelector de sintaxis inválida (D-5: fail-open). */
const PERFIL_SELECTOR_ROTO = {
  id: 'demo',
  detect: PERFIL_CARGA.detect,
  invalidMarkerSelector: '.demo-invalid-marker',
  loadingMarkerSelector: '##carga',
};

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

/**
 * Serializer centinela (settle.test.js): cada llamada devuelve un objeto
 * DISTINTO sin tocar el DOM — permite aserciones de IDENTIDAD de frame y
 * conteo de ciclos.
 */
function stubSer() {
  const llamadas = [];
  const fn = () => {
    const frame = { __frameCentinela: llamadas.length };
    llamadas.push(frame);
    return frame;
  };
  return { fn, llamadas };
}

/** DOM estático de P1-a: firma de raíz + marcador de carga (cero mutaciones). */
const HTML_MARCADOR =
  '<div data-suite-root="demo"><main><button>Base</button></main>' +
  '<span class="demo-cargando">Cargando</span></div>';

/** Guard de fixture compartido por los PINes: el escenario NO es vacuo. */
function assertFixtureViva(doc, { marcador = true } = {}) {
  if (marcador) {
    assert.ok(
      doc.querySelector('.demo-cargando'),
      'guard de no-vacuidad: el marcador de carga SÍ está en el DOM — sin esto, "settled:true" podría pasar con el marcador ausente',
    );
  }
  assert.equal(
    PERFIL_CARGA.detect(doc),
    true,
    'guard de no-vacuidad: el perfil SÍ detectaría la raíz de este DOM — sin esto, el veto no podría morder aunque la opción existiera',
  );
}

// ── P1 — el veto de sitio muerde y se levanta (spec §3.2) ────────────────────

test('P1-a: documento estático con .demo-cargando + PERFIL_CARGA explícito ⇒ settled:false acotado por deadline, frame completo por identidad; contraparte sin la clase ⇒ settled:true', async () => {
  const doc = makeDom(HTML_MARCADOR);
  assertFixtureViva(doc);
  const stub = stubSer();
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_CARGA], waitMs: 400, quietMs: 80 }, stub.fn);
  assert.equal(
    res.settled,
    false,
    'P1-a: con el marcador de sitio presente el veto jamás declara settled:true (D-6: presence-based; sin veto este DOM quieto daría true a ≈80 ms)',
  );
  assert.ok(
    res.waitedMs <= 400 + 250,
    `P1-a: la espera sigue acotada por el deadline (waitedMs=${res.waitedMs} ≤ 400+TOL 650) — el veto extiende, nunca espera indefinidamente`,
  );
  assert.equal(
    res.frame,
    stub.llamadas[stub.llamadas.length - 1],
    'P1-a: el frame devuelto es el último serializado por el centinela — el veto extiende la espera, nunca recorta el mapa (I-A/I-4)',
  );
  // Contraparte de no-vacuidad (misma llamada, mismo DOM SIN la clase marcadora).
  const docLimpio = makeDom(
    '<div data-suite-root="demo"><main><button>Base</button></main><span>Cargando</span></div>',
  );
  assert.ok(
    !docLimpio.querySelector('.demo-cargando'),
    'guard de no-vacuidad: la contraparte NO tiene la clase marcadora',
  );
  assertFixtureViva(docLimpio, { marcador: false });
  const resLimpio = await waitForSettle(docLimpio, { validityProfiles: [PERFIL_CARGA], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    resLimpio.settled,
    true,
    'P1-a (no-vacuidad): el MISMO DOM sin la clase marcadora settlea normalmente — el veto muerde por el marcador del perfil, no por cualquier otra cosa',
  );
});

test('P1-b: marcador removido a t≈120 ⇒ settled:true con waitedMs ≥ 190 (remoción + ventana completa; extiende y nunca se queda pegado)', async () => {
  const doc = makeDom(
    '<div data-suite-root="demo"><main><button>Base</button></main>' +
    '<span id="carga" class="demo-cargando">Cargando</span></div>',
  );
  assertFixtureViva(doc);
  assert.ok(doc.getElementById('carga'), 'guard de fixture: existe el marcador removible');
  // A t≈120 (pasado el primer intento de quietud, quietMs=80) se remueve el
  // marcador. La remoción ES una mutación ⇒ reinicia la ventana; con el veto
  // levantado ya no bloquea ⇒ settle a ≈200 (120+80). Discrimina contra:
  // (a) veto inexistente (settle a ≈80, antes de la remoción) y (b) veto
  // pegajoso (settled:false para siempre). Espejo exacto del P4b de settle.test.js.
  const remocion = setTimeout(() => {
    doc.getElementById('carga').remove();
  }, 120);
  try {
    const res = await waitForSettle(doc, { validityProfiles: [PERFIL_CARGA], waitMs: 3000, quietMs: 80 }, stubSer().fn);
    assert.equal(
      res.settled,
      true,
      'P1-b: removido el marcador, el settle resuelve normalmente (el veto extiende, jamás bloquea para siempre)',
    );
    assert.ok(
      res.waitedMs >= 190,
      `P1-b: el settle ocurre tras la remoción + ventana completa (piso ≈200; waitedMs=${res.waitedMs}) — ` +
        'un settle a ≈80 indicaría un veto inexistente (la opción ignorada)',
    );
  } finally {
    clearTimeout(remocion);
  }
});

test('P1-c: marcador dentro de un open shadow root presente al instalar ⇒ settled:false (el veto consulta el MISMO Set de shadow roots que el estándar)', async () => {
  const doc = makeDom(
    '<div data-suite-root="demo"><main><button>Base</button></main><div id="host"></div></div>',
  );
  const shadow = doc.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<span class="demo-cargando">Cargando</span>';
  // Guards de no-vacuidad: el marcador vive DENTRO del shadow root (no en el
  // light DOM) y el perfil detecta la raíz desde el documento.
  assert.ok(
    !doc.querySelector('.demo-cargando'),
    'guard de no-vacuidad: el marcador NO está en el light DOM — si estuviera, el caso "shadow scope" no existiría',
  );
  assert.ok(
    shadow.querySelector('.demo-cargando'),
    'guard de no-vacuidad: el marcador SÍ está dentro del open shadow root',
  );
  assert.equal(PERFIL_CARGA.detect(doc), true, 'guard de no-vacuidad: el perfil detecta la raíz (light DOM)');
  const stub = stubSer();
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_CARGA], waitMs: 400, quietMs: 80 }, stub.fn);
  assert.equal(
    res.settled,
    false,
    'P1-c: el veto de sitio consulta documento + shadow roots abiertos del Set compartido (§2 In-2: "sobre el mismo alcance de hoy"), ' +
      'no un alcance paralelo que deje la sombra sin veto',
  );
});

// ── P2 — sin registro el veto es exactamente el de hoy (PINes verde-en-RED) ──

test('P2-a: mismo DOM de P1-a SIN validityProfiles en opts ⇒ settled:true (el núcleo no conoce convenciones de sitio hasta que se le inyectan)', async () => {
  const doc = makeDom(HTML_MARCADOR);
  assertFixtureViva(doc);
  const res = await waitForSettle(doc, { waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    true,
    'P2-a (I-2/I-5 de fb-020-005): sin registro inyectado, el marcador de sitio NO veta — la convención viaja sólo como dato',
  );
});

test('P2-b: opción presente pero no-array (\'demo\', 42) ⇒ settled:true (guard Array.isArray de detectActiveProfile)', async () => {
  const doc = makeDom(HTML_MARCADOR);
  assertFixtureViva(doc);
  for (const noArray of ['demo', 42]) {
    const res = await waitForSettle(doc, { validityProfiles: noArray, waitMs: 400, quietMs: 80 }, stubSer().fn);
    assert.equal(
      res.settled,
      true,
      `P2-b: validityProfiles=${JSON.stringify(noArray)} (no-array) ⇒ sin perfil reconocido ⇒ sin veto de sitio`,
    );
  }
});

test('P2-c: PERFIL_SIN_CARGA + firma de raíz + clase marcadora presente ⇒ settled:true (clave ausente = declara cero marcadores)', async () => {
  const doc = makeDom(HTML_MARCADOR);
  assertFixtureViva(doc);
  assert.equal(
    'loadingMarkerSelector' in PERFIL_SIN_CARGA,
    false,
    'guard de no-vacuidad: PERFIL_SIN_CARGA NO declara la clave nueva (D-2: opcional)',
  );
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_SIN_CARGA], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    true,
    'P2-c: un perfil detectado sin loadingMarkerSelector declara CERO marcadores de sitio — el veto estándar queda intacto y nada más veta',
  );
});

test('P2-d: composición con override explícito — entry.waitForSettle + [PERFIL_CARGA] con marcador presente ⇒ settled:false; el explícito prevalece', async () => {
  assert.equal(
    typeof entry.waitForSettle,
    'function',
    'guard de no-vacuidad: index.js exporta waitForSettle (hoy crudo; la composición es la pieza de GREEN, §3.3)',
  );
  const doc = makeDom(HTML_MARCADOR);
  assertFixtureViva(doc);
  // (1) Override explícito: el registro del caller prevalece sobre el default.
  const res = await entry.waitForSettle(doc, { validityProfiles: [PERFIL_CARGA], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    false,
    'P2-d: el override EXPLÍCITO prevalece — entry.waitForSettle compone como serializeFrame ({ validityProfiles: VALIDITY_PROFILES, ...opts }, §3.3); ' +
      'un re-export crudo ignora la opción y settlea true',
  );
  // (2) Explícito ausente: el default del entry (registro real, raíz Odoo) no
  // detecta este DOM demo ⇒ sin marcador de sitio ⇒ settle normal.
  const resDefault = await entry.waitForSettle(doc, { waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    resDefault.settled,
    true,
    'P2-d: sin override, el registro default (Odoo) no detecta la raíz de este DOM demo ⇒ sin veto de sitio ⇒ settled:true',
  );
});

test('P2-e: composición default con el registro real — DOM Odoo capturado (.o_web_client + .o_loading_indicator) sin override ⇒ settled:false; sin marcador ⇒ true; marcador sin raíz ⇒ true (gating)', async () => {
  assert.ok(
    Array.isArray(entry.VALIDITY_PROFILES) && entry.VALIDITY_PROFILES.length >= 1,
    'guard de no-vacuidad: el entry exporta VALIDITY_PROFILES (I-9) — el registro default existe',
  );
  // (1) El DOM real capturado (sonda de campo 2026-09-29, §2): raíz del webclient
  // + el marcador medido de la transición SPA. Los dos selectores son literales
  // de campo MEDIDOS usados como DATO de fixture en un TEST (I-6 lo permite:
  // I-1 audita módulos del núcleo, no tests).
  const docCon = makeDom('<div class="o_web_client"><span class="o_loading_indicator">Cargando (1)</span></div>');
  assert.ok(
    docCon.querySelector('.o_loading_indicator'),
    'guard de no-vacuidad: el marcador medido SÍ está en el DOM del fixture',
  );
  assert.ok(
    entry.VALIDITY_PROFILES.some((p) => p && typeof p.detect === 'function' && p.detect(docCon)),
    'guard de no-vacuidad: el registro default SÍ detecta la raíz de este DOM (sin esto, settled:false jamás podría deberse al marcador)',
  );
  const res = await entry.waitForSettle(docCon, { waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    false,
    'P2-e: con el registro real inyectado por DEFAULT en la composición, el marcador medido .o_loading_indicator veta (RED: hoy index.js re-exporta ' +
      'waitForSettle crudo, sin composición — el registro jamás llega al core)',
  );
  // (2) El mismo DOM sin el marcador (raíz presente) ⇒ settled:true.
  const docRaiz = makeDom('<div class="o_web_client"><main><button>Base</button></main></div>');
  assert.ok(
    !docRaiz.querySelector('.o_loading_indicator') && docRaiz.querySelector('.o_web_client'),
    'guard de fixture: raíz presente, marcador ausente',
  );
  assert.equal(
    (await entry.waitForSettle(docRaiz, { waitMs: 400, quietMs: 80 }, stubSer().fn)).settled,
    true,
    'P2-e: el mismo DOM sin el marcador settlea normalmente — el veto muerde por el marcador, no por la raíz',
  );
  // (3) El marcador con raíz AUSENTE ⇒ settled:true (gating del perfil: sin
  // .o_web_client el perfil no se activa y el span no es indicador estándar).
  const docSinRaiz = makeDom(
    '<main><button>Base</button></main><span class="o_loading_indicator">Cargando (1)</span>',
  );
  assert.ok(
    docSinRaiz.querySelector('.o_loading_indicator') && !docSinRaiz.querySelector('.o_web_client'),
    'guard de fixture: marcador presente, raíz ausente',
  );
  assert.ok(
    !entry.VALIDITY_PROFILES.some((p) => p && typeof p.detect === 'function' && p.detect(docSinRaiz)),
    'guard de no-vacuidad: NINGÚN perfil del registro default detecta este DOM (gating real)',
  );
  assert.equal(
    (await entry.waitForSettle(docSinRaiz, { waitMs: 400, quietMs: 80 }, stubSer().fn)).settled,
    true,
    'P2-e (gating): sin raíz el perfil no se activa ⇒ sin marcador de sitio ⇒ settled:true',
  );
});

// ── P3 — aislamiento del detect (D-4, obligatoria) ───────────────────────────

test('P3-a: perfil cuyo detect lanza ⇒ settle no rompe y no veta de más (settled:true sin indicadores; el estándar sigue mordiendo junto a un perfil roto)', async () => {
  // Guard de no-vacuidad: el detect del perfil de prueba LANZA de verdad.
  let lanza = false;
  try {
    PERFIL_QUE_LANZA.detect(makeDom('<main></main>'));
  } catch {
    lanza = true;
  }
  assert.ok(lanza, 'guard de no-vacuidad: el detect del perfil de prueba lanza');
  // (1) Documento estático sin indicadores: la excepción del detect se trata
  // como "sin perfil" (D-4) — NO como evidencia de carga. El await directo ES
  // la aserción "jamás throw hacia el caller" (patrón P6/P5b-guard).
  const doc = makeDom('<main><button>Base</button></main>');
  assert.ok(
    !doc.querySelector('[aria-busy="true"], [role="progressbar"], progress'),
    'guard de fixture: sin indicadores estándar',
  );
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_QUE_LANZA], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    true,
    'P3-a: un perfil roto se trata como "sin perfil" por evaluación (D-4) — la excepción del detect no es indicador ni rompe settle (I-3)',
  );
  // (2) Espejo: detect que lanza + aria-busy presente ⇒ settled:false (el veto
  // ESTÁNDAR sigue mordiendo junto a un perfil roto).
  const docBusy = makeDom('<main><button>Base</button></main><div aria-busy="true"><span>Trabajando</span></div>');
  assert.ok(
    docBusy.querySelector('[aria-busy="true"]'),
    'guard de no-vacuidad: el indicador estándar SÍ está en el DOM del espejo',
  );
  const resBusy = await waitForSettle(docBusy, { validityProfiles: [PERFIL_QUE_LANZA], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    resBusy.settled,
    false,
    'P3-a (espejo): el veto estándar conserva su semántica junto a un perfil roto — el aislamiento no apaga el estándar (I-2)',
  );
});

test('P3-b: serializeFrame con un detect que lanza devuelve Frame en vez de throw (D-4 blinda los dos caminos; salda D-2 del review fb-020-005 §5.4)', () => {
  const doc = makeDom('<main><button>Guardar</button><input aria-label="nombre"></main>');
  let lanza = false;
  try {
    PERFIL_QUE_LANZA.detect(doc);
  } catch {
    lanza = true;
  }
  assert.ok(lanza, 'guard de no-vacuidad: el detect del perfil de prueba lanza');
  // Captura directa: si serializeFrame lanza, el test falla por esta aserción
  // (AssertionError), no por un error sin atrapar — RED por la razón correcta.
  let threw = null;
  let frame = null;
  try {
    frame = serializeFrame(doc.body, { validityProfiles: [PERFIL_QUE_LANZA] });
  } catch (e) {
    threw = e;
  }
  assert.equal(
    threw,
    null,
    `P3-b: serializeFrame no propaga el throw de un detect roto — un perfil roto degrada validez, jamás rompe la serialización (I-3). ` +
      `RED: hoy detectActiveProfile no tiene try/catch y propaga: ${threw && threw.message}`,
  );
  assert.ok(
    frame && Array.isArray(frame.sections) && frame.sections.length > 0,
    `P3-b: devuelve un Frame real (no-vacuidad); recibido ${JSON.stringify(frame)}`,
  );
  assert.ok(
    !('invalidCount' in frame) && !('invalidProfile' in frame),
    'P3-b: sin marcadores de invalidez en el fixture, el frame no trae claves de perfil',
  );
});

// ── P4 — marcador de sitio roto ⇒ sin marcador, sin crash (D-5, PINes) ───────

test('P4-a: loadingMarkerSelector con sintaxis inválida (\'##carga\') + clase carga presente y perfil detectado ⇒ settled:true, sin throw', async () => {
  // Guard de latitud declarada (spec §3.2 P4-a): el parser de selectores de
  // jsdom RECHAZA el token — si lo aceptara, el fixture no ejercitaría el
  // fail-open y habría que elegir otro token inválido.
  const docGuard = makeDom('<main></main>');
  assert.throws(
    () => docGuard.querySelector('##carga'),
    'P4-a guard: el token ##carga es inválido para el parser de selectores (si no lo fuera, el fixture sería vacuo)',
  );
  const doc = makeDom(
    '<div data-suite-root="demo"><main><button>Base</button></main><span class="carga">Cargando</span></div>',
  );
  assert.ok(
    doc.querySelector('.carga'),
    'guard de no-vacuidad: la clase carga SÍ está en el DOM',
  );
  assert.equal(PERFIL_CARGA.detect(doc), true, 'guard de no-vacuidad: el perfil detecta la raíz');
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_SELECTOR_ROTO], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    true,
    'P4-a: selector de sitio inválido ⇒ tratado como "sin marcador de sitio" (D-5 fail-open, sin throw) — un perfil roto no rompe settle ni extiende todas las esperas (I-3)',
  );
});

test('P4-b: loadingMarkerSelector no-string (42, {}) ⇒ tratado como ausente ⇒ settled:true', async () => {
  for (const roto of [42, {}]) {
    const perfil = { id: 'demo', detect: PERFIL_CARGA.detect, invalidMarkerSelector: '.demo-invalid-marker', loadingMarkerSelector: roto };
    const doc = makeDom(HTML_MARCADOR);
    assertFixtureViva(doc);
    assert.notEqual(
      typeof perfil.loadingMarkerSelector,
      'string',
      'guard de no-vacuidad: el loadingMarkerSelector de esta variante NO es string',
    );
    const res = await waitForSettle(doc, { validityProfiles: [perfil], waitMs: 400, quietMs: 80 }, stubSer().fn);
    assert.equal(
      res.settled,
      true,
      `P4-b: loadingMarkerSelector ${JSON.stringify(roto)} (no-string) ⇒ ausente ⇒ sin marcador de sitio ⇒ settled:true`,
    );
  }
});

test('P4-c: selector de sitio inválido + aria-busy presente ⇒ settled:false (el fail-open del sitio no apaga el veto estándar)', async () => {
  const doc = makeDom(
    '<div data-suite-root="demo"><main><button>Base</button></main><span class="carga">Cargando</span></div>' +
    '<div aria-busy="true"><span>Trabajando</span></div>',
  );
  assert.ok(
    doc.querySelector('[aria-busy="true"]'),
    'guard de no-vacuidad: el indicador estándar SÍ está en el DOM',
  );
  assert.ok(doc.querySelector('.carga'), 'guard de no-vacuidad: la clase carga SÍ está en el DOM');
  assert.equal(PERFIL_CARGA.detect(doc), true, 'guard de no-vacuidad: el perfil detecta la raíz');
  const res = await waitForSettle(doc, { validityProfiles: [PERFIL_SELECTOR_ROTO], waitMs: 400, quietMs: 80 }, stubSer().fn);
  assert.equal(
    res.settled,
    false,
    'P4-c: el veto ESTÁNDAR conserva su semántica (D-5: nada del camino estándar cambia) — el fail-open del marcador de sitio no lo anula (I-2)',
  );
});

// ── P6 — pureza de literales extendida a settle.js (I-1; técnica P14) ────────

const MODULO_PERFIL = 'profiles/odoo.js';
const CONSUMIDORES = ['settle.js', 'validity-profiles.js'];

/** Tokens demasiado genéricos para ser "literal de producto" (P14). */
const GENERICOS = new Set([
  '', 'use strict', 'name', 'id', 'class', 'div', 'span', 'input', 'true', 'false',
  'null', 'undefined', 'string', 'object', 'function', 'detect', 'data', 'value', 'type',
]);

function leer(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/**
 * Literales de string de un módulo, tokenizados (P14): el test los extrae en
 * RUNTIME, sin leer el módulo con los ojos. Comparar literal-contra-literal
 * evita falsos positivos por COMENTARIOS que mencionen el producto: I-1 habla
 * de literales de código, no de prosa.
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

test('P6 (I-1): ningún literal del perfil de producto aparece en settle.js ni validity-profiles.js; el perfil declara el marcador medido .o_loading_indicator', () => {
  let fuentePerfil = null;
  try {
    fuentePerfil = leer(`./${MODULO_PERFIL}`);
  } catch (e) {
    assert.fail(`P6: ${MODULO_PERFIL} debe existir (capa de producto, §3.3). Error de lectura: ${e.message}`);
  }
  const delPerfil = literalesDe(fuentePerfil);
  assert.ok(
    delPerfil.size > 0,
    'no-vacuidad: el módulo del perfil declara literales (firma de raíz y selectores)',
  );
  // Guard de no-vacuidad (enmienda de ledger 2026-09-29): el marcador medido
  // (sonda §2, transición SPA) debe estar entre los literales del perfil —
  // exige que profiles/odoo.js declare la clave nueva (§3.3). En RED este guard
  // falla: la clave todavía no existe; es el rojo honesto del hueco que GREEN
  // cierra. El guard NO se debilita para forzar un verde.
  assert.ok(
    delPerfil.has('.o_loading_indicator') || delPerfil.has('o_loading_indicator'),
    'P6 guard: profiles/odoo.js debe declarar loadingMarkerSelector ".o_loading_indicator" (§3.3, marcador medido) — ' +
      'sin esta guarda el grep de pureza sería vacuo',
  );
  for (const archivo of CONSUMIDORES) {
    let fuente = null;
    try {
      fuente = leer(`./${archivo}`);
    } catch (e) {
      assert.fail(`P6: ${archivo} debe existir (I-1 lo nombra entre los auditados). Error: ${e.message}`);
    }
    const compartidos = [...literalesDe(fuente)].filter((t) => delPerfil.has(t));
    assert.deepEqual(
      compartidos,
      [],
      `P6 (I-1): ${archivo} no puede contener ningún literal del perfil de producto (settle.js es el consumidor nuevo del registro; ` +
        `validity-profiles.js es repetición intencional del audit, autocontenida); compartidos=${JSON.stringify(compartidos)}`,
    );
  }
});
