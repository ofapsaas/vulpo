/**
 * rules.js — motor de reglas host+path con globs (fb-027-001, enmienda fb-026-001).
 *
 * ESM puro, SIN globals de navegador: lo importa `node --test` directamente y
 * el event page lo consume vía el bundle IIFE (`rules-bundle.js`, global
 * VulpoRules) cargado antes de `background.js` (restricción MV3, spec §2.1).
 *
 * Firma fija del seam (spec §2.1): `parseRules` / `matchDomain` / `resolveProfile`.
 * `parseRules` NUNCA falla por validación (siempre `{ok:true, profiles, warnings}`);
 * el único `ok:false` vivo queda en el wrapper de Options (infra: bundle ausente).
 *
 * Semántica del patrón de dominio (spec §2.2, NORMATIVA):
 *   host                    → cualquier path de ese host (anclado en ambos extremos).
 *   host/prefijo            → frontera de segmento: /prefijo o /prefijo/... (P2).
 *   *.sufijo                → comodín de subdominio MÁS el ápice (forma pura, P6).
 *   *                       → cero o más caracteres que NO son `/` (cruza `.`).
 *   **                      → globstar (cruza `/`); como token completo = catch-all.
 *   *                       → token pelado inválido (reservado; NUNCA catch-all).
 *
 * Dirección fail-closed (spec §2.3, no negociable): un token que no se puede
 * interpretar se DESCARTA con warning; nunca degrada a un match más amplio.
 */

// ── Globs ───────────────────────────────────────────────────────────────────

/**
 * Convierte un glob a fuente de regex (sin anclas): `*` → `[^/]*` (no cruza
 * `/`), `**` → `.*` (globstar, cruza `/`). El resto se escapa.
 * @param {string} glob
 * @returns {string}
 */
function globToRegexSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Regex anclada en ambos extremos de un glob. */
function globRegex(glob) {
  return new RegExp('^' + globToRegexSource(glob) + '$');
}

// ── Descomposición del patrón ───────────────────────────────────────────────

/**
 * Descompone un token de dominio en host + path (con globs) y devuelve su
 * forma canónica para almacenar (`canonical`, spec §2.2): host tal como lo
 * escribió el operador + path recortado; el vacío-tras-recorte es host-only.
 * @param {string} token
 * @returns {{catchAll: boolean, host: object|null, path: string|null, canonical: string}|null}
 *   `null` si el token no es interpretable (`*` pelado, `://`, host sin
 *   alfanumérico, label vacío o con `-` inicial/final, segmento de path
 *   inválido): `parseRules` lo saltea con warning (fail-closed) y
 *   `matchDomain` → false. Un path VACÍO tras el recorte NO es inválido: es
 *   host-only (B2 de la review).
 */
function parsePattern(token) {
  if (token === '**') return { catchAll: true, host: null, path: null, canonical: '**' };
  if (token === '*') return null;

  const slash = token.indexOf('/');
  const hostPart = slash === -1 ? token : token.slice(0, slash);
  const rawPath = slash === -1 ? null : token.slice(slash + 1);

  const host = parseHost(hostPart);
  if (host === null) return null;

  let path = null;
  if (rawPath !== null) {
    path = parsePath(rawPath);
    if (path === null) return null; // segmento inválido ⇒ token descartado
    if (path === '') path = null;   // vacío tras recorte ⇒ host-only (B2)
  }

  // Forma canónica del dominio almacenado (§2.2, normativo): `example.com/` y
  // `example.com//` → `example.com`; `example.com//products` y
  // `example.com/products/` → `example.com/products`. La caja del host NO se
  // normaliza en storage (se resuelve en el matching).
  const canonical = path === null ? hostPart : `${hostPart}/${path}`;
  return { catchAll: false, host, path, canonical };
}

/**
 * Host válido (spec §2.2): labels separados por `.`, cada uno de alnum/`*`/`-`
 * (sin `-` inicial/final); el host debe contener ≥1 alfanumérico (excluye `*`
 * y `*.*`, P21). Distingue la forma pura `*.sufijo` (comodín de subdominio) del
 * glob genérico.
 * @returns {{kind:'wild',suffix:string}|{kind:'glob',source:string}|{kind:'exact',v:string}|null}
 */
function parseHost(hostPart) {
  if (hostPart === '') return null;
  for (const label of hostPart.split('.')) {
    if (label === '') return null;
    if (!/^[A-Za-z0-9*-]+$/.test(label)) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }

  const lower = hostPart.toLowerCase();
  if (!/[a-z0-9]/.test(lower)) return null; // sin alfanumérico ⇒ fail-closed

  if (lower.startsWith('*.') && !lower.slice(2).includes('*')) {
    return { kind: 'wild', suffix: lower.slice(2) };
  }
  if (lower.includes('*')) return { kind: 'glob', source: lower };
  return { kind: 'exact', v: lower };
}

