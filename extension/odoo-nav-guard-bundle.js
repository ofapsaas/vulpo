var VulpoNavGuard = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // nav-guard.js
  var nav_guard_exports = {};
  __export(nav_guard_exports, {
    HEARTBEAT_MS: () => HEARTBEAT_MS,
    NAV_WAIT_MS: () => NAV_WAIT_MS,
    ORPHAN_GRACE_MS: () => ORPHAN_GRACE_MS,
    dispatchAfterNav: () => dispatchAfterNav2,
    guardInjection: () => guardInjection,
    noResultError: () => noResultError,
    probeTabsGuarded: () => probeTabsGuarded
  });

  // ../nav-guard.js
  var NAV_WAIT_MS = 1e4;
  var ORPHAN_GRACE_MS = 3e3;
  var HEARTBEAT_MS = 15e3;
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
  var defaultStillNavigatingError = (tabId, navWaitMs) => new Error(`tab ${tabId} is still navigating after ${navWaitMs} ms; the command was NOT dispatched; retry after the page loads`);
  var defaultClosedWhileNavigatingError = (tabId) => new Error(`tab ${tabId} was closed while navigating; the command was NOT dispatched`);
  function dispatchAfterNav({
    tabId,
    inject,
    isNavigating,
    events,
    navWaitMs = NAV_WAIT_MS,
    getStatus,
    clearNavigating,
    stillNavigatingError = defaultStillNavigatingError,
    closedWhileNavigatingError = defaultClosedWhileNavigatingError
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
          return false;
        }
        if (status !== "complete") return false;
        clearNavigating?.(tabId);
        dispatch();
        return true;
      };
      const unsubscribe = subscribeToTab(events, tabId, (type) => {
        if (type === "removed") fail(closedWhileNavigatingError(tabId));
        else if (type === "complete") dispatch();
      });
      const ceiling = setTimeout(async () => {
        if (!await dispatchIfComplete()) fail(stillNavigatingError(tabId, navWaitMs));
      }, navWaitMs);
      dispatchIfComplete();
    });
  }
  function watchInjection({
    tabId,
    inject,
    orphanError,
    isNavigating,
    events,
    navWaitMs = NAV_WAIT_MS,
    orphanGraceMs = ORPHAN_GRACE_MS,
    declaredWaitMs = 0,
    onOutcome
  }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let orphanTimer = null;
      const settle = (outcome, value, kind) => {
        if (settled) return;
        settled = true;
        clearTimeout(orphanTimer);
        unsubscribe();
        onOutcome?.(kind === "resolve" ? { outcome: kind } : { outcome: kind, error: value });
        outcome(value);
      };
      const rejectOrphan = () => settle(reject, orphanError(), "orphan");
      const rejectOrphanAfter = (ms) => {
        clearTimeout(orphanTimer);
        orphanTimer = setTimeout(rejectOrphan, ms);
      };
      let orphanCase = isNavigating(tabId) ? "b" : null;
      const unsubscribe = subscribeToTab(events, tabId, (type) => {
        if (type === "removed") {
          rejectOrphan();
        } else if (type === "loading") {
          orphanCase = "a";
          rejectOrphanAfter(navWaitMs + orphanGraceMs);
        } else if (type === "complete" && orphanCase) {
          rejectOrphanAfter(orphanCase === "b" ? declaredWaitMs + orphanGraceMs : orphanGraceMs);
        }
      });
      if (orphanCase) rejectOrphanAfter(navWaitMs + orphanGraceMs);
      invoke(inject).then(
        (value) => settle(resolve, value, "resolve"),
        (err) => orphanCase ? rejectOrphan() : settle(reject, err, "reject")
      );
    });
  }

  // session-probe.js
  function classifyInjectionFailure(tabId, cause) {
    const detail = cause instanceof Error ? cause.message : cause;
    const causeText = detail ? String(detail) : "no result from the injected script";
    return `odoo_tab_unreachable: tab ${tabId}: ${causeText}`;
  }

  // nav-guard.js
  function dispatchAfterNav2(options) {
    return dispatchAfterNav({
      ...options,
      stillNavigatingError: (tabId, navWaitMs) => new Error(`odoo_tab_unreachable: tab ${tabId} is still navigating after ${navWaitMs} ms; the command was NOT dispatched; retry after the page loads`),
      closedWhileNavigatingError: (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} was closed while navigating; the command was NOT dispatched`)
    });
  }
  var READ_NAVIGATION_ERROR = (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} navigated while the command was running; the command did not complete; it is safe to retry`);
  var NAVIGATION_ERRORS = {
    "orm-write": (tabId) => new Error(`odoo_tab_unreachable: tab ${tabId} navigated while the command was running; the command may have been dispatched \u2014 re-read before retrying`),
    "orm-read": READ_NAVIGATION_ERROR,
    probe: READ_NAVIGATION_ERROR
  };
  function guardInjection({ kind, id, heartbeatMs, onProgress, ...options }) {
    const navigationError = NAVIGATION_ERRORS[kind];
    if (!navigationError) return Promise.reject(new Error(`guardInjection: unknown kind ${JSON.stringify(kind)}`));
    return watchInjection({ ...options, orphanError: () => navigationError(options.tabId) });
  }
  function noResultError(tabId, kind) {
    if (kind === "orm-write") {
      return new Error(`odoo_tab_unreachable: tab ${tabId}: the command may have been dispatched \u2014 re-read before retrying`);
    }
    return new Error(classifyInjectionFailure(tabId, "no result from the injected script (tab closed, navigating or not injectable)"));
  }
  function probeTabsGuarded({ tabs, probe, isNavigating, events, navWaitMs, orphanGraceMs, getStatus, clearNavigating, onOutcome }) {
    return Promise.all(tabs.map(({ tabId, url }) => {
      const report = onOutcome && ((event) => onOutcome({ ...event, tabId }));
      let dispatched = false;
      return dispatchAfterNav2({
        tabId,
        isNavigating,
        events,
        navWaitMs,
        getStatus,
        clearNavigating,
        inject: () => {
          dispatched = true;
          return guardInjection({
            tabId,
            kind: "probe",
            inject: () => probe(tabId),
            isNavigating,
            events,
            navWaitMs,
            orphanGraceMs,
            onOutcome: report
          });
        }
      }).catch((error) => {
        if (!dispatched) report?.({ outcome: "not-dispatched", error });
        return { tabId, url, state: "detection-failed" };
      });
    }));
  }
  return __toCommonJS(nav_guard_exports);
})();
