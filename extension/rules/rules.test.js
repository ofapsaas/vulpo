/**
 * rules.test.js — fb-027-001-rules-policy-and-globs (RED, seam puro).
 *
 * Verifica P1–P22 de
 * docs/specs/fb-027-001-rules-policy-and-globs/spec.md §2.1/§2.2/§2.3/§2.4
 * y el mapeo test↔postcondición del test-audit.md aprobado (§4a/§4b).
 *
 * Enmienda fb-026-001: la política de carga pasa de **fail-loud** a
 * **warning + carga** (§2.3): overlap, token inválido, línea malformada, id
 * duplicado y `**` conflictivo dejan de tumbar la config entera; el
 * orden/first-match decide. La gramática admite globs `*`/`**` en host y path
 * (§2.2). El matching NO se debilita: sólo cambia la expectativa de POLÍTICA
 * (Q5 del HITL).
 *
 * Escrito SOLO contra el contrato del spec. Esta sesión (rol test-writer,
 * aislamiento de fase, ADR-011) NO leyó implementación: `src/extension/rules/
 * rules.js` no se leyó. Los tests ejercitan el contrato observable de los TRES
 * exports del seam (`parseRules`/`matchDomain`/`resolveProfile`).
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  El módulo se carga de forma CONTROLADA (patrón C-1): un `import()` dinámico
 *  cuyo rechazo se mapea a `rules = null`. CADA test empieza con
 *  `assert.ok(rules, ...)`, así el fallo es AssertionError (no ImportError).
 *  Los tests de POLÍTICA asertan `assert.equal(r.ok, true)` PRIMERO: hoy
 *  `parseRules` devuelve `{ok:false, error}` SIN `warnings`/`profiles`, y
 *  dereferenciar antes fallaría por TypeError (RED inválido).
 *
 * ── Guards green-to-green (declarados, no RED) ──────────────────────────────
 *  `fb027_P6`/`fb027_P7`/`fb027_P10` son postcondiciones de PRESERVACIÓN
 *  (fb-026), no de cambio: pasan hoy y deben seguir pasando.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Carga controlada del seam (patrón C-1) ──────────────────────────────────

let rules = null;
try {
  rules = await import('./rules.js');
} catch {
  rules = null; // módulo ausente ⇒ cada test falla por AssertionError (RED válido)
}

const AUSENTE =
  'rules.js ausente — contrato sin implementar (RED válido: AssertionError, no ImportError)';

// ── Fixtures mínimas ────────────────────────────────────────────────────────

const B = 'https://bridge.example.com';
const TOKEN_A = 'TOKEN_A';
const TOKEN_B = 'TOKEN_B';
const ID_A = `${B}|${TOKEN_A}`;
const ID_B = `${B}|${TOKEN_B}`;

/** Construye un Profile según el typedef del spec §2.1 (para tests de resolve/match). */
function prof(id, token, domains) {
  return { id, bridgeUrl: B, token, domains };
}

/** ¿Hay un warning con el `code` dado? (tolerante a `warnings` no-arreglo). */
function hasCode(warnings, code) {
  return Array.isArray(warnings) && warnings.some((w) => w && w.code === code);
}

/** Texto humano de un warning (message + detail) para asertar lo que "nombra". */
function wtext(w) {
  return `${(w && w.message) || ''} ${(w && w.detail) || ''}`;
}

// ════════════════════════════════════════════════════════════════════════════
// C2 — globs: matching (P1–P10; P6/P7/P10 son guards de preservación)
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P1_star_cero_o_mas_no_cruza_slash', () => {
  assert.ok(rules, AUSENTE);
  // `*` matchea cero o más caracteres (que no son `/`): el label `cert` con y
  // sin sufijo numérico.
  assert.equal(
    rules.matchDomain('https://edu-us-cert1.odoo.com/', 'edu-us-cert*.odoo.com'),
    true,
  );
  assert.equal(
    rules.matchDomain('https://edu-us-cert.odoo.com/', 'edu-us-cert*.odoo.com'),
    true,
  );
});

test('fb027_P2_star_cruza_punto_en_host', () => {
  assert.ok(rules, AUSENTE);
  // El glob estándar cruza `.` en el host (declarado).
  assert.equal(
    rules.matchDomain('https://edu-us-cert.x.odoo.com/', 'edu-us-cert*.odoo.com'),
    true,
  );
});

