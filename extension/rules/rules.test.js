/**
 * rules.test.js — fb-026-001-host-path-isolation (RED, seam puro).
 *
 * Verifica P1–P13 de docs/specs/fb-026-001-host-path-isolation/spec.md §2.1/§2.2/§2.3
 * y el mapeo test↔postcondición del test-audit.md aprobado (§3).
 *
 * Escrito SOLO contra el contrato del spec (firma del seam §2.1 + semántica §2.2 +
 * postcondiciones §2.3). Esta sesión (rol test-writer, aislamiento de fase, ADR-011)
 * NO leyó implementación: `src/extension/rules/rules.js` no existe aún y los call
 * sites del background quedan a review (§2.4). Los tests ejercitan el contrato
 * observable de los TRES exports del seam.
 *
 * ── Naturaleza RED esperada (requisito R-7) ─────────────────────────────────
 *  `rules.js` NO existe. Un `import` estático fallaría con ERR_MODULE_NOT_FOUND
 *  (throw) — eso NO es RED válido. Por eso el módulo se carga de forma
 *  CONTROLADA (patrón C-1 de frame/odoosh-proxy-doc.test.js): un `import()`
 *  dinámico cuyo rechazo se mapea a `rules = null`. CADA test empieza con
 *  `assert.ok(rules, ...)`, así el fallo es AssertionError (no ImportError).
 *
 * ── Oráculos discriminantes (deuda histórica R-8) ───────────────────────────
 *  P5/P8b/P9 pinean `ok:false` **y** la ausencia de perfiles (`profiles`
 *  undefined): no basta "no lanzó". La atomicidad (P9) es observable en el
 *  objeto retornado — el seam es puro, no muta estado global.
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

// ── D1 — scoping host+path ──────────────────────────────────────────────────

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

// ── D2 — fail-loud en la carga de perfiles ──────────────────────────────────

test('P5a_solape_mismo_host_path', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} example.com/project\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, false, 'P5a: dos perfiles con el mismo host/path deben fallar visible');
  assert.equal(r.profiles, undefined, 'P5a (atomicidad R-8): cero perfiles del texto rechazado');
});

test('P5b_solape_host_sin_path', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} example.com\n${B} ${TOKEN_B} example.com/project\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, false, 'P5b: host sin path solapa con host/prefijo ⇒ falla visible');
  assert.equal(r.profiles, undefined, 'P5b (atomicidad R-8): cero perfiles del texto rechazado');
});

test('P5c_solape_wildcard_vs_host_y_prefijos_anidados', () => {
  assert.ok(rules, AUSENTE);
  // (i) comodín de subdominio (más ápice) vs host exacto del sufijo.
  const tWild = `${B} ${TOKEN_A} *.example.com\n${B} ${TOKEN_B} example.com\n`;
  const rWild = rules.parseRules(tWild);
  assert.equal(rWild.ok, false, 'P5c: *.sufijo solapa con el ápice ⇒ falla visible');
  assert.equal(rWild.profiles, undefined, 'P5c (atomicidad R-8): cero perfiles del texto rechazado');
  // (ii) prefijos anidados.
  const tNested = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} example.com/project/sub\n`;
  const rNested = rules.parseRules(tNested);
  assert.equal(rNested.ok, false, 'P5c: prefijos anidados solapan ⇒ falla visible');
  assert.equal(
    rNested.profiles,
    undefined,
    'P5c (atomicidad R-8): cero perfiles del texto rechazado',
  );
});

test('P6_asterisco_pelado_rechazado', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules(`${B} ${TOKEN_A} *\n`);
  assert.equal(r.ok, false, 'P6: un * pelado debe fallar visible');
  assert.equal(typeof r.error, 'string', 'P6: el rechazo lleva un error');
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

test('P8b_dos_doble_asterisco_rechazado', () => {
  assert.ok(rules, AUSENTE);
  const text = `${B} ${TOKEN_A} **\n${B} ${TOKEN_B} **\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, false, 'P8b: a lo sumo un ** por config; dos ⇒ falla visible');
  assert.equal(r.profiles, undefined, 'P8b (atomicidad R-8): cero perfiles del texto rechazado');
});

test('P9_atomicidad_texto_invalido', () => {
  assert.ok(rules, AUSENTE);
  // Una línea válida + una inválida (* pelado): no debe haber aplicación parcial.
  const text = `${B} ${TOKEN_A} example.com/project\n${B} ${TOKEN_B} *\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, false, 'P9: el texto inválido falla completo');
  assert.equal(
    r.profiles,
    undefined,
    'P9: ningún perfil del texto inválido se registra (sin aplicación parcial)',
  );
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

test('P11_error_observable_en_el_seam', () => {
  assert.ok(rules, AUSENTE);
  const r = rules.parseRules(`${B} ${TOKEN_A} *\n`);
  assert.equal(r.ok, false, 'P11: texto inválido ⇒ ok:false');
  assert.equal(typeof r.error, 'string', 'P11: el error se produce y se retorna (no se traga)');
  assert.ok(r.error.length > 0, 'P11: el error es un string no vacío');
});

// ── D3 — consistencia asignación ↔ guard (vía el seam, spec §2.4) ───────────

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
