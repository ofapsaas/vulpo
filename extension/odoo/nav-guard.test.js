/**
 * nav-guard.test.js — fb-020-007-orm-navigation-hang (sub-fase RED).
 *
 * Verifica P7–P11 y P14 del spec docs/specs/fb-020-007-orm-navigation-hang/spec.md
 * (§2.1 espera previa, §2.2 watchdog de inyección) con node:test puro y timers
 * REALES cortos (precedente frame/settle.test.js). Sin navegador: la pestaña,
 * la inyección (executeScript) y los eventos de navegación son fakes.
 *
 * ── Interfaz declarada por test-writer para el implementer ──────────────────
 * Módulo: extension/odoo/nav-guard.js (ESM). Los techos se inyectan; los
 * defaults de producción son NAV_WAIT_MS = 10000 y ORPHAN_GRACE_MS = 3000
 * (también exportados como constantes).
 *
 * Tipos comunes:
 *   isNavigating: (tabId:number) => boolean   // lectura de navigatingTabs
 *   events: { subscribe(listener) => unsubscribe }
 *     listener recibe { type: 'loading' | 'complete' | 'removed', tabId }
 *     (el caller ya filtró: solo navegaciones de página completa del frame
 *     principal — R-2). El módulo ignora eventos de otras tabId y debe
 *     desuscribirse al terminar.
 *   inject: () => Promise<any>                // el executeScript real
 *
 * export function dispatchAfterNav({ tabId, inject, isNavigating, events, navWaitMs })
 *   → Promise<resultado de inject()>
 *   - si isNavigating(tabId) es false: invoca inject() una vez, ya.
 *   - si es true: espera un 'complete' de esa tab; recién entonces invoca
 *     inject() exactamente una vez.
 *   - si no llega 'complete' en navWaitMs: NO invoca inject y rechaza con
 *     Error(`odoo_tab_unreachable: tab ${tabId} is still navigating after ${navWaitMs} ms; the command was NOT dispatched; retry after the page loads`)
 *
 * export function guardInjection({ tabId, inject, kind, isNavigating, events, navWaitMs, orphanGraceMs })
 *   → Promise<resultado de inject()>
 *   - invoca inject() exactamente una vez, inmediatamente.
 *   - huérfana si (a) llega 'loading' de la tab después del despacho, o
 *     (b) isNavigating(tabId) era true al despachar y llega 'complete'.
 *   - huérfana sin resolver: rechaza orphanGraceMs después del 'complete';
 *     si el 'complete' no llega, navWaitMs + orphanGraceMs después del
 *     'loading' (o del despacho en el caso (b)).
 *   - 'removed' de la tab con inyección pendiente: rechaza de inmediato.
 *   - sin eventos: sin tiempo máximo; el resultado de inject pasa intacto.
 *   - resolución/rechazo de inject posterior al rechazo del watchdog: se
 *     descarta (sin segundo desenlace ni unhandledRejection).
 *   - kind y mensaje del rechazo por navegación (§2.2):
 *       'orm-write' → `odoo_tab_unreachable: tab ${T} navigated while the command was running; the command may have been dispatched — re-read before retrying`
 *       'orm-read' | 'probe' → `odoo_tab_unreachable: tab ${T} navigated while the command was running; the command did not complete; it is safe to retry`
 *       'act' → writeOutcomeUnknownError('act', 'tab navigated while the action was running')
 *               (vive en background.js; el implementer puede aceptar un
 *               `makeError` opcional o replicar el texto vigente "…may or may
 *               not have been dispatched…" — no testeado acá: ninguna P# lo exige)
 *       'wait' → `tab ${T} navigated while the command was running; retry`
 *   - [v1.2 §9.2, P17 reescrita] SIN latido por timer propio: aunque reciba
 *       id/heartbeatMs/onProgress (params del v1.1), nunca invoca onProgress.
 *       El latido lo origina la página (pageHeartbeat en ../nav-guard.js,
 *       ver nav-core.test.js).
 *   - [v1.2 §9.5, P25] declaredWaitMs opcional (default 0): en el caso (b)
 *       el rechazo ocurre a complete + declaredWaitMs + orphanGraceMs.
 *       Caso (a) sin cambios. (Reenviado al watchInjection genérico.)
 *
 * [v1.2 §9.4, P24] dispatchAfterNav acepta getStatus opcional:
 *   getStatus: (tabId) => Promise<'loading'|'complete'>. Ausente → comportamiento
 *   de P7/P8. Presente: antes de esperar y al vencer el techo consulta el estado
 *   real; 'complete' → despacha (una vez) aunque isNavigating diga true.
 *
 * [v1.2 §9.3, P22] export function noResultError(tabId, kind) → Error | string
 *   (se lee .message si es Error). Resultado nulo de una inyección que corrió:
 *     'orm-write' → `odoo_tab_unreachable: tab ${T}: the command may have been dispatched — re-read before retrying`
 *     'orm-read' | 'probe' → el mensaje vigente de fb-020-006 (classifyInjectionFailure
 *       de session-probe.js): empieza con "odoo_tab_unreachable:", contiene el
 *       tabId y no dice "may have been dispatched".
 *
 * [v1.2 §9.7, I-6] Estructura: el núcleo genérico vive en extension/nav-guard.js
 *   (ver nav-core.test.js). Este módulo (extension/odoo/nav-guard.js, NO se
 *   renombra) conserva la capa ORM: dispatchAfterNav con el mensaje ORM de §2.1
 *   (wrapper del genérico), guardInjection (kinds/mensajes), probeTabsGuarded y
 *   noResultError.
 *
 * export async function probeTabsGuarded({ tabs, probe, isNavigating, events, navWaitMs, orphanGraceMs })
 *   → Promise<Array<{ tabId, url, state, info? }>>   (entradas para aggregateDetection)
 *   - tabs: [{ tabId, url }]; probe: (tabId) => Promise<{ tabId, url, state, info? }>
 *   - sondea todas las tabs en paralelo, cada una con dispatchAfterNav +
 *     guardInjection(kind 'probe'); toda falla (espera vencida, huérfana,
 *     cerrada, rechazo) → { tabId, url, state: 'detection-failed' }.
 *   - devuelve una entrada por tab, en el orden de `tabs`.
 *   odooDetectTabs (background.js) = aggregateDetection(await probeTabsGuarded(...)).
 *
 * ── Guard de RED ────────────────────────────────────────────────────────────
 * nav-guard.js no existe: import dinámico con catch → null y cada test abre
 * con assert.ok(fn, GUARD(...)) → hoy fallan por AssertionError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let mod = null;
try {
  mod = await import('./nav-guard.js');
} catch {
  mod = null; // RED: el módulo lo crea el implementer en GREEN.
}
const dispatchAfterNav = mod?.dispatchAfterNav ?? null;
const guardInjection = mod?.guardInjection ?? null;
const probeTabsGuarded = mod?.probeTabsGuarded ?? null;
const noResultError = mod?.noResultError ?? null;

const GUARD = (id, fn) =>
  `nav-guard.js debe existir y exportar ${fn} (postcondición ${id}) — RED de fb-020-007`;

// ── fakes ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EPS = 150; // ε de scheduling (ms)
const NAV_WAIT = 200; // navWaitMs inyectado
const GRACE = 100; // orphanGraceMs inyectado

function makeEvents() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(type, tabId) {
      for (const fn of [...listeners]) fn({ type, tabId });
    },
    get size() {
      return listeners.size;
    },
  };
}

function makeTab(navigating) {
  const state = { navigating };
  return { state, isNavigating: () => state.navigating };
}

/** inject fake con contador; `never` → promesa que nunca se resuelve. */
function makeInject({ never = false, value, afterMs = 0 } = {}) {
  const calls = [];
  let resolve;
  let reject;
  const fn = () => {
    calls.push(Date.now());
    return new Promise((res, rej) => {
      resolve = res;
      reject = rej;
      if (!never) setTimeout(() => res(value), afterMs);
    });
  };
  return {
    fn,
    calls,
    resolveLate: (v) => resolve?.(v),
    rejectLate: (e) => reject?.(e),
  };
}

