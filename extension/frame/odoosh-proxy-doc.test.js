/**
 * odoosh-proxy-doc.test.js — fb-025-004-kit-empaquetado-docs (RED, tier T-doc).
 *
 * Verifica P4/P5/P6/P10 de docs/specs/fb-025-004-kit-empaquetado-docs/spec.md
 * §3.5/§3.6 y las condiciones C-1/C-2/C-3/C-13/C-14/C-15 del test-audit.md aprobado.
 *
 * Escrito SOLO contra el contrato del spec (headings verbatim + anclajes por
 * sección). Esta sesión (rol test-writer, aislamiento de fase, ADR-011) NO leyó
 * la implementación Go del proxy ni código de producto: el test SOLO lee docs
 * (I-12). El guard `read` niega `src/**`; los docs/scripts de harness se leyeron
 * con shell (límite honesto PD-15, declarado como en el AUDIT).
 *
 * ── Naturaleza RED esperada (spec §3.3 / audit §4.3) ────────────────────────
 *  · FALLAN por AssertionError (el doc NUEVO todavía no existe):
 *      P4 — `src/docs/odoosh-proxy.md` ausente ⇒ AssertionError (C-1);
 *      P5 — idem ⇒ no hay secciones para los anclajes;
 *      P6 — README/getting-started todavía no mencionan el proxy;
 *      P10 — idem ⇒ no hay doc que inspeccionar.
 *  · GUARDA de infraestructura: README.md y getting-started.md PREEXISTEN;
 *    su ausencia es infraestructura (throw), nunca RED (C-3).
 *
 * ── Condición crítica C-1 (bloqueante) ──────────────────────────────────────
 *  El doc `src/docs/odoosh-proxy.md` es NUEVO: su ausencia DEBE producir
 *  AssertionError (RED válido), NUNCA un throw de infraestructura. Helper
 *  partido: `docNuevo()` → `null` si falta; `leerInfra()` → throw si falta.
 *
 * ── Anclajes (spec §3.5, verbatim) — se buscan EN EL CUERPO de su sección (C-2) ─
 *  I-6/I-7: el test no incluye clientes, URLs de instancia ni tokens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Rutas resueltas relativas a ESTE test (import.meta.url) ─────────────────

const DIR_TEST = path.dirname(fileURLToPath(import.meta.url));
const PATH_DOC = path.resolve(DIR_TEST, '../../docs/odoosh-proxy.md'); // NUEVO
const PATH_README = path.resolve(DIR_TEST, '../../README.md'); // preexistente
const PATH_GETTING_STARTED = path.resolve(DIR_TEST, '../../docs/getting-started.md'); // preexistente

// ── Helpers ─────────────────────────────────────────────────────────────────

/** C-3: lectura fail-loud para archivos PREEXISTENTES (su ausencia = infraestructura). */
function leerInfra(ruta, etiqueta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(
      `fallo de infraestructura (C-3): no se encontró ${etiqueta} en ${ruta} — ` +
        'es un archivo preexistente; su ausencia NO es RED válido (fail-loud, no AssertionError)',
    );
  }
  return fs.readFileSync(ruta, 'utf8');
}

/**
 * C-1 (bloqueante): el doc del proxy es NUEVO. Devuelve su contenido o `null`
 * si falta. NUNCA lanza: la ausencia la convierte el llamador en AssertionError
 * (RED válido), no en throw de infraestructura.
 */
function docNuevo() {
  if (!fs.existsSync(PATH_DOC)) return null;
  return fs.readFileSync(PATH_DOC, 'utf8');
}

const RE_HEADING = /^## /;

/**
 * C-2: devuelve el CUERPO de la sección cuyo heading es exactamente `heading`,
 * o `null` si NO existe. NUNCA lanza.
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

/**
 * C-13 / §3.5.1.5: recorre el doc separando los headings reales de los que
 * aparecen DENTRO de bloques de código (fences ```). El extractor corta en
 * `^## `; un `## ` dentro de un fence rompería el orden/unicidad. Devuelve
 * `{ headings, enFence }`.
 */
