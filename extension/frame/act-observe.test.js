/**
 * act-observe.test.js — fb-020-002-type-commit-cycle v2, componente C1 (sub-fase RED).
 *
 * Verifica P1–P11 de docs/specs/fb-020-002-type-commit-cycle/spec.md §3.1
 * (performActionAndObserve), con el criterio normativo de §2.3 y las formas de §2.2.
 * T1: jsdom (MutationObserver por ventana, isConnected) con timers REALES cortos.
 *
 * Escrito sólo contra la superficie pública del spec §2.1:
 *   performActionAndObserve(el, action, value, {force?, waitMs?, quietMs?}) → Promise
 * exportada por ./index.js, más performAction (./act.js) y resolveRef (./resolver.js)
 * como referencia/fixture, igual que los tests existentes. El test-writer no leyó
 * act.js, settle.js, resolver.js, serializer.js, index.js ni background.js.
 *
 * ── Guard de RED (por qué el import de index.js es dinámico) ────────────────
 * Precedente settle.test.js:62-71. Un import estático de ./index.js rompería la
 * CARGA del archivo entero si index.js lanzara al cargarse en node (y no hay forma
 * de verificarlo sin leer código de implementación). Se carga con catch y CADA test
 * abre con `api(id)`, que aserta `typeof performActionAndObserve === 'function'`:
 * hoy todos fallan por AssertionError "no exportada (RED)". Si index.js no carga,
 * el mensaje incluye el error de carga (no se oculta).
 *
 * ── Tiempos (t₀) ────────────────────────────────────────────────────────────
 * El despacho de `type` ocurre dentro de la llamada. Cada test toma `inicio` y
 * programa sus timers de página inmediatamente ANTES de llamar, así que todo evento
 * programado a `t` ocurre a ≥ inicio+t y la respuesta no puede resolver legítimamente
 * antes de inicio+t+quietMs. Los chequeos "no resuelve antes de X" usan
 * Promise.race con sleep(X − 30): 30 ms de margen contra jitter de timers.
 *
 * Naturaleza RED esperada: TODOS los tests fallan en su primera línea por
 * AssertionError del guard (performActionAndObserve no exportada). Ningún pin verde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { performAction } from './act.js';
import { resolveRef } from './resolver.js';

// ── Guard de RED ────────────────────────────────────────────────────────────
let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  frame = null;
  errorDeCarga = e;
}

function api(id) {
  const fn = frame?.performActionAndObserve;
  assert.equal(
    typeof fn,
    'function',
    `performActionAndObserve no exportada (RED) por ./index.js — ${id} de fb-020-002` +
      (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
  );
  return fn;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MARGEN = 30;

/**
 * Llama a performActionAndObserve y captura, en el microtask de la resolución
 * (antes de que corra cualquier otro timer), el `.value` del elemento y los ms
 * transcurridos desde `inicio`.
 */
function observar(observe, el, accion, valor, opciones, inicio) {
  const p = observe(el, accion, valor, opciones);
  return Promise.resolve(p).then((res) => ({
    res,
    valorAlResolver: el && 'value' in el ? el.value : undefined,
    ms: performance.now() - inicio,
  }));
}

/** 'pendiente' si `p` no resolvió (ni rechazó) a los `ms`. */
function estadoA(p, ms) {
  return Promise.race([p.then(() => 'resuelta', () => 'rechazada'), sleep(ms).then(() => 'pendiente')]);
}

const HTML_INPUT = '<main><input id="x" aria-label="campo"></main>';

// ── P1: forma de la respuesta de type ───────────────────────────────────────

test('P1: type sobre input habilitado ⇒ ok:true, settled booleano, waitedMs entero ≥ 0, value === el.value al resolver; "abc" sin cambios ⇒ value "abc"', async () => {
  const observe = api('P1');
  const doc = makeDom(HTML_INPUT);
  const el = doc.getElementById('x');
  const inicio = performance.now();
  const { res, valorAlResolver } = await observar(observe, el, 'type', 'abc', { waitMs: 2000, quietMs: 80 }, inicio);
  const json = JSON.stringify(res);
  assert.equal(res.ok, true, `P1: despacho ok ⇒ ok:true; recibido ${json}`);
  assert.equal(typeof res.settled, 'boolean', `P1: settled es booleano; recibido ${json}`);
  assert.ok(Number.isInteger(res.waitedMs) && res.waitedMs >= 0, `P1: waitedMs entero ≥ 0; recibido ${json}`);
  assert.equal(typeof res.value, 'string', `P1: value es string; recibido ${json}`);
  assert.equal(res.value, valorAlResolver, `P1: value === el.value en el momento de resolver (${valorAlResolver}); recibido ${json}`);
  assert.equal(res.value, 'abc', `P1: el texto escrito no se transforma (I-5); recibido ${json}`);
});