/** Observa el desenlace de una promesa sin dejarla sin handler. */
function settle(p) {
  const out = { done: false, value: undefined, error: undefined, at: null };
  out.promise = p.then(
    (v) => Object.assign(out, { done: true, value: v, at: Date.now() }),
    (e) => Object.assign(out, { done: true, error: e, at: Date.now() })
  );
  return out;
}

// ── P7: espera previa, invoca una vez tras complete ─────────────────────────

test('P7: con la pestaña navegando, inject no se invoca antes de complete y exactamente una vez después', async () => {
  assert.ok(typeof dispatchAfterNav === 'function', GUARD('P7', 'dispatchAfterNav'));
  const tab = makeTab(true);
  const events = makeEvents();
  const inj = makeInject({ value: 2733 });
  const out = settle(
    dispatchAfterNav({ tabId: 24, inject: inj.fn, isNavigating: tab.isNavigating, events, navWaitMs: 2000 })
  );
  await sleep(60);
  assert.equal(inj.calls.length, 0, 'P7: inject NO debe invocarse mientras la pestaña navega');
  assert.equal(out.done, false, 'P7: no debe haber desenlace antes de complete');
  tab.state.navigating = false;
  events.emit('complete', 99); // otra pestaña: no cuenta
  await sleep(20);
  assert.equal(inj.calls.length, 0, 'P7: un complete de otra tab no despacha');
  events.emit('complete', 24);
  await out.promise;
  assert.equal(inj.calls.length, 1, `P7: inject exactamente una vez tras complete — got ${inj.calls.length}`);
  assert.equal(out.error, undefined, `P7: no debe rechazar — got ${out.error?.message}`);
  assert.equal(out.value, 2733, 'P7: devuelve el resultado de inject');
  events.emit('complete', 24);
  await sleep(20);
  assert.equal(inj.calls.length, 1, 'P7: un segundo complete no re-despacha (I-1)');
});

