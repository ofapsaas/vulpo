/**
 * options-format-doc.test.js — fb-026-001-host-path-isolation (RED, P14).
 *
 * Verifica P14 de docs/specs/fb-026-001-host-path-isolation/spec.md §2.3:
 * la documentación del formato de reglas en `options.html` (label + bloque de
 * ejemplo, ~:73-94) refleja (a) entradas `host`/`host/prefijo` con frontera de
 * segmento, (b) el catch-all se escribe `**` (opt-in explícito), (c) un `*`
 * pelado es inválido / fail-loud — y ya NO presenta `*` como catch-all válido.
 *
 * Patrón de doc-test del proyecto (frame/odoosh-proxy-doc.test.js): aserción de
 * contenido sobre el archivo. Ubicación resuelta B-2 del test-audit (comparte el
 * runner de rules/).
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 *  `options.html` PREEXISTE: su ausencia es infraestructura (throw), nunca RED.
 *  El RED es de CONTENIDO: hoy el doc promueve `*` como catch-all
 *  (`Se puede usar "*" como dominio catch-all:` + `YOUR_TOKEN *`), no menciona
 *  `**` ni la forma `host/prefijo` ni la invalidez de `*` ⇒ AssertionError.
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

  // Ya NO presenta * como catch-all válido (el ejemplo viejo promovía `YOUR_TOKEN *`).
  assert.equal(
    doc.includes('YOUR_TOKEN *'),
    false,
    'P14: el ejemplo con * pelado como dominio catch-all debe desaparecer',
  );
});