test('fb027_P3_star_no_cruza_slash', () => {
  assert.ok(rules, AUSENTE);
  // `*` no cruza `/`: consume el resto del segmento, no otro segmento.
  assert.equal(rules.matchDomain('https://manjaro.org/products', 'manjaro.org/products*'), true);
  assert.equal(
    rules.matchDomain('https://manjaro.org/products-otro', 'manjaro.org/products*'),
    true,
  );
  assert.equal(rules.matchDomain('https://manjaro.org/otro', 'manjaro.org/products*'), false);
});

test('fb027_P5_path_glob_es_superset_del_prefijo', () => {
  assert.ok(rules, AUSENTE);
  // Agregar `*` NUNCA angosta: el glob de path sigue cubriendo el subpath.
  assert.equal(
    rules.matchDomain('https://manjaro.org/products/x', 'manjaro.org/products*'),
    true,
  );
});

test('fb027_P6_forma_pura_subdominio_apice_y_profundidad', () => {
  assert.ok(rules, AUSENTE);
  // GUARD (preservación fb-026): `*.sufijo` matchea el ápice y cualquier profundidad.
  assert.equal(rules.matchDomain('https://odoo.com/', '*.odoo.com'), true);
  assert.equal(rules.matchDomain('https://a.odoo.com/', '*.odoo.com'), true);
  assert.equal(rules.matchDomain('https://a.b.odoo.com/', '*.odoo.com'), true);
});

test('fb027_P7_doble_asterisco_catch_all', () => {
  assert.ok(rules, AUSENTE);
  // GUARD (preservación): `**` (token completo) es catch-all de cualquier URL http(s).
  assert.equal(rules.matchDomain('https://cualquiera.example/a/b?q=1#f', '**'), true);
});

test('fb027_P8_star_en_medio_de_label', () => {
  assert.ok(rules, AUSENTE);
  // Un `*` en el medio de un label es aceptado (C2).
  assert.equal(rules.matchDomain('https://eduXus.odoo.com/', 'edu*us.odoo.com'), true);
});

test('fb027_P9_doble_asterisco_en_path_globstar', () => {
  assert.ok(rules, AUSENTE);
  // `**` en el path es globstar: cualquier path (incluido el vacío/raíz).
  assert.equal(rules.matchDomain('https://example.com/', 'example.com/**'), true);
  assert.equal(rules.matchDomain('https://example.com/a', 'example.com/**'), true);
  assert.equal(rules.matchDomain('https://example.com/a/b', 'example.com/**'), true);
});

test('fb027_P10_path_case_sensitive', () => {
  assert.ok(rules, AUSENTE);
  // GUARD (preservación): el path es case-sensitive.
  assert.equal(rules.matchDomain('https://example.com/Products', 'example.com/products'), false);
});

// ════════════════════════════════════════════════════════════════════════════
// D1 — scoping host+path (fb-026; PRESERVADOS, no se tocan)
// ════════════════════════════════════════════════════════════════════════════

test('P1_host_sin_path_matchea_cualquier_path', () => {
  assert.ok(rules, AUSENTE);
  assert.equal(rules.matchDomain('https://example.com/', 'example.com'), true);
  assert.equal(rules.matchDomain('https://example.com/a/b', 'example.com'), true);
  assert.equal(rules.matchDomain('https://example.com/x?q=1#f', 'example.com'), true);
});

test('P2a_path_prefijo_positivo', () => {
  assert.ok(rules, AUSENTE);
  assert.equal(rules.matchDomain('https://example.com/project', 'example.com/project'), true);
  assert.equal(rules.matchDomain('https://example.com/project/x', 'example.com/project'), true);
  assert.equal(
    rules.matchDomain('https://example.com/project/x?q=1#f', 'example.com/project'),
    true,
  );
});

test('P2b_frontera_de_segmento_negativo', () => {
  assert.ok(rules, AUSENTE);
  assert.equal(rules.matchDomain('https://example.com/projectile', 'example.com/project'), false);
  assert.equal(rules.matchDomain('https://example.com/project-x', 'example.com/project'), false);
});

test('P3_scope_disjunto_no_reclama', () => {
  assert.ok(rules, AUSENTE);
  const profA = prof(ID_A, TOKEN_A, ['example.com/pathA']);
  // Fuera del scope de A ⇒ no reclama.
  assert.equal(rules.resolveProfile('https://example.com/pathB/x', [profA]), null);
  // Dentro del scope de A ⇒ lo reclama (misma referencia).
  assert.equal(rules.resolveProfile('https://example.com/pathA/x', [profA]), profA);
});

