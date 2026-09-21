// nav-guard.js — fb-020-007-orm-navigation-hang, capa ORM (event page + node).
// Aplica el núcleo genérico (../nav-guard.js, I-6) a los comandos Odoo:
//
//   · dispatchAfterNav (§2.1, §9.4): espera previa con el mensaje ORM.
//   · guardInjection: watchdog con el mensaje de cada kind ORM (§2.2, §9.5).
//   · noResultError (§9.3): inyección que corrió sin devolver resultado.
//   · probeTabsGuarded: sondas de detección en paralelo, nunca rechaza.
//
// El event page lo consume vía bundle IIFE (odoo-nav-guard-bundle.js, global
// VulpoNavGuard, generado por build-probe.sh).

import {
  NAV_WAIT_MS,
  ORPHAN_GRACE_MS,
  HEARTBEAT_MS,
  dispatchAfterNav as dispatchAfterNavGeneric,
  watchInjection,
} from '../nav-guard.js';
import { classifyInjectionFailure } from './session-probe.js';

export { NAV_WAIT_MS, ORPHAN_GRACE_MS, HEARTBEAT_MS };

// §2.1: espera previa de un comando ORM o de la sonda de sesión.
export function dispatchAfterNav(options) {
  return dispatchAfterNavGeneric({
    ...options,
    stillNavigatingError: (tabId, navWaitMs) => new Error(`odoo_tab_unreachable: tab ${tabId} is still navigating after ${navWaitMs} ms; the command was NOT dispatched; retry after the page loads`),
    closedWhileNavigatingError: (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} was closed while navigating; the command was NOT dispatched`),
  });
}

const READ_NAVIGATION_ERROR = (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} navigated while the command was running; the command did not complete; it is safe to retry`);

// Mensaje del rechazo por navegación según qué pudo haber pasado (§2.2).
const NAVIGATION_ERRORS = {
  'orm-write': (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} navigated while the command was running; the command may have been dispatched — re-read before retrying`),
  'orm-read': READ_NAVIGATION_ERROR,
  probe: READ_NAVIGATION_ERROR,
};

// §2.2 + §9.5: watchdog ORM. Sin latido por timer (§9.2): id/heartbeatMs/onProgress se ignoran.
export function guardInjection({ kind, id, heartbeatMs, onProgress, ...options }) {
  const navigationError = NAVIGATION_ERRORS[kind];
  if (!navigationError) return Promise.reject(new Error(`guardInjection: unknown kind ${JSON.stringify(kind)}`));
  return watchInjection({ ...options, orphanError: () => navigationError(options.tabId) });
}

// §9.3: una escritura sin resultado pudo haberse despachado; una lectura no.
export function noResultError(tabId, kind) {
  if (kind === 'orm-write') {
    return new Error(`odoo_tab_unreachable: tab ${tabId}: the command may have been dispatched — re-read before retrying`);
  }
  return new Error(classifyInjectionFailure(tabId, 'no result from the injected script (tab closed, navigating or not injectable)'));
}

// §2.1 + §2.2 aplicados a la detección: una entrada por pestaña, en orden.
// onOutcome({outcome, error, tabId}) es opcional (diagnóstico, §9.6): lleva el
// tabId para que el desenlace de cada sonda sea atribuible a su pestaña.
export function probeTabsGuarded({ tabs, probe, isNavigating, events, navWaitMs, orphanGraceMs, getStatus, clearNavigating, onOutcome }) {
  return Promise.all(tabs.map(({ tabId, url }) => {
    const report = onOutcome && ((event) => onOutcome({ ...event, tabId }));
    let dispatched = false;
    return dispatchAfterNav({
      tabId, isNavigating, events, navWaitMs, getStatus, clearNavigating,
      inject: () => {
        dispatched = true;
        return guardInjection({
          tabId, kind: 'probe', inject: () => probe(tabId), isNavigating, events, navWaitMs, orphanGraceMs,
          onOutcome: report,
        });
      },
    }).catch((error) => {
      // O-5 (§9.6): la sonda que nunca se despachó también deja su desenlace en
      // el anillo; la despachada ya lo registró dentro de guardInjection.
      if (!dispatched) report?.({ outcome: 'not-dispatched', error });
      return { tabId, url, state: 'detection-failed' };
    });
  }));
}
