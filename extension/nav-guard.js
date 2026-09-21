// nav-guard.js — fb-020-007-orm-navigation-hang, núcleo genérico (I-6, §9.7).
// Una llamada que inyecta en una pestaña nunca queda sin desenlace por una
// navegación de página completa. Sin lógica ni textos de ningún producto: los
// mensajes de error llegan por parámetro (la capa Odoo vive en odoo/nav-guard.js).
//
//   · dispatchAfterNav (§2.1, §9.4): si la pestaña navega, espera el commit
//     antes del único despacho; consulta el estado real para no esperar por
//     una marca vieja; techo vencido → no despacha.
//   · watchInjection (§2.2, §9.5): rechaza la inyección que quedó huérfana por
//     una navegación o por el cierre de la pestaña. Sin latido propio (§9.2).
//   · pageHeartbeat (§9.2): latido que emite la página mientras su trabajo
//     sigue pendiente. Autocontenida: se inlinea en la función inyectada.
//   · routePageProgress (§9.2): traduce el latido de la página al del hub.
//   · createDiagnosticRing (§9.6): anillo en memoria de eventos de navegación.
//
// Sin APIs de browser: la pestaña, los eventos y la inyección llegan por
// parámetro. El event page lo consume vía bundle IIFE (nav-guard-bundle.js,
// global VulpoNav, generado por odoo/build-probe.sh).

export const NAV_WAIT_MS = 10000;
export const ORPHAN_GRACE_MS = 3000;
export const HEARTBEAT_MS = 15000;
export const DIAGNOSTIC_RING_SIZE = 200;

function subscribeToTab(events, tabId, listener) {
  return events.subscribe((event) => {
    if (event.tabId === tabId) listener(event.type);
  });
}

function invoke(inject) {
  try {
    return Promise.resolve(inject());
  } catch (err) {
    return Promise.reject(err);
  }
}

const defaultStillNavigatingError = (tabId, navWaitMs) =>
  new Error(`tab ${tabId} is still navigating after ${navWaitMs} ms; the command was NOT dispatched; retry after the page loads`);

const defaultClosedWhileNavigatingError = (tabId) =>
  new Error(`tab ${tabId} was closed while navigating; the command was NOT dispatched`);

// §2.1 + §9.4: despacha una sola vez, recién cuando la pestaña no navega.
// getStatus(tabId) → Promise<'loading'|'complete'> (opcional): antes de esperar
// y al vencer el techo, un 'complete' real despacha aunque la marca diga
// navegando; clearNavigating(tabId) (opcional) limpia esa marca vieja.
export function dispatchAfterNav({
  tabId, inject, isNavigating, events, navWaitMs = NAV_WAIT_MS, getStatus, clearNavigating,
  stillNavigatingError = defaultStillNavigatingError,
  closedWhileNavigatingError = defaultClosedWhileNavigatingError,
}) {
  if (!isNavigating(tabId)) return invoke(inject);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(ceiling);
      unsubscribe();
      return true;
    };
    const dispatch = () => {
      if (finish()) invoke(inject).then(resolve, reject);
    };
    const fail = (err) => {
      if (finish()) reject(err);
    };
    const dispatchIfComplete = async () => {
      if (!getStatus) return false;
      let status;
      try {
        status = await getStatus(tabId);
      } catch {
        return false; // estado desconocido: se sigue esperando
      }
      if (status !== 'complete') return false;
      clearNavigating?.(tabId);
      dispatch();
      return true;
    };

    const unsubscribe = subscribeToTab(events, tabId, (type) => {
      if (type === 'removed') fail(closedWhileNavigatingError(tabId));
      else if (type === 'complete') dispatch();
    });
    const ceiling = setTimeout(async () => {
      if (!(await dispatchIfComplete())) fail(stillNavigatingError(tabId, navWaitMs));
    }, navWaitMs);
    dispatchIfComplete();
  });
}