// ── P2: sin actividad ⇒ settled:true ────────────────────────────────────────

test('P2: sin mutaciones ni cambios tras el despacho ⇒ settled:true con waitedMs ≥ quietMs', async () => {
  const observe = api('P2');
  const QUIET = 100;
  const doc = makeDom(HTML_INPUT);
  const el = doc.getElementById('x');
  const inicio = performance.now();
  const { res } = await observar(observe, el, 'type', 'abc', { waitMs: 2000, quietMs: QUIET }, inicio);
  const json = JSON.stringify(res);
  assert.equal(res.ok, true, `P2: ok:true; recibido ${json}`);
  assert.equal(res.settled, true, `P2: documento quieto durante quietMs (${QUIET}) y waitMs 2000 ⇒ settled:true; recibido ${json}`);
  assert.ok(res.waitedMs >= QUIET, `P2: waitedMs (${res.waitedMs}) ≥ quietMs (${QUIET}) — §2.3.3`);
});

// ── P3: cambio sólo de la propiedad value ───────────────────────────────────

test('P3: el script cambia SÓLO la propiedad el.value a t₀+t (sin mutar el DOM) ⇒ no resuelve antes de t₀+t+quietMs, settled:true y value nuevo', async () => {
  const observe = api('P3');
  const T = 100;
  const QUIET = 150;
  const doc = makeDom(HTML_INPUT);
  const el = doc.getElementById('x');
  const inicio = performance.now();
  // Sólo propiedad: sin evento, sin atributo ⇒ ningún récord de MutationObserver.
  const cambio = setTimeout(() => {
    el.value = 'nuevo';
  }, T);
  try {
    const p = observar(observe, el, 'type', 'abc', { waitMs: 3000, quietMs: QUIET }, inicio);
    const estado = await estadoA(p, T + QUIET - MARGEN);
    assert.equal(
      estado,
      'pendiente',
      `P3: piso t+quietMs = ${T + QUIET} ms; a los ${T + QUIET - MARGEN} ms (margen ${MARGEN}) la respuesta debe seguir pendiente — ` +
        'resolver antes indica que el cambio de propiedad no reinició la quietud (§2.3.1)',
    );
    const { res } = await p;
    const json = JSON.stringify(res);
    assert.equal(el.value, 'nuevo', 'precondición P3: el cambio de propiedad ocurrió');
    assert.equal(res.ok, true, `P3: ok:true; recibido ${json}`);
    assert.equal(res.settled, true, `P3: tras la ventana completa desde el cambio ⇒ settled:true; recibido ${json}`);
    assert.equal(res.value, 'nuevo', `P3: value refleja el valor asignado por propiedad; recibido ${json}`);
  } finally {
    clearTimeout(cambio);
  }
});

// ── P4: mutación ajena y reformateo posterior ───────────────────────────────

test('P4: mutación del DOM fuera del campo a t₀+t y cambio de el.value a t₀+t+Δ (Δ < quietMs) ⇒ no resuelve antes de t₀+t+Δ+quietMs y trae el valor nuevo', async () => {
  const observe = api('P4');
  const T = 60;
  const DELTA = 100;
  const QUIET = 150;
  const doc = makeDom(
    '<main><section id="campo"><input id="x" aria-label="campo"></section>' +
      '<section id="otra"><p>otra sección</p></section></main>',
  );
  const el = doc.getElementById('x');
  const otra = doc.getElementById('otra');
  assert.equal(otra.contains(el), false, 'precondición P4: la sección mutada no es ancestro del campo');
  const inicio = performance.now();
  const mutacion = setTimeout(() => {
    otra.appendChild(doc.createElement('span'));
  }, T);
  const reformateo = setTimeout(() => {
    el.value = 'abc,00';
  }, T + DELTA);
  try {
    const p = observar(observe, el, 'type', 'abc', { waitMs: 3000, quietMs: QUIET }, inicio);
    const piso = T + DELTA + QUIET;
    const estado = await estadoA(p, piso - MARGEN);
    assert.equal(
      estado,
      'pendiente',
      `P4: piso t+Δ+quietMs = ${piso} ms; a los ${piso - MARGEN} ms (margen ${MARGEN}) debe seguir pendiente — ` +
        `una quietud cerrada sólo por el DOM caería a ≈${T + QUIET} ms e ignoraría el reformateo`,
    );
    const { res } = await p;
    const json = JSON.stringify(res);
    assert.equal(res.ok, true, `P4: ok:true; recibido ${json}`);
    assert.equal(res.value, 'abc,00', `P4: trae el valor posterior al reformateo; recibido ${json}`);
  } finally {
    clearTimeout(mutacion);
    clearTimeout(reformateo);
  }
});

