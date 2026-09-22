// act.js — fb-017-002 frame-map-api (content script, isolated world).
// Texto de **escritura** (write path, separado de read — regla de oro I2):
// ejecuta una acción sobre un Element ya resuelto por resolveRef y devuelve un
// ActResponse: {ok:true} | {ok:false, stale:true} | {ok:false, error}
// | {ok:false, inert:true, error} | {ok:false, disabled:true, error}.
// El camino de lectura (serializeFrame/resolveRef) NUNCA llama aquí; el único
// que escribe es performAction (y solo vía estas acciones).

import { getActiveDialog, isInert, isBlocking } from './dialog.js';

// dispatch: crea el evento en el window del documento del elemento, con fallback
// al global (Firefox isolated world), y lo despacha burbujeante sobre `el`.
function dispatch(el, type) {
  const win = el.ownerDocument ? el.ownerDocument.defaultView : null;
  const Ctor = (win && win.Event) || globalThis.Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true }));
}

function err(message) {
  return { ok: false, error: String(message) };
}

// fb-020-001 §2.2 — "actually disabled" de HTML, que coincide con `:disabled`
// (incluye descendientes de <fieldset disabled> fuera de su primer <legend>).
function isActuallyDisabled(el) {
  return el.matches(':disabled');
}

// §2.3 paso 4 / §2.4: se usa después de la aplicabilidad y antes del despacho,
// con y sin `options.force`. El mensaje no nombra force: no lo saltea.
function disabledResponse() {
  return {
    ok: false,
    disabled: true,
    error: 'control deshabilitado: la acción no se ejecutó; habilitalo antes de reintentar',
  };
}

// fb-020-004 §2.2 — type/select sin `value` (null/undefined) no escriben ni
// despachan: vaciar un campo se pide explícitamente con value:"".
function missingValueResponse(action) {
  return err(`${action} requiere value (string); para vaciar el campo usá value:""`);
}

// performAction: ejecuta `action` sobre `el` (null → stale) con `value`.
// fb-018-004 §2.5/§2.6: guard de inertness ANTES de cualquier despacho, para
// las cuatro acciones. `options.force` (default false) lo desactiva. La
// determinación del diálogo activo y del predicado de inertness viene del
// módulo compartido `dialog.js` (§2.6) — la misma fuente que usa
// serializer.js, para que la coherencia serializer↔act sea estructural (I-4).
export function performAction(el, action, value, options) {
  if (el == null) return { ok: false, stale: true }; // ref no resoluble → mapa stale (PC11), precede al guard (P16)

  const force = !!(options && options.force);
  if (!force) {
    const root = el.ownerDocument ? el.ownerDocument.body : null;
    const activeDialog = root ? getActiveDialog(root) : null;
    // fb-018-007 §2.5 — el guard consulta `isBlocking` antes de `isInert`,
    // desde el mismo módulo compartido que serializer.js: mismo mecanismo, así
    // que I-4 se sostiene en los dos regímenes de blocking.
    const blocking = root ? isBlocking(root, activeDialog) : false;
    if (isInert(activeDialog, blocking, el)) {
      return {
        ok: false,
        inert: true,
        error: 'elemento inerte: cubierto por un diálogo modal activo; usá force:true para forzar',
      };
    }
  }

  switch (action) {
    case 'click':
      if (typeof el.click !== 'function') {
        return err(`click no es aplicable a <${(el.tagName || '').toLowerCase()}>`);
      }
      if (isActuallyDisabled(el)) return disabledResponse();
      el.click();
      return { ok: true };

    case 'type': {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'input' && tag !== 'textarea') {
        return err(`type no es aplicable a <${tag}> (espera input/textarea)`);
      }
      if (isActuallyDisabled(el)) return disabledResponse();
      if (value == null) return missingValueResponse('type');
      el.value = String(value);
      dispatch(el, 'input'); // burbujeante
      dispatch(el, 'change'); // burbujeante
      return { ok: true };
    }

    case 'focus':
      if (typeof el.focus !== 'function') {
        return err('focus no es aplicable a este elemento');
      }
      if (isActuallyDisabled(el)) return disabledResponse();
      el.focus();
      return { ok: true };

    case 'select': {
      if (!el || el.tagName.toLowerCase() !== 'select') {
        return err(`select no es aplicable a <${(el.tagName || '').toLowerCase()}> (espera select)`);
      }
      if (isActuallyDisabled(el)) return disabledResponse();
      if (value == null) return missingValueResponse('select');
      const sv = String(value);
      let opt = null;
      for (const o of el.options) {
        if (o.value === sv) { opt = o; break; }
      }
      if (!opt) {
        // fallback por texto visible de la opción
        for (const o of el.options) {
          if (o.textContent === sv) { opt = o; break; }
        }
      }
      if (!opt) return err(`select: no hay opción con value o label "${sv}"`);
      el.value = opt.value;
      dispatch(el, 'change'); // burbujeante
      return { ok: true };
    }

    default:
      return err(`acción desconocida: ${action}`);
  }
}