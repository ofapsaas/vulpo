/**
 * language-convention.test.js — fb-020-002-type-commit-cycle (sub-fase RED, 3.1).
 *
 * Verifica P15–P17 del spec docs/specs/fb-020-002-type-commit-cycle/spec.md §3.3
 * contra el export nuevo `languageConvention(info, langRecords) → object` de
 * `session-probe.js` (§2.1). `versionResult` no cambia (fuera de alcance de
 * este archivo). Archivo nuevo por AC-4 (sólo `A` en los archivos `*.test.js`
 * bajo `extension/`, test-audit.md §0/§6); nombres con prefijo `fb-020-002` para no colisionar
 * con `P16a–c` de fb-019-002 en session-probe.test.js.
 *
 * ── Guard pattern de RED ─────────────────────────────────────────────────
 * `session-probe.js` ya existe (fb-019-001/002), pero `languageConvention`
 * todavía no está exportada: el import estático del módulo no rompe, pero
 * `probe.languageConvention` es `undefined`. Cada test abre con
 * `assert.equal(typeof probe.languageConvention, 'function', ...)`, que
 * falla por AssertionError (razón correcta) hasta que GREEN la agregue.
 *
 * ── Fuente de verdad ─────────────────────────────────────────────────────
 * §2.2 "get_version" (presencia opcional, nunca `null`), §3.3 P15–P17, §5 I-8.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as probe from './session-probe.js';

/** I-8 / P17: en ningún caso una clave del resultado vale null ni undefined. */
function assertNoNullishValues(obj, message) {
  for (const [key, value] of Object.entries(obj)) {
    assert.notEqual(value, null, `${message}: la clave "${key}" no debe ser null`);
    assert.notEqual(value, undefined, `${message}: la clave "${key}" no debe ser undefined`);
  }
}

// ── P15 ──────────────────────────────────────────────────────────────────

test('fb-020-002 P15 lang + decimal_point + thousands_sep exactos con un registro válido', () => {
  assert.equal(
    typeof probe.languageConvention,
    'function',
    'languageConvention no exportada (RED)',
  );

  const info = { user_context: { lang: 'es_ES' } };
  const langRecords = [{ decimal_point: ',', thousands_sep: '.' }];

  const result = probe.languageConvention(info, langRecords);

  assert.deepStrictEqual(result, { lang: 'es_ES', decimal_point: ',', thousands_sep: '.' });
  assertNoNullishValues(result, 'P15 (thousands_sep normal)');
});

test('fb-020-002 P15 thousands_sep vacío se incluye como cadena vacía', () => {
  assert.equal(
    typeof probe.languageConvention,
    'function',
    'languageConvention no exportada (RED)',
  );

  const info = { user_context: { lang: 'es_ES' } };
  const langRecords = [{ decimal_point: ',', thousands_sep: '' }];

  const result = probe.languageConvention(info, langRecords);

  assert.deepStrictEqual(result, { lang: 'es_ES', decimal_point: ',', thousands_sep: '' });
  assertNoNullishValues(result, 'P15 (thousands_sep vacío)');
});

// ── P16 ──────────────────────────────────────────────────────────────────

test('fb-020-002 P16 lang válido pero lectura de res.lang no utilizable devuelve exactamente {lang}', () => {
  assert.equal(
    typeof probe.languageConvention,
    'function',
    'languageConvention no exportada (RED)',
  );

  const info = { user_context: { lang: 'es_ES' } };
  const casosLangRecords = [
    ['undefined', undefined],
    ['null', null],
    ['[] (sin registros)', []],
    ['dos registros', [
      { decimal_point: ',', thousands_sep: '.' },
      { decimal_point: '.', thousands_sep: ',' },
    ]],
    ['decimal_point ausente', [{ thousands_sep: '.' }]],
    ['decimal_point vacío', [{ decimal_point: '', thousands_sep: '.' }]],
    ['decimal_point no string', [{ decimal_point: 1, thousands_sep: '.' }]],
    ['thousands_sep no string', [{ decimal_point: ',', thousands_sep: 1 }]],
  ];

  for (const [descripcion, langRecords] of casosLangRecords) {
    const result = probe.languageConvention(info, langRecords);
    assert.deepStrictEqual(
      result,
      { lang: 'es_ES' },
      `P16 caso "${descripcion}" debe devolver exactamente {lang}`,
    );
    assertNoNullishValues(result, `P16 caso "${descripcion}"`);
  }
});

// ── P17 ──────────────────────────────────────────────────────────────────

test('fb-020-002 P17 sin user_context o lang inválido devuelve {} y ninguna clave es null/undefined', () => {
  assert.equal(
    typeof probe.languageConvention,
    'function',
    'languageConvention no exportada (RED)',
  );

  const langRecords = [{ decimal_point: ',', thousands_sep: '.' }];
  const casosInfo = [
    ['sin user_context', {}],
    ['lang ausente', { user_context: {} }],
    ['lang vacío', { user_context: { lang: '' } }],
    ['lang no string', { user_context: { lang: 42 } }],
  ];

  for (const [descripcion, info] of casosInfo) {
    const result = probe.languageConvention(info, langRecords);
    assert.deepStrictEqual(result, {}, `P17 caso "${descripcion}" debe devolver {}`);
    assertNoNullishValues(result, `P17 caso "${descripcion}"`);
  }
});
