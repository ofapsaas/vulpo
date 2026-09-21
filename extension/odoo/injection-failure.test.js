/**
 * injection-failure.test.js — fb-020-006-orm-diagnostics-client-health (RED).
 *
 * P13 (spec §2.4, D-3b): la construcción del mensaje de falla de inyección vive
 * en el módulo session-probe, testeable en node.
 *
 * Interfaz esperada (declarada por test-writer para el implementer):
 *   export function classifyInjectionFailure(tabId, cause) → string
 *     - tabId: number (tabId del navegador)
 *     - cause: Error | string | undefined (rechazo de executeScript o
 *       descripción de la ausencia de resultado)
 *   El mensaje empieza con "odoo_tab_unreachable:" y contiene tabId y la causa
 *   original. (Se tolera que devuelva un Error: se lee su .message.)
 *   odooRpc (background.js) hace `throw new Error(classifyInjectionFailure(...))`.
 *
 * Guard de RED (patrón de session-probe.test.js): import dinámico + assert.ok
 * del export → hoy falla por AssertionError, no por error de carga.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let mod = null;
try {
  mod = await import('./session-probe.js');
} catch {
  mod = null;
}
const classifyInjectionFailure = mod?.classifyInjectionFailure ?? null;
const unwrapRpcResult = mod?.unwrapRpcResult ?? null;

const GUARD = (fn) =>
  `session-probe.js debe exportar ${fn} (postcondición P13) — RED de fb-020-006`;

function messageOf(r) {
  if (typeof r === 'string') return r;
  if (r instanceof Error) return r.message;
  return null;
}

test('P13a: classifyInjectionFailure(24, Error) → "odoo_tab_unreachable:" + tabId + causa original', () => {
  assert.ok(typeof classifyInjectionFailure === 'function', GUARD('classifyInjectionFailure'));
  const cause = new Error('An unexpected error occurred');
  const msg = messageOf(classifyInjectionFailure(24, cause));
  assert.equal(typeof msg, 'string', `P13: debe producir un mensaje string — got: ${String(msg)}`);
  assert.ok(msg.startsWith('odoo_tab_unreachable:'), `P13: debe empezar con "odoo_tab_unreachable:" — got: ${JSON.stringify(msg)}`);
  assert.ok(msg.includes('24'), `P13: debe contener la tabId 24 — got: ${JSON.stringify(msg)}`);
  assert.ok(msg.includes('An unexpected error occurred'), `P13: debe contener la causa original — got: ${JSON.stringify(msg)}`);
});

test('P13b: classifyInjectionFailure(1931, string) → contiene tabId y la causa string sin cambios', () => {
  assert.ok(typeof classifyInjectionFailure === 'function', GUARD('classifyInjectionFailure'));
  const cause = 'Missing host permission for the tab';
  const msg = messageOf(classifyInjectionFailure(1931, cause));
  assert.equal(typeof msg, 'string', `P13: debe producir un mensaje string — got: ${String(msg)}`);
  assert.ok(msg.startsWith('odoo_tab_unreachable:'), `P13: prefijo — got: ${JSON.stringify(msg)}`);
  assert.ok(msg.includes('1931'), `P13: tabId — got: ${JSON.stringify(msg)}`);
  assert.ok(msg.includes(cause), `P13: causa original — got: ${JSON.stringify(msg)}`);
});

test('P13c: un error RPC de Odoo sigue produciendo el mensaje actual (sin odoo_tab_unreachable)', () => {
  assert.ok(typeof unwrapRpcResult === 'function', GUARD('unwrapRpcResult'));
  let err = null;
  try {
    unwrapRpcResult({
      jsonrpc: '2.0',
      error: {
        code: 200,
        message: 'Odoo Server Error',
        data: { name: 'odoo.exceptions.AccessError', message: 'You are not allowed to access Contact' },
      },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'P13: envelope con error RPC debe lanzar');
  // Mensaje actual observado antes de fb-020-006 (baseline 2026-09-17).
  assert.equal(err.message, 'Odoo Server Error', `P13: mensaje RPC sin cambios — got: ${JSON.stringify(err.message)}`);
});