// ── P5: veto por indicador de carga ─────────────────────────────────────────

test('P5 (remoción): [aria-busy="true"] presente desde el despacho y quitado a t₀+t ⇒ no hay settled:true antes de t₀+t+quietMs', async () => {
  const observe = api('P5');
  const T = 100;
  const QUIET = 120;
  const doc = makeDom(
    '<main><input id="x" aria-label="campo"></main><div id="carga" aria-busy="true"><span>Cargando</span></div>',
  );
  const el = doc.getElementById('x');
  const inicio = performance.now();
  const remocion = setTimeout(() => {
    doc.getElementById('carga').remove();
  }, T);
  try {
    const { res, ms } = await observar(observe, el, 'type', 'abc', { waitMs: 3000, quietMs: QUIET }, inicio);
    const json = JSON.stringify(res);
    // Guarda de no-vacuidad: quitado el indicador y sin más actividad, §2.3.3 + P2 dan
    // settled:true antes del deadline; sin esto, un settled:false permanente pasaría vacuo.
    assert.equal(res.settled, true, `precondición P5: tras quitar el indicador el documento queda quieto ⇒ settled:true; recibido ${json}`);
    const piso = T + QUIET;
    assert.ok(
      ms >= piso - MARGEN,
      `P5: settled:true no puede llegar antes de t+quietMs = ${piso} ms (margen ${MARGEN}); resolvió a ${Math.round(ms)} ms — ` +
        `sin veto la quietud se declararía a ≈${QUIET} ms con el indicador presente`,
    );
  } finally {
    clearTimeout(remocion);
  }
});

test('P5 (persistente): [aria-busy="true"] presente hasta vencer waitMs ⇒ settled:false', async () => {
  const observe = api('P5');
  const doc = makeDom(
    '<main><input id="x" aria-label="campo"></main><div aria-busy="true"><span>Cargando</span></div>',
  );
  const el = doc.getElementById('x');
  const inicio = performance.now();
  const { res } = await observar(observe, el, 'type', 'abc', { waitMs: 400, quietMs: 80 }, inicio);
  const json = JSON.stringify(res);
  assert.equal(res.ok, true, `P5: ok:true; recibido ${json}`);
  assert.equal(
    res.settled,
    false,
    `P5: con el indicador presente al vencer waitMs (400) ⇒ settled:false (sin veto, este DOM quieto daría true a ≈80 ms); recibido ${json}`,
  );
});

// ── P6: deadline ────────────────────────────────────────────────────────────

