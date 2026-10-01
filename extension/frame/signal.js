// signal.js — fb-024-senal-previa-accion (content script, isolated world).
//
// D-2: interfaz declarada `signalAction(el, action, value, options)` síncrona →
// `{signaled: boolean}`. Devuelve `signaled:true` SÓLO si, evaluada en ese
// instante, la acción que el frame despacharía (performActionAndObserve para
// click/type/focus/select; performFill para fill) devolvería ok:true /
// success:true. En cualquier rechazo devuelve `signaled:false` y NO toca el DOM.
//
// El veredicto se re-evalúa acá con las MISMAS fuentes que el despacho real
// (`dialog.js` para inertness, el atributo de `native-dialog.js`, y los mismos
// guards de aplicabilidad/disabled/value de `act.js`), sin ejecutar la acción:
// el bundle no puede despachar para "ver si despacharía" (eso mutaría el DOM).
//
// Forma interna (D-2, sujeta a P1–P6): un host persistente (uno por documento)
// hijo de `<html>` —fuera del árbol serializable y del cuerpo—, con un shadow
// root abierto que contiene la animación. El host lleva `pointer-events:none`
// en su estilo INLINE (condición C1 del test-audit: jsdom lo resuelve así).
// La animación es CSS pura: no quedan mutaciones de JS después de la llamada
// (I-4). La señal no entra en ninguna serialización (el host no es hijo de
// body y su shadow no lo recorre `querySelectorAll`).

import { getActiveDialog, isBlocking, isInert } from './dialog.js';
import { readNativeDialog } from './native-dialog.js';

// Atributo marcador del host en el DOM. Permite re-adoptar el host de una
// inyección previa si el estado del módulo no persistió entre executeScript
// (VERIFY de discovery A.2 #3): la unicidad del host es por documento, no por
// instancia del bundle.
const HOST_ATTR = 'data-vulpo-action-signal';

// Un host por documento. Clave débil: no retiene documentos vivos.
const hosts = new WeakMap();

// CSS de la señal (dentro del shadow). Círculos concéntricos + punto, centrados
// por márgenes negativos sobre el left/top que fija `showSignal`.
const SIGNAL_CSS = `
.ring, .dot { position: fixed; pointer-events: none; opacity: 0; }
.ring {
  box-sizing: border-box;
  width: 48px; height: 48px; margin: -24px 0 0 -24px;
  border: 3px solid #7c3aed; border-radius: 50%;
}
.dot {
  width: 12px; height: 12px; margin: -6px 0 0 -6px;
  background: #7c3aed; border-radius: 50%;
}
@keyframes vulpo-signal-ring {
  0%   { transform: scale(0.25); opacity: 1; }
  100% { transform: scale(1.35); opacity: 0; }
}
@keyframes vulpo-signal-dot {
  0%   { transform: scale(0.6); opacity: 1; }
  100% { transform: scale(1); opacity: 0; }
}
`;

/** durationMs válido: número finito > 0 (D-2; "600" string NO vale). */
function isPositiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** `actually disabled` de HTML: idéntico al guard de `act.js` (`:disabled`). */
function actuallyDisabled(el) {
  return el.matches(':disabled');
}

// Veredicto del despacho SIN despachar. Espeja `performActionAndObserve`
// (pregunta nativa + performAction) y `performFill` (pregunta nativa +
// `:disabled`). La pregunta nativa ya se evaluó en signalAction; acá van sólo
// los guards de la acción.
function wouldDispatch(el, action, value, options) {
  if (action === 'fill') {
    return !el.matches(':disabled');
  }

  const force = !!(options && options.force);
  if (!force) {
    const root = el.ownerDocument ? el.ownerDocument.body : null;
    const activeDialog = root ? getActiveDialog(root) : null;
    const blocking = root ? isBlocking(root, activeDialog) : false;
    if (isInert(activeDialog, blocking, el)) return false;
  }

  switch (action) {
    case 'click':
      if (typeof el.click !== 'function') return false;
      if (actuallyDisabled(el)) return false;
      return true;

    case 'type': {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'input' && tag !== 'textarea') return false;
      if (actuallyDisabled(el)) return false;
      if (value == null) return false;
      return true;
    }

    case 'focus':
      if (typeof el.focus !== 'function') return false;
      if (actuallyDisabled(el)) return false;
      return true;

    case 'select': {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'select') return false;
      if (actuallyDisabled(el)) return false;
      if (value == null) return false;
      const sv = String(value);
      for (const o of el.options) {
        if (o.value === sv || o.textContent === sv) return true;
      }
      return false;
    }

    default:
      return false;
  }
}