function headingsSegunFences(doc) {
  const headings = [];
  const enFence = [];
  let fence = false;
  for (const l of doc.split('\n')) {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      continue;
    }
    if (RE_HEADING.test(l)) {
      if (fence) enFence.push(l.trim());
      else headings.push(l.trim());
    }
  }
  return { headings, enFence };
}

// ── Wire pineado (spec §3.5, verbatim) ──────────────────────────────────────

/** Los 9 headings, en este orden. */
const HEADINGS = [
  '## What it is',
  '## Requirements',
  '## Build',
  '## Install',
  '## Run as a user service',
  '## Point odoosh-mcp at the proxy',
  '## Configuration',
  '## Health',
  '## Troubleshooting',
];

/** Anclajes obligatorios por sección (spec §3.5) — se buscan en el cuerpo (C-2). */
const ANCHORS = {
  '## What it is': ['vlp-odoosh-proxy', 'odoosh-mcp', 'odoo.sh', 'vlp_eval'],
  '## Requirements': ['Go 1.24', '0600', 'systemd', 'Firefox', 'Build'],
  '## Build': ['build-agent-kit.sh', 'CGO_ENABLED=0', 'GOOS=linux', 'GOARCH=amd64', 'go test ./...'],
  '## Install': ['install.sh', '~/.local/bin/vlp-odoosh-proxy', '0755'],
  '## Run as a user service': ['vlp-odoosh-proxy.service', 'systemctl --user', '%h'],
  '## Point odoosh-mcp at the proxy': [
    'session add',
    '--base-url',
    '127.0.0.1:8899',
    'set-default',
    'placeholder',
    'write_scope',
  ],
  '## Configuration': [
    'VLP_PROXY_BIND',
    'VLP_PROXY_PORT',
    'VLP_URL',
    'VLP_TOKEN_FILE',
    'VLP_TAB_URL_PREFIX',
    'VLP_EVAL_TAB',
    'VLP_EVAL_TIMEOUT',
    '~/.config/vulpo/token',
  ],
  '## Health': ['/healthz', '/readyz', '{"status":"ok"}'],
  '## Troubleshooting': ['go test', '0600', 'Plan'],
};

// ── Guarda de infraestructura (C-3) — pasa en RED ───────────────────────────

test('Guarda C-3 (infraestructura): README.md y getting-started.md existen y no están vacíos', () => {
  const readme = leerInfra(PATH_README, 'README.md');
  const gettingStarted = leerInfra(PATH_GETTING_STARTED, 'docs/getting-started.md');
  assert.ok(readme.trim().length > 0, 'fallo de infraestructura (C-3): README.md está vacío');
  assert.ok(
    gettingStarted.trim().length > 0,
    'fallo de infraestructura (C-3): docs/getting-started.md está vacío',
  );
});

// ── P4 (RED estructural): el doc NUEVO existe con los 9 headings verbatim ───

test('P4 (RED): src/docs/odoosh-proxy.md existe, no vacío, con los 9 headings verbatim, únicos y en orden', () => {
  const doc = docNuevo();

  // C-1: doc NUEVO ⇒ ausencia = AssertionError (RED válido), NUNCA throw.
  assert.ok(
    doc !== null,
    'P4 (C-1): no existe src/docs/odoosh-proxy.md — el doc es NUEVO, su ausencia es RED válido (AssertionError), no infraestructura.',
  );
  assert.ok(doc.trim().length > 0, 'P4: src/docs/odoosh-proxy.md existe pero está vacío.');

  const { headings, enFence } = headingsSegunFences(doc);

  // C-13 / §3.5.1.5: sin `## ` dentro de bloques de código.
  assert.equal(
    enFence.length,
    0,
    `P4 (C-13): hay ${enFence.length} heading(s) \`## \` DENTRO de bloques de código (el extractor corta en ^## ): ${JSON.stringify(enFence)}`,
  );

  // Cada heading aparece EXACTAMENTE una vez y en el orden de §3.5.
  const indices = HEADINGS.map((h) => {
    const veces = headings.filter((x) => x === h).length;
    assert.equal(
      veces,
      1,
      `P4: el heading "${h}" debe aparecer EXACTAMENTE una vez — aparece ${veces}.`,
    );
    return headings.indexOf(h);
  });
  for (let i = 1; i < HEADINGS.length; i++) {
    assert.ok(
      indices[i] > indices[i - 1],
      `P4: "${HEADINGS[i]}" debe aparecer DESPUÉS de "${HEADINGS[i - 1]}" (índices ${indices[i - 1]} → ${indices[i]}).`,
    );
  }
});

// ── P5 (RED wire): anclajes por sección (C-2) ───────────────────────────────

test('P5 (RED): cada sección contiene sus anclajes obligatorios (buscados en el cuerpo de la sección, C-2)', () => {
  const doc = docNuevo();

  // C-1: doc NUEVO ⇒ ausencia = AssertionError (RED válido).
  assert.ok(
    doc !== null,
    'P5 (C-1): no existe src/docs/odoosh-proxy.md — no hay secciones para verificar los anclajes (RED válido).',
  );

  for (const [heading, anclajes] of Object.entries(ANCHORS)) {
    const cuerpo = seccion(doc, heading);
    assert.ok(
      cuerpo !== null,
      `P5: falta la sección "${heading}" (el doc debe tener los 9 headings de §3.5).`,
    );
    for (const ancla of anclajes) {
      assert.ok(
        cuerpo.includes(ancla),
        `P5 (C-2): la sección "${heading}" debe contener el anclaje "${ancla}" EN SU CUERPO (no global).`,
      );
    }
  }
});

// ── P6 (RED wire): README y getting-started actualizados ────────────────────

test('P6 (RED): README.md menciona vlp-odoosh-proxy y odoosh-proxy.md; getting-started.md enlaza odoosh-proxy.md', () => {
  // C-3: preexistentes ⇒ su ausencia es infraestructura (throw), no RED.
  const readme = leerInfra(PATH_README, 'README.md');
  const gettingStarted = leerInfra(PATH_GETTING_STARTED, 'docs/getting-started.md');

  assert.ok(
    readme.includes('vlp-odoosh-proxy'),
    'P6: README.md debe mencionar `vlp-odoosh-proxy` (tabla de componentes).',
  );
  assert.ok(
    readme.includes('odoosh-proxy.md'),
    'P6: README.md debe mencionar `odoosh-proxy.md`.',
  );
  assert.ok(
    gettingStarted.includes('odoosh-proxy.md'),
    'P6: docs/getting-started.md debe enlazar `odoosh-proxy.md`.',
  );
});

// ── P10 (RED higiene): sin URLs de instancia ni tokens ──────────────────────

test('P10 (RED): el doc no contiene URLs de instancia ni patrones hex de token (C-15)', () => {
  const doc = docNuevo();

  // C-1: doc NUEVO ⇒ ausencia = AssertionError (RED válido).
  assert.ok(
    doc !== null,
    'P10 (C-1): no existe src/docs/odoosh-proxy.md — no hay doc que auditar (RED válido).',
  );

  // C-15: prohibido el path de instancia; `https://www.odoo.sh` (sin /project/) sí está permitido.
  assert.equal(
    doc.includes('https://www.odoo.sh/project/'),
    false,
    'P10 (C-15): el doc no debe contener URLs de instancia `https://www.odoo.sh/project/…`.',
  );

  // C-15: patrón hex largo (token de 32+ chars).
  const hex = doc.match(/\b[0-9a-fA-F]{32,}\b/);
  assert.equal(
    hex,
    null,
    `P10 (C-15): el doc no debe contener un patrón hex de token (≥32) — encontrado: ${hex && hex[0]}.`,
  );
});
