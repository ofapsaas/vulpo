/**
 * frame-fold.js — fb-020-008-act-frame-fold
 *
 * El pliegue de la lectura del mapa en las acciones del navegador.
 * Módulo ESM sin APIs directas de browser: dependencias inyectadas.
 * Patrón: fb-020-007 (nav-guard.js).
 *
 * Interfaz: FRAME_FOLD_KEYS, frameReadOptions, declaredFoldWait,
 * actWithFold, navigateWithFold.
 */

// Las 8 claves aceptadas de §2.1.1 (omitIfUnchanged NO está, §9.1).
export const FRAME_FOLD_KEYS = [
  'page',
  'maxElementsPerPage',
  'include',
  'roles',
  'namedOnly',
  'settle',
  'waitMs',
  'quietMs',
];

/**
 * frameReadOptions(frameArg) → { settle, waitMs, quietMs, serializerOptions }
 * Mapeo único de frame a los parámetros de la lectura (I-1).
 *
 * - settle: default true (§2.1.2, divergencia deliberada respecto getFrame)
 * - waitMs: 5000, quietMs: 300
 * - serializerOptions: SOLO las claves de acotamiento PRESENTES
 *   (page, maxElementsPerPage, include, roles, namedOnly).
 *   Las ausentes NO aparecen ni como null/undefined (§2.1.1/P8/I-1).
 *   settle/waitMs/quietMs jamás entran aquí (viven en la capa de espera).
 */
export function frameReadOptions(frameArg) {
  if (!frameArg || typeof frameArg !== 'object') {
    frameArg = {};
  }

  const result = {
    settle: frameArg.settle !== false, // default true (§2.1.2)
    waitMs: frameArg.waitMs ?? 5000,
    quietMs: frameArg.quietMs ?? 300,
    serializerOptions: {},
  };

  // Pass-through verbatim SOLO las claves de acotamiento presentes.
  const boundingKeys = ['page', 'maxElementsPerPage', 'include', 'roles', 'namedOnly'];
  for (const key of boundingKeys) {
    if (Object.prototype.hasOwnProperty.call(frameArg, key)) {
      result.serializerOptions[key] = frameArg[key];
    }
  }

  return result;
}

/**
 * declaredFoldWait({ actionWaitMs, frameWaitMs }) → number
 * §2.3.1/§2.3.2 (P14): actionWaitMs + 2·frameWaitMs
 * actionWaitMs: 0 para click/focus/select, waitMs para type.
 */
export function declaredFoldWait({ actionWaitMs, frameWaitMs }) {
  return actionWaitMs + 2 * frameWaitMs;
}

/**
 * actWithFold({params, performAction, readFrame, lastFrameByTab, declareWait, waitForNavCommit})
 *
 * params: {tabId, ref, action, value?, waitMs?, quietMs?, frame?}
 * performAction({ declaredWaitMs }) → Promise<respuesta de la acción>
 * readFrame({ tabId, options, settle, waitMs, quietMs, kind }) → Promise<{ frame?, settled?, waitedMs? }>
 *   frame incluye fingerprint; readFrame puede rechazar o resolver frame null.
 * lastFrameByTab: Map<tabId, fingerprint> — el marcador de changedSinceLast.
 * declareWait(totalMs): reporta al hub/watchdog.
 * waitForNavCommit({ tabId, waitMs }) → Promise<{ committed: boolean }>:
 *   la ÚNICA ruta de espera de commit (la misma que consume navigateWithFold/
 *   getFrame(settle)). Reproduce, dentro del pliegue de `act`, la precondición
 *   de getFrame(settle): si se pidió settle y la marca de navegación está
 *   puesta, espera el commit con techo frame.waitMs ANTES de leer; si el techo
 *   vence, el veredicto in-page no puede surfacear como true (I-5) — más abajo
 *   se fuerza `frame.invalidation.settled:false`. Ya resuelve `committed:true`
 *   de inmediato si el tab no está navegando (no hace falta un chequeo previo
 *   acá — evita una segunda ruta de espera, §1.3/I-1).
 *
 * Devuelve respuesta de la acción MÁS exactamente una de frame/frameError
 * cuando el pliegue corrió, o la respuesta tal cual sin pliegue.
 *
 * Orden (§2.3, no negociable):
 *  (1) se despacha la acción
 *  (2) corre la observación del campo escrito hasta su desenlace
 *  (3) recién entonces arranca la espera del documento (con su espera de
 *      commit de navegación, si corresponde)
 */
