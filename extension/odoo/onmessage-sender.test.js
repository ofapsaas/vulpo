/**
 * onmessage-sender.test.js — fb-024-onmessage-sender (sub-fase RED).
 *
 * Verifica P1 del spec docs/specs/fb-024-onmessage-sender/spec.md (D-2):
 * tabla de verdad completa del predicado puro isExtensionPageSender.
 * Sin navegador y sin APIs de browser: el predicado es puro y recibe
 * extensionId/extensionUrlPrefix inyectados (extensionId = browser.runtime.id,
 * extensionUrlPrefix = browser.runtime.getURL('') en producción).
 *
 * ── Interfaz declarada por test-writer para el implementer ──────────────────
 * Módulo: extension/nav-guard.js (ESM, el núcleo genérico ya bundleado — D-3).
 *
 * export function isExtensionPageSender(sender, { extensionId, extensionUrlPrefix })
 *   → verdad ⇔ sender no nulo
 *            ∧ sender.id === extensionId
 *            ∧ typeof sender.url === 'string'
 *            ∧ sender.url.startsWith(extensionUrlPrefix)
 *
 *   - Fail-closed: sender null, id ausente/distinto, url no-string o
 *     extensionUrlPrefix vacío ⇒ falso.
 *   - NO se exige !sender.tab: options puede vivir en pestaña y sigue siendo
 *     página de la extensión (D-2).
 *   - No se usan frameId ni envType.
 *
 * ── Guard de RED ────────────────────────────────────────────────────────────
 * isExtensionPageSender aún no existe en nav-guard.js: import DINÁMICO con
 * catch + guard `typeof` para que el RED falle por AssertionError (un named
 * import estático de una exportación inexistente daría SyntaxError y
 * contaminaría todo el archivo). Prescripción del audit de fb-024.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let mod = null;
try {
  mod = await import('../nav-guard.js');
} catch {
  mod = null; // RED: el módulo lo crea/extend el implementer en GREEN.
}
const isExtensionPageSender = mod?.isExtensionPageSender ?? null;

const GUARD = (id, fn) =>
  `nav-guard.js debe existir y exportar ${fn} (postcondición ${id}) — RED de fb-024-onmessage-sender`;

// Identidad de la extensión bajo test (browser.runtime.id y getURL('') fakes).
const EX = '0f1fc27d-80a8-4b06-9b0e-13a3a9e97384';
const PREFIX = `moz-extension://${EX}/`;
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // otra identidad/UUID

const opts = { extensionId: EX, extensionUrlPrefix: PREFIX };

// ── P1: casos VERDADEROS ─────────────────────────────────────────────────────

test('P1: sender del popup de la extensión → verdadero', () => {
  assert.ok(typeof isExtensionPageSender === 'function', GUARD('P1', 'isExtensionPageSender'));
  const sender = { id: EX, url: `${PREFIX}popup/popup.html` };
  assert.ok(isExtensionPageSender(sender, opts), 'P1: popup de la extensión es página de la extensión');
});

test('P1: sender de options en pestaña (con tab) → verdadero', () => {
  assert.ok(typeof isExtensionPageSender === 'function', GUARD('P1', 'isExtensionPageSender'));
  const sender = { id: EX, url: `${PREFIX}options.html`, tab: { id: 2 } };
  assert.ok(
    isExtensionPageSender(sender, opts),
    'P1: options con tab sigue siendo página de la extensión (D-2: no se exige !sender.tab)'
  );
});

// ── P1: casos FALSOS (fail-closed) ───────────────────────────────────────────

const FALSE_CASES = [
  [
    'página web / script inyectado (id correcto, url de página, con tab y frameId)',
    { id: EX, url: 'https://site.example/p', tab: { id: 3 }, frameId: 0 },
    opts,
  ],
  [
    'otra extensión (id distinto, url con NUESTRO prefijo)',
    { id: OTHER, url: `${PREFIX}popup.html` },
    opts,
  ],
  [
    'otro UUID (id correcto, url con prefijo de OTRO UUID) — guarda: se compara el PREFIJO, no el esquema moz-extension://',
    { id: EX, url: `moz-extension://${OTHER}/popup.html` },
    opts,
  ],
  ['sender vacío {}', {}, opts],
  ['sender null', null, opts],
  ['url no-string (ausente)', { id: EX }, opts],
  [
    'extensionUrlPrefix vacío (fail-closed)',
    { id: EX, url: `${PREFIX}popup.html` },
    { extensionId: EX, extensionUrlPrefix: '' },
  ],
];

for (const [label, sender, useOpts] of FALSE_CASES) {
  test(`P1: ${label} → falso`, () => {
    assert.ok(typeof isExtensionPageSender === 'function', GUARD('P1', 'isExtensionPageSender'));
    assert.ok(
      !isExtensionPageSender(sender, useOpts),
      `P1: ${label} debe ser falso (fail-closed, D-2)`
    );
  });
}
