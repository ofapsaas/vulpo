// validity-profiles.js — fb-020-005-odoo-form-validity (§3.1, §3.7).
// Núcleo: registro de convenciones de SITIO inyectado como dato + resolución
// del perfil activo. SIN literales de ningún producto (I-1) — los literales
// concretos (firma de raíz, selectores, atributo) viven en `profiles/<sitio>.js`.
// fb-024-settle-carga-de-sitio (D-1): el registro mantiene su nombre histórico
// (`VALIDITY_PROFILES` / `validityProfiles`); ahora agrupa convenciones de
// sitio con capacidades por claves OPCIONALES.
//
// Perfil (dato, §3.1/D-2):
//   {
//     id: string,
//     detect: (doc) => boolean,        // sobre el DOM, NUNCA sobre la URL
//     invalidMarkerSelector: string,   // opcional: marcador de invalidez
//     fieldNameAttribute?: string,     // opcional: atributo del nombre de campo
//     loadingMarkerSelector?: string,  // opcional (D-2): marcador de carga del
//                                      // sitio; ausente = declara cero
//   }
//
// Como máximo UN perfil activo por frame: el PRIMERO del registro que
// detecte (§3.1). `detect` se evalúa por evaluación (D-4/D-7): sin caché ni
// latch entre evaluaciones.

// detectActiveProfile — resuelve el perfil activo de un registro inyectado
// (`options.validityProfiles`, §3.7/§10.3). Sin registro (no es array) ⇒
// ningún perfil reconocido (P14, I-2): el núcleo no sabe que existen
// convenciones de sitio hasta que se le inyectan como dato.
//
// D-4 (fb-024): un `detect` que lanza se trata como "sin perfil" para esta
// evaluación — sin propagación y sin latch (se vuelve a evaluar en la
// siguiente). Un perfil roto degrada validez, jamás rompe settle ni la
// serialización (I-3). Es la única pieza que blinda los dos caminos
// (serializer y settle) sin tocar `serializer.js`.
export function detectActiveProfile(doc, profiles) {
  if (!Array.isArray(profiles)) return null;
  for (const profile of profiles) {
    if (!profile || typeof profile.detect !== 'function') continue;
    let detected = false;
    try {
      detected = profile.detect(doc);
    } catch {
      // D-4: aislamiento del detect — un detect que lanza no es evidencia de
      // nada; no se propaga ni se fija como perfil para esta evaluación.
      detected = false;
    }
    if (detected) return profile;
  }
  return null;
}