export async function actWithFold({
  params,
  performAction,
  readFrame,
  lastFrameByTab,
  declareWait,
  waitForNavCommit,
}) {
  // Guard: si no hay frame, devolvé la respuesta vigente sin tocar nada.
  if (!params.frame) {
    return performAction({ declaredWaitMs: 0 });
  }

  const { tabId, action, waitMs: actionWaitMs } = params;

  // §2.3.1/§2.3.2: calcula la espera declarada y la reporta ANTES de despachar.
  const frameOptions = frameReadOptions(params.frame);
  const actionWait = action === 'type' ? (actionWaitMs ?? 5000) : 0;
  const totalDeclaredWait = declaredFoldWait({
    actionWaitMs: actionWait,
    frameWaitMs: frameOptions.waitMs,
  });
  declareWait(totalDeclaredWait);

  // (1) Despacha la acción. Si falla, el rechazo de performAction propaga tal
  // cual (P16(b)): el pliegue no lo intercepta ni lo convierte en otra cosa.
  const actionResponse = await performAction({ declaredWaitMs: totalDeclaredWait });

  // (2) Si ok:false o write gate rechaza, devolvé sin pliegue (§2.4, P15, P16).
  if (!actionResponse.ok) {
    return actionResponse;
  }

  // (3) Con ok:true, corré el pliegue.
  // §2.4: si hay diálogo nativo pendiente, no espero quiescencia (cuelga).
  const hasNativeDialog = !!actionResponse.nativeDialog;
  const settleForRead = !hasNativeDialog && frameOptions.settle;

  // Bloqueante cerrado (review §1): reproduce, dentro del pliegue de `act`, la
  // MISMA precondición que getFrame(settle) — si se pidió settle, espera el
  // commit de navegación por la ÚNICA ruta existente (waitForNavCommit, la
  // misma que navigateWithFold). Sin esto, un click que dispara una
  // navegación de página completa serializaría el documento VIEJO y, al
  // estar quieto, certificaría settled:true sobre un mapa ya muerto — peor
  // que el status quo (I-5).
  let commitTimedOut = false;
  if (settleForRead && waitForNavCommit) {
    const commit = await waitForNavCommit({ tabId, waitMs: frameOptions.waitMs });
    commitTimedOut = !commit.committed;
  }

  // Arma las opciones para readFrame (§2.3 paso 3, después del desenlace y,
  // si correspondía, después de la espera de commit).
  const readOptions = {
    tabId,
    options: frameOptions.serializerOptions,
    settle: settleForRead,
    waitMs: frameOptions.waitMs,
    quietMs: frameOptions.quietMs,
    kind: 'wait', // P13: vigila con kind 'wait', no 'act'
  };

  // Intenta la lectura; cualquier fallo degrada a frameError sin propagar (§2.7, P12, P13).
  let readResult;
  try {
    readResult = await readFrame(readOptions);
  } catch (err) {
    // Error durante la lectura: acción ya ocurrió.
    // P13: si la inyección fue rechazada por navegación (err.navigated),
    // mensaje específico; si no, mensaje genérico de serialización.
    let errorMsg;
    if (err.navigated) {
      errorMsg = 'frame fold: tab navigated while the map was being read — the action completed; re-read with getFrame';
    } else {
      errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
    }
    return {
      ...actionResponse,
      frameError: { error: errorMsg },
    };
  }

  // §2.7: dos casos distintos, dos mensajes distintos.
  // - Sin resultado de inyección (readFrame no resolvió nada): "the page
  //   returned no map".
  // - Resultado presente pero sin mapa (el serializer in-page falló y
  //   readFrame lo normalizó a frame:null): "serialization failed" — el
  //   mismo caso que getFrame(settle) resuelve con throw (§1.3/§2.7,
  //   divergencia deliberada: acá degrada en vez de propagar).
  if (!readResult) {
    const errorMsg = 'frame fold: the page returned no map — the action completed; re-read with getFrame';
    return {
      ...actionResponse,
      frameError: { error: errorMsg },
    };
  }
  if (!readResult.frame) {
    const errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
    return {
      ...actionResponse,
      frameError: { error: errorMsg },
    };
  }

  // Éxito: serializa la respuesta.
  // Primero computa changedSinceLast ANTES de actualizar el marcador (P10).
  const frame = readResult.frame;
  const fingerprint = frame.fingerprint;
  const changedSinceLast = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint;

  // §2.5/P9/I-4: actualiza siempre el marcador, incluso con settle:false.
  lastFrameByTab.set(tabId, fingerprint);

  // Construye invalidation (§2.2, present-only):
  //  - changedSinceLast: siempre presente
  //  - settled/waitedMs: presentes IFF settle fue pedido (P7, P23)
  //  - navigating: nunca en act (I-A/I-B de fb-018-006 son para navigate)
  const invalidation = {
    changedSinceLast,
  };

  // P7: settled/waitedMs presentes ⇔ settle fue pedido (frameOptions.settle).
  // P23: con diálogo nativo, se saltó la espera → settled:false explícito, sin waitedMs.
  if (frameOptions.settle) {
    if (hasNativeDialog) {
      // P23: se pidió settle pero se saltó por diálogo → settled:false explícito, sin waitedMs.
      invalidation.settled = false;
    } else {
      // Caso normal: se esperó quiescencia. I-5: si el commit de navegación
      // venció, el veredicto in-page NO puede surfacear como true — se fuerza
      // settled:false aunque readResult diga otra cosa (mismo patrón que
      // navigateWithFold/getFrame). Default seguro: cualquier valor que no
      // sea exactamente `true` cuenta como no-settled (nunca se inventa un
      // true que no vino, I-5).
      invalidation.settled = !commitTimedOut && readResult.settled === true;
      invalidation.waitedMs = readResult.waitedMs;
    }
  }

  // Retorna: respuesta de la acción intacta + frame sin fingerprint + invalidation.
  // §2.2: clave por clave, salvo fingerprint que no viaja.
  const framePropagated = { ...frame };
  delete framePropagated.fingerprint;
  framePropagated.invalidation = invalidation;

  return {
    ...actionResponse,
    frame: framePropagated,
  };
}