test('P6: el.value o el DOM cambiando cada 50 ms (< quietMs) hasta después de waitMs ⇒ settled:false, waitMs ≤ waitedMs < waitMs+500, value === el.value al resolver', async () => {
  const observe = api('P6');
  const WAIT = 600;
  const QUIET = 150;
  const PERIODO = 50;

  async function correr(variante) {
    const doc = makeDom(HTML_INPUT);
    const el = doc.getElementById('x');
    let n = 0;
    const inicio = performance.now();
    const actividad = setInterval(() => {
      n++;
      if (variante === 'value') el.value = `v${n}`;
      else doc.body.appendChild(doc.createElement('span'));
    }, PERIODO);
    try {
      return await observar(observe, el, 'type', 'abc', { waitMs: WAIT, quietMs: QUIET }, inicio);
    } finally {
      clearInterval(actividad);
    }
  }

  // En paralelo: dos documentos propios, mismo reloj.
  const [porValue, porDom] = await Promise.all([correr('value'), correr('dom')]);
  for (const [variante, { res, valorAlResolver }] of [
    ['cambios de el.value', porValue],
    ['mutaciones del DOM', porDom],
  ]) {
    const json = JSON.stringify(res);
    assert.equal(res.ok, true, `P6 ${variante}: ok:true (settled:false nunca vuelve ok false); recibido ${json}`);
    assert.equal(res.settled, false, `P6 ${variante}: sin quietud hasta el deadline ⇒ settled:false; recibido ${json}`);
    assert.ok(res.waitedMs >= WAIT, `P6 ${variante}: waitedMs (${res.waitedMs}) ≥ waitMs (${WAIT}) — límite del spec tal cual`);
    assert.ok(res.waitedMs < WAIT + 500, `P6 ${variante}: waitedMs (${res.waitedMs}) < waitMs+500 (${WAIT + 500}) — I-7`);
    assert.equal(res.value, valorAlResolver, `P6 ${variante}: value === el.value al resolver (${valorAlResolver}); recibido ${json}`);
  }
  assert.notEqual(porValue.valorAlResolver, 'abc', 'precondición P6: en la variante de propiedad el valor efectivamente cambió');
});

// ── P7: detached ────────────────────────────────────────────────────────────

test('P7: el elemento se quita del documento a t₀+t ⇒ ok:true, detached:true, settled:false, sin clave value, waitedMs < t+quietMs', async () => {
  const observe = api('P7');
  const T = 60;
  const QUIET = 400;
  const doc = makeDom(HTML_INPUT);
  const el = doc.getElementById('x');
  const inicio = performance.now();
  const quitar = setTimeout(() => {
    el.remove();
  }, T);
  try {
    const { res } = await observar(observe, el, 'type', 'abc', { waitMs: 3000, quietMs: QUIET }, inicio);
    const json = JSON.stringify(res);
    assert.equal(el.isConnected, false, 'precondición P7: el elemento dejó el documento');
    assert.equal(res.ok, true, `P7: detached es observación posterior a un despacho exitoso ⇒ ok:true; recibido ${json}`);
    assert.equal(res.detached, true, `P7: detached:true; recibido ${json}`);
    assert.equal(res.settled, false, `P7: settled:false; recibido ${json}`);
    assert.equal('value' in res, false, `P7: sin la clave value; recibido ${json}`);
    assert.ok(
      res.waitedMs < T + QUIET,
      `P7: waitedMs (${res.waitedMs}) < t+quietMs (${T + QUIET}) — la detección es inmediata (§2.3.5, ≈${T} ms); ` +
        `detectar recién al cerrar la ventana reiniciada por la remoción daría ≥ ${T + QUIET}`,
    );
  } finally {
    clearTimeout(quitar);
  }
});

// ── P8: reemplazo por clon idéntico ─────────────────────────────────────────

test('P8: el elemento se reemplaza en la misma posición por uno idéntico (mismo tag, atributos y ref) ⇒ detached:true igual', async () => {
  const observe = api('P8');
  const T = 60;
  const REF = 'main>input';
  const doc = makeDom('<main><input id="x" name="peso" aria-label="Peso"></main>');
  const el = doc.getElementById('x');
  assert.equal(resolveRef(REF, doc.body), el, `precondición P8: el ref ${REF} resuelve al elemento retenido`);
  let clon = null;
  const inicio = performance.now();
  const reemplazo = setTimeout(() => {
    clon = el.cloneNode(true);
    el.replaceWith(clon);
  }, T);
  try {
    const { res } = await observar(observe, el, 'type', 'abc', { waitMs: 3000, quietMs: 200 }, inicio);
    const json = JSON.stringify(res);
    assert.ok(clon, 'precondición P8: el reemplazo ocurrió durante la espera');
    assert.equal(clon.tagName, el.tagName, 'precondición P8: mismo tag');
    assert.equal(clon.outerHTML, el.outerHTML, 'precondición P8: mismos atributos');
    assert.equal(resolveRef(REF, doc.body), clon, `precondición P8: el ref ${REF} ahora resuelve al clon (mismo ref resultante)`);
    assert.equal(res.ok, true, `P8: ok:true; recibido ${json}`);
    assert.equal(
      res.detached,
      true,
      `P8: se decide por el elemento RETENIDO, nunca re-resolviendo el ref (§2.3.5) ⇒ detached:true; recibido ${json}`,
    );
    assert.equal('value' in res, false, `P8: detached ⇒ sin la clave value (§2.2); recibido ${json}`);
  } finally {
    clearTimeout(reemplazo);
  }
});