test('P4_dos_perfiles_mismo_host_paths_disjuntos', () => {
  assert.ok(rules, AUSENTE);
  const profA = prof(ID_A, TOKEN_A, ['example.com/project/a']);
  const profB = prof(ID_B, TOKEN_B, ['example.com/project/b']);
  assert.equal(rules.resolveProfile('https://example.com/project/a/x', [profA, profB]), profA);
  assert.equal(rules.resolveProfile('https://example.com/project/b/x', [profA, profB]), profB);
});

// ════════════════════════════════════════════════════════════════════════════
// D2/C1 — política de carga: OVERLAP → warning + first-match (§2.3)
// ════════════════════════════════════════════════════════════════════════════

test('P5a_solape_mismo_host_path', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} example.com/project\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P5a: el overlap ya NO tumba la carga (warning + carga)');
  assert.equal(r.profiles.length, 2, 'P5a: ambos perfiles solapados quedan cargados');
  const ov = (r.warnings || []).find((w) => w && w.code === 'overlap');
  assert.ok(ov, 'P5a: se emite un warning `overlap`');
  const t = wtext(ov);
  assert.ok(t.includes(ID_A), 'P5a: el warning nombra el perfil A');
  assert.ok(t.includes(ID_B), 'P5a: el warning nombra el perfil B');
  assert.ok(
    /first|primero|gana|ganador|winner|prevalece|prioridad/i.test(t),
    'P5a: el warning nombra cuál gana por first-match (el anterior)',
  );
});

test('P5b_solape_host_sin_path', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} example.com\n${B} ${TOKEN_B} example.com/project\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P5b: host sin path solapa con host/prefijo ⇒ carga con warning');
  assert.equal(r.profiles.length, 2, 'P5b: ambos perfiles quedan cargados');
  const ov = (r.warnings || []).find((w) => w && w.code === 'overlap');
  assert.ok(ov, 'P5b: se emite un warning `overlap`');
  const t = wtext(ov);
  assert.ok(t.includes(ID_A), 'P5b: el warning nombra el perfil A (ganador)');
  assert.ok(t.includes(ID_B), 'P5b: el warning nombra el perfil B');
});