// Centro del rect del elemento recortado al viewport (D-6). Rect vacío (0×0,
// jsdom) ⇒ primer ancestro con rect no vacío. Sin scroll.
function centroid(el, win) {
  let node = el;
  let rect = null;
  while (node) {
    rect = node.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) break;
    node = node.parentElement;
  }
  if (!rect) rect = { left: 0, top: 0, width: 0, height: 0 };
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  const vw = win && win.innerWidth;
  const vh = win && win.innerHeight;
  if (vw) x = Math.min(Math.max(x, 0), vw);
  if (vh) y = Math.min(Math.max(y, 0), vh);
  return { x, y };
}

// Crea el host con su shadow abierto y su contenido de animación.
function createHost(doc) {
  const host = doc.createElement('vulpo-action-signal');
  host.setAttribute(HOST_ATTR, '');
  // Estilo INLINE (condición C1): pointer-events resoluble por getComputedStyle.
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.margin = '0';
  host.style.padding = '0';
  host.style.border = '0';
  host.style.background = 'transparent';
  host.style.overflow = 'visible';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  let ring = null;
  let dot = null;
  if (typeof host.attachShadow === 'function') {
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = SIGNAL_CSS;
    ring = doc.createElement('div');
    ring.setAttribute('class', 'ring');
    dot = doc.createElement('div');
    dot.setAttribute('class', 'dot');
    shadow.appendChild(style);
    shadow.appendChild(ring);
    shadow.appendChild(dot);
  }
  return { host, ring, dot };
}

// Re-adopta el host de una inyección anterior si existe (unicidad por
// documento aunque el estado del mundo aislado no persista).
function adoptHost(host) {
  const entry = { host, ring: null, dot: null };
  const shadow = host.shadowRoot;
  if (shadow) {
    entry.ring = shadow.querySelector('.ring');
    entry.dot = shadow.querySelector('.dot');
  }
  return entry;
}

// Un host por documento: del registro, o del DOM (reinyección), o nuevo.
function ensureHost(doc) {
  let entry = hosts.get(doc);
  if (entry && entry.host && entry.host.isConnected) return entry;

  const root = doc.documentElement;
  const existing = root && typeof root.querySelector === 'function'
    ? root.querySelector('[' + HOST_ATTR + ']')
    : null;

  if (existing) {
    entry = adoptHost(existing);
  } else {
    entry = createHost(doc);
    root.appendChild(entry.host);
  }
  hosts.set(doc, entry);
  return entry;
}

// Reposiciona y (re)arranca la animación. Todo ocurre dentro del shadow, fuera
// de la observación de `documentElement`; el reinicio es sincrónico, así que
// después de la llamada no queda ninguna mutación de JS pendiente (I-4).
function showSignal(entry, x, y, durationMs) {
  const { ring, dot } = entry;
  if (!ring || !dot) return;
  for (const node of [ring, dot]) {
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    node.style.animation = 'none';
  }
  // Reflow: reinicia la animación aunque el host sea persistente.
  void ring.offsetWidth;
  ring.style.animation = `vulpo-signal-ring ${durationMs}ms ease-out`;
  dot.style.animation = `vulpo-signal-dot ${durationMs}ms ease-out`;
}

/**
 * fb-024 D-2. Síncrona. `{signaled:true}` sólo si la acción despacharía y el
 * documento es visible; `{signaled:false}` en cualquier rechazo, sin DOM.
 */
export function signalAction(el, action, value, options) {
  const opts = options || {};

  // D-2/D-5: sin duración válida o documento no visible ⇒ nada, sin tocar DOM.
  if (!isPositiveFinite(opts.durationMs)) return { signaled: false };
  if (el == null) return { signaled: false };

  const doc = el.ownerDocument;
  if (!doc || doc.visibilityState !== 'visible') return { signaled: false };

  // D-2: `el` desconectado ⇒ rechazo (no hay destino que despachar).
  if (!el.isConnected) return { signaled: false };

  // Misma precedencia que performActionAndObserve/performFill: la pregunta
  // nativa pendiente gana a cualquier otro rechazo.
  if (readNativeDialog(doc)) return { signaled: false };

  // D-2: paridad con el veredicto del despacho real.
  if (!wouldDispatch(el, action, value, opts)) return { signaled: false };

  const { x, y } = centroid(el, doc.defaultView);
  const entry = ensureHost(doc);
  showSignal(entry, x, y, opts.durationMs);
  return { signaled: true };
}
