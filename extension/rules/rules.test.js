/**
 * rules.test.js — fb-026-001-host-path-isolation (RED, seam puro).
 *
 * Verifica P1–P13 y P15 (Enmienda 2, §2.7) de
 * docs/specs/fb-026-001-host-path-isolation/spec.md §2.1/§2.2/§2.3/§2.7
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

// ── D2 — fail-loud de líneas malformadas (Enmienda 2 / P15, spec §2.7) ───────
// Una línea que NO es comentario (#), NO es vacía/whitespace, NO es el sentinel
// `* None`, y NO es un perfil válido de ≥3 partes (bridgeUrl http(s) válida,
// token no vacío, ≥1 token de dominio) hace FALLAR VISIBLE la carga:
// `{ok:false, error}` y CERO perfiles del texto (atomicidad, P9). No hay
// descarte silencioso de líneas malformadas.

test('P15a_linea_corta_no_sentinel_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  const VALIDA = `${B} ${TOKEN_A} example.com/project\n`;
  // (control) la línea válida por sí sola carga: así el "no registrada" del
  // texto combinado es discriminante (todo-o-nada), no un falso positivo.
  const control = rules.parseRules(VALIDA);
  assert.equal(control.ok, true, 'P15a control: la línea válida por sí sola carga');
  assert.equal(control.profiles.length, 1, 'P15a control: un solo perfil');

  // Línea de 2 partes que NO es el sentinel `* None` (aquí `https://b T`):
  // no es comentario, no es vacía, no es sentinel ni un perfil de ≥3 partes.
  const r = rules.parseRules(`https://b T\n${VALIDA}`);
  assert.equal(
    r.ok,
    false,
    'P15a: línea de <3 partes no-sentinel ⇒ la carga debe fallar visible (fail-loud)',
  );
  assert.equal(typeof r.error, 'string', 'P15a: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P15a: el error es un string no vacío');
  assert.equal(
    r.profiles,
    undefined,
    'P15a (atomicidad R-8, todo-o-nada): ni la línea válida del mismo texto se registra',
  );
});

test('P15b_bridgeurl_invalida_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  const VALIDA = `${B} ${TOKEN_A} example.com/project\n`;
  const control = rules.parseRules(VALIDA);
  assert.equal(control.ok, true, 'P15b control: la línea válida por sí sola carga');
  assert.equal(control.profiles.length, 1, 'P15b control: un solo perfil');

  // 3 partes, token no vacío, ≥1 token de dominio — pero bridgeUrl NO es http(s)
  // válida. El dominio del perfil malformado (example.org) es distinto del de la
  // línea válida (example.com), para que el fallo solo pueda provenir de P15 y no
  // de un solape entre perfiles.
  const r = rules.parseRules(`notaurl T example.org\n${VALIDA}`);
  assert.equal(
    r.ok,
    false,
    'P15b: bridgeUrl inválida (no http(s)) ⇒ la carga debe fallar visible (fail-loud)',
  );
  assert.equal(typeof r.error, 'string', 'P15b: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P15b: el error es un string no vacío');
  assert.equal(
    r.profiles,
    undefined,
    'P15b (atomicidad R-8, todo-o-nada): ni la línea válida del mismo texto se registra',
  );
});

// ── D2 — composición de perfiles y forma del token (Enmienda 3 / P16–P18) ───
// spec §2.8: (P16) un perfil es catch-all SOLO si `**` es su único token de
// dominio; (P17) dos líneas con el mismo (bridgeUrl, token) ⇒ id duplicado
// fail-loud, sin fusión silenciosa; (P18) el token de dominio debe ser un host
// válido (host o `*.suffix` con path opcional), comparado case-insensitive.
// Todo error ⇒ `{ok:false, error}` no vacío y CERO perfiles (atomicidad R-8).

test('P16a_catch_all_mezclado_en_misma_linea_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  // Un mismo perfil con `**` + un token con scope (misma línea) NO es un
  // catch-all puro: el operador nunca aprobó esa amplitud ⇒ fail-loud.
  const r = rules.parseRules(`${B} ${TOKEN_A} ** example.com/own\n`);
  assert.equal(
    r.ok,
    false,
    'P16a: `**` mezclado con un dominio con scope en la misma línea ⇒ falla visible',
  );
  assert.equal(typeof r.error, 'string', 'P16a: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P16a: el error es un string no vacío');
  assert.equal(r.profiles, undefined, 'P16a (atomicidad R-8): cero perfiles del texto rechazado');
});

test('P16b_catch_all_por_fusion_de_lineas_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  // Dos líneas del MISMO (bridgeUrl, token): una con scope y otra `**`. La
  // fusión (unión) convertiría el perfil en catch-all silencioso ⇒ fail-loud.
  const text = `${B} ${TOKEN_A} example.com/own\n${B} ${TOKEN_A} **\n`;
  const r = rules.parseRules(text);
  assert.equal(
    r.ok,
    false,
    'P16b: `**` fusionado con un dominio con scope en el mismo id ⇒ falla visible',
  );
  assert.equal(typeof r.error, 'string', 'P16b: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P16b: el error es un string no vacío');
  assert.equal(r.profiles, undefined, 'P16b (atomicidad R-8): cero perfiles del texto rechazado');
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

test('P17_id_duplicado_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  // Control positivo inline (patrón P15a): cada línea por separado carga, así el
  // "no registrada" del texto combinado es discriminante (todo-o-nada).
  const soloA = rules.parseRules(`${B} ${TOKEN_A} example.com/a\n`);
  assert.equal(soloA.ok, true, 'P17 control: la línea del mismo id por sí sola carga');
  // Dos líneas con el MISMO (bridgeUrl, token) ⇒ id duplicado. No hay fusión
  // silenciosa (unión) ni last-wins silencioso ⇒ fail-loud.
  const text = `${B} ${TOKEN_A} example.com/a\n${B} ${TOKEN_A} example.com/b\n`;
  const r = rules.parseRules(text);
  assert.equal(r.ok, false, 'P17: id (bridgeUrl|token) duplicado ⇒ falla visible');
  assert.equal(typeof r.error, 'string', 'P17: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P17: el error es un string no vacío');
  assert.equal(r.profiles, undefined, 'P17 (atomicidad R-8): cero perfiles del texto rechazado');
  // Control positivo: distinto token ⇒ distinto id ⇒ carga.
  const distintos = rules.parseRules(
    `${B} ${TOKEN_A} example.com/a\n${B} ${TOKEN_B} example.com/b\n`,
  );
  assert.equal(distintos.ok, true, 'P17 control: distinto token ⇒ distinto id ⇒ carga');
  assert.equal(distintos.profiles.length, 2, 'P17 control: dos perfiles');
});

test('P18a_token_con_esquema_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  // Un token de dominio con `://` (una URL pegada como dominio) no es un host
  // válido: el perfil no reclamaría ninguna URL ⇒ fail-loud, no perfil muerto.
  const r = rules.parseRules(`${B} ${TOKEN_A} https://example.com/roadmap\n`);
  assert.equal(r.ok, false, 'P18a: token de dominio con `://` ⇒ falla visible');
  assert.equal(typeof r.error, 'string', 'P18a: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P18a: el error es un string no vacío');
  assert.equal(r.profiles, undefined, 'P18a (atomicidad R-8): cero perfiles del texto rechazado');
});

test('P18b_token_con_asterisco_invalido_fail_loud', () => {
  assert.ok(rules, AUSENTE);
  // Un `*` que no es el catch-all `**` ni el comodín `*.` al inicio es un token
  // imposible (el comodín de subdominio solo vale como `*.` al inicio).
  const r = rules.parseRules(`${B} ${TOKEN_A} exa*mple.com\n`);
  assert.equal(r.ok, false, 'P18b: `*` fuera de `**`/`*.` ⇒ falla visible');
  assert.equal(typeof r.error, 'string', 'P18b: el rechazo lleva un error');
  assert.ok(r.error.length > 0, 'P18b: el error es un string no vacío');
  assert.equal(r.profiles, undefined, 'P18b (atomicidad R-8): cero perfiles del texto rechazado');
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
