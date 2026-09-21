// observe.js — fb-020-002-type-commit-cycle v2 (content script, isolated world).
// Escritura + observación del campo escrito (spec §2.1–§2.3):
//   · performActionAndObserve(el, action, value, {force?, waitMs?, quietMs?})
//     delega en performAction (que no cambia, I-1) y, sólo si fue un `type`
//     con ok:true, espera a que el campo se estabilice y agrega
//     value/settled/waitedMs o detached.
//   · performFill(el, value, {waitMs?, quietMs?}) aplica el guard `:disabled`
//     (sin guard inert), escribe, despacha input+change y observa igual.
//
// Criterio de "estabilizado" (§2.3), temporal y no semántico: una ventana
// `quietMs` completa sin mutaciones del documento (y sus shadow roots
// abiertos), sin cambios de `el.value` del elemento retenido y sin indicador
// de carga estándar, antes de t₀ + `waitMs`. Nada específico de sitio (I-2),
// nada que dependa del entorno (I-3), sin normalizar lo escrito (I-5).

import { performAction } from './act.js';
import { readNativeDialog } from './native-dialog.js';

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_QUIET_MS = 300;

// Período de muestreo de `el.isConnected` y `el.value`: ni la propiedad
// `value` ni una desconexión fuera del árbol observado producen récords de
// MutationObserver; el muestreo los detecta sin esperar al cierre de ventana.
const SAMPLE_MS = 20;

// Indicadores de carga nombrados por estándar (WAI-ARIA 1.2 + HTML), §2.3.2.
// Selectores separados (en vez de un único selector compuesto) y `progress`
// primero: un selector de tag simple resuelve casi gratis (motor de selectores
// indexado por tag) mientras que un selector compuesto con atributos fuerza un
// barrido completo del documento incluso cuando el match está cerca de la raíz
// (medido: ~1.2 s sobre un documento de 80 000 nodos, R-02).
const LOADING_INDICATOR_SELECTORS = ['progress', '[aria-busy="true"]', '[role="progressbar"]'];

const MO_OPTIONS = { subtree: true, childList: true, attributes: true, characterData: true };

const FILL_DISABLED_ERROR = 'control deshabilitado: no se escribió el valor; habilitalo antes de reintentar';

// fb-020-003 §3.2 P5: pregunta nativa pendiente, precede a stale/inert/disabled.
const NATIVE_DIALOG_PENDING_ERROR =
  'hay una pregunta nativa del navegador esperando respuesta de un humano: avisale y volvé a leer la página con getFrame';

