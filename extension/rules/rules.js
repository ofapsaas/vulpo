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
 *   `null` si el token no es un dominio válido (`*` pelado, `://`, espacios,
 *   `*` fuera de `**`/`*.`, `*` en el path, host vacío): `parseRules` lo rechaza
 *   (P18/P18d) y `matchDomain` devuelve false.
 */
function parsePattern(token) {
  if (token === '**') return { catchAll: true, host: null, path: null };
  if (token === '*') return null;

  const slash = token.indexOf('/');
  const hostPart = slash === -1 ? token : token.slice(0, slash);
  const rawPath = slash === -1 ? null : token.slice(slash + 1);

  // P18d (review v3 #1): el `*` en la PORCIÓN DE PATH no es válido. El catch-all
  // es el token `**` (sin host) y el comodín de subdominio solo vale como `*.`
  // al inicio del host; un `*` de path se aceptaba como literal (perfil muerto)
  // ⇒ fail-loud.
  if (rawPath !== null && rawPath.includes('*')) return null;

  // P18 (Enmienda 3, §2.8): el host debe ser válido (`host` o `*.suffix`); el
  // `*` solo vale como comodín `*.` al inicio. El host se normaliza a lowercase
  // para comparar case-insensitive (P18c).
  const wildcard = hostPart.startsWith('*.');
  const hostName = wildcard ? hostPart.slice(2) : hostPart;
  if (!isValidHost(hostName)) return null;

  const host = { t: wildcard ? 'w' : 'e', v: hostName.toLowerCase() };

  const path = rawPath === null ? null : rawPath.replace(/^\/+|\/+$/g, '') || null;

  return { catchAll: false, host, path };
}

/** Host válido (P18): etiquetas alfanuméricas separadas por puntos, con guiones
 *  internos; sin esquema, sin espacios, sin `*`. */
function isValidHost(host) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
    host,
  );
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

    // P15 (Enmienda 2, §2.7): toda línea que no sea un perfil válido de ≥3
    // partes (bridgeUrl http(s) válida + token no vacío + ≥1 token de dominio)
    // hace FALLAR VISIBLE la carga. No hay descarte silencioso de líneas
    // malformadas (regresión de observabilidad / amplificador de seguridad).
    if (parts.length < 3) {
      return {
        ok: false,
        error: `invalid rules line "${line}": expected "bridgeUrl token domain1 domain2 ..."`,
      };
    }

    const bridgeUrl = parts[0].replace(/\/+$/, '');
    const token = parts[1];
    const domains = parts.slice(2);

    if (!isValidUrl(bridgeUrl)) {
      return { ok: false, error: `invalid bridge URL "${parts[0]}" in rules line "${line}"` };
    }

    // P18 (Enmienda 3, §2.8): cada token de dominio debe ser un host válido
    // (`host` o `*.suffix`, con path opcional). Un token imposible (`*` pelado,
    // `://`, espacios, `*` fuera de `**`/`*.`) hace fallar visible la carga:
    // cierra el "perfil muerto silencioso".
    for (const domain of domains) {
      if (domain === '*') {
        return {
          ok: false,
          error: `invalid domain "*" (line "${line}") — use "**" for an explicit catch-all`,
        };
      }
      if (parsePattern(domain) === null) {
        return { ok: false, error: `invalid domain "${domain}" (line "${line}") — not a valid host` };
      }
    }

    // P16 (Enmienda 3, §2.8): `**` es catch-all SOLO si es el ÚNICO token de
    // dominio del perfil. Mezclarlo con dominios con scope sería un catch-all
    // silencioso (amplitud nunca aprobada por el operador) ⇒ fail-loud.
    if (domains.includes('**') && domains.length > 1) {
      return { ok: false, error: `"**" must be the only domain of profile "${bridgeUrl}|${token}"` };
    }

    const id = `${bridgeUrl}|${token}`;
    // P17 (Enmienda 3, §2.8): id duplicado ⇒ fail-loud. No hay fusión (unión)
    // ni last-wins silencioso; el id `(bridgeUrl, token)` debe ser único.
    if (byId.has(id)) {
      return { ok: false, error: `duplicate profile id "${id}"` };
    }
    const profile = { id, bridgeUrl, token, domains: [...domains] };
    byId.set(id, profile);
    profiles.push(profile);
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

/** bridgeUrl válida = URL con protocolo http(s) (spec §2.3 P15). */
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