// ── P8: techo de espera previa ──────────────────────────────────────────────

test('P8: sin complete antes de navWaitMs rechaza con odoo_tab_unreachable + tabId + "NOT dispatched"; inject 0 veces', async () => {
  assert.ok(typeof dispatchAfterNav === 'function', GUARD('P8', 'dispatchAfterNav'));
  const tab = makeTab(true);
  const events = makeEvents();
  const inj = makeInject({ value: 1 });
  const t0 = Date.now();
  const out = settle(
    dispatchAfterNav({ tabId: 24, inject: inj.fn, isNavigating: tab.isNavigating, events, navWaitMs: 80 })
  );
  await Promise.race([out.promise, sleep(80 + 1000)]);
  assert.ok(out.done, 'P8: debe tener desenlace tras el techo');
  assert.ok(out.error instanceof Error, `P8: debe rechazar con Error — got value ${JSON.stringify(out.value)}`);
  const m = out.error.message;
  assert.ok(m.startsWith('odoo_tab_unreachable:'), `P8: prefijo — got ${JSON.stringify(m)}`);
  assert.ok(m.includes('24'), `P8: tabId — got ${JSON.stringify(m)}`);
  assert.ok(m.includes('NOT dispatched'), `P8: "NOT dispatched" — got ${JSON.stringify(m)}`);
  assert.equal(
    m,
    'odoo_tab_unreachable: tab 24 is still navigating after 80 ms; the command was NOT dispatched; retry after the page loads',
    'P8: texto exacto de §2.1'
  );
  assert.ok(out.at - t0 >= 70, `P8: no rechaza antes del techo — ${out.at - t0} ms`);
  assert.equal(inj.calls.length, 0, 'P8: inject 0 veces');
  events.emit('complete', 24);
  await sleep(20);
  assert.equal(inj.calls.length, 0, 'P8: un complete tardío no despacha');
});

// ── P9: watchdog, loading + complete después del despacho ──────────────────

for (const [kind, needle, forbidden] of [
  ['orm-write', 'may have been dispatched', 'safe to retry'],
  ['orm-read', 'safe to retry', 'may have been dispatched'],
]) {
  test(`P9 (${kind}): inyección huérfana (loading+complete tras despacho) rechaza dentro de ORPHAN_GRACE_MS+ε desde complete con "${needle}"`, async () => {
    assert.ok(typeof guardInjection === 'function', GUARD('P9', 'guardInjection'));
    const tab = makeTab(false);
    const events = makeEvents();
    const inj = makeInject({ never: true });
    const out = settle(
      guardInjection({
        tabId: 24,
        inject: inj.fn,
        kind,
        isNavigating: tab.isNavigating,
        events,
        navWaitMs: NAV_WAIT,
        orphanGraceMs: GRACE,
      })
    );
    await sleep(20);
    tab.state.navigating = true;
    events.emit('loading', 24);
    await sleep(30);
    tab.state.navigating = false;
    const tComplete = Date.now();
    events.emit('complete', 24);
    await Promise.race([out.promise, sleep(GRACE + NAV_WAIT + 1000)]);
    assert.ok(out.done, 'P9: la inyección huérfana debe tener desenlace');
    assert.ok(out.error instanceof Error, 'P9: debe rechazar');
    const elapsed = out.at - tComplete;
    assert.ok(elapsed <= GRACE + EPS, `P9: rechazo dentro de ${GRACE}+${EPS} ms desde complete — got ${elapsed} ms`);
    const m = out.error.message;
    assert.ok(m.startsWith('odoo_tab_unreachable:'), `P9: prefijo — got ${JSON.stringify(m)}`);
    assert.ok(m.includes('tab 24'), `P9: tabId — got ${JSON.stringify(m)}`);
    assert.ok(m.includes(needle), `P9: debe contener "${needle}" — got ${JSON.stringify(m)}`);
    assert.ok(!m.includes(forbidden), `P9: no debe contener "${forbidden}" — got ${JSON.stringify(m)}`);
    assert.equal(inj.calls.length, 1, 'P9: inject exactamente una vez');
  });
}

// ── P10: despachada navegando + complete; pestaña cerrada ───────────────────

test('P10a: inyección despachada con la pestaña navegando que no se resuelve rechaza dentro de ORPHAN_GRACE_MS+ε desde complete', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P10', 'guardInjection'));
  const tab = makeTab(true);
  const events = makeEvents();
  const inj = makeInject({ never: true });
  const out = settle(
    guardInjection({
      tabId: 31,
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
    })
  );
  await sleep(30);
  tab.state.navigating = false;
  const tComplete = Date.now();
  events.emit('complete', 31);
  await Promise.race([out.promise, sleep(GRACE + NAV_WAIT + 1000)]);
  assert.ok(out.done && out.error instanceof Error, 'P10a: debe rechazar');
  const elapsed = out.at - tComplete;
  assert.ok(elapsed <= GRACE + EPS, `P10a: dentro de ${GRACE}+${EPS} ms desde complete — got ${elapsed} ms`);
  assert.ok(out.error.message.startsWith('odoo_tab_unreachable:'), `P10a: prefijo — got ${out.error.message}`);
  assert.ok(out.error.message.includes('tab 31'), `P10a: tabId — got ${out.error.message}`);
  assert.equal(inj.calls.length, 1, 'P10a: inject exactamente una vez');
});