function positiveMsOrDefault(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function dispatchBubbling(el, type) {
  const win = el.ownerDocument ? el.ownerDocument.defaultView : null;
  const EventCtor = (win && win.Event) || globalThis.Event;
  el.dispatchEvent(new EventCtor(type, { bubbles: true }));
}

// Shadow roots ABIERTOS alcanzables desde `root` (incluido el propio `root`
// si es un host), transitivo. Devuelve los que no estaban en `known`.
//
// Costo lineal: `root.querySelectorAll('*')` ya recorre TODOS los
// descendientes de `root` en una sola pasada (no atraviesa fronteras de
// shadow root, que es justo lo que necesitamos delegarle a la recursión).
// Por eso se llama UNA vez por raíz, no por cada nodo — recursar
// `collectNewOpenShadowRoots` sobre cada nodo de ese resultado repetía el
// barrido completo en cada nivel (costo exponencial con la profundidad).
// La recursión sólo cruza fronteras de shadow root: la propia del host
// `root` (si la tiene) y la de cada descendiente-host hallado en la pasada.
function collectNewOpenShadowRoots(root, known, found = []) {
  if (!root) return found;
  const shadow = root.shadowRoot;
  if (shadow && !known.has(shadow)) {
    known.add(shadow);
    found.push(shadow);
    collectNewOpenShadowRoots(shadow, known, found);
  }
  if (typeof root.querySelectorAll !== 'function') return found;
  for (const node of root.querySelectorAll('*')) {
    const nodeShadow = node.shadowRoot;
    if (nodeShadow && !known.has(nodeShadow)) {
      known.add(nodeShadow);
      found.push(nodeShadow);
      collectNewOpenShadowRoots(nodeShadow, known, found);
    }
  }
  return found;
}

// Observación del campo retenido desde t₀ (= la llamada). Resuelve
// {detached:true, waitedMs} o {settled, value, waitedMs}. Nunca rechaza.
function observeWrittenField(el, options) {
  const t0 = Date.now();
  const waitMs = positiveMsOrDefault(options && options.waitMs, DEFAULT_WAIT_MS);
  const quietMs = positiveMsOrDefault(options && options.quietMs, DEFAULT_QUIET_MS);
  const elapsed = () => Math.max(0, Date.now() - t0);

  return new Promise((resolve) => {
    const doc = el.ownerDocument;
    let lastValue = el.value;
    let windowStart = t0;
    let finished = false;
    let observer = null;
    let quietTimer = null;
    let deadlineTimer = null;
    let sampleTimer = null;
    const shadowRoots = new Set();
    // R-01/R-02/P35: el barrido `querySelectorAll('*')` de
    // `collectNewOpenShadowRoots` es O(N) — correrlo por cada nodo agregado
    // (O(N·h) sobre el lote) o en cada cierre de ventana con veto activo es lo
    // que el review v2 midió como cuadrático/repetido (R-01/R-02). Pero atarlo
    // sólo a registros de mutación (propuesta A original) pierde `attachShadow`
    // tardío sobre un host ya existente: ese llamado no produce childList ni
    // ningún otro registro observable, así que un shadow root recién adjuntado
    // (y las mutaciones dentro de él, antes de que se lo registre) nunca se
    // descubre. Por eso el barrido se dispara acá — en `onQuietWindowClosed`,
    // sólo en el cierre que de otro modo resolvería `settled:true` (veto ya
    // resuelto en falso) y sólo mientras `elapsed() < waitMs` — en vez de en
    // cada mutación: es la única cadencia que cubre attachShadow sin registro
    // (P35) sin repetir el barrido en cada cierre con veto activo (R-02, donde
    // el veto cacheado evita llegar a esa rama) ni por cada nodo agregado
    // (R-01, donde el barrido decoupled de mutaciones corre una sola vez al
    // cierre final).
    // R-02 (veto): el resultado de `hasLoadingIndicator` sólo puede cambiar por
    // una mutación (agregar/quitar el indicador, o desconectar el host de un
    // shadow root) — todas pasan por `onMutation`. Recomputarlo en cada cierre
    // de ventana aunque nada haya mutado desde la última vez es el mismo patrón
    // de barrido repetido que R-02 señaló para los shadow roots; se cachea y
    // sólo se re-evalúa cuando `vetoDirty` lo marca.
    let vetoDirty = true;
    let cachedVeto = false;

    const cleanup = () => {
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      clearInterval(sampleTimer);
      try {
        if (observer) observer.disconnect();
      } catch {
        /* noop */
      }
    };

    // Único punto de resolución: detached se decide por el elemento retenido
    // (§2.3.5); si no, `value` se lee en el mismo instante en que se resuelve.
    const finish = (settled) => {
      if (finished) return;
      finished = true;
      cleanup();
      const waitedMs = elapsed();
      if (!el.isConnected) {
        resolve({ detached: true, waitedMs });
        return;
      }
      resolve({ settled, value: el.value, waitedMs });
    };

    const safely = (fn) => (...args) => {
      if (finished) return;
      try {
        fn(...args);
      } catch {
        finish(false); // §2.3.7: falla interna ⇒ settled:false
      }
    };

    const restartQuietWindow = () => {
      windowStart = Date.now();
      clearTimeout(quietTimer);
      quietTimer = setTimeout(onQuietWindowClosed, quietMs);
    };

    // Devuelve true si detectó desconexión (y resolvió) o un cambio de value.
    const sampleElement = () => {
      if (!el.isConnected) {
        finish(false);
        return true;
      }
      if (el.value === lastValue) return false;
      lastValue = el.value;
      restartQuietWindow();
      return true;
    };

    // Observa los shadow roots abiertos nuevos bajo `root`; true si hubo alguno.
    const observeNewShadowRoots = (root) => {
      const found = collectNewOpenShadowRoots(root, shadowRoots);
      for (const shadow of found) observer.observe(shadow, MO_OPTIONS);
      return found.length > 0;
    };

    // R-03: un shadow root cuyo host salió del documento (`host.isConnected`
    // false) deja de estar "en el documento" (§2.3.1) — no veta. `isConnected`
    // atraviesa fronteras de shadow root, así que también cubre un host anidado
    // dentro de un shadow root cuyo host externo se desconectó.
    const matchesLoadingIndicator = (root) => LOADING_INDICATOR_SELECTORS.some((sel) => root.querySelector(sel));

    const hasLoadingIndicator = () => {
      if (matchesLoadingIndicator(doc)) return true;
      for (const shadow of shadowRoots) {
        const host = shadow.host;
        if (host && !host.isConnected) continue;
        if (matchesLoadingIndicator(shadow)) return true;
      }
      return false;
    };

    const onQuietWindowClosed = safely(() => {
      const remaining = quietMs - (Date.now() - windowStart);
      if (remaining > 0) {
        quietTimer = setTimeout(onQuietWindowClosed, remaining);
        return;
      }
      if (sampleElement()) return;
      if (vetoDirty) {
        cachedVeto = hasLoadingIndicator();
        vetoDirty = false;
      }
      if (cachedVeto) {
        restartQuietWindow(); // §2.3.2: el veto sólo extiende
        return;
      }
      // P35: el cierre que de otro modo resolvería settled:true es el único
      // punto donde barrer de nuevo el documento paga su costo — un shadow
      // root adjuntado tarde sin registro de mutación (p.ej. attachShadow
      // sobre un host existente) sólo se descubre así. Acotado por el
      // deadline (R-02: nunca corre después de vencido waitMs).
      if (elapsed() < waitMs && observeNewShadowRoots(doc.documentElement)) {
        vetoDirty = true; // territorio nuevo: puede traer su propio indicador
        restartQuietWindow(); // territorio nuevo, aún no observado
        return;
      }
      finish(true);
    });

    const onDeadline = safely(() => {
      const remaining = waitMs - elapsed();
      if (remaining > 0) {
        deadlineTimer = setTimeout(onDeadline, remaining);
        return;
      }
      finish(false);
    });

    // R-01: NO se barre el subárbol de cada nodo agregado aquí (ese barrido
    // por nodo es lo que el review v2 midió como O(N·h)/cuadrático en una
    // cadena construida adjunta). Los shadow roots nuevos se descubren en
    // `onQuietWindowClosed` (ver comentario ahí); acá sólo se marca el veto
    // como recalculable, porque una mutación pudo agregar/quitar un indicador
    // o desconectar un host.
    const onMutation = safely((records) => {
      if (!el.isConnected) {
        finish(false);
        return;
      }
      if (records.length > 0) {
        vetoDirty = true; // la mutación pudo agregar/quitar un indicador o desconectar un host
      }
      restartQuietWindow();
    });

    try {
      const MutationObserverCtor = doc && doc.defaultView ? doc.defaultView.MutationObserver : undefined;
      if (typeof MutationObserverCtor !== 'function') {
        finish(false); // §2.3.6
        return;
      }
      observer = new MutationObserverCtor(onMutation);
      observer.observe(doc.documentElement, MO_OPTIONS);
      // R-02: el deadline se arma antes del barrido inicial (sincrónico, O(N))
      // para que el techo I-7 corra desde t₀ con independencia de su costo.
      deadlineTimer = setTimeout(onDeadline, waitMs);
      observeNewShadowRoots(doc.documentElement);
      restartQuietWindow();
      sampleTimer = setInterval(safely(sampleElement), SAMPLE_MS);
    } catch {
      finish(false);
    }
  });
}

// performActionAndObserve: fuera de `type` con ok:true devuelve exactamente
// la respuesta de performAction (P11).
export async function performActionAndObserve(el, action, value, options) {
  // P5: guard de pregunta pendiente, antes de cualquier despacho y de
  // cualquier `await` — precede a stale/inert/disabled (§2.3).
  const doc = el ? el.ownerDocument : globalThis.document;
  const nativeDialog = doc ? readNativeDialog(doc) : null;
  if (nativeDialog) return { ok: false, nativeDialog, error: NATIVE_DIALOG_PENDING_ERROR };

  const force = options && options.force;
  const result = performAction(el, action, value, { force });
  if (action !== 'type' || result.ok !== true) return result;

  const observation = await observeWrittenField(el, options);
  if (observation.detached) {
    return { ok: true, detached: true, settled: false, waitedMs: observation.waitedMs };
  }
  return { ok: true, value: observation.value, settled: observation.settled, waitedMs: observation.waitedMs };
}

// performFill: guard de pregunta pendiente (P6), antes de :disabled, de
// escribir y de cualquier `await` — precede a disabled (§2.3). Guard
// `:disabled` antes de escribir; sin guard inert (P14).
export async function performFill(el, value, options) {
  const nativeDialog = readNativeDialog(el.ownerDocument);
  if (nativeDialog) return { success: false, nativeDialog, error: NATIVE_DIALOG_PENDING_ERROR };

  if (el.matches(':disabled')) {
    return { success: false, disabled: true, error: FILL_DISABLED_ERROR };
  }
  el.value = value;
  dispatchBubbling(el, 'input');
  dispatchBubbling(el, 'change');

  const observation = await observeWrittenField(el, options);
  if (observation.detached) {
    return { success: true, detached: true, settled: false, waitedMs: observation.waitedMs };
  }
  return { success: true, value: observation.value, settled: observation.settled, waitedMs: observation.waitedMs };
}
