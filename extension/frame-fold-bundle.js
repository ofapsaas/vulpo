var VulpoFrameFold = (() => {
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

  // ../frame-fold.js
  var frame_fold_exports = {};
  __export(frame_fold_exports, {
    FRAME_FOLD_KEYS: () => FRAME_FOLD_KEYS,
    actWithFold: () => actWithFold,
    declaredFoldWait: () => declaredFoldWait,
    frameReadOptions: () => frameReadOptions,
    navigateWithFold: () => navigateWithFold
  });
  var FRAME_FOLD_KEYS = [
    "page",
    "maxElementsPerPage",
    "include",
    "roles",
    "namedOnly",
    "settle",
    "waitMs",
    "quietMs"
  ];
  function frameReadOptions(frameArg) {
    if (!frameArg || typeof frameArg !== "object") {
      frameArg = {};
    }
    const result = {
      settle: frameArg.settle !== false,
      // default true (§2.1.2)
      waitMs: frameArg.waitMs ?? 5e3,
      quietMs: frameArg.quietMs ?? 300,
      serializerOptions: {}
    };
    const boundingKeys = ["page", "maxElementsPerPage", "include", "roles", "namedOnly"];
    for (const key of boundingKeys) {
      if (Object.prototype.hasOwnProperty.call(frameArg, key)) {
        result.serializerOptions[key] = frameArg[key];
      }
    }
    return result;
  }
  function declaredFoldWait({ actionWaitMs, frameWaitMs }) {
    return actionWaitMs + 2 * frameWaitMs;
  }
  async function actWithFold({
    params,
    performAction,
    readFrame,
    lastFrameByTab,
    declareWait,
    waitForNavCommit
  }) {
    if (!params.frame) {
      return performAction({ declaredWaitMs: 0 });
    }
    const { tabId, action, waitMs: actionWaitMs } = params;
    const frameOptions = frameReadOptions(params.frame);
    const actionWait = action === "type" ? actionWaitMs ?? 5e3 : 0;
    const totalDeclaredWait = declaredFoldWait({
      actionWaitMs: actionWait,
      frameWaitMs: frameOptions.waitMs
    });
    declareWait(totalDeclaredWait);
    const actionResponse = await performAction({ declaredWaitMs: totalDeclaredWait });
    if (!actionResponse.ok) {
      return actionResponse;
    }
    const hasNativeDialog = !!actionResponse.nativeDialog;
    const settleForRead = !hasNativeDialog && frameOptions.settle;
    let commitTimedOut = false;
    if (settleForRead && waitForNavCommit) {
      const commit = await waitForNavCommit({ tabId, waitMs: frameOptions.waitMs });
      commitTimedOut = !commit.committed;
    }
    const readOptions = {
      tabId,
      options: frameOptions.serializerOptions,
      settle: settleForRead,
      waitMs: frameOptions.waitMs,
      quietMs: frameOptions.quietMs,
      kind: "wait"
      // P13: vigila con kind 'wait', no 'act'
    };
    let readResult;
    try {
      readResult = await readFrame(readOptions);
    } catch (err) {
      let errorMsg;
      if (err.navigated) {
        errorMsg = "frame fold: tab navigated while the map was being read \u2014 the action completed; re-read with getFrame";
      } else {
        errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
      }
      return {
        ...actionResponse,
        frameError: { error: errorMsg }
      };
    }
    if (!readResult) {
      const errorMsg = "frame fold: the page returned no map \u2014 the action completed; re-read with getFrame";
      return {
        ...actionResponse,
        frameError: { error: errorMsg }
      };
    }
    if (!readResult.frame) {
      const errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
      return {
        ...actionResponse,
        frameError: { error: errorMsg }
      };
    }
    const frame = readResult.frame;
    const fingerprint = frame.fingerprint;
    const changedSinceLast = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint;
    lastFrameByTab.set(tabId, fingerprint);
    const invalidation = {
      changedSinceLast
    };
    if (frameOptions.settle) {
      if (hasNativeDialog) {
        invalidation.settled = false;
      } else {
        invalidation.settled = !commitTimedOut && readResult.settled === true;
        invalidation.waitedMs = readResult.waitedMs;
      }
    }
    const framePropagated = { ...frame };
    delete framePropagated.fingerprint;
    framePropagated.invalidation = invalidation;
    return {
      ...actionResponse,
      frame: framePropagated
    };
  }
  async function navigateWithFold({
    params,
    navigateTab,
    replacesDocument,
    seedNavigating,
    waitForNavCommit,
    readFrame,
    lastFrameByTab,
    declareWait
  }) {
    const hasFrame = !!params.frame;
    if (!hasFrame) {
      const navResult2 = await navigateTab({ tabId: params.tabId, url: params.url });
      return navResult2;
    }
    const { tabId, url } = params;
    const frameOptions = frameReadOptions(params.frame);
    const totalDeclaredWait = declaredFoldWait({
      actionWaitMs: 0,
      frameWaitMs: frameOptions.waitMs
    });
    declareWait(totalDeclaredWait);
    const navResult = await navigateTab({ tabId, url });
    const replaces = replacesDocument(navResult);
    if (!replaces) {
      const readOptions2 = {
        tabId,
        options: frameOptions.serializerOptions,
        settle: frameOptions.settle,
        waitMs: frameOptions.waitMs,
        quietMs: frameOptions.quietMs,
        kind: "wait"
      };
      let readResult2;
      try {
        readResult2 = await readFrame(readOptions2);
      } catch (err) {
        let errorMsg;
        if (err.navigated) {
          errorMsg = "frame fold: tab navigated while the map was being read \u2014 the action completed; re-read with getFrame";
        } else {
          errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
        }
        return {
          ...navResult,
          frameError: { error: errorMsg }
        };
      }
      if (!readResult2) {
        const errorMsg = "frame fold: the page returned no map \u2014 the action completed; re-read with getFrame";
        return {
          ...navResult,
          frameError: { error: errorMsg }
        };
      }
      if (!readResult2.frame) {
        const errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
        return {
          ...navResult,
          frameError: { error: errorMsg }
        };
      }
      const frame2 = readResult2.frame;
      const fingerprint2 = frame2.fingerprint;
      const changedSinceLast2 = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint2;
      lastFrameByTab.set(tabId, fingerprint2);
      const invalidation2 = {
        changedSinceLast: changedSinceLast2
      };
      if (frameOptions.settle) {
        invalidation2.settled = readResult2.settled === true;
        invalidation2.waitedMs = readResult2.waitedMs;
      }
      const framePropagated2 = { ...frame2 };
      delete framePropagated2.fingerprint;
      framePropagated2.invalidation = invalidation2;
      return {
        ...navResult,
        frame: framePropagated2
      };
    }
    seedNavigating(tabId);
    const commitResult = await waitForNavCommit({
      tabId,
      waitMs: frameOptions.waitMs
      // techo del commit es frame.waitMs (§2.6, P18)
    });
    const readOptions = {
      tabId,
      options: frameOptions.serializerOptions,
      settle: frameOptions.settle,
      waitMs: frameOptions.waitMs,
      quietMs: frameOptions.quietMs,
      kind: "wait"
    };
    let readResult;
    try {
      readResult = await readFrame(readOptions);
    } catch (err) {
      let errorMsg;
      if (err.navigated) {
        errorMsg = "frame fold: tab navigated while the map was being read \u2014 the action completed; re-read with getFrame";
      } else {
        errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
      }
      return {
        ...navResult,
        frameError: { error: errorMsg }
      };
    }
    if (!readResult) {
      const errorMsg = "frame fold: the page returned no map \u2014 the action completed; re-read with getFrame";
      return {
        ...navResult,
        frameError: { error: errorMsg }
      };
    }
    if (!readResult.frame) {
      const errorMsg = "frame fold: serialization failed \u2014 the action completed; re-read with getFrame";
      return {
        ...navResult,
        frameError: { error: errorMsg }
      };
    }
    const frame = readResult.frame;
    const fingerprint = frame.fingerprint;
    const changedSinceLast = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint;
    lastFrameByTab.set(tabId, fingerprint);
    const invalidation = {
      changedSinceLast
    };
    if (frameOptions.settle) {
      const settleFinal = commitResult.committed && readResult.settled === true;
      invalidation.settled = settleFinal;
      invalidation.waitedMs = readResult.waitedMs;
      if (!commitResult.committed) {
        invalidation.navigating = true;
      }
    }
    const framePropagated = { ...frame };
    delete framePropagated.fingerprint;
    framePropagated.invalidation = invalidation;
    return {
      ...navResult,
      frame: framePropagated
    };
  }
  return __toCommonJS(frame_fold_exports);
})();