/**
 * navigateWithFold({params, navigateTab, replacesDocument, seedNavigating,
 *                    waitForNavCommit, readFrame, lastFrameByTab, declareWait})
 *
 * params: {tabId, url, frame?}
 * navigateTab({ tabId, url }) → Promise<{success:true, tabId, url}>
 * replacesDocument(...) → boolean (§2.6: falso ⇒ solo fragmento)
 * seedNavigating(tabId): siembra la marca; con pliegue va ANTES de cualquier lectura.
 * waitForNavCommit({ tabId, waitMs }) → Promise<{ committed: boolean }>:
 *   ÚNICA ruta de espera de commit. committed:false ⇒ techo vencido.
 * readFrame, lastFrameByTab, declareWait: igual que en actWithFold.
 *
 * Sin pliegue: respuesta vigente ({success:true, tabId, url}, sin esperas).
 * Con pliegue: success:true significa el documento destino existe y se serializó.
 */
export async function navigateWithFold({
  params,
  navigateTab,
  replacesDocument,
  seedNavigating,
  waitForNavCommit,
  readFrame,
  lastFrameByTab,
  declareWait,
}) {
  // Guard: si no hay frame, devolvé navegación vigente sin pliegue.
  const hasFrame = !!params.frame;
  if (!hasFrame) {
    const navResult = await navigateTab({ tabId: params.tabId, url: params.url });
    return navResult; // {success:true, tabId, url}
  }

  const { tabId, url } = params;
  const frameOptions = frameReadOptions(params.frame);

  // §2.3.2/P14: espera declarada es 2·frame.waitMs (sin aporte de acción).
  const totalDeclaredWait = declaredFoldWait({
    actionWaitMs: 0,
    frameWaitMs: frameOptions.waitMs,
  });
  declareWait(totalDeclaredWait);

  // Despacha la navegación.
  const navResult = await navigateTab({ tabId, url });

  // Determina si reemplaza documento (§2.6).
  const replaces = replacesDocument(navResult);

  // Si solo cambio de fragmento, lee de inmediato sin sembrar ni esperar commit.
  if (!replaces) {
    // P19: sin reemplazo, lectura de inmediato con su espera de quiescencia.
    const readOptions = {
      tabId,
      options: frameOptions.serializerOptions,
      settle: frameOptions.settle,
      waitMs: frameOptions.waitMs,
      quietMs: frameOptions.quietMs,
      kind: 'wait',
    };

    let readResult;
    try {
      readResult = await readFrame(readOptions);
    } catch (err) {
      let errorMsg;
      if (err.navigated) {
        errorMsg = 'frame fold: tab navigated while the map was being read — the action completed; re-read with getFrame';
      } else {
        errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
      }
      return {
        ...navResult,
        frameError: { error: errorMsg },
      };
    }

    // §2.7: sin resultado de inyección vs. resultado sin mapa son casos
    // distintos con mensajes distintos (mismo criterio que actWithFold).
    if (!readResult) {
      const errorMsg = 'frame fold: the page returned no map — the action completed; re-read with getFrame';
      return {
        ...navResult,
        frameError: { error: errorMsg },
      };
    }
    if (!readResult.frame) {
      const errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
      return {
        ...navResult,
        frameError: { error: errorMsg },
      };
    }

    // Actualiza marcador y construye invalidation.
    const frame = readResult.frame;
    const fingerprint = frame.fingerprint;
    const changedSinceLast = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint;
    lastFrameByTab.set(tabId, fingerprint);

    const invalidation = {
      changedSinceLast,
    };

    if (frameOptions.settle) {
      invalidation.settled = readResult.settled === true;
      invalidation.waitedMs = readResult.waitedMs;
    }

    const framePropagated = { ...frame };
    delete framePropagated.fingerprint;
    framePropagated.invalidation = invalidation;

    return {
      ...navResult,
      frame: framePropagated,
    };
  }

  // Con reemplazo de documento: siembra marca, espera commit, luego lee.
  // §2.6/P18: orden es despacho → sembrado → espera de commit → lectura.
  seedNavigating(tabId);

  const commitResult = await waitForNavCommit({
    tabId,
    waitMs: frameOptions.waitMs, // techo del commit es frame.waitMs (§2.6, P18)
  });

  // Lee del documento nuevo (o viejo si commit venció).
  const readOptions = {
    tabId,
    options: frameOptions.serializerOptions,
    settle: frameOptions.settle,
    waitMs: frameOptions.waitMs,
    quietMs: frameOptions.quietMs,
    kind: 'wait',
  };

  let readResult;
  try {
    readResult = await readFrame(readOptions);
  } catch (err) {
    let errorMsg;
    if (err.navigated) {
      errorMsg = 'frame fold: tab navigated while the map was being read — the action completed; re-read with getFrame';
    } else {
      errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
    }
    return {
      ...navResult,
      frameError: { error: errorMsg },
    };
  }

  // §2.7: sin resultado de inyección vs. resultado sin mapa son casos
  // distintos con mensajes distintos (mismo criterio que actWithFold).
  if (!readResult) {
    const errorMsg = 'frame fold: the page returned no map — the action completed; re-read with getFrame';
    return {
      ...navResult,
      frameError: { error: errorMsg },
    };
  }
  if (!readResult.frame) {
    const errorMsg = 'frame fold: serialization failed — the action completed; re-read with getFrame';
    return {
      ...navResult,
      frameError: { error: errorMsg },
    };
  }

  // Actualiza marcador.
  const frame = readResult.frame;
  const fingerprint = frame.fingerprint;
  const changedSinceLast = !lastFrameByTab.has(tabId) || lastFrameByTab.get(tabId) !== fingerprint;
  lastFrameByTab.set(tabId, fingerprint);

  // Construye invalidation con I-5 override (§2.6/P18/I-5).
  // Si el commit no ocurrió dentro del techo, forced settled:false y add navigating:true,
  // incluso si el veredicto in-page diga otra cosa.
  const invalidation = {
    changedSinceLast,
  };

  if (frameOptions.settle) {
    // I-5: si commit venció (committed:false), fuerza settled:false + navigating:true.
    // Default seguro: cualquier valor que no sea exactamente `true` cuenta
    // como no-settled (nunca se inventa un true que no vino).
    const settleFinal = commitResult.committed && readResult.settled === true;
    invalidation.settled = settleFinal;
    invalidation.waitedMs = readResult.waitedMs;

    if (!commitResult.committed) {
      invalidation.navigating = true; // present-only: solo si true.
    }
  }

  const framePropagated = { ...frame };
  delete framePropagated.fingerprint;
  framePropagated.invalidation = invalidation;

  return {
    ...navResult,
    frame: framePropagated,
  };
}