/**
 * Path válido (spec §2.2): se recortan `/` iniciales/finales (como hoy). El
 * resultado VACÍO tras el recorte significa "sin path" (host-only) y NO es
 * inválido — se distingue de un segmento malo (B2 de la review). Segmentos no
 * vacíos y sin espacios/`?`/`#`.
 * @returns {string|null} el path normalizado (posiblemente `''` = host-only),
 *   o `null` si es inválido (segmento malo).
 */
function parsePath(rawPath) {
  const p = rawPath.replace(/^\/+|\/+$/g, '');
  if (p === '') return ''; // "example.com/" ⇒ vacío tras recorte ⇒ host-only (B2)
  for (const segment of p.split('/')) {
    if (!/^[^\s?#]+$/.test(segment)) return null;
  }
  return p;
}

// ── Matching ────────────────────────────────────────────────────────────────

function hostMatches(hostname, host) {
  if (host.kind === 'wild') {
    return hostname === host.suffix || hostname.endsWith('.' + host.suffix);
  }
  if (host.kind === 'exact') return hostname === host.v;
  return globRegex(host.source).test(hostname);
}

/** Path anclado al inicio con cola de frontera de segmento `(/.*)?` (P2/P4/P5). */
function pathMatches(pathname, path) {
  if (path === null) return true;
  return new RegExp('^' + globToRegexSource('/' + path) + '(/.*)?$').test(pathname);
}

// ── Solape (conservador: puede avisar de más, nunca de menos) ────────────────

/** ¿El host exacto `h` cae dentro del patrón `pat` (wild/glob/exact)? */
function hostCoveredBy(h, pat) {
  if (pat.kind === 'wild') return h === pat.suffix || h.endsWith('.' + pat.suffix);
  if (pat.kind === 'glob') return globRegex(pat.source).test(h);
  if (pat.kind === 'exact') return h === pat.v;
  return false;
}

/** Prefijo/sufijo literal de un glob (antes del 1er `*` / después del último). */
function literalPrefix(s) {
  const i = s.indexOf('*');
  return i === -1 ? s : s.slice(0, i);
}
function literalSuffix(s) {
  const i = s.lastIndexOf('*');
  return i === -1 ? s : s.slice(i + 1);
}

/** Prefijo/sufijo literal de un host (exact/wild/glob) para el solape conservador. */
function hostLiteralParts(host) {
  if (host.kind === 'exact') return { prefix: host.v, suffix: host.v };
  if (host.kind === 'wild') return { prefix: '', suffix: host.suffix };
  return { prefix: literalPrefix(host.source), suffix: literalSuffix(host.source) };
}

/**
 * Solape de hosts con globs, conservador: compara los prefijos/sufijos literales.
 * @returns {boolean}
 */
function globHostsMayOverlap(a, b) {
  const { prefix: pa, suffix: sa } = hostLiteralParts(a);
  const { prefix: pb, suffix: sb } = hostLiteralParts(b);
  const prefixOk = pa === '' || pb === '' || pa.startsWith(pb) || pb.startsWith(pa);
  const suffixOk = sa === '' || sb === '' || sa.endsWith(sb) || sb.endsWith(sa);
  return prefixOk && suffixOk;
}

function hostsOverlap(a, b) {
  if (a.kind === 'exact' && b.kind === 'exact') return a.v === b.v;
  if (a.kind === 'exact') return hostCoveredBy(a.v, b);
  if (b.kind === 'exact') return hostCoveredBy(b.v, a);
  if (a.kind === 'wild' && b.kind === 'wild') {
    return a.suffix === b.suffix || a.suffix.endsWith('.' + b.suffix) || b.suffix.endsWith('.' + a.suffix);
  }
  return globHostsMayOverlap(a, b);
}

function pathsOverlap(a, b) {
  if (a === null || b === null) return true;
  if (a === b) return true;
  if (a.includes('*') || b.includes('*')) {
    const pa = literalPrefix(a);
    const pb = literalPrefix(b);
    return pa === pb || pa.startsWith(pb) || pb.startsWith(pa);
  }
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function patternsOverlap(a, b) {
  return hostsOverlap(a.host, b.host) && pathsOverlap(a.path, b.path);
}

// ── Seam ────────────────────────────────────────────────────────────────────

/**
 * ¿La URL matchea un único patrón host[+path]? (predicado atómico)
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
 * @typedef {Object} Profile
 * @property {string}   id        // `${bridgeUrl}|${token}`
 * @property {string}   bridgeUrl
 * @property {string}   token
 * @property {string[]} domains   // patrones host[+path] (globs admitidos)
 */

/**
 * @typedef {Object} Warning
 * @property {'invalid_domain'|'invalid_line'|'overlap'|'broad_glob'|'duplicate_id'|'catch_all_conflict'} code
 * @property {number}  line       // 1-based, sobre el texto ORIGINAL
 * @property {string}  message
 * @property {string}  [detail]
 */

/**
 * Carga/valida un texto de reglas. NUNCA falla por validación: devuelve
 * perfiles + warnings (ordenados por `line`) y la carga siempre procede
 * (spec §2.3). Cada anomalía degrada fail-closed (nunca amplía el alcance).
 * @param {string} text
 * @returns {{ ok: true, profiles: Profile[], warnings: Warning[] }}
 */
export function parseRules(text) {
  const warnings = [];
  const warn = (code, line, message, detail) => warnings.push({ code, line, message, detail });

  const rawLines = String(text).split('\n');
  const byId = new Map();
  const profiles = [];
  const scoped = []; // { id, line, patterns } — perfiles con scope (sin `**`)
  let catchAllTaken = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    const lineNo = i + 1;
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);

    // Sentinel `* None` (default de loadConfig): cero perfiles, sin warning (P7).
    if (parts.length === 2 && parts[0] === '*' && parts[1] === 'None') continue;

    // Línea malformada (no sentinel, <3 partes o bridgeUrl no http(s)): se
    // saltea la línea con warning; el resto de la config carga (P15).
    if (parts.length < 3) {
      warn('invalid_line', lineNo, `invalid rules line "${line}": expected "bridgeUrl token domain1 domain2 ..."`, line);
      continue;
    }

    const bridgeUrl = parts[0].replace(/\/+$/, '');
    const token = parts[1];

    if (!isValidUrl(bridgeUrl)) {
      warn('invalid_line', lineNo, `invalid bridge URL "${parts[0]}" in rules line "${line}"`, parts[0]);
      continue;
    }

    // Id duplicado `(bridgeUrl, token)`: first-wins, se ignora la línea
    // posterior (D4/P16). Actúa ANTES del conflicto de catch-all (P16b).
    const id = `${bridgeUrl}|${token}`;
    if (byId.has(id)) {
      warn('duplicate_id', lineNo, `duplicate profile id "${id}" — first-wins: se ignora la línea posterior`, id);
      continue;
    }

    // Tokens de dominio: un token ilegible se SALTEA (la línea conserva sus
    // otros dominios); nunca degrada a un match más amplio (fail-closed, P13).
    // Se almacena la forma CANÓNICA (`pattern.canonical`, §2.2): el recorte de
    // "/" del path es normativo y el matcher no reconoce la forma cruda (B2).
    let domains = [];
    for (const domain of parts.slice(2)) {
      const pattern = parsePattern(domain);
      if (pattern === null) {
        warn('invalid_domain', lineNo, `invalid domain "${domain}" (line "${line}") — token descartado`, domain);
        continue;
      }
      domains.push(pattern.canonical);
      if (!pattern.catchAll && isBroadGlob(pattern.host)) {
        warn('broad_glob', lineNo, `broad host glob "${domain}" (line "${line}") — el perfil carga tal cual; revisá el alcance`, domain);
      }
    }

    // `**` conflictivo: mezclado con dominios con scope o duplicado en la
    // misma línea ⇒ se ignora el `**`; el perfil NO es catch-all (D5/P17).
    const catchCount = domains.filter((d) => d === '**').length;
    const scopedDomains = domains.filter((d) => d !== '**');
    if (catchCount > 0 && (scopedDomains.length > 0 || catchCount > 1)) {
      warn('catch_all_conflict', lineNo, `"**" must be the only domain of profile "${id}" — se ignora el catch-all`, id);
      domains = scopedDomains.length > 0 ? scopedDomains : ['**'];
    }

    // Línea sin dominios (todos salteados): se saltea la línea (P14).
    if (domains.length === 0) {
      warn('invalid_line', lineNo, `rules line "${line}" has no valid domain — se saltea la línea`, line);
      continue;
    }

    // A lo sumo un catch-all: sólo el primer perfil `**` lo es; los posteriores
    // se ignoran y, sin dominios, se saltea la línea (D5/P18).
    if (domains.length === 1 && domains[0] === '**') {
      if (catchAllTaken) {
        warn('catch_all_conflict', lineNo, `at most one "**" catch-all profile is allowed — se ignora "${id}"`, id);
        continue;
      }
      catchAllTaken = true;
    }

    const profile = { id, bridgeUrl, token, domains: [...domains] };
    byId.set(id, profile);
    profiles.push(profile);
    if (!domains.includes('**')) {
      scoped.push({ id, line: lineNo, patterns: domains.map(parsePattern).filter(Boolean) });
    }
  }

  // Solape entre perfiles distintos (los `**` quedan exentos): warning + carga;
  // first-match (el declarado primero) decide (D2/P11/P12).
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      for (const a of scoped[i].patterns) {
        for (const b of scoped[j].patterns) {
          if (patternsOverlap(a, b)) {
            warn(
              'overlap',
              scoped[j].line,
              `overlapping domains between profiles "${scoped[i].id}" and "${scoped[j].id}" — first-match wins: "${scoped[i].id}" prevalece`,
              `${scoped[i].id} < ${scoped[j].id}`,
            );
          }
        }
      }
    }
  }

  warnings.sort((a, b) => a.line - b.line);
  return { ok: true, profiles, warnings };
}

/** bridgeUrl válida = URL con protocolo http(s) (spec §2.3 P15). */
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** Host glob "ancho" (D7/P22): primer label empieza con `*` y no es `*.sufijo` puro. */
function isBroadGlob(host) {
  if (host.kind !== 'glob') return false;
  return host.source.split('.')[0].startsWith('*');
}
