// validity-profiles.js — fb-020-005-odoo-form-validity (§3.1, §3.7).
// Núcleo: contrato del perfil de convención de validez + resolución del
// registro. SIN literales de ningún producto (I-1) — los literales concretos
// (firma de raíz, selectores, atributo) viven en `profiles/<sitio>.js`.
//
// Perfil (dato, §3.1):
//   {
//     id: string,
//     detect: (doc) => boolean,        // sobre el DOM, NUNCA sobre la URL
//     invalidMarkerSelector: string,
//     fieldNameAttribute?: string,     // opcional
//   }
//
// Como máximo UN perfil activo por frame: el PRIMERO del registro que
// detecte (§3.1). `detect` se evalúa una vez por serialización.

// detectActiveProfile — resuelve el perfil activo de un registro inyectado
// (`options.validityProfiles`, §3.7/§10.3). Sin registro (no es array) ⇒
// ningún perfil reconocido (P14, I-2): el núcleo no sabe que existen
// convenciones de sitio hasta que se le inyectan como dato.
export function detectActiveProfile(doc, profiles) {
  if (!Array.isArray(profiles)) return null;
  for (const profile of profiles) {
    if (profile && typeof profile.detect === 'function' && profile.detect(doc)) return profile;
  }
  return null;
}