test('P10b: pestaña cerrada (removed) con inyección pendiente rechaza dentro de ε', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P10', 'guardInjection'));
  const tab = makeTab(false);
  const events = makeEvents();
  const inj = makeInject({ never: true });
  const out = settle(
    guardInjection({
      tabId: 32,
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: 5000,
      orphanGraceMs: 5000,
    })
  );
  await sleep(20);
  const tRemoved = Date.now();
  events.emit('removed', 32);
  await Promise.race([out.promise, sleep(1000)]);
  assert.ok(out.done && out.error instanceof Error, 'P10b: debe rechazar al cerrarse la pestaña');
  const elapsed = out.at - tRemoved;
  assert.ok(elapsed <= EPS, `P10b: dentro de ε=${EPS} ms — got ${elapsed} ms`);
});

// ── P11: sin navegación no hay tiempo máximo; un único desenlace ────────────

test('P11a: sin eventos, una inyección que resuelve a T > grace y T > navWait devuelve su resultado intacto', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P11', 'guardInjection'));
  const tab = makeTab(false);
  const events = makeEvents();
  const result = { value: 2733, nested: { ok: true } };
  const T = NAV_WAIT + GRACE + 100;
  const inj = makeInject({ value: result, afterMs: T });
  const t0 = Date.now();
  const out = settle(
    guardInjection({
      tabId: 40,
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
    })
  );
  events.emit('loading', 41); // otra pestaña: no cuenta
  events.emit('complete', 41);
  await Promise.race([out.promise, sleep(T + 1000)]);
  assert.ok(out.done, 'P11a: debe tener desenlace');
  assert.equal(out.error, undefined, `P11a: no debe rechazar — got ${out.error?.message}`);
  assert.equal(out.value, result, 'P11a: resultado intacto (misma referencia)');
  assert.ok(out.at - t0 >= T - 10, `P11a: el desenlace es la resolución real — ${out.at - t0} ms`);
  assert.equal(inj.calls.length, 1, 'P11a: inject exactamente una vez');
});

