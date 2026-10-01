// index.js — bundle entry de fb-017 (frame-map-api). Re-exporta los módulos del
// frame para que el bundle IIFE exponga el global VulpoFrame con
// serializeFrame (001), resolveRef y performAction (002). fb-017-004 (enmienda
// HITL): la invalidación es un diff stateless en background — no hay observer.
// fb-018-006 (§2.4): waitForSettle — predicado temporal de quiescencia,
// transitorio por llamada (observadores propios, desconectados al resolver).
import { serializeFrame as coreSerializeFrame } from './serializer.js';
import { waitForSettle as coreWaitForSettle } from './settle.js';
import { odooValidityProfile } from './profiles/odoo.js';

// fb-020-005 §3.7/§10.3 — composición: el entry del bundle INYECTA el
// registro de perfiles de convención de validez (I-2, I-9). `VALIDITY_PROFILES`
// es el registro compuesto real de la extensión (deuda D-2: hoy solo Odoo).
export const VALIDITY_PROFILES = [odooValidityProfile];

// serializeFrame compuesto: mismo contrato que el del núcleo, con el registro
// inyectado por default. `options.validityProfiles` explícito prevalece
// (permite a un caller —p.ej. este propio test suite— inyectar otro registro).
export function serializeFrame(root, options) {
  return coreSerializeFrame(root, { validityProfiles: VALIDITY_PROFILES, ...options });
}
export { resolveRef } from './resolver.js';
export { performAction } from './act.js';

// fb-024-settle-carga-de-sitio (§3.3, D-3): waitForSettle compuesto exactamente
// como serializeFrame — el registro de convenciones de sitio (que alimenta el
// veto del marcador de carga) viaja por `validityProfiles` inyectado por
// default; el explícito prevalece (spread order). El re-export crudo que
// ignoraba la opción desaparece.
export function waitForSettle(doc, opts, serializeFn) {
  return coreWaitForSettle(doc, { validityProfiles: VALIDITY_PROFILES, ...opts }, serializeFn);
}
// fb-020-002 v2 (§2.1): escritura + observación del campo escrito.
export { performActionAndObserve, performFill } from './observe.js';
// fb-024-senal-previa-accion (D-2): señal visual previa al despacho. Aditivo:
// sin `durationMs` finito > 0 no cambia ningún comportamiento existente (D-7).
export { signalAction } from './signal.js';
// fb-020-003 v3.3 (§2.2, P24): lector de la pregunta nativa pendiente. El
// envoltorio vive sólo en ../native-dialog-main.js.
export { readNativeDialog } from './native-dialog.js';