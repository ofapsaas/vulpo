/**
 * cargar-linea-nueva-lista-editable.test.js — fb-023-005-cargar-linea-nueva-lista-editable (RED).
 *
 * Verifica P1–P5 de docs/specs/fb-023-005-cargar-linea-nueva-lista-editable/spec.md §3.2
 * (doc-only A+C; tier único T-doc: lectura de los SKILL reales, validación estructural).
 * P6 NO se duplica acá: es un PIN del guardián Go existente
 * (`go test ./internal/docsguard -count=1`, cobertura vigente — audit C-7).
 *
 * Escrito SOLO contra el contrato del spec (§3.1 D-2..D-5, §3.2) y las condiciones
 * C-1..C-7 del test-audit.md aprobado: esta sesión NO leyó código de implementación
 * de la extensión (rol test-writer, aislamiento de fase, ADR-011). El objeto de la
 * feature es el SKILL de agent-kit; se lo leyó con shell/grep (el guard `read` niega
 * `src/**` — límite honesto PD-15, declarado como en el AUDIT). El test NO edita el
 * SKILL ni agrega fences (C-3): solo verifica su estructura/tokens.
 *
 * ── Naturaleza RED esperada (spec §5) ───────────────────────────────────────
 *  · FALLAN por AssertionError (el SKILL todavía se contradice / no documenta):
 *      P1 — "## Document lines" hoy manda `type → re-read → click option` y no
 *        nombra `expands` ni una instrucción de `pick` (audit G-1);
 *      P2 — hoy hay 3 `menuitem` (:49, :61, :469) ≠ 0 y no aparece
 *        `their own accessible role` (audit G-2);
 *      P3 — no existe la sección NUEVA de modales → falta `product configurator`
 *        + `dismiss` (audit G-3);
 *      P4 — ídem → falta `server` + `error`/`RPC_ERROR` (audit G-4);
 *      P5 — no existe la sección NUEVA de receta → faltan los anclajes ordenados
 *        + `expands` + `re-read` (audit G-5).
 *  · GUARDAS de infraestructura (C-1/C-2) — pasan en RED; si fallan es fallo de
 *    infraestructura (SKILL ausente / layout cambiado / sección preexistente
 *    borrada), NO RED válido: corren fail-loud ANTES de las aserciones RED.
 *
 * ── Condición crítica C-1 (audit §3, obligatoria) ───────────────────────────
 *  `seccion(doc, heading)` devuelve `null` si la sección NO existe (NUNCA lanza).
 *  · P1 usa una sección PREEXISTENTE (`## Document lines (many2one in a row)`):
 *    `null`/vacío ⇒ fallo de INFRAESTRUCTURA (assert.ok con mensaje de infra).
 *  · P3/P4/P5 usan secciones NUEVAS (anexadas al EOF): su ausencia ⇒
 *    `assert.ok(sec !== null, …)` = AssertionError = RED válido.
 *  Descubrimiento estructural de las secciones nuevas: todo `## …` posterior a
 *  la última sección preexistente (`## Actionable cells in list rows`, fb-023-004);
 *  el spec §3.3 manda anexar las dos secciones nuevas al EOF. NUNCA se fija el
 *  texto del heading nuevo: se identifica por sus tokens de contrato.
 *
 * ── Anclajes (spec §3.2, verbatim) ──────────────────────────────────────────
 *  P1: NO `act type`, NO `type → re-read`; SÍ `expands` + `pick`.
 *  P2: 0 `menuitem`; SÍ `role:"option"` + `their own accessible role`;
 *      conservar `never by an assumed role`.
 *  P3: `product configurator` + `dismiss`.
 *  P4: `server` + `error`/`RPC_ERROR`.
 *  P5: `Add the line` → `Open the product cell` → `Pick the option` → `Quantity`
 *      → `Save` (índice creciente, una sola vez cada uno) + `expands` + `re-read`.
 *  I-6: el test no incluye clientes, URLs ni tokens de instancia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── C-2: rutas resueltas relativas a ESTE test (patrón namedonly) ───────────

const DIR_TEST = path.dirname(fileURLToPath(import.meta.url));
const PATH_ODOO = path.resolve(DIR_TEST, '../../agent-kit/skills/vulpo-odoo-web/SKILL.md');

/** C-2: lectura fail-loud — SKILL ausente ⇒ error de infraestructura (nunca RED). */
function leerDoc(ruta, etiqueta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(
      `fallo de infraestructura (C-2): no se encontró ${etiqueta} en ${ruta} — ` +
        'cambió el layout de agent-kit/skills/*/SKILL.md respecto de extension/frame/ (fail-loud, no RED)',
    );
  }
  return fs.readFileSync(ruta, 'utf8');
}

let CACHE_DOC = null;
function docOdoo() {
  if (CACHE_DOC === null) CACHE_DOC = leerDoc(PATH_ODOO, 'vulpo-odoo-web/SKILL.md');
  return CACHE_DOC;
}

// ── Secciones: extracción por ESTRUCTURA (C-1) ──────────────────────────────

const RE_HEADING = /^## /;

/**
 * C-1: devuelve el CUERPO de la sección cuyo heading es exactamente `heading`,
 * o `null` si NO existe. NUNCA lanza (la ausencia la decide el llamador:
 * infraestructura para secciones preexistentes, AssertionError para las nuevas).
 */
function seccion(doc, heading) {
  const lineas = doc.split('\n');
  const i = lineas.findIndex((l) => l.trim() === heading.trim());
  if (i < 0) return null;
  let fin = lineas.length;
  for (let j = i + 1; j < lineas.length; j++) {
    if (RE_HEADING.test(lineas[j])) {
      fin = j;
      break;
    }
  }
  return lineas.slice(i + 1, fin).join('\n');
}

/** Todas las secciones `## …` del documento como { heading, cuerpo }, en orden. */
function secciones(doc) {
  const lineas = doc.split('\n');
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!RE_HEADING.test(lineas[i])) continue;
    let fin = lineas.length;
    for (let j = i + 1; j < lineas.length; j++) {
      if (RE_HEADING.test(lineas[j])) {
        fin = j;
        break;
      }
    }
    out.push({ heading: lineas[i], cuerpo: lineas.slice(i + 1, fin).join('\n') });
  }
  return out;
}

/**
 * Última sección PREEXISTENTE del SKILL (fb-023-004). El spec §3.3 manda anexar
 * las DOS secciones nuevas de esta feature al EOF, es decir DESPUÉS de ésta.
 * Si desaparece es infraestructura (I-1 net-zero: el GREEN no borra secciones).
 */
const HEADING_ULTIMA_PREEXISTENTE = '## Actionable cells in list rows (`actionable`, fb-023-004)';

function seccionesNuevas(doc) {
  const heads = secciones(doc);
  const i = heads.findIndex((s) => s.heading.trim() === HEADING_ULTIMA_PREEXISTENTE);
  if (i < 0) {
    throw new Error(
      `fallo de infraestructura (C-1/C-2): no se encontró la última sección preexistente ` +
        `"${HEADING_ULTIMA_PREEXISTENTE}" — el GREEN no puede eliminar secciones (I-1, net-zero); fail-loud, no RED`,
    );
  }
  return heads.slice(i + 1);
}

/**
 * Sección NUEVA (anexada tras la última preexistente) que contiene TODOS los
 * tokens dados, o `null` si no hay ninguna. La ausencia la convierte el llamador
 * en AssertionError (C-1: secciones nuevas ⇒ RED válido, no infraestructura).
 */
function seccionNuevaConTokens(doc, tokens) {
  const s = seccionesNuevas(doc).find((sec) => tokens.every((t) => sec.cuerpo.includes(t)));
  return s || null;
}

/** Cuenta ocurrencias de un literal (para la cardinalidad cerrada de P2). */
function contar(doc, literal) {
  return doc.split(literal).length - 1;
}

// ── Guardas de infraestructura (C-1 / C-2) — pasan en RED ───────────────────

test('Guarda C-2 (infraestructura): el SKILL de Odoo existe, no está vacío y conserva la última sección preexistente', () => {
  assert.ok(
    fs.existsSync(PATH_ODOO),
    `fallo de infraestructura (C-2): no se encontró vulpo-odoo-web/SKILL.md en ${PATH_ODOO} (resuelto con import.meta.url desde ${DIR_TEST})`,
  );
  const d = docOdoo();
  assert.ok(d.trim().length > 0, 'fallo de infraestructura (C-2): el SKILL está vacío');

  // Sección PREEXISTENTE de P1: su ausencia/vacío es infraestructura, no RED.
  const doclines = seccion(d, '## Document lines (many2one in a row)');
  assert.ok(
    doclines !== null,
    'fallo de infraestructura (C-1): no existe la sección preexistente "## Document lines (many2one in a row)" (P1)',
  );
  assert.ok(
    doclines.trim() !== '',
    'fallo de infraestructura (C-1): la sección preexistente "## Document lines" está vacía (P1)',
  );

  // `seccionesNuevas` no debe lanzar: la última sección preexistente está presente.
  const nuevas = seccionesNuevas(d);
  assert.ok(
    Array.isArray(nuevas),
    'fallo de infraestructura (C-1): no se pudo extraer la lista de secciones nuevas (última preexistente ausente)',
  );
});

// ── P1 (RED documental): "Document lines" deja de mandar `type` ─────────────

test('P1 (RED documental): "## Document lines (many2one in a row)" no manda `act type` ni `type → re-read`; sí `expands` + `pick`', () => {
  const d = docOdoo();
  const sec = seccion(d, '## Document lines (many2one in a row)');

  // C-1: sección PREEXISTENTE ⇒ null/vacío es INFRAESTRUCTURA (no RED válido).
  assert.ok(
    sec !== null,
    'fallo de infraestructura (C-1): no existe la sección preexistente "## Document lines (many2one in a row)"',
  );
  assert.ok(sec.trim() !== '', 'fallo de infraestructura (C-1): la sección "## Document lines" está vacía');

  // Anclas NEGATIVAS (spec §3.1 D-2): no debe mandar `type` sobre un campo de conjunto cerrado.
  assert.equal(
    sec.includes('act type'),
    false,
    'P1 (D-2): "## Document lines" no debe mandar `act type` (un campo con `expands`/`expanded` es un conjunto cerrado). RED: la contradicción sigue.',
  );
  assert.equal(
    sec.includes('type → re-read'),
    false,
    'P1 (D-2): "## Document lines" no debe conservar la receta genérica `type → re-read → click option`. RED: hoy la conserva.',
  );

  // Anclas POSITIVAS (spec §3.1 D-2): debe abrir y elegir, nombrando la señal `expands`.
  assert.ok(
    sec.includes('expands'),
    'P1 (D-2): "## Document lines" debe nombrar `expands` (señal de conjunto cerrado). RED: hoy no aparece.',
  );
  assert.ok(
    /\bpick\b/i.test(sec),
    'P1 (D-2): "## Document lines" debe incluir una instrucción de `pick` (abrir con click + frame y elegir). RED: hoy no aparece.',
  );
});

// ── P2 (RED documental): rol real de las opciones (0 `menuitem`) ────────────

test('P2 (RED documental): el SKILL de Odoo tiene 0 `menuitem`; contiene `role:"option"` y `their own accessible role`; conserva `never by an assumed role`', () => {
  const d = docOdoo();

  // Cardinalidad CERRADA (spec §3.2 P2 / C-3): exactamente 0.
  const n = contar(d, 'menuitem');
  assert.equal(
    n,
    0,
    `P2 (D-3): el SKILL de Odoo debe tener 0 ocurrencias de \`menuitem\` (audit C-6) — tiene ${n}. RED: hoy fija un rol inexistente.`,
  );

  // Rol MEDIDO documentado + la regla de resolver por el rol propio del elemento.
  assert.ok(
    d.includes('role:"option"'),
    'P2 (D-3): el SKILL debe documentar el rol medido `role:"option"` (audit C-6).',
  );
  assert.ok(
    d.includes('their own accessible role'),
    'P2 (D-3): el SKILL debe mandar leer las opciones con `their own accessible role` (no fijar un rol). RED: hoy no aparece.',
  );

  // Regla CONSERVADA (spec §3.1 D-3 / audit C-6): no elegir por un rol asumido.
  assert.ok(
    d.includes('never by an assumed role'),
    'P2 (D-3): debe conservarse la regla `never by an assumed role` (audit C-6).',
  );
});

