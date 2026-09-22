var VulpoNav = (() => {
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

  // ../nav-guard.js
  var nav_guard_exports = {};
  __export(nav_guard_exports, {
    DIAGNOSTIC_RING_SIZE: () => DIAGNOSTIC_RING_SIZE,
    HEARTBEAT_MS: () => HEARTBEAT_MS,
    NAV_WAIT_MS: () => NAV_WAIT_MS,
    ORPHAN_GRACE_MS: () => ORPHAN_GRACE_MS,
    createDiagnosticRing: () => createDiagnosticRing,
    dispatchAfterNav: () => dispatchAfterNav,
    pageHeartbeat: () => pageHeartbeat,
    routePageProgress: () => routePageProgress,
    watchInjection: () => watchInjection
  });
  var NAV_WAIT_MS = 1e4;
  var ORPHAN_GRACE_MS = 3e3;
  var HEARTBEAT_MS = 15e3;
  var DIAGNOSTIC_RING_SIZE = 200;
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
  function pageHeartbeat({ token, sendMessage, heartbeatMs, run, setInterval, clearInterval }) {
    const beat = () => {
      try {
        Promise.resolve(sendMessage({ type: "fb-progress", token })).catch(() => {
        });
      } catch (_) {
      }
    };
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
      }
    );
  }
  function routePageProgress(msg, sender, pendingByToken, send, now = Date.now) {
    if (msg?.type !== "fb-progress") return;
    const dispatch = pendingByToken.get(msg.token);
    if (!dispatch || dispatch.tabId !== sender?.tab?.id) return;
    send({ type: "progress", id: dispatch.id, tabId: dispatch.tabId, elapsedMs: now() - dispatch.startedAt });
  }
  function createDiagnosticRing(size = DIAGNOSTIC_RING_SIZE, now = Date.now) {
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
      }
    };
  }
  return __toCommonJS(nav_guard_exports);
})();