test('P11b: resolución o rechazo posterior al rechazo del watchdog no produce un segundo desenlace', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P11', 'guardInjection'));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const late of ['resolve', 'reject']) {
      const tab = makeTab(false);
      const events = makeEvents();
      const inj = makeInject({ never: true });
      let outcomes = 0;
      const p = guardInjection({
        tabId: 50,
        inject: inj.fn,
        kind: 'orm-write',
        isNavigating: tab.isNavigating,
        events,
        navWaitMs: NAV_WAIT,
        orphanGraceMs: GRACE,
      });
      const out = settle(p);
      p.then(() => outcomes++, () => outcomes++);
      await sleep(10);
      events.emit('removed', 50);
      await Promise.race([out.promise, sleep(1000)]);
      assert.ok(out.done && out.error instanceof Error, `P11b(${late}): el watchdog rechaza primero`);
      const firstError = out.error;
      if (late === 'resolve') inj.resolveLate({ late: true });
      else inj.rejectLate(new Error('late failure'));
      await sleep(50);
      assert.equal(outcomes, 1, `P11b(${late}): un único desenlace`);
      assert.equal(out.error, firstError, `P11b(${late}): el desenlace sigue siendo el rechazo original`);
      assert.equal(out.value, undefined, `P11b(${late}): el resultado tardío se descarta`);
    }
    assert.equal(unhandled.length, 0, `P11b: sin unhandledRejection — got ${unhandled.map(String)}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ── P14: detección con una sonda huérfana ───────────────────────────────────

test('P14: probeTabsGuarded con una sonda huérfana retorna antes de NAV_WAIT_MS+ORPHAN_GRACE_MS+ε, esa tab detection-failed y las demás clasificadas', async () => {
  assert.ok(typeof probeTabsGuarded === 'function', GUARD('P14', 'probeTabsGuarded'));
  const navigating = new Set();
  const events = makeEvents();
  const tabs = [
    { tabId: 5, url: 'https://edu.example.com/odoo' },
    { tabId: 7, url: 'https://erp.example.com/odoo/action-760' },
    { tabId: 9, url: 'https://old.example.com/web' },
  ];
  const probeCalls = new Map();
  const probe = (tabId) => {
    probeCalls.set(tabId, (probeCalls.get(tabId) ?? 0) + 1);
    const tab = tabs.find((t) => t.tabId === tabId);
    if (tabId === 7) {
      // Sonda que queda huérfana: la pestaña empieza a navegar tras el
      // despacho y el commit nunca llega (peor caso del plazo de §2.2).
      setTimeout(() => {
        navigating.add(7);
        events.emit('loading', 7);
      }, 10);
      return new Promise(() => {});
    }
    if (tabId === 5) {
      return sleep(20).then(() => ({
        tabId: 5,
        url: tab.url,
        state: 'valid',
        info: { uid: 2, username: 'admin', db: 'demo', server_version: '19.0', is_superuser: true, user_context: {} },
      }));
    }
    return sleep(20).then(() => ({ tabId: 9, url: tab.url, state: 'expired' }));
  };
  const t0 = Date.now();
  const out = settle(
    probeTabsGuarded({
      tabs,
      probe,
      isNavigating: (id) => navigating.has(id),
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
    })
  );
  await Promise.race([out.promise, sleep(NAV_WAIT + GRACE + 2000)]);
  assert.ok(out.done, 'P14: la detección debe terminar');
  const elapsed = out.at - t0;
  assert.ok(
    elapsed <= NAV_WAIT + GRACE + EPS,
    `P14: debe retornar antes de ${NAV_WAIT}+${GRACE}+${EPS} ms — got ${elapsed} ms`
  );
  assert.equal(out.error, undefined, `P14: no debe rechazar — got ${out.error?.message}`);
  assert.ok(Array.isArray(out.value), `P14: devuelve array de entradas — got ${JSON.stringify(out.value)}`);
  const byId = new Map(out.value.map((e) => [e.tabId, e]));
  assert.equal(out.value.length, 3, `P14: una entrada por tab — got ${JSON.stringify(out.value)}`);
  assert.equal(byId.get(7)?.state, 'detection-failed', `P14: tab 7 huérfana → detection-failed — got ${JSON.stringify(byId.get(7))}`);
  assert.equal(byId.get(7)?.url, tabs[1].url, 'P14: la entrada fallida conserva url');
  assert.equal(byId.get(5)?.state, 'valid', `P14: tab 5 clasificada normal — got ${JSON.stringify(byId.get(5))}`);
  assert.equal(byId.get(5)?.info?.uid, 2, 'P14: tab 5 conserva info');
  assert.equal(byId.get(9)?.state, 'expired', `P14: tab 9 clasificada normal — got ${JSON.stringify(byId.get(9))}`);
  for (const t of tabs) assert.equal(probeCalls.get(t.tabId), 1, `P14: sonda de tab ${t.tabId} exactamente una vez`);
});

// ── P17 (v1.2 §9.2): guardInjection NO late por timer propio ────────────────
// Reemplaza a los tres P17 de v1.1 (latido de background vía onProgress): ese
// latido ya no existe. La afirmación nueva es su negación observable.

test('P17 (v1.2): guardInjection con inyección pendiente no emite ningún latido por timer propio (aunque reciba id/heartbeatMs/onProgress)', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P17', 'guardInjection'));
  const HB = 20;
  const tab = makeTab(false);
  const events = makeEvents();
  const beats = [];
  const inj = makeInject({ never: true });
  const out = settle(
    guardInjection({
      tabId: 60,
      id: 'cmd-17',
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
      heartbeatMs: HB,
      onProgress: (p) => beats.push(p),
    })
  );
  await sleep(HB * 8);
  const seen = beats.length;
  inj.resolveLate(1); // antes de asertar: no dejar timers vivos si falla (RED sin cuelgue)
  await out.promise;
  assert.equal(seen, 0, `P17 v1.2: sin latido de background — got ${JSON.stringify(beats)}`);
  assert.equal(out.value, 1, 'P17 v1.2: el resultado pasa intacto');
});

// ── P22 (v1.2 §9.3): resultado nulo según kind ──────────────────────────────

const msgOf = (x) => (x instanceof Error ? x.message : x);

test('P22a: noResultError(tabId, "orm-write") dice "may have been dispatched" y "re-read before retrying"', () => {
  assert.ok(typeof noResultError === 'function', GUARD('P22', 'noResultError'));
  const m = msgOf(noResultError(24, 'orm-write'));
  assert.equal(typeof m, 'string', `P22a: mensaje string — got ${JSON.stringify(m)}`);
  assert.ok(m.startsWith('odoo_tab_unreachable:'), `P22a: prefijo — got ${JSON.stringify(m)}`);
  assert.ok(m.includes('tab 24'), `P22a: tabId — got ${JSON.stringify(m)}`);
  assert.ok(m.includes('may have been dispatched'), `P22a: "may have been dispatched" — got ${JSON.stringify(m)}`);
  assert.ok(m.includes('re-read before retrying'), `P22a: "re-read before retrying" — got ${JSON.stringify(m)}`);
  assert.ok(!m.includes('safe to retry'), `P22a: no invita a reintentar sin releer — got ${JSON.stringify(m)}`);
});

for (const kind of ['orm-read', 'probe']) {
  test(`P22b (${kind}): noResultError conserva el mensaje vigente de lectura (odoo_tab_unreachable:, tabId, sin "may have been dispatched")`, () => {
    assert.ok(typeof noResultError === 'function', GUARD('P22', 'noResultError'));
    const m = msgOf(noResultError(31, kind));
    assert.equal(typeof m, 'string', `P22b: mensaje string — got ${JSON.stringify(m)}`);
    assert.ok(m.startsWith('odoo_tab_unreachable:'), `P22b: prefijo — got ${JSON.stringify(m)}`);
    assert.ok(m.includes('31'), `P22b: tabId — got ${JSON.stringify(m)}`);
    assert.ok(!m.includes('may have been dispatched'), `P22b: lectura no dice "may have been dispatched" — got ${JSON.stringify(m)}`);
    assert.ok(!m.includes('re-read before retrying'), `P22b: lectura no pide releer — got ${JSON.stringify(m)}`);
  });
}

// ── P24 (v1.2 §9.4): marca de navegación desactualizada ─────────────────────

test('P24a: isNavigating true + getStatus→complete despacha de inmediato (sin evento complete), exactamente una vez', async () => {
  assert.ok(typeof dispatchAfterNav === 'function', GUARD('P24', 'dispatchAfterNav'));
  const events = makeEvents();
  const inj = makeInject({ value: 2733 });
  const statusCalls = [];
  const t0 = Date.now();
  const out = settle(
    dispatchAfterNav({
      tabId: 24,
      inject: inj.fn,
      isNavigating: () => true, // marca vieja: nunca se limpia sola
      getStatus: async (id) => {
        statusCalls.push(id);
        return 'complete';
      },
      events,
      navWaitMs: 2000,
    })
  );
  await Promise.race([out.promise, sleep(2000 + 500)]);
  assert.ok(out.done, 'P24a: debe tener desenlace');
  assert.equal(out.error, undefined, `P24a: no debe rechazar — got ${out.error?.message}`);
  assert.equal(out.value, 2733, 'P24a: devuelve el resultado de inject');
  assert.equal(inj.calls.length, 1, `P24a: inject exactamente una vez — got ${inj.calls.length}`);
  assert.ok(inj.calls[0] - t0 <= EPS, `P24a: despacho inmediato (≤ ε=${EPS} ms) — got ${inj.calls[0] - t0} ms`);
  assert.ok(statusCalls.includes(24), 'P24a: consulta getStatus de la tab');
  events.emit('complete', 24);
  await sleep(20);
  assert.equal(inj.calls.length, 1, 'P24a: un complete posterior no re-despacha (I-1)');
});

test('P24b: isNavigating true + getStatus→loading sin complete falla al techo como P8; inject 0 veces', async () => {
  assert.ok(typeof dispatchAfterNav === 'function', GUARD('P24', 'dispatchAfterNav'));
  const events = makeEvents();
  const inj = makeInject({ value: 1 });
  const t0 = Date.now();
  const out = settle(
    dispatchAfterNav({
      tabId: 24,
      inject: inj.fn,
      isNavigating: () => true,
      getStatus: async () => 'loading',
      events,
      navWaitMs: 80,
    })
  );
  await Promise.race([out.promise, sleep(80 + 1000)]);
  assert.ok(out.done && out.error instanceof Error, `P24b: debe rechazar — got ${JSON.stringify(out.value)}`);
  assert.equal(
    out.error.message,
    'odoo_tab_unreachable: tab 24 is still navigating after 80 ms; the command was NOT dispatched; retry after the page loads',
    'P24b: texto exacto de §2.1 (como P8)'
  );
  assert.ok(out.at - t0 >= 70, `P24b: no rechaza antes del techo — ${out.at - t0} ms`);
  assert.equal(inj.calls.length, 0, 'P24b: inject 0 veces');
});

// ── P25 (v1.2 §9.5): caso (b) con espera declarada ──────────────────────────

const W = 300; // declaredWaitMs inyectado
const DELTA = 80; // δ

test('P25a: caso (b) con declaredWaitMs W: inyección que resuelve a complete+W−δ devuelve su resultado', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P25', 'guardInjection'));
  const tab = makeTab(true);
  const events = makeEvents();
  const inj = makeInject({ never: true });
  const out = settle(
    guardInjection({
      tabId: 70,
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
      declaredWaitMs: W,
    })
  );
  await sleep(20);
  tab.state.navigating = false;
  events.emit('complete', 70);
  await sleep(W - DELTA);
  assert.equal(out.done, false, `P25a: sin desenlace antes de complete+W — got ${out.error?.message}`);
  inj.resolveLate('ok-70');
  await Promise.race([out.promise, sleep(500)]);
  assert.ok(out.done, 'P25a: debe tener desenlace');
  assert.equal(out.error, undefined, `P25a: no debe rechazar — got ${out.error?.message}`);
  assert.equal(out.value, 'ok-70', 'P25a: resultado intacto');
  assert.equal(inj.calls.length, 1, 'P25a: inject exactamente una vez');
});

test('P25b: caso (b) con declaredWaitMs W: inyección que no resuelve rechaza entre complete+W+grace y +ε', async () => {
  assert.ok(typeof guardInjection === 'function', GUARD('P25', 'guardInjection'));
  const tab = makeTab(true);
  const events = makeEvents();
  const inj = makeInject({ never: true });
  const out = settle(
    guardInjection({
      tabId: 71,
      inject: inj.fn,
      kind: 'orm-read',
      isNavigating: tab.isNavigating,
      events,
      navWaitMs: NAV_WAIT,
      orphanGraceMs: GRACE,
      declaredWaitMs: W,
    })
  );
  await sleep(20);
  tab.state.navigating = false;
  const tComplete = Date.now();
  events.emit('complete', 71);
  await Promise.race([out.promise, sleep(W + GRACE + 1000)]);
  assert.ok(out.done && out.error instanceof Error, 'P25b: debe rechazar');
  const elapsed = out.at - tComplete;
  assert.ok(elapsed >= W + GRACE - 10, `P25b: no antes de complete+W+grace (${W + GRACE} ms) — got ${elapsed} ms`);
  assert.ok(elapsed <= W + GRACE + EPS, `P25b: dentro de W+grace+ε (${W + GRACE + EPS} ms) — got ${elapsed} ms`);
  assert.ok(out.error.message.startsWith('odoo_tab_unreachable:'), `P25b: prefijo — got ${out.error.message}`);
  assert.equal(inj.calls.length, 1, 'P25b: inject exactamente una vez');
});

