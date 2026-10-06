/**
 * rules.js — motor de reglas host+path (fb-026-001).
 *
 * ESM puro, SIN globals de navegador: lo importa `node --test` directamente y
 * el event page lo consume vía el bundle IIFE (`rules-bundle.js`, global
 * VulpoRules) cargado antes de `background.js` (restricción MV3, spec §2.1).
 *
 * Firma fija del seam (spec §2.1): `parseRules` / `matchDomain` / `resolveProfile`.
 *
 * Semántica del patrón de dominio (spec §2.2):
 *   host                    → cualquier path de ese host.
 *   host/prefijo            → frontera de segmento: /prefijo o /prefijo/...
 *   *.sufijo[/prefijo]      → comodín de subdominio MÁS el ápice.
 *   **                      → catch-all con opt-in explícito (a lo sumo uno).
 *   *                       → rechazado (fail-loud).
 */

// ── Descomposición del patrón ───────────────────────────────────────────────

/**
 * Descompone un token de dominio en host + prefijo de path.
 * @param {string} token
 * @returns {{host: {t: 'e'|'w', v: string}, path: string|null, catchAll: boolean}|null}
 *   `null` si el token es un `*` pelado (inválido: `parseRules` lo rechaza).
 */
function parsePattern(token) {
  if (token === '**') return { catchAll: true, host: null, path: null };
  if (token === '*') return null;

  const slash = token.indexOf('/');
  const hostPart = slash === -1 ? token : token.slice(0, slash);
  const rawPath = slash === -1 ? null : token.slice(slash + 1);

  const host = hostPart.startsWith('*.')
    ? { t: 'w', v: hostPart.slice(2) }
    : { t: 'e', v: hostPart };

  const path = rawPath === null ? null : rawPath.replace(/^\/+|\/+$/g, '') || null;

  return { catchAll: false, host, path };
}

function hostMatches(hostname, host) {
  if (host.t === 'w') return hostname === host.v || hostname.endsWith('.' + host.v);
  return hostname === host.v;
}

/** Frontera de segmento: `/project` matchea `/project` y `/project/x`, no `/projectile`. */
function pathMatches(pathname, prefix) {
  if (prefix === null) return true;
  const p = '/' + prefix;
  return pathname === p || pathname.startsWith(p + '/');
}

/** ¿El host exacto `h` cae dentro del comodín `*.suffix` (más ápice)? */
function exactInWildcard(h, suffix) {
  return h === suffix || h.endsWith('.' + suffix);
}

function hostsOverlap(a, b) {
  if (a.t === 'e' && b.t === 'e') return a.v === b.v;
  if (a.t === 'e') return exactInWildcard(a.v, b.v);
  if (b.t === 'e') return exactInWildcard(b.v, a.v);
  return a.v === b.v || a.v.endsWith('.' + b.v) || b.v.endsWith('.' + a.v);
}

function pathsOverlap(a, b) {
  if (a === null || b === null) return true;
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function patternsOverlap(a, b) {
  return hostsOverlap(a.host, b.host) && pathsOverlap(a.path, b.path);
}

// ── Seam ────────────────────────────────────────────────────────────────────

/**
 * ¿La URL matchea un único patrón host+path? (predicado atómico)
 * @param {string} url      // http(s)
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchDomain(url, pattern) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!u.protocol.startsWith('http')) return false;

  const p = parsePattern(pattern);
  if (p === null) return false;
  if (p.catchAll) return true;

  return hostMatches(u.hostname, p.host) && pathMatches(u.pathname, p.path);
}

/**
 * Perfil (a lo sumo uno) que reclama la URL, o null.
 * @param {string} url
 * @param {Array<{id: string, domains: string[]}>} profiles
 * @returns {object|null}
 */
export function resolveProfile(url, profiles) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.protocol.startsWith('http')) return null;

  for (const profile of profiles) {
    for (const domain of profile.domains) {
      if (matchDomain(url, domain)) return profile;
    }
  }
  return null;
}

/**
 * Carga/valida un texto de reglas. Atómico: ante texto inválido devuelve
 * `{ ok:false, error }` sin `profiles` (cero aplicación parcial, spec P9).
 * @param {string} text
 * @returns {{ ok: true, profiles: object[] } | { ok: false, error: string }}
 */
export function parseRules(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const byId = new Map();
  const profiles = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);

    // Sentinel `* None` (default de loadConfig): cero perfiles, sin error (P7).
    if (parts.length === 2 && parts[0] === '*' && parts[1] === 'None') continue;

    // Cada línea: bridgeUrl token dominio1 dominio2 ... (mínimo 3 partes).
    if (parts.length < 3) continue;

    const bridgeUrl = parts[0].replace(/\/+$/, '');
    const token = parts[1];
    const domains = parts.slice(2);

    if (!isValidUrl(bridgeUrl)) continue;

    const id = `${bridgeUrl}|${token}`;
    const existing = byId.get(id);
    if (existing) {
      existing.domains.push(...domains);
    } else {
      const profile = { id, bridgeUrl, token, domains: [...domains] };
      byId.set(id, profile);
      profiles.push(profile);
    }
  }

  // P6 — `*` pelado inválido (fail-loud).
  for (const profile of profiles) {
    for (const domain of profile.domains) {
      if (domain === '*') {
        return {
          ok: false,
          error: `invalid domain "*" (profile "${profile.id}") — use "**" for an explicit catch-all`,
        };
      }
    }
  }

  // P8 — a lo sumo un perfil `**` (catch-all con opt-in explícito).
  const catchAlls = profiles.filter((p) => p.domains.includes('**'));
  if (catchAlls.length > 1) {
    return { ok: false, error: 'at most one "**" catch-all profile is allowed' };
  }

  // P5 — solapamiento entre perfiles distintos (los `**` quedan exentos).
  const scoped = profiles
    .filter((p) => !p.domains.includes('**'))
    .map((p) => ({ id: p.id, patterns: p.domains.map(parsePattern).filter(Boolean) }));

  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      for (const a of scoped[i].patterns) {
        for (const b of scoped[j].patterns) {
          if (patternsOverlap(a, b)) {
            return {
              ok: false,
              error: `overlapping domains between profiles "${scoped[i].id}" and "${scoped[j].id}"`,
            };
          }
        }
      }
    }
  }

  return { ok: true, profiles };
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}