// ── P9: parámetros inválidos valen el default ───────────────────────────────

const INVALIDOS = [
  ['"x"', 'x'],
  ['0', 0],
  ['-1', -1],
  ['NaN', NaN],
];

test('P9 (quietMs inválido): "x", 0, -1, NaN resuelven sin error y como sin el parámetro — un cambio de el.value a los 150 ms se refleja en value', async () => {
  const observe = api('P9');
  const T = 150;
  // Excepción a "ventanas cortas" (test-audit §7): se usa el default real de quietMs
  // (300). Con el default, el cambio a 150 ms cae dentro de la ventana y value lo
  // refleja; un quietMs tratado como 0/≈1 ms resolvería a pocos ms con "abc".
  // Margen: 150 ms a cada lado. Tras el cambio el DOM queda quieto (sin deadline de 5 s).
  const corridas = INVALIDOS.map(async ([etiqueta, invalido]) => {
    const doc = makeDom(HTML_INPUT);
    const el = doc.getElementById('x');
    const inicio = performance.now();
    const cambio = setTimeout(() => {
      el.value = 'nuevo';
    }, T);
    try {
      const r = await observar(observe, el, 'type', 'abc', { quietMs: invalido }, inicio);
      return [etiqueta, r];
    } finally {
      clearTimeout(cambio);
    }
  });
  for (const [etiqueta, { res }] of await Promise.all(corridas)) {
    const json = JSON.stringify(res);
    assert.equal(res.ok, true, `P9 quietMs=${etiqueta}: resuelve sin error, ok:true; recibido ${json}`);
    assert.equal(
      res.value,
      'nuevo',
      `P9 quietMs=${etiqueta}: vale el default (300) ⇒ el cambio a ${T} ms se refleja en value; ` +
        `"abc" indica un quietMs tratado como 0; recibido ${json}`,
    );
  }
});

test('P9 (waitMs inválido): "x", 0, -1, NaN resuelven sin error y como sin el parámetro — documento quieto ⇒ settled:true', async () => {
  const observe = api('P9');
  const QUIET = 80;
  // Sin el parámetro (default 5000) un documento quieto da settled:true a ≈quietMs (P2).
  // Un waitMs tratado como 0 o negativo vencería el deadline de inmediato ⇒ settled:false.
  const corridas = INVALIDOS.map(async ([etiqueta, invalido]) => {
    const doc = makeDom(HTML_INPUT);
    const el = doc.getElementById('x');
    const inicio = performance.now();
    return [etiqueta, await observar(observe, el, 'type', 'abc', { waitMs: invalido, quietMs: QUIET }, inicio)];
  });
  for (const [etiqueta, { res }] of await Promise.all(corridas)) {
    const json = JSON.stringify(res);
    assert.equal(res.ok, true, `P9 waitMs=${etiqueta}: resuelve sin error, ok:true; recibido ${json}`);
    assert.equal(
      res.settled,
      true,
      `P9 waitMs=${etiqueta}: vale el default (5000) ⇒ documento quieto ⇒ settled:true; recibido ${json}`,
    );
  }
});

// ── P10: sin MutationObserver ───────────────────────────────────────────────

test('P10: sin doc.defaultView.MutationObserver ⇒ type resuelve settled:false con value', async () => {
  const observe = api('P10');
  const doc = makeDom(HTML_INPUT);
  const el = doc.getElementById('x');
  const win = doc.defaultView;
  const moReal = win.MutationObserver;
  win.MutationObserver = undefined;
  let r;
  try {
    // Captura directa (no assert.doesNotReject, ver settle.test.js P6): un rechazo falla el test.
    r = await observar(observe, el, 'type', 'abc', { waitMs: 500, quietMs: 80 }, performance.now());
  } finally {
    win.MutationObserver = moReal;
  }
  const { res, valorAlResolver } = r;
  const json = JSON.stringify(res);
  assert.equal(res.ok, true, `P10: ok:true; recibido ${json}`);
  assert.equal(res.settled, false, `P10: sin MutationObserver no hay evidencia de quietud ⇒ settled:false (§2.3.6); recibido ${json}`);
  assert.equal(typeof res.value, 'string', `P10: trae value; recibido ${json}`);
  assert.equal(res.value, valorAlResolver, `P10: value === el.value al resolver; recibido ${json}`);
});

