// index.js — bundle entry de fb-017 (frame-map-api). Re-exporta los módulos del
// frame para que el bundle IIFE exponga el global VulpoFrame con
// serializeFrame (001), resolveRef y performAction (002). fb-017-004 (enmienda
// HITL): la invalidación es un diff stateless en background — no hay observer.
// fb-018-006 (§2.4): waitForSettle — predicado temporal de quiescencia,
// transitorio por llamada (observadores propios, desconectados al resolver).
import { serializeFrame as coreSerializeFrame } from './serializer.js';
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
export { waitForSettle } from './settle.js';
// fb-020-002 v2 (§2.1): escritura + observación del campo escrito.
export { performActionAndObserve, performFill } from './observe.js';
// fb-020-003 v3.3 (§2.2, P24): lector de la pregunta nativa pendiente. El
// envoltorio vive sólo en ../native-dialog-main.js.
export { readNativeDialog } from './native-dialog.js';