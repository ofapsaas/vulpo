/**
 * options-format-doc.test.js — fb-026-001 (P14) + fb-027-001 (P25) (RED).
 *
 * P14 de docs/specs/fb-026-001-host-path-isolation/spec.md §2.3:
 * la documentación del formato de reglas en `options.html` (label + bloque de
 * ejemplo, ~:73-94) refleja (a) entradas `host`/`host/prefijo` con frontera de
 * segmento, (b) el catch-all se escribe `**` (opt-in explícito), (c) un `*`
 * pelado es inválido — y ya NO presenta `*` como catch-all válido.
 *
 * P25 de docs/specs/fb-027-001-rules-policy-and-globs/spec.md §2.4:
 * la doc debe documentar globs `*` en host y path, `*.sufijo`, `**` catch-all,
 * el `*` pelado inválido (ignorado con aviso), y que overlap/token inválido
 * AVISAN pero la carga CONTINÚA (first-match decide) — ya NO fail-loud.
 *
 * Patrón de doc-test del proyecto (frame/odoosh-proxy-doc.test.js): aserción de
 * contenido sobre el archivo. Ubicación resuelta B-2 del test-audit (comparte el
 * runner de rules/).
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  `options.html` PREEXISTE: su ausencia es infraestructura (throw), nunca RED.
 *  El RED es de CONTENIDO: la mitad positiva exige host/prefijo, `**` y la
 *  invalidez del `*` pelado ⇒ AssertionError si el doc no se actualizó.
 *
 * ── Refuerzo del oráculo negativo (hallazgo #8, ronda de fixes) ─────────────
 *  La mitad negativa ya NO es el string único `doc.includes('YOUR_TOKEN *')`.
 *  Ahora asierta la PROPIEDAD GENERAL: ninguna línea de ejemplo promueve un `*`
 *  pelado como token de dominio (fuera de `**`/`*.sufijo`), y la doc SÍ ata el
 *  `*` pelado al fail-loud. Se auto-verifica la discriminancia del oráculo con
 *  cadenas sintéticas (detecta `YOUR_BRIDGE YOUR_TOKEN *`, no confunde `**` ni
 *  `*.sufijo`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR_TEST = path.dirname(fileURLToPath(import.meta.url));
const PATH_DOC = path.resolve(DIR_TEST, '../options.html'); // preexistente

/** Lectura fail-loud: archivo preexistente ⇒ su ausencia es infraestructura, no RED. */
function leerInfra(ruta, etiqueta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(
      `fallo de infraestructura: no se encontró ${etiqueta} en ${ruta} — ` +
        'es un archivo preexistente; su ausencia NO es RED válido',
    );
  }
  return fs.readFileSync(ruta, 'utf8');
}

test('P14_doc_formato_options_actualizada', () => {
  const doc = leerInfra(PATH_DOC, 'options.html');

  // (a) entradas host o host/prefijo con frontera de segmento.
  assert.ok(
    /host\/(prefijo|prefix|path|ruta)/i.test(doc),
    'P14(a): options.html debe documentar la forma host/prefijo (frontera de segmento)',
  );

  // (b) catch-all ** con opt-in explícito.
  assert.ok(
    doc.includes('**'),
    'P14(b): options.html debe documentar el catch-all ** (opt-in explícito)',
  );

  // (c) un * pelado es inválido / fail-loud.
  assert.ok(
    /inv[aá]lid|rechazad|no se permite|no es v[aá]lid|fail-loud/i.test(doc),
    'P14(c): options.html debe declarar que un * pelado es inválido (fail-loud)',
  );

  // ── Oráculo negativo REFORZADO (hallazgo #8 de la review) ────────────────
  // Propiedad GENERAL, no un string único: la doc NO debe promover un `*`
  // pelado como token de dominio válido, y SÍ debe atar el `*` pelado al
  // fail-loud. Un `*` pelado es un `*` que NO forma parte de `**` (catch-all)
  // ni de `*.sufijo` (comodín de subdominio); puede venir citado (`"*"`,
  // `<code>*</code>`, `(*)`), como en el estilo de la doc vieja (`"*"`).
  const STAR_PELADO = /(?<!\*)(?:^|[^\w*])\*(?![\*.\w])/; // no matchea `**` ni `*.x`
  const FAILLOUD = /inv[aá]lid|rechazad|no se permite|no es v[aá]lid|fail[- ]?loud|falla/i;
  // Texto plano: las etiquetas HTML no deben ocultar un `*` pelado del oráculo.
  const plano = doc.replace(/<[^>]*>/g, ' ');

  // (i) Discriminancia del propio oráculo (auto-test de la propiedad).
  assert.ok(
    STAR_PELADO.test('YOUR_BRIDGE YOUR_TOKEN *'),
    'P14: el oráculo debe detectar un `*` pelado como dominio (discriminante, no string único)',
  );
  assert.ok(
    STAR_PELADO.test('un "*" pelado no es válido'),
    'P14: el oráculo debe detectar un `*` pelado citado ("*")',
  );
  assert.ok(
    !STAR_PELADO.test('YOUR_BRIDGE YOUR_TOKEN **'),
    'P14: el oráculo NO debe confundir el catch-all `**` con un `*` pelado',
  );
  assert.ok(
    !STAR_PELADO.test('YOUR_BRIDGE YOUR_TOKEN *.example.com'),
    'P14: el oráculo NO debe confundir el comodín `*.sufijo` con un `*` pelado',
  );

  // (ii) Propiedad negativa: ninguna línea de ejemplo promueve un `*` pelado
  //      como token de dominio. Se identifican las líneas con forma de regla
  //      (contienen un campo bridge/token: placeholder en mayúsculas o URL
  //      http(s)) y cuyo último campo (el dominio) es exactamente `*`, salvo
  //      que la línea lo presente explícitamente como inválido (fail-loud).
  const esLineaRegla = (l) => {
    const toks = l.split(/\s+/).filter(Boolean);
    if (toks.length < 2) return false;
    return toks.some((t) => /^https?:\/\//i.test(t) || /^[A-Z][A-Z0-9_]*$/.test(t));
  };
  const promueveStarPelado = (l) => {
    const toks = l.split(/\s+/).filter(Boolean);
    if (toks.length === 0 || toks[toks.length - 1] !== '*') return false;
    if (FAILLOUD.test(l)) return false; // la línea lo declara inválido: correcto
    return esLineaRegla(l);
  };
  const lineasPromuevenStar = plano
    .split('\n')
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter(({ l }) => promueveStarPelado(l))
    .map(({ n, l }) => `L${n}: ${l}`);
  assert.deepEqual(
    lineasPromuevenStar,
    [],
    'P14: la doc NO debe promover un `*` pelado como dominio válido en ninguna línea de ejemplo',
  );

  // (iii) La doc SÍ debe atar el `*` pelado al fail-loud (no basta un lenguaje
  //       genérico de invalidez): un `*` pelado debe aparecer en las cercanías
  //       de lenguaje de fail-loud.
  let mencionaFailLoudStar = false;
  const reStar = new RegExp(STAR_PELADO.source, 'g');
  let m;
  while ((m = reStar.exec(plano)) !== null) {
    const desde = Math.max(0, m.index - 200);
    const hasta = Math.min(plano.length, m.index + 200);
    if (FAILLOUD.test(plano.slice(desde, hasta))) {
      mencionaFailLoudStar = true;
      break;
    }
  }
  assert.ok(
    mencionaFailLoudStar,
    'P14: la doc debe mencionar el fail-loud del `*` pelado (no solo un `*` como catch-all)',
  );
});

/**
 * fb-027-001 (P25) — la doc de formato refleja la política nueva (warning, no
 * fail-loud) y los globs de C2. Extiende el doc-test con 6 aserciones:
 * globs en host y path, `*.sufijo`, la política warning, "la carga continúa"
 * (first-match) y el NEGATIVO nuevo: la doc ya NO dice que la carga falla.
 *
 * Pitfall de regex: `!/bloquea la carga/i` FALLA contra "no bloquea la carga"
 * (subcadena) ⇒ el negativo usa `!/carga falla|fail[- ]?loud/i`.
 */
test('fb027_P25_doc_globs_y_politica_warning', () => {
  const doc = leerInfra(PATH_DOC, 'options.html');
  // Texto plano: las etiquetas HTML no deben ocultar un ejemplo del oráculo.
  const plano = doc.replace(/<[^>]*>/g, ' ');

  // (1) glob en el HOST (en el medio de un label) — cubre `edu-us-cert*.odoo.com`.
  assert.ok(
    /[\w-]+\*\w*\./.test(plano),
    'P25(1): la doc debe documentar un glob `*` en el host (medio de un label)',
  );

  // (2) glob en el PATH — cubre `manjaro.org/products*` / `example.com/*`.
  assert.ok(
    /\/[\w.-]*\*[\w.-]*/.test(plano),
    'P25(2): la doc debe documentar un glob `*` en el path',
  );

  // (3) forma pura `*.sufijo` (reforzar).
  assert.ok(/\*\.\w/.test(plano), 'P25(3): la doc debe documentar la forma pura `*.sufijo`');

  // (4) política de warning (aviso, no bloqueo).
  assert.ok(
    /warning|aviso|advierte|advertencia/i.test(doc),
    'P25(4): la doc debe declarar la política de warning (aviso, no bloqueo)',
  );

  // (5) la carga continúa + first-match decide.
  assert.ok(
    /contin[uú]a|no bloquea|first[- ]?match|primero que coincide|gana/i.test(doc),
    'P25(5): la doc debe declarar que la carga continúa y first-match decide',
  );

  // (6) NEGATIVO nuevo: la doc ya NO dice que la carga falla (fail-loud).
  assert.ok(
    !/carga falla|fail[- ]?loud/i.test(doc),
    'P25(6): la doc ya NO debe declarar que la carga falla (fail-loud)',
  );
});