test('P5c_solape_wildcard_vs_host_y_prefijos_anidados', () => {
  assert.ok(rules, AUSENTE);
  // (i) comodín de subdominio (más ápice) vs host exacto del sufijo.
  const tWild = `${B} ${TOKEN_A} *.example.com\n${B} ${TOKEN_B} example.com\n`;
  const rWild = rules.parseRules(tWild);
  assert.equal(rWild.ok, true, 'P5c: *.sufijo solapa con el ápice ⇒ carga con warning');
  assert.equal(rWild.profiles.length, 2, 'P5c(i): ambos perfiles cargan');
  assert.ok(hasCode(rWild.warnings, 'overlap'), 'P5c(i): warning overlap');
  // (ii) prefijos anidados.
  const tNested = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} example.com/project/sub\n`;
  const rNested = rules.parseRules(tNested);
  assert.equal(rNested.ok, true, 'P5c: prefijos anidados solapan ⇒ carga con warning');
  assert.equal(rNested.profiles.length, 2, 'P5c(ii): ambos perfiles cargan');
  assert.ok(hasCode(rNested.warnings, 'overlap'), 'P5c(ii): warning overlap');
});

// ════════════════════════════════════════════════════════════════════════════
// D6/C1 — `*` pelado: inválido pero NO bloquea (warning) (§2.3)
// ════════════════════════════════════════════════════════════════════════════

test('P6_asterisco_pelado_invalido_con_warning', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules(`${B} ${TOKEN_A} *\n`);
  assert.equal(r.ok, true, 'P6: un * pelado ya NO tumba la carga');
  assert.ok(Array.isArray(r.profiles), 'P6: profiles es un arreglo');
  assert.equal(r.profiles.length, 0, 'P6: la línea queda sin dominios ⇒ se saltea');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P6: warning invalid_domain del * pelado');
  assert.ok(
    hasCode(r.warnings, 'invalid_line'),
    'P6: la línea queda con 0 dominios ⇒ warning invalid_line',
  );
});

test('P7_sentinel_star_none', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules('* None\n');
  assert.equal(r.ok, true, 'P7: el sentinel * None NO es un * pelado');
  assert.ok(Array.isArray(r.profiles), 'P7: texto válido ⇒ profiles es un arreglo');
  assert.equal(r.profiles.length, 0, 'P7: cero perfiles, sin error');
});

test('P8a_un_doble_asterisco_aceptado_exento', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} **\n${B} ${TOKEN_B} example.com/project\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P8a: ** es el opt-in explícito de catch-all');
  assert.equal(r.profiles.length, 2, 'P8a: el perfil ** queda exento del chequeo de solapamiento');
});

// ════════════════════════════════════════════════════════════════════════════
// D5/C1 — `**` conflictivo: sólo el primero es catch-all (§2.3)
// ════════════════════════════════════════════════════════════════════════════

test('P8b_dos_doble_asterisco_solo_el_primero', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} **\n${B} ${TOKEN_B} **\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P8b: el segundo ** ya NO tumba la carga');
  assert.equal(r.profiles.length, 1, 'P8b: sólo el primer ** es catch-all');
  assert.equal(r.profiles[0].id, ID_A, 'P8b: sobrevive el primer perfil');
  assert.ok(hasCode(r.warnings, 'catch_all_conflict'), 'P8b: warning catch_all_conflict');
});

// ════════════════════════════════════════════════════════════════════════════
// C1 — atomicidad RETIRADA: el resto de la config carga (§2.3 / P20)
// ════════════════════════════════════════════════════════════════════════════

test('P9_atomicidad_retirada_linea_valida_carga', () => {
  assert.ok(rules, AUSENTE);
  // Una línea válida + una inválida (* pelado): ya NO hay todo-o-nada; la
  // línea válida carga y la inválida se saltea con warning.
  const text = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} *\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P9: la línea inválida ya no aborta el texto (atomicidad retirada)');
  assert.equal(r.profiles.length, 1, 'P9: la línea válida carga');
  assert.equal(r.profiles[0].id, ID_A, 'P9: sólo el perfil válido carga');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P9: warning de la línea del * pelado');
});

test('P10_texto_valido_inequivoco_y_orden', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} example.com/project/a\n${B} ${TOKEN_B} example.com/project/b\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P10: config sin solape carga normalmente');
  assert.equal(r.profiles.length, 2);
  // Orden preservado + forma del Profile.
  assert.equal(r.profiles[0].id, ID_A, 'P10: el orden de profiles se preserva');
  assert.equal(r.profiles[1].id, ID_B, 'P10: el orden de profiles se preserva');
  assert.equal(r.profiles[0].bridgeUrl, B);
  assert.equal(r.profiles[0].token, TOKEN_A);
  // Resolución inequívoca: cada URL la resuelve exactamente su perfil.
  assert.equal(
    rules.resolveProfile('https://example.com/project/a/x', r.profiles),
    r.profiles[0],
  );
  assert.equal(
    rules.resolveProfile('https://example.com/project/b/x', r.profiles),
    r.profiles[1],
  );
});

// ════════════════════════════════════════════════════════════════════════════
// C1 — el problema se reporta como WARNING (no se traga) (§2.1/§2.3)
// ════════════════════════════════════════════════════════════════════════════

test('P11_warnings_observables_en_el_seam', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules(`${B} ${TOKEN_A} *\n`);
  assert.equal(r.ok, true, 'P11: el seam ya no produce ok:false por validación');
  assert.equal(r.error, undefined, 'P11: el campo `error` ya no existe en la validación');
  assert.ok(Array.isArray(r.warnings), 'P11: warnings es un arreglo');
  assert.ok(r.warnings.length > 0, 'P11: el problema se reporta (no se traga)');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P11: el warning nombra la causa');
});

// ════════════════════════════════════════════════════════════════════════════
// D3 — consistencia asignación ↔ guard (vía el seam; PRESERVADOS)
// ════════════════════════════════════════════════════════════════════════════

test('P12a_destino_en_scope_permitido', () => {
  assert.ok(rules, AUSENTE);
  const profA = prof(ID_A, TOKEN_A, ['example.com/pathA']);
  const resolved = rules.resolveProfile('https://example.com/pathA/x', [profA]);
  assert.ok(resolved, 'P12a: destino dentro del scope del caller debe resolver');
  assert.equal(resolved.id, profA.id, 'P12a: el guard permite (mismo perfil)');
});

test('P12b_destino_fuera_de_scope_denegado', () => {
  assert.ok(rules, AUSENTE);
  const profA = prof(ID_A, TOKEN_A, ['example.com/pathA']);
  const profB = prof(ID_B, TOKEN_B, ['example.com/pathB']);
  const dest = 'https://example.com/pathB/x';
  assert.equal(rules.resolveProfile(dest, [profA]), null, 'P12b: fuera del scope del caller ⇒ null');
  const resolved = rules.resolveProfile(dest, [profA, profB]);
  assert.ok(
    resolved && resolved.id !== profA.id,
    'P12b: el destino pertenece a OTRO perfil ⇒ denegado para el caller',
  );
  assert.equal(resolved.id, profB.id);
});

test('P13_listtabs_excluye_fuera_de_scope', () => {
  assert.ok(rules, AUSENTE);
  const profA = prof(ID_A, TOKEN_A, ['example.com/pathA']);
  const dentro = 'https://example.com/pathA/x';
  const fuera = 'https://example.com/pathB/x';
  // Post-filtro de listTabs: el mismo predicado sobre las URLs de las pestañas.
  assert.equal(rules.matchDomain(dentro, profA.domains[0]), true, 'P13: en scope ⇒ pertenece');
  assert.equal(rules.matchDomain(fuera, profA.domains[0]), false, 'P13: fuera de scope ⇒ NO pertenece');
  assert.equal(rules.resolveProfile(fuera, [profA]), null, 'P13: fuera de scope ⇒ no listada');
});

// ════════════════════════════════════════════════════════════════════════════
// C1 — FIRST-MATCH sobre overlap parseado (P12) (§2.2/§2.3)
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P12_overlap_resuelve_first_match', () => {
  assert.ok(rules, AUSENTE);
  // Dos perfiles solapados: `example.com/project` (A) y `example.com` (B). La URL
  // `/project/x` la reclaman ambos ⇒ gana el primero del arreglo (first-match).
  const text = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} example.com\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P12: la config con overlap carga');
  assert.ok(Array.isArray(r.profiles), 'P12: profiles es un arreglo');
  assert.equal(r.profiles.length, 2, 'P12: ambos perfiles cargan');
  assert.equal(r.profiles[0].id, ID_A, 'P12: el orden de la config se preserva');
  const url = 'https://example.com/project/x';
  assert.equal(
    rules.resolveProfile(url, r.profiles),
    r.profiles[0],
    'P12: gana el primero declarado (first-match)',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D3 — token inválido: skip del TOKEN; línea sin dominios: skip de la LÍNEA
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P13_token_invalido_se_saltea_y_linea_carga', () => {
  assert.ok(rules, AUSENTE);
  // `*` pelado entre dominios válidos: se saltea SÓLO el token; la línea conserva
  // sus otros dominios.
  const r = rules.parseRules(`${B} ${TOKEN_A} example.com *\n`);
  assert.equal(r.ok, true, 'P13: el token inválido no tumba la carga');
  assert.equal(r.profiles.length, 1, 'P13: la línea carga con sus otros dominios');
  assert.deepEqual(r.profiles[0].domains, ['example.com'], 'P13: se saltea sólo el token inválido');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P13: warning invalid_domain');
});

test('fb027_P14_linea_sin_dominios_se_saltea', () => {
  assert.ok(rules, AUSENTE);
  // Línea 1: token `*` inválido ⇒ queda con 0 dominios ⇒ se saltea la línea.
  // Línea 2: válida ⇒ carga. El resto de la config carga.
  const text = `${B} ${TOKEN_A} *\n${B} ${TOKEN_B} example.com\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P14: la línea sin dominios no tumba el resto');
  assert.equal(r.profiles.length, 1, 'P14: sólo la línea válida carga');
  assert.equal(r.profiles[0].id, ID_B, 'P14: el resto de la config carga');
  assert.ok(hasCode(r.warnings, 'invalid_line'), 'P14: warning invalid_line de la línea salteada');
});