// ── P3 (RED documental): sección nueva de modales — configurador ────────────

test('P3 (RED documental): existe una sección NUEVA de modales que documenta el configurador de producto con su descarte', () => {
  const d = docOdoo();
  const modal = seccionNuevaConTokens(d, ['product configurator']);

  // C-1: sección NUEVA ⇒ ausencia = AssertionError (RED válido).
  assert.ok(
    modal !== null,
    'P3 (D-4): falta la sección NUEVA de modales que documente el configurador de producto (`product configurator`) y su descarte. RED: la sección no existe.',
  );
  assert.ok(
    modal.cuerpo.includes('dismiss'),
    'P3 (D-4): la sección de modales debe documentar el descarte del configurador (`dismiss`). RED: hoy no existe.',
  );
});

// ── P4 (RED documental): sección nueva de modales — error de servidor ───────

test('P4 (RED documental): esa sección documenta el modal de error de servidor (`server` + `error`/`RPC_ERROR`)', () => {
  const d = docOdoo();
  const modal = seccionNuevaConTokens(d, ['product configurator']);

  // C-1: sección NUEVA ⇒ ausencia = AssertionError (RED válido).
  assert.ok(
    modal !== null,
    'P4 (D-4): falta la sección NUEVA de modales que documente el modal de error de servidor. RED: la sección no existe.',
  );
  assert.ok(
    /\bserver\b/i.test(modal.cuerpo),
    'P4 (D-4): la sección de modales debe documentar el modal de error de `server`. RED: hoy no existe.',
  );
  assert.ok(
    /(error|RPC_ERROR)/.test(modal.cuerpo),
    'P4 (D-4): debe aparecer `error`/`RPC_ERROR` (defecto server-side, no reintentar a ciegas). RED: hoy no existe.',
  );
});

// ── P5 (RED documental): sección nueva de receta con anclajes ordenados ─────

test('P5 (RED documental): existe una sección NUEVA de receta con `Add the line`→`Open the product cell`→`Pick the option`→`Quantity`→`Save` (ordenados, una vez) + `expands` + `re-read`', () => {
  const d = docOdoo();
  const receta = seccionNuevaConTokens(d, ['Add the line']);

  // C-1: sección NUEVA ⇒ ausencia = AssertionError (RED válido).
  assert.ok(
    receta !== null,
    'P5 (D-5): falta la sección NUEVA de receta "cargar una línea" (anclaje `Add the line`). RED: la sección no existe.',
  );

  const anclajes = ['Add the line', 'Open the product cell', 'Pick the option', 'Quantity', 'Save'];

  // Guarda (spec §3.2 P5): cada anclaje aparece EXACTAMENTE una vez.
  const indices = anclajes.map((a) => {
    const veces = contar(receta.cuerpo, a);
    assert.equal(
      veces,
      1,
      `P5 (D-5): el anclaje "${a}" debe aparecer EXACTAMENTE una vez en la receta — aparece ${veces}.`,
    );
    return receta.cuerpo.indexOf(a);
  });

  // Guarda (spec §3.2 P5): índice estrictamente creciente (orden de los pasos).
  for (let i = 1; i < anclajes.length; i++) {
    assert.ok(
      indices[i] > indices[i - 1],
      `P5 (D-5): "${anclajes[i]}" debe aparecer DESPUÉS de "${anclajes[i - 1]}" (índices ${indices[i - 1]} → ${indices[i]}).`,
    );
  }

  // Barreras observables de la receta (spec §3.1 D-5).
  assert.ok(
    receta.cuerpo.includes('expands'),
    'P5 (D-5): la receta debe nombrar `expands` (el many2one es un conjunto cerrado: abrir y elegir).',
  );
  assert.ok(
    receta.cuerpo.includes('re-read'),
    'P5 (D-5): la receta debe mandar `re-read` (re-leer tras agregar la fila / elegir la opción).',
  );
});
