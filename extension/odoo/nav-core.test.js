/**
 * nav-core.test.js — fb-020-007-orm-navigation-hang, RED v1.3 (post re-review).
 *
 * Núcleo GENÉRICO de navegación (spec §9.7 I-6): verifica P17 (v1.3, latido
 * de página con latido inicial en t=0), P20 (ruteo de fb-progress) y la
 * ubicación/generalidad de I-6.
 * Vive en extension/odoo/ solo por el runner (package.json con node --test);
 * importa el módulo genérico por ruta relativa: ../nav-guard.js.
 *
 * ── Interfaz declarada por test-writer para el implementer ──────────────────
 * Módulo: extension/nav-guard.js (ESM; extension/ no tiene package.json: node
 * 24 lo carga por detección de sintaxis ESM. Si se prefiere sin warning, el
 * implementer puede agregar extension/package.json {"type":"module"} —
 * verificar que no rompa manifest/bundles). Sin mensajes ORM: los literales
 * "odoo_tab_unreachable", "may have been dispatched" y "safe to retry" no
 * aparecen en el archivo (viven en extension/odoo/nav-guard.js).
 *
 * export function dispatchAfterNav({ tabId, inject, isNavigating, events, navWaitMs, getStatus?, stillNavigatingError? })
 *   Mecanismo genérico de §2.1/§9.4. stillNavigatingError(tabId, navWaitMs) → Error
 *   lo provee la capa Odoo (extension/odoo/nav-guard.js re-exporta un
 *   dispatchAfterNav con el mensaje ORM de P8; ver nav-guard.test.js).
 * export function watchInjection({...})
 *   Watchdog genérico de §2.2/§9.5 (firma libre para el implementer; la capa
 *   ORM guardInjection lo envuelve con kinds/mensajes). Sin latido propio.
 *   (+ anillo de diagnóstico §9.6: sin postcondición JS, no testeado acá.)
 *
 * export function pageHeartbeat({ token, sendMessage, heartbeatMs, run, setInterval, clearInterval }) → Promise
 *   P17 v1.3 (§9.2, O-1). Función AUTOCONTENIDA: no referencia nada fuera de su
 *   propio cuerpo (ni imports, ni constantes de módulo, ni helpers), para que
 *   pueda INLINEARSE en la función que se pasa a executeScript (toString o
 *   bundle). Las dependencias entran por parámetro; como los args de
 *   executeScript deben ser JSON, NO se le pasan funciones por args: la
 *   función inyectada (wrapper) llama pageHeartbeat con los globals de la
 *   página (browser.runtime.sendMessage, fetch, setInterval, clearInterval) y
 *   solo token/heartbeatMs cruzan como args.
 *   - invoca run() una vez (run: () => Promise, p.ej. el fetch del ORM).
 *   - emite el latido inicial AL INICIAR (t=0, enmienda v1.3 O-1: recupera
 *     margen frente al throttling de timers en pestañas de segundo plano) y
 *     después, mientras la promesa de run() está pendiente, cada heartbeatMs
 *     (vía el setInterval inyectado): sendMessage({ type: 'fb-progress', token }).
 *     Tras N ticks hay 1 + N latidos.
 *   - al resolver o rechazar run(): llama clearInterval(handle) y no emite más.
 *   - devuelve el mismo desenlace: el valor resuelto, o rechaza con el mismo
 *     error (misma referencia).
 *
 * export function routePageProgress(msg, sender, pendingByToken, send, now?) → void
 *   P20 (§9.2). Función pura del background.
 *   - pendingByToken: Map<token, { id, tabId, startedAt }> de despachos
 *     pendientes (el background borra la entrada al terminar el despacho).
 *   - now: () => number (default Date.now).
 *   - si msg.type === 'fb-progress' y pendingByToken tiene msg.token con
 *     tabId === sender.tab.id: send({ type: 'progress', id, tabId, elapsedMs: now() - startedAt }).
 *   - en cualquier otro caso (otro type, token desconocido/terminado, otra
 *     pestaña, sender sin tab): no llama send.
 *
 * ── Guard de RED ────────────────────────────────────────────────────────────
 * Import dinámico con catch → null; cada test abre con assert.ok(fn, GUARD).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const GENERIC_URL = new URL('../nav-guard.js', import.meta.url);

let core = null;
try {
  core = await import(GENERIC_URL.href);
} catch {
  core = null; // RED: el módulo genérico lo crea el implementer en GREEN.
}

const GUARD = (id, fn) =>
  `extension/nav-guard.js debe existir y exportar ${fn} (${id}) — RED v1.2 de fb-020-007`;

// ── I-6: núcleo genérico en extension/nav-guard.js ──────────────────────────

test('I-6 (§9.7): extension/nav-guard.js exporta dispatchAfterNav y watchInjection y no contiene lógica/textos Odoo', async () => {
  assert.ok(core, GUARD('I-6', 'el módulo'));
  for (const fn of ['dispatchAfterNav', 'watchInjection', 'pageHeartbeat', 'routePageProgress']) {
    assert.equal(typeof core[fn], 'function', GUARD('I-6', fn));
  }
  const src = await readFile(GENERIC_URL, 'utf8');
  for (const s of ['odoo_tab_unreachable', 'may have been dispatched', 'safe to retry']) {
    assert.ok(!src.includes(s), `I-6: el mensaje ORM "${s}" vive en la capa odoo, no en el núcleo genérico`);
  }
});

test('I-6 (P7 genérico): dispatchAfterNav del núcleo, con la pestaña navegando, despacha exactamente una vez tras complete', async () => {
  assert.ok(typeof core?.dispatchAfterNav === 'function', GUARD('I-6/P7', 'dispatchAfterNav'));
  const listeners = new Set();
  const events = {
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: (type, tabId) => [...listeners].forEach((fn) => fn({ type, tabId })),
  };
  let navigating = true;
  let calls = 0;
  const p = core.dispatchAfterNav({
    tabId: 24,
    inject: async () => (calls++, 42),
    isNavigating: () => navigating,
    events,
    navWaitMs: 2000,
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 0, 'I-6/P7: no despacha mientras navega');
  navigating = false;
  events.emit('complete', 24);
  assert.equal(await p, 42, 'I-6/P7: devuelve el resultado de inject');
  assert.equal(calls, 1, 'I-6/P7: exactamente una vez');
});

// ── P17 (v1.2): latido originado en la página ───────────────────────────────

function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  const cleared = [];
  return {
    cleared,
    setInterval: (fn, ms) => {
      const h = next++;
      intervals.set(h, { fn, ms });
      return h;
    },
    clearInterval: (h) => {
      cleared.push(h);
      intervals.delete(h);
    },
    tick() {
      for (const { fn } of [...intervals.values()]) fn();
    },
    get active() {
      return intervals.size;
    },
    get periods() {
      return [...intervals.values()].map((i) => i.ms);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

for (const outcome of ['resolve', 'reject']) {
  test(`P17 (v1.3, ${outcome}): pageHeartbeat emite {type:"fb-progress", token} al iniciar (t=0) y después cada heartbeatMs mientras run está pendiente, y para al ${outcome}, con el mismo desenlace`, async () => {
    assert.ok(typeof core?.pageHeartbeat === 'function', GUARD('P17', 'pageHeartbeat'));
    const timers = fakeTimers();
    const sent = [];
    const d = deferred();
    let runs = 0;
    const p = core.pageHeartbeat({
      token: 'tok-abc',
      sendMessage: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
      heartbeatMs: 15000,
      run: () => (runs++, d.promise),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    const out = { done: false };
    p.then(
      (v) => Object.assign(out, { done: true, value: v }),
      (e) => Object.assign(out, { done: true, error: e })
    );
    await flush();
    await flush();
    assert.equal(runs, 1, 'P17: run se invoca una vez');
    assert.ok(timers.periods.includes(15000), `P17: intervalo de heartbeatMs — got ${timers.periods}`);
    assert.deepEqual(
      sent,
      [{ type: 'fb-progress', token: 'tok-abc' }],
      'P17 (v1.3, O-1): exactamente un latido al iniciar (t=0), antes del primer heartbeatMs'
    );
    timers.tick();
    timers.tick();
    timers.tick();
    assert.deepEqual(
      sent,
      [
        { type: 'fb-progress', token: 'tok-abc' },
        { type: 'fb-progress', token: 'tok-abc' },
        { type: 'fb-progress', token: 'tok-abc' },
        { type: 'fb-progress', token: 'tok-abc' },
      ],
      'P17 (v1.3): 1 latido inicial + 1 por tick (3 ticks → 4)'
    );
    const boom = new Error('fetch failed');
    if (outcome === 'resolve') d.resolve({ result: 2733 });
    else d.reject(boom);
    await flush();
    assert.ok(out.done, 'P17: desenlace propagado');
    if (outcome === 'resolve') assert.deepEqual(out.value, { result: 2733 }, 'P17: mismo valor');
    else assert.equal(out.error, boom, 'P17: mismo error (misma referencia)');
    assert.ok(timers.cleared.length >= 1, 'P17: clearInterval al terminar');
    const count = sent.length;
    timers.tick();
    timers.tick();
    assert.equal(sent.length, count, 'P17: sin latidos después del desenlace');
  });
}

test('P17 (v1.3, inyectable): pageHeartbeat reconstruida desde su código fuente (como executeScript) late en t=0 y funciona igual', async () => {
  assert.ok(typeof core?.pageHeartbeat === 'function', GUARD('P17', 'pageHeartbeat'));
  const rebuilt = (0, eval)(`(${core.pageHeartbeat.toString()})`);
  assert.equal(typeof rebuilt, 'function', 'P17: el código fuente es una expresión de función');
  const timers = fakeTimers();
  const sent = [];
  const d = deferred();
  const p = rebuilt({
    token: 't2',
    sendMessage: (m) => (sent.push(m), Promise.resolve()),
    heartbeatMs: 10,
    run: () => d.promise,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await flush();
  await flush();
  assert.deepEqual(
    sent,
    [{ type: 'fb-progress', token: 't2' }],
    'P17 (v1.3, O-1): la copia serializada late al iniciar (t=0)'
  );
  timers.tick();
  assert.deepEqual(
    sent,
    [
      { type: 'fb-progress', token: 't2' },
      { type: 'fb-progress', token: 't2' },
    ],
    'P17 (v1.3): la copia serializada late también por tick'
  );
  d.resolve('ok');
  assert.equal(await p, 'ok', 'P17: la copia serializada devuelve el desenlace');
  timers.tick();
  assert.equal(sent.length, 2, 'P17: la copia serializada deja de latir tras el desenlace');
});

// ── P20: ruteo de fb-progress en el background ──────────────────────────────

function routeCase({ msg, sender }) {
  const pending = new Map([
    ['tok-1', { id: 'cmd-9', tabId: 24, startedAt: 1000 }],
    ['tok-2', { id: 'cmd-10', tabId: 31, startedAt: 5000 }],
  ]);
  const sent = [];
  core.routePageProgress(msg, sender, pending, (m) => sent.push(m), () => 16000);
  return { sent, pending };
}

test('P20a: fb-progress con token pendiente de esa pestaña → progress {id, tabId, elapsedMs} al hub', () => {
  assert.ok(typeof core?.routePageProgress === 'function', GUARD('P20', 'routePageProgress'));
  const { sent } = routeCase({ msg: { type: 'fb-progress', token: 'tok-1' }, sender: { tab: { id: 24 } } });
  assert.deepEqual(sent, [{ type: 'progress', id: 'cmd-9', tabId: 24, elapsedMs: 15000 }]);
});

test('P20b: token desconocido o de un despacho ya terminado → no reenvía', () => {
  assert.ok(typeof core?.routePageProgress === 'function', GUARD('P20', 'routePageProgress'));
  assert.deepEqual(routeCase({ msg: { type: 'fb-progress', token: 'nope' }, sender: { tab: { id: 24 } } }).sent, []);
  const pending = new Map([['tok-1', { id: 'cmd-9', tabId: 24, startedAt: 1000 }]]);
  pending.delete('tok-1'); // el despacho terminó
  const sent = [];
  core.routePageProgress({ type: 'fb-progress', token: 'tok-1' }, { tab: { id: 24 } }, pending, (m) => sent.push(m), () => 2000);
  assert.deepEqual(sent, [], 'P20b: despacho terminado no reenvía');
});

test('P20c: token pendiente de OTRA pestaña → no reenvía', () => {
  assert.ok(typeof core?.routePageProgress === 'function', GUARD('P20', 'routePageProgress'));
  assert.deepEqual(routeCase({ msg: { type: 'fb-progress', token: 'tok-2' }, sender: { tab: { id: 24 } } }).sent, []);
});

test('P20d: mensaje que no es fb-progress → no reenvía', () => {
  assert.ok(typeof core?.routePageProgress === 'function', GUARD('P20', 'routePageProgress'));
  assert.deepEqual(routeCase({ msg: { type: 'other', token: 'tok-1' }, sender: { tab: { id: 24 } } }).sent, []);
});