// ── P11: paridad con performAction fuera de type ok:true ────────────────────

// Duplicado de act-disabled.test.js (no exportado): HTML_MODAL, FORCE, focoEnOtro y CASOS.
// `inaplicableHabilitado` es el "type inaplicable" que nombra P11.

function focoEnOtro(doc) {
  doc.getElementById('otro').focus();
  assert.equal(doc.activeElement, doc.getElementById('otro'), 'precondición: el foco está en otro elemento habilitado');
}

const HTML_MODAL =
  '<div class="o_content">' +
  '<button id="fondo-deshab" disabled>Guardar</button>' +
  '<input value="ACME">' +
  '</div>' +
  '<div role="dialog" class="modal d-block o_technical_modal" tabindex="-1">' +
  '<div class="modal-dialog modal-dialog-centered modal-xl">' +
  '<div class="modal-content">' +
  '<header class="modal-header"><h4 class="modal-title">Crear Contacto</h4></header>' +
  '<main class="modal-body"><p>Complete los datos.</p></main>' +
  '<footer class="modal-footer"><button id="dlg-deshab" disabled>Confirmar</button><button>Cerrar</button></footer>' +
  '</div></div></div>';

const FORCE = { force: true };

const CASOS = {
  p1Button: { html: '<main><button id="x" disabled>Registrar</button></main>', id: 'x', accion: 'click' },
  p2Input: { html: '<main><input id="x" value="v0" disabled></main>', id: 'x', accion: 'click' },
  p2Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'click',
  },
  p2Textarea: { html: '<main><textarea id="x" disabled>t0</textarea></main>', id: 'x', accion: 'click' },
  p3Markup: { html: '<main><button id="x" disabled="disabled">Go</button></main>', id: 'x', accion: 'click' },
  p3Propiedad: {
    html: '<main><button id="x">Go</button></main>',
    id: 'x',
    accion: 'click',
    preparar: (doc, el) => {
      el.disabled = true;
    },
  },
  p4Button: {
    html: '<form><fieldset disabled><legend>Datos</legend><button id="x" type="button">Go</button></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p4Input: {
    html: '<form><fieldset disabled><legend>Datos</legend><input id="x" type="checkbox"></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p5Legend: {
    html: '<form><fieldset disabled><legend><button id="x" type="button">En legend</button></legend><input></fieldset></form>',
    id: 'x',
    accion: 'click',
  },
  p6Input: { html: '<main><input id="x" value="orig" disabled></main>', id: 'x', accion: 'type', valor: 'nuevo' },
  p6TextareaFieldset: {
    html: '<form><fieldset disabled><legend>L</legend><textarea id="x">orig</textarea></fieldset></form>',
    id: 'x',
    accion: 'type',
    valor: 'nuevo',
  },
  p7Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'b',
  },
  p8Focus: {
    html: '<main><input id="otro"><input id="x" disabled></main>',
    id: 'x',
    accion: 'focus',
    preparar: (doc) => focoEnOtro(doc),
  },
  p9Type: { html: '<main><button id="x" disabled>Go</button></main>', id: 'x', accion: 'type', valor: 'hola' },
  p9Desconocida: { html: '<main><button id="x" disabled>Go</button></main>', id: 'x', accion: 'frobnicar' },
  p10Click: {
    html: '<main><button id="x" disabled>Go</button></main>',
    id: 'x',
    accion: 'click',
    opciones: FORCE,
  },
  p10Type: {
    html: '<main><input id="x" value="orig" disabled></main>',
    id: 'x',
    accion: 'type',
    valor: 'nuevo',
    opciones: FORCE,
  },
  p10Focus: {
    html: '<main><input id="otro"><input id="x" disabled></main>',
    id: 'x',
    accion: 'focus',
    opciones: FORCE,
    preparar: (doc) => focoEnOtro(doc),
  },
  p10Select: {
    html: '<main><select id="x" disabled><option value="a">A</option><option value="b">B</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'b',
    opciones: FORCE,
  },
  p11Fondo: { html: HTML_MODAL, id: 'fondo-deshab', accion: 'click' },
  p12FondoForce: { html: HTML_MODAL, id: 'fondo-deshab', accion: 'click', opciones: FORCE },
  p13Dialogo: { html: HTML_MODAL, id: 'dlg-deshab', accion: 'click' },
  p13DialogoForce: { html: HTML_MODAL, id: 'dlg-deshab', accion: 'click', opciones: FORCE },
  p14StaleForce: {
    html: '<main><button>x</button></main>',
    ref: 'main>input',
    accion: 'click',
    opciones: FORCE,
  },
  p15Click: { html: '<main><button id="x">Go</button></main>', id: 'x', accion: 'click', opciones: FORCE },
  p15Type: { html: '<main><input id="x"></main>', id: 'x', accion: 'type', valor: 'hola', opciones: FORCE },
  p15Focus: { html: '<main><input id="x"></main>', id: 'x', accion: 'focus', opciones: FORCE },
  p15Select: {
    html: '<main><select id="x"><option value="a">A</option><option value="v">V</option></select></main>',
    id: 'x',
    accion: 'select',
    valor: 'v',
    opciones: FORCE,
  },
  inaplicableHabilitado: { html: '<main><button id="x">Go</button></main>', id: 'x', accion: 'type', valor: 'hola' },
};