// ════════════════════════════════════════════════════════════════════════════
// D6 — host sin alfanumérico (`*`, `*.*`): inválido, fail-closed (P21)
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P21_host_solo_asterisco_punto_invalido', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules(`${B} ${TOKEN_A} *.*\n`);
  assert.equal(r.ok, true, 'P21: el host sin alfanumérico no tumba la carga');
  assert.equal(r.profiles.length, 0, 'P21: el token se descarta (fail-closed)');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P21: warning invalid_domain');
});

// ════════════════════════════════════════════════════════════════════════════
// D7 — host glob "ancho": aviso `broad_glob`, la carga honra el patrón (P22)
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P22_broad_glob_warning_pero_carga', () => {
  assert.ok(rules, AUSENTE);
  for (const patron of ['*cert*.odoo.com', '*foo.com', '*.dev.odoo.com*.vauxoo.com']) {
    const r = rules.parseRules(`${B} ${TOKEN_A} ${patron}\n`);
    assert.equal(r.ok, true, `P22: ${patron} no bloquea la carga`);
    assert.equal(r.profiles.length, 1, `P22: ${patron} carga tal cual`);
    assert.deepEqual(r.profiles[0].domains, [patron], `P22: ${patron} se honra como dominio`);
    assert.ok(hasCode(r.warnings, 'broad_glob'), `P22: ${patron} dispara broad_glob (aviso)`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// C1/P20 — parseRules siempre ok:true; warnings por line; profiles en orden
// ════════════════════════════════════════════════════════════════════════════

test('fb027_P20_siempre_ok_warnings_ordenados_profiles_ordenados', () => {
  assert.ok(rules, AUSENTE);
  // Anomalías en líneas desordenadas respecto del orden de emisión esperado.
  const text =
    `${B} ${TOKEN_A} *\n` + //          línea 1: invalid_domain (+ invalid_line)
    `${B} ${TOKEN_A} example.com\n` + // línea 2: perfil A (carga)
    `${B} ${TOKEN_B} example.net\n` + // línea 3: perfil B (carga)
    `${B} ${TOKEN_B} example.org\n`; //  línea 4: duplicate_id (first-wins)
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P20: parseRules(string) siempre devuelve ok:true');
  assert.ok(Array.isArray(r.profiles), 'P20: profiles es un arreglo');
  assert.ok(Array.isArray(r.warnings), 'P20: warnings es un arreglo');
  assert.equal(r.profiles.length, 2, 'P20: dos perfiles cargan (la línea duplicada se ignora)');
  assert.equal(r.profiles[0].id, ID_A, 'P20: profiles preserva el orden de la config');
  assert.equal(r.profiles[1].id, ID_B, 'P20: profiles preserva el orden de la config');
  const lines = r.warnings.map((w) => w.line);
  assert.deepEqual(
    lines,
    [...lines].sort((a, b) => a - b),
    'P20: warnings ordenado por `line`',
  );
  assert.ok(
    r.warnings.some((w) => w.line === 1 && w.code === 'invalid_domain'),
    'P20: warning de la línea 1 (invalid_domain)',
  );
  assert.ok(
    r.warnings.some((w) => w.line === 4 && w.code === 'duplicate_id'),
    'P20: warning de la línea 4 (duplicate_id)',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D2/C1 — líneas malformadas: se SALTEAN con warning (P15; ya no fail-loud)
// ════════════════════════════════════════════════════════════════════════════

test('P15a_linea_corta_no_sentinel_se_saltea_con_warning', () => {
  assert.ok(rules, AUSENTE);
  const VALIDA = `${B} ${TOKEN_A} example.com/project\n`;
  // (control) la línea válida por sí sola carga: así el "carga el resto" del
  // texto combinado es discriminante, no un falso positivo.
  const control = rules.parseRules(VALIDA);
  assert.equal(control.ok, true, 'P15a control: la línea válida por sí sola carga');
  assert.equal(control.profiles.length, 1, 'P15a control: un solo perfil');

  // Línea de 2 partes que NO es el sentinel `* None` (aquí `https://b T`):
  // se saltea la línea con warning; la línea válida del mismo texto carga.
  const r = rules.parseRules(`https://b T\n${VALIDA}`);
  assert.equal(r.ok, true, 'P15a: la línea malformada ya no tumba la carga (warning)');
  assert.equal(r.profiles.length, 1, 'P15a: el resto de la config carga');
  assert.equal(r.profiles[0].id, ID_A, 'P15a: sólo la línea válida carga');
  assert.ok(hasCode(r.warnings, 'invalid_line'), 'P15a: warning invalid_line de la línea salteada');
});

test('P15b_bridgeurl_invalida_se_saltea_con_warning', () => {
  assert.ok(rules, AUSENTE);
  const VALIDA = `${B} ${TOKEN_A} example.com/project\n`;
  const control = rules.parseRules(VALIDA);
  assert.equal(control.ok, true, 'P15b control: la línea válida por sí sola carga');
  assert.equal(control.profiles.length, 1, 'P15b control: un solo perfil');

  // 3 partes, token no vacío, ≥1 token de dominio — pero bridgeUrl NO es http(s)
  // válida. El dominio del perfil malformado (example.org) es distinto del de la
  // línea válida (example.com), para que el warning solo pueda provenir de P15.
  const r = rules.parseRules(`notaurl T example.org\n${VALIDA}`);
  assert.equal(r.ok, true, 'P15b: bridgeUrl inválida ya no tumba la carga (warning)');
  assert.equal(r.profiles.length, 1, 'P15b: el resto de la config carga');
  assert.equal(r.profiles[0].id, ID_A, 'P15b: sólo la línea válida carga');
  assert.ok(hasCode(r.warnings, 'invalid_line'), 'P15b: warning invalid_line de la línea salteada');
});

// ════════════════════════════════════════════════════════════════════════════
// D5 — `**` mezclado con scope: se IGNORA el `**` (no amplía) (P17)
// ════════════════════════════════════════════════════════════════════════════

test('P16a_catch_all_mezclado_en_misma_linea_ignorado', () => {
  assert.ok(rules, AUSENTE);
  // Un mismo perfil con `**` + un token con scope (misma línea) NO es un
  // catch-all puro: se ignora el `**` y el perfil conserva su scope.
  const r = rules.parseRules(`${B} ${TOKEN_A} ** example.com/own\n`);
  assert.equal(r.ok, true, 'P16a: `**` mezclado ya no tumba la carga');
  assert.equal(r.profiles.length, 1, 'P16a: el perfil carga (sin el `**`)');
  assert.deepEqual(
    r.profiles[0].domains,
    ['example.com/own'],
    'P16a: se ignora el `**`, se conserva el scope (NO catch-all)',
  );
  assert.ok(hasCode(r.warnings, 'catch_all_conflict'), 'P16a: warning catch_all_conflict');
});

// ════════════════════════════════════════════════════════════════════════════
// D4 — id duplicado `(bridgeUrl, token)`: first-wins + warning (P16)
// ════════════════════════════════════════════════════════════════════════════

test('P16b_id_duplicado_scoped_primero_catch_all_ignorado', () => {
  assert.ok(rules, AUSENTE);
  // ORDEN CRÍTICO (audit §2): scoped-primero, `**`-después. El id duplicado hace
  // first-wins ⇒ la línea del `**` se descarta ANTES de poder ser catch-all:
  // el warning es `duplicate_id` (D4), NO `catch_all_conflict` (D5).
  const text = `${B} ${TOKEN_A} example.com/own\n${B} ${TOKEN_A} **\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P16b: la fusión por id duplicado ya no tumba la carga');
  assert.equal(r.profiles.length, 1, 'P16b: sólo el perfil scoped sobrevive (first-wins)');
  assert.deepEqual(r.profiles[0].domains, ['example.com/own'], 'P16b: NO es catch-all');
  assert.ok(hasCode(r.warnings, 'duplicate_id'), 'P16b: warning duplicate_id (first-wins)');
  assert.ok(
    !hasCode(r.warnings, 'catch_all_conflict'),
    'P16b: NO es catch_all_conflict (matiz D4: el duplicado actúa antes)',
  );
});

test('P16c_catch_all_exclusivo_control_positivo', () => {
  assert.ok(rules, AUSENTE);
  // Control positivo: `**` como ÚNICO token de dominio sigue siendo catch-all
  // válido; el fix de P16 no debe rechazarlo.
  const text = `${B} ${TOKEN_A} **\n${B} ${TOKEN_B} example.net/app\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P16c: `**` único token del perfil ⇒ catch-all válido');
  assert.ok(Array.isArray(r.profiles), 'P16c: texto válido ⇒ profiles es un arreglo');
  assert.equal(r.profiles.length, 2, 'P16c: ambos perfiles cargan');
});

test('P17_id_duplicado_first_wins', () => {
  assert.ok(rules, AUSENTE);
  // Control positivo inline: la línea del mismo id por sí sola carga.
  const soloA = rules.parseRules(`${B} ${TOKEN_A} example.com/a\n`);
  assert.equal(soloA.ok, true, 'P17 control: la línea del mismo id por sí sola carga');
  // Dos líneas con el MISMO (bridgeUrl, token): first-wins ⇒ se ignora la
  // línea posterior (no hay fusión ni last-wins silencioso).
  const text = `${B} ${TOKEN_A} example.com/a\n${B} ${TOKEN_A} example.com/b\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, true, 'P17: el id duplicado ya no tumba la carga');
  assert.equal(r.profiles.length, 1, 'P17: first-wins ⇒ un solo perfil');
  assert.equal(r.profiles[0].id, ID_A, 'P17: sobrevive la primera línea');
  assert.deepEqual(r.profiles[0].domains, ['example.com/a'], 'P17: se ignora la línea posterior');
  assert.ok(hasCode(r.warnings, 'duplicate_id'), 'P17: warning duplicate_id');
  // Control positivo: distinto token ⇒ distinto id ⇒ carga.
  const distintos = rules.parseRules(
    `${B} ${TOKEN_A} example.com/a\n${B} ${TOKEN_B} example.com/b\n`,
  );
  assert.equal(distintos.ok, true, 'P17 control: distinto token ⇒ distinto id ⇒ carga');
  assert.equal(distintos.profiles.length, 2, 'P17 control: dos perfiles');
});

// ════════════════════════════════════════════════════════════════════════════
// D3/C2 — token de dominio: `://` inválido (skip) vs `*` en host = glob válido
// ════════════════════════════════════════════════════════════════════════════

test('P18a_token_con_esquema_salteado_con_warning', () => {
  assert.ok(rules, AUSENTE);
  // Un token de dominio con `://` (una URL pegada como dominio) no es un host:
  // se saltea el token; la línea queda con 0 dominios ⇒ se saltea con warning.
  const r = rules.parseRules(`${B} ${TOKEN_A} https://example.com/roadmap\n`);
  assert.equal(r.ok, true, 'P18a: el token con `://` ya no tumba la carga');
  assert.equal(r.profiles.length, 0, 'P18a: el token se descarta; la línea queda sin dominios');
  assert.ok(hasCode(r.warnings, 'invalid_domain'), 'P18a: warning invalid_domain');
  assert.ok(hasCode(r.warnings, 'invalid_line'), 'P18a: warning invalid_line (línea sin dominios)');
});

test('P18b_token_con_asterisco_es_glob_valido', () => {
  assert.ok(rules, AUSENTE);
  // C2: un `*` en el medio de un label de host es un glob válido (ya no inválido).
  const r = rules.parseRules(`${B} ${TOKEN_A} exa*mple.com\n`);
  assert.equal(r.ok, true, 'P18b: `*` en el host ya no es inválido (C2: glob válido)');
  assert.equal(r.profiles.length, 1, 'P18b: el perfil carga');
  assert.deepEqual(r.profiles[0].domains, ['exa*mple.com'], 'P18b: el glob se conserva');
  assert.equal(r.error, undefined, 'P18b: sin error');
});

test('P18c_host_case_insensitive', () => {
  assert.ok(rules, AUSENTE);
  // (1) `Example.COM` es un host válido (el patrón se normaliza a lowercase).
  const r = rules.parseRules(`${B} ${TOKEN_A} Example.COM\n`);
  assert.equal(r.ok, true, 'P18c: host con mayúsculas es válido (se normaliza)');
  // (2) El matcher compara case-insensitive: patrón `Example.COM` vs URL lowercase.
  assert.equal(
    rules.matchDomain('https://example.com/x', 'Example.COM'),
    true,
    'P18c: el patrón se normaliza a lowercase ⇒ matchea',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D6/C2 — `*` en el PATH es glob válido (enmienda P18d; ya no fail-loud)
// ════════════════════════════════════════════════════════════════════════════

test('P18d_asterisco_en_path_es_glob_valido', () => {
  assert.ok(rules, AUSENTE);
  // Control discriminante: un path VÁLIDO sin `*` carga (así el cambio del texto
  // con `*` en el path solo puede provenir de la nueva gramática de glob).
  const control = rules.parseRules(`${B} ${TOKEN_A} example.com/project\n`);
  assert.equal(control.ok, true, 'P18d control: un path válido sin `*` carga');
  assert.equal(control.profiles.length, 1, 'P18d control: un solo perfil');

  // C2: un `*` en la PORCIÓN DE PATH del token es un glob válido (`example.com/**`
  // globstar, `example.com/*` glob de segmento); el perfil carga.
  for (const dominio of ['example.com/**', 'example.com/*']) {
    const r = rules.parseRules(`${B} ${TOKEN_A} ${dominio}\n`);
    assert.equal(r.ok, true, `P18d: el \`*\` en el path (${dominio}) es un glob válido`);
    assert.equal(r.profiles.length, 1, `P18d: el perfil carga (${dominio})`);
    assert.deepEqual(r.profiles[0].domains, [dominio], `P18d: el glob de path se conserva (${dominio})`);
  }
});