// §2.2 + §9.5: `orphanError()` construye el rechazo por navegación o cierre.
//   (a) 'loading' después del despacho → rechaza grace después del 'complete'.
//   (b) despachada navegando → rechaza declaredWaitMs + grace después del
//       'complete' (la espera declarada puede correr en el documento nuevo).
//   Sin 'complete': navWaitMs + grace desde el 'loading' (o el despacho).
// onOutcome({outcome: 'resolve'|'reject'|'orphan', error?}) es opcional (diagnóstico).
export function watchInjection({
  tabId, inject, orphanError, isNavigating, events,
  navWaitMs = NAV_WAIT_MS, orphanGraceMs = ORPHAN_GRACE_MS, declaredWaitMs = 0, onOutcome,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let orphanTimer = null;
    const settle = (outcome, value, kind) => {
      if (settled) return;
      settled = true;
      clearTimeout(orphanTimer);
      unsubscribe();
      onOutcome?.(kind === 'resolve' ? { outcome: kind } : { outcome: kind, error: value });
      outcome(value);
    };
    const rejectOrphan = () => settle(reject, orphanError(), 'orphan');
    const rejectOrphanAfter = (ms) => {
      clearTimeout(orphanTimer);
      orphanTimer = setTimeout(rejectOrphan, ms);
    };

    let orphanCase = isNavigating(tabId) ? 'b' : null;
    const unsubscribe = subscribeToTab(events, tabId, (type) => {
      if (type === 'removed') {
        rejectOrphan();
      } else if (type === 'loading') {
        orphanCase = 'a';
        rejectOrphanAfter(navWaitMs + orphanGraceMs);
      } else if (type === 'complete' && orphanCase) {
        rejectOrphanAfter(orphanCase === 'b' ? declaredWaitMs + orphanGraceMs : orphanGraceMs);
      }
    });

    if (orphanCase) rejectOrphanAfter(navWaitMs + orphanGraceMs);
    // Una inyección que falla después de quedar huérfana falló por la
    // navegación: su error de plataforma no dice si el comando se despachó.
    invoke(inject).then(
      (value) => settle(resolve, value, 'resolve'),
      (err) => (orphanCase ? rejectOrphan() : settle(reject, err, 'reject')),
    );
  });
}

// §9.2: latido desde la página. AUTOCONTENIDA (sin referencias fuera de su
// cuerpo): background.js inlinea una copia textual en la función inyectada,
// porque executeScript no transporta closures. Un fallo del latido nunca
// cambia el desenlace de run().
export function pageHeartbeat({ token, sendMessage, heartbeatMs, run, setInterval, clearInterval }) {
  const beat = () => {
    try {
      Promise.resolve(sendMessage({ type: 'fb-progress', token })).catch(() => {});
    } catch (_) {
      // latido perdido: el hub decide por inactividad
    }
  };
  // O-1: latido inicial en t=0, antes del primer intervalo — recupera margen
  // frente al throttling de timers de las pestañas en segundo plano.
  beat();
  const handle = setInterval(beat, heartbeatMs);
  let pending;
  try {
    pending = Promise.resolve(run());
  } catch (err) {
    pending = Promise.reject(err);
  }
  return pending.then(
    (value) => {
      clearInterval(handle);
      return value;
    },
    (err) => {
      clearInterval(handle);
      throw err;
    },
  );
}

// §9.2: `pendingByToken` = Map<token, {id, tabId, startedAt}> de despachos
// pendientes. Solo un latido de un despacho vivo de esa pestaña llega al hub.
export function routePageProgress(msg, sender, pendingByToken, send, now = Date.now) {
  if (msg?.type !== 'fb-progress') return;
  const dispatch = pendingByToken.get(msg.token);
  if (!dispatch || dispatch.tabId !== sender?.tab?.id) return;
  send({ type: 'progress', id: dispatch.id, tabId: dispatch.tabId, elapsedMs: now() - dispatch.startedAt });
}

// §9.6: anillo de diagnóstico en memoria (las entradas más viejas se descartan).
export function createDiagnosticRing(size = DIAGNOSTIC_RING_SIZE, now = Date.now) {
  const entries = [];
  return {
    record(entry) {
      const stamped = { t: now(), ...entry };
      entries.push(stamped);
      if (entries.length > size) entries.splice(0, entries.length - size);
      return stamped;
    },
    entries(tabId) {
      return tabId == null ? [...entries] : entries.filter((e) => e.tabId === tabId);
    },
  };
}