/** DOM nuevo por llamada: performAction tiene efectos, no se comparan dos llamadas sobre el mismo documento. */
function prepararCaso(caso) {
  const doc = makeDom(caso.html);
  const el = caso.ref !== undefined ? resolveRef(caso.ref, doc.body) : doc.getElementById(caso.id);
  if (caso.preparar) caso.preparar(doc, el);
  return el;
}

function argumentos(caso, el) {
  return caso.opciones === undefined ? [el, caso.accion, caso.valor] : [el, caso.accion, caso.valor, caso.opciones];
}

test('P11: click/focus/select habilitados y todo ok:false (stale, inert, disabled, inaplicable, también type) ⇒ deepEqual a performAction y sin value/settled/waitedMs/detached', async () => {
  const observe = api('P11');
  const NUEVAS = ['value', 'settled', 'waitedMs', 'detached'];
  const cubiertos = [];
  const excluidos = [];

  for (const [nombre, caso] of Object.entries(CASOS)) {
    const esperado = performAction(...argumentos(caso, prepararCaso(caso)));
    // type con despacho ok es el caso observado (P1–P10), fuera del alcance de P11.
    if (caso.accion === 'type' && esperado.ok === true) {
      excluidos.push(nombre);
      continue;
    }
    const obtenido = await observe(...argumentos(caso, prepararCaso(caso)));
    const json = JSON.stringify(obtenido);
    assert.deepEqual(
      obtenido,
      esperado,
      `P11 ${nombre} (${caso.accion}): respuesta idéntica a performAction ${JSON.stringify(esperado)}; recibido ${json}`,
    );
    for (const k of NUEVAS) {
      assert.equal(k in obtenido, false, `P11 ${nombre} (${caso.accion}): sin la clave ${k}; recibido ${json}`);
    }
    cubiertos.push([nombre, caso.accion, esperado]);
  }

  // Guardas de no-vacuidad del recorrido.
  assert.deepEqual(excluidos, ['p15Type'], `precondición P11: sólo se excluye el type habilitado con despacho ok; excluidos ${JSON.stringify(excluidos)}`);
  const hay = (pred) => cubiertos.some(([, accion, r]) => pred(accion, r));
  for (const accion of ['click', 'focus', 'select']) {
    assert.ok(hay((a, r) => a === accion && r.ok === true), `precondición P11: el recorrido incluye ${accion} habilitado con ok:true`);
  }
  assert.ok(hay((a, r) => r.stale === true), 'precondición P11: el recorrido incluye un stale');
  assert.ok(hay((a, r) => r.inert === true), 'precondición P11: el recorrido incluye un inert');
  assert.ok(hay((a, r) => r.disabled === true), 'precondición P11: el recorrido incluye un disabled');
  assert.ok(hay((a, r) => a === 'type' && r.disabled === true), 'precondición P11: el recorrido incluye type disabled');
  assert.ok(
    cubiertos.some(([n, a, r]) => n === 'inaplicableHabilitado' && a === 'type' && r.ok === false),
    'precondición P11: el recorrido incluye un type inaplicable (ok:false) sobre control habilitado',
  );
});
