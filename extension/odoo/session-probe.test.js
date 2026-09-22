/**
 * session-probe.test.js — fb-019-001-fix-no-odoo-tab (sub-fase RED).
 *
 * Verifica P1–P7 del spec docs/specs/fb-019-001-fix-no-odoo-tab/spec.md contra
 * la superficie pineada §9.1 + §9.1bis (6 exports con firmas exactas):
 * probeRequest, classifyProbeResponse, aggregateDetection, rpcRequest,
 * versionResult, unwrapRpcResult. Sin DOM: node:test puro (spec §3); la
 * frontera de red se ejercita vía las funciones constructoras del wire (los
 * fetch reales son la frontera externa del service worker, fuera de alcance).
 *
 * ── Guard pattern de RED (por qué el import es dinámico) ────────────────────
 * El módulo `session-probe.js` NO existe todavía (lo escribe el implementer en
 * GREEN — para esta fase no existe). Un `import './session-probe.js'` estático
 * rompería la CARGA de todo el archivo (error de resolución, que el gate
 * rechaza como RED inválido). Por eso se carga con catch → null y CADA test
 * abre con `assert.ok(fn, GUARD(...))`: hoy TODOS los tests fallan por
 * AssertionError (ERR_ASSERTION) por la razón correcta (el comportamiento no
 * existe), y cuando GREEN cree el módulo pasan a ejercitar el contrato real.
 * Patrón replicado de frame/settle.test.js:62-71 (fb-018-006); anti-verde-vacuo
 * analizado en test-audit.md §4.1.
 *
 * ── Fuente de verdad ────────────────────────────────────────────────────────
 * Wire §2.1 (POST JSON-RPC a get_session_info), tabla de clasificación §2.2
 * (6 casos medidos en vivo 2026-09-09), agregación §2.3, mapping §2.4,
 * no-regresión odooRpc/unwrap §2.5, invariantes I-1/I-2/I-3. Los literales de
 * estado son EXACTOS (§9.1): 'valid' | 'expired' | 'detection-failed'.
 * El shape de perfil de 8 campos (P5d) está congelado en Go
 * (odooregistry_test.go:67-91) — el test se ALINEA, no lo redefinir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Guard de RED: el módulo todavía no existe ───────────────────────────────
let mod = null;
try {
  mod = await import('./session-probe.js');
} catch {
  mod = null; // RED: el import falla hasta que GREEN cree el módulo.
}
const probeRequest = mod?.probeRequest ?? null;
const classifyProbeResponse = mod?.classifyProbeResponse ?? null;
const aggregateDetection = mod?.aggregateDetection ?? null;
const rpcRequest = mod?.rpcRequest ?? null;
const versionResult = mod?.versionResult ?? null;
const unwrapRpcResult = mod?.unwrapRpcResult ?? null;

const GUARD = (id, fn) =>
  `session-probe.js debe existir y exportar ${fn} (postcondición ${id}) — RED de fb-019-001`;

// ── fixtures sintéticos (observaciones de frontera, spec §9.1) ──────────────

// §2.2 caso 1: envelope result de get_session_info con sesión válida real.
const VALID_INFO = {
  uid: 2,
  username: 'admin',
  db: 'demo',
  server_version: '19.0',
  is_superuser: true,
  user_context: {},
};

// Entrada válida para aggregateDetection (shape de input §9.1: {tabId, state, info?, url?}).
const VALID_ENTRY = {
  tabId: 5,
  state: 'valid',
  url: 'https://edu.example.com/web#action=menu',
  info: { ...VALID_INFO },
};

// Parseo defensivo del body: si GREEN lo emite no-JSON, el fallo debe ser
// AssertionError con captura, no TypeError de JSON.parse.
function parseBody(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── P1: wire de la sonda de sesión (spec §2.1) ──────────────────────────────

test('P1 (§2.1): probeRequest emite POST JSON-RPC exacto a /web/session/get_session_info', () => {
  assert.ok(probeRequest, GUARD('P1', 'probeRequest'));
  const req = probeRequest();
  const captura = JSON.stringify(req);
  assert.equal(
    req.url,
    '/web/session/get_session_info',
    `P1: url debe ser /web/session/get_session_info — captura completa: ${captura}`
  );
  assert.equal(
    req.init?.method,
    'POST',
    `P1: method debe ser POST (el defecto actual es GET implícito por omitir method) — captura completa: ${captura}`
  );
  assert.equal(
    req.init?.headers?.['Content-Type'],
    'application/json',
    `P1: header Content-Type: application/json requerido (su ausencia causa el 415) — captura completa: ${captura}`
  );
  assert.equal(
    req.init?.credentials,
    'include',
    `P1: credentials: 'include' (cookie de sesión) — captura completa: ${captura}`
  );
  assert.equal(
    typeof req.init?.body,
    'string',
    `P1: body debe ser string JSON — captura completa: ${captura}`
  );
  const body = parseBody(req.init?.body);
  assert.ok(
    body,
    `P1: body no es JSON parseable — captura completa: ${captura}`
  );
  assert.equal(
    body.jsonrpc,
    '2.0',
    `P1: envelope jsonrpc "2.0" — body: ${JSON.stringify(body)}`
  );
  assert.equal(
    body.method,
    'call',
    `P1: envelope method "call" — body: ${JSON.stringify(body)}`
  );
  assert.ok(
    body.params !== null &&
      typeof body.params === 'object' &&
      !Array.isArray(body.params) &&
      Object.keys(body.params).length === 0,
    `P1: params debe ser objeto vacío {} (I-1: la sonda es read-only) — body: ${JSON.stringify(body)}`
  );
});

// ── P2: tabla de clasificación §2.2 — los 6 casos medidos ───────────────────

test('P2.1 (§2.2 caso 1): result.uid numérico > 0 → estado "valid" con info expuesta', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { jsonrpc: '2.0', result: { ...VALID_INFO } },
  });
  assert.equal(
    res.state,
    'valid',
    `P2.1: estado debe ser "valid" — got: ${JSON.stringify(res)}`
  );
  assert.ok(
    res.info && typeof res.info === 'object',
    `P2.1: info debe estar expuesta — got: ${JSON.stringify(res)}`
  );
  assert.equal(res.info.uid, 2, `P2.1: info.uid — got: ${JSON.stringify(res.info)}`);
  assert.equal(res.info.username, 'admin', `P2.1: info.username — got: ${JSON.stringify(res.info)}`);
  assert.equal(res.info.db, 'demo', `P2.1: info.db — got: ${JSON.stringify(res.info)}`);
  assert.equal(res.info.server_version, '19.0', `P2.1: info.server_version — got: ${JSON.stringify(res.info)}`);
  assert.equal(res.info.is_superuser, true, `P2.1: info.is_superuser — got: ${JSON.stringify(res.info)}`);
  assert.ok(
    res.info.user_context && typeof res.info.user_context === 'object',
    `P2.1: info.user_context expuesto (los 6 campos de §2.2 caso 1) — got: ${JSON.stringify(res.info)}`
  );
});

test('P2.2 (§2.2 caso 2): envelope error JSON-RPC → estado "expired" con mensaje que incluye el message del server', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { jsonrpc: '2.0', error: { code: 100, message: 'Odoo Session Expired' } },
  });
  assert.equal(
    res.state,
    'expired',
    `P2.2: estado debe ser "expired" (medido en vivo: error JSON-RPC code:100) — got: ${JSON.stringify(res)}`
  );
  const msg = res.message;
  assert.equal(
    typeof msg,
    'string',
    `P2.2: debe exponer un mensaje (string) para la clase (b) — got: ${JSON.stringify(res)}`
  );
  assert.ok(msg.length > 0, `P2.2: el mensaje no puede ser vacío — got: ${JSON.stringify(res)}`);
  assert.ok(
    msg.includes('Odoo Session Expired'),
    `P2.2: el mensaje debe incluir el message del server ("Odoo Session Expired") — got: ${JSON.stringify(msg)}`
  );
});

test('P2.3 (§2.2 caso 3): result con uid falsy (false) → estado "expired"', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { jsonrpc: '2.0', result: { uid: false } },
  });
  assert.equal(
    res.state,
    'expired',
    `P2.3: uid falsy → rama defensiva (b) "expired" — got: ${JSON.stringify(res)}`
  );
});

test('P2.4 (§2.2 caso 4): respuesta no-JSON (text/html 200) → estado "detection-failed"', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({ contentType: 'text/html', status: 200 });
  assert.equal(
    res.state,
    'detection-failed',
    `P2.4: no-JSON ya NO es "sesión expirada" (el colapso (a)=(b) era la raíz de la mentira) — got: ${JSON.stringify(res)}`
  );
});

test('P2.5 (§2.2 caso 5): fetch rechaza (red/abort) → estado "detection-failed"', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({ rejected: true });
  assert.equal(
    res.state,
    'detection-failed',
    `P2.5: red rota → detección fallida — got: ${JSON.stringify(res)}`
  );
});

test('P2.6 (§2.2 caso 6): executeScript sin resultado → estado "detection-failed" (jamás colapsar a {})', () => {
  assert.ok(classifyProbeResponse, GUARD('P2', 'classifyProbeResponse'));
  const res = classifyProbeResponse({ noResult: true });
  assert.equal(
    res.state,
    'detection-failed',
    `P2.6: sin resultado de la inyección → detección fallida (audit §8: prohibido el {} indistinguible) — got: ${JSON.stringify(res)}`
  );
});

// ── P3: dirección conservadora (I-2) ────────────────────────────────────────

test('P3 (I-2): duda → "detection-failed"; nunca "valid" sin uid numérico > 0', () => {
  assert.ok(classifyProbeResponse, GUARD('P3', 'classifyProbeResponse'));

  const rHtml = classifyProbeResponse({ contentType: 'text/html', status: 200 });
  assert.equal(
    rHtml.state,
    'detection-failed',
    `P3: html con status 200 → detection-failed — got: ${JSON.stringify(rHtml)}`
  );
  assert.notEqual(rHtml.state, 'expired', 'P3: html 200 nunca es "expired"');
  assert.notEqual(rHtml.state, 'valid', 'P3: html 200 nunca es "valid"');

  const rJunk = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { foo: 1 },
  });
  assert.equal(
    rJunk.state,
    'detection-failed',
    `P3: JSON que no es envelope JSON-RPC → detection-failed — got: ${JSON.stringify(rJunk)}`
  );
  assert.notEqual(rJunk.state, 'expired', 'P3: JSON no-envelope nunca es "expired"');
  assert.notEqual(rJunk.state, 'valid', 'P3: JSON no-envelope nunca es "valid"');

  const rNeg = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { jsonrpc: '2.0', result: { ...VALID_INFO, uid: -1 } },
  });
  assert.notEqual(
    rNeg.state,
    'valid',
    `P3: uid negativo NUNCA es "valid" (exigido uid > 0) — got: ${JSON.stringify(rNeg)}`
  );
  assert.ok(
    ['valid', 'expired', 'detection-failed'].includes(rNeg.state),
    `P3 (I-3): uid negativo cae en exactamente una de las 3 clases — got: ${JSON.stringify(rNeg)}`
  );

  const rStr = classifyProbeResponse({
    contentType: 'application/json',
    status: 200,
    json: { jsonrpc: '2.0', result: { ...VALID_INFO, uid: '2' } },
  });
  assert.notEqual(
    rStr.state,
    'valid',
    `P3: uid no numérico ("2") NUNCA es "valid" (§2.2 caso 1 exige uid NUMÉRICO > 0) — got: ${JSON.stringify(rStr)}`
  );
  assert.ok(
    ['valid', 'expired', 'detection-failed'].includes(rStr.state),
    `P3 (I-3): uid string cae en exactamente una de las 3 clases — got: ${JSON.stringify(rStr)}`
  );
});

// ── P4: mapping de odooGetVersion (spec §2.4, export §9.1bis) ───────────────

test('P4a (§2.4): versionResult estado "valid" → shape exacto {version, db, uid, username, is_superuser}', () => {
  assert.ok(versionResult, GUARD('P4', 'versionResult'));
  const v = versionResult({
    state: 'valid',
    info: { ...VALID_INFO },
  });
  assert.deepStrictEqual(
    v,
    { version: '19.0', db: 'demo', uid: 2, username: 'admin', is_superuser: true },
    `P4a: shape exacto de odooGetVersion (server_version→version, resto directo) — got: ${JSON.stringify(v)}`
  );
  // Regresión del defecto hermano (audit §8): prohibido el success con campos null/undefined.
  for (const [campo, valor] of Object.entries(v)) {
    assert.ok(
      valor !== null && valor !== undefined,
      `P4a: campo ${campo} es null/undefined — prohibido el success con campos null`
    );
  }
  // Coerción !! de is_superuser (mapeo actual de odooGetVersion): truthy no-boolean → true.
  const vCoerce = versionResult({
    state: 'valid',
    info: { ...VALID_INFO, is_superuser: 1 },
  });
  assert.equal(
    vCoerce.is_superuser,
    true,
    `P4a: is_superuser debe normalizarse con !! (truthy → true boolean) — got: ${JSON.stringify(vCoerce?.is_superuser)}`
  );
});

test('P4b (§2.4): versionResult estado "expired" → throw /session expired/i Y /re-login/i', () => {
  assert.ok(versionResult, GUARD('P4', 'versionResult'));
  let err = null;
  try {
    versionResult({ state: 'expired', message: 'Odoo Session Expired' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, `P4b: estado "expired" debe LANZAR, no resolver — got: ${JSON.stringify(err)}`);
  assert.match(
    err.message,
    /session expired/i,
    `P4b: mensaje clase (b) nombra la sesión vencida — got: ${JSON.stringify(err?.message)}`
  );
  assert.match(
    err.message,
    /re-login/i,
    `P4b: mensaje clase (b) pide re-login — got: ${JSON.stringify(err?.message)}`
  );
});

test('P4c (§2.4): versionResult estado "detection-failed" → throw /detection failed/i; mensajes (a)/(b) distintos; sin "session expired" en (a)', () => {
  assert.ok(versionResult, GUARD('P4', 'versionResult'));
  let errA = null;
  try {
    versionResult({ state: 'detection-failed' });
  } catch (e) {
    errA = e;
  }
  assert.ok(errA, 'P4c: estado "detection-failed" debe LANZAR, no resolver');
  assert.match(
    errA.message,
    /detection failed/i,
    `P4c: mensaje clase (a) nombra el fallo de detección — got: ${JSON.stringify(errA?.message)}`
  );
  assert.ok(
    !/session expired/i.test(errA.message),
    `P4c (§2.3.4): ningún mensaje de detección fallida contiene "session expired" — got: ${JSON.stringify(errA?.message)}`
  );

  let errB = null;
  try {
    versionResult({ state: 'expired', message: 'Odoo Session Expired' });
  } catch (e) {
    errB = e;
  }
  assert.ok(errB, 'P4c: estado "expired" debe LANZAR (para comparar mensajes entre clases)');
  assert.notEqual(
    errA.message,
    errB.message,
    `P4c: los mensajes de (a) y (b) son distintos entre sí — a: ${JSON.stringify(errA?.message)}, b: ${JSON.stringify(errB?.message)}`
  );
});

// ── P5: agregación odooDetectTabs (spec §2.3, export §9.1) ──────────────────

test('P5a (§2.3.1): aggregateDetection([]) → [] sin error', () => {
  assert.ok(aggregateDetection, GUARD('P5', 'aggregateDetection'));
  const res = aggregateDetection([]);
  assert.ok(Array.isArray(res), `P5a: debe devolver array — got: ${JSON.stringify(res)}`);
  assert.equal(
    res.length,
    0,
    `P5a: cero candidatos → lista vacía SIN error (igual a hoy, honesto) — got: ${JSON.stringify(res)}`
  );
});

test('P5b (§2.3.3): todos los candidatos fallan → throw que enumera cada tab con su clase', () => {
  assert.ok(aggregateDetection, GUARD('P5', 'aggregateDetection'));
  const allBad = [
    { tabId: 5, state: 'expired', url: 'https://a.example.com' },
    { tabId: 7, state: 'detection-failed', url: 'https://b.example.com' },
  ];
  let err = null;
  try {
    aggregateDetection(allBad);
  } catch (e) {
    err = e;
  }
  assert.ok(
    err,
    `P5b: con ≥1 candidato y NINGUNO válido debe lanzar error clasificado (ya no devuelve []) — got: ${JSON.stringify(err)}`
  );
  const m = err?.message ?? '';
  assert.ok(
    m.includes('tab 5'),
    `P5b: el mensaje debe enumerar "tab 5" — got: ${JSON.stringify(m)}`
  );
  assert.match(
    m,
    /session expired/i,
    `P5b: el mensaje debe nombrar la clase (b) del tab 5 ("session expired") — got: ${JSON.stringify(m)}`
  );
  assert.ok(
    m.includes('tab 7'),
    `P5b: el mensaje debe enumerar "tab 7" — got: ${JSON.stringify(m)}`
  );
  assert.match(
    m,
    /detection failed/i,
    `P5b: el mensaje debe nombrar la clase (a) del tab 7 ("detection failed") — got: ${JSON.stringify(m)}`
  );
});

test('P5c (§2.3.2): mezcla con ≥1 válido → solo los perfiles de los válidos, sin throw', () => {
  assert.ok(aggregateDetection, GUARD('P5', 'aggregateDetection'));
  const mixed = [
    { ...VALID_ENTRY },
    { tabId: 9, state: 'expired', url: 'https://x.example.com' },
    { tabId: 11, state: 'detection-failed', url: 'https://y.example.com' },
  ];
  const res = aggregateDetection(mixed);
  assert.ok(Array.isArray(res), `P5c: debe devolver array — got: ${JSON.stringify(res)}`);
  assert.equal(
    res.length,
    1,
    `P5c: los tabs (a)/(b) se omiten de la lista; queda solo el válido — got: ${JSON.stringify(res)}`
  );
  assert.equal(
    res[0]?.tabId,
    5,
    `P5c: el perfil restante es el del tab válido 5 — got: ${JSON.stringify(res)}`
  );
});

test('P5d (§2.3.2): shape de perfil EXACTO de 8 campos con tipos (alineado al congelado en Go)', () => {
  assert.ok(aggregateDetection, GUARD('P5', 'aggregateDetection'));
  const res = aggregateDetection([{ ...VALID_ENTRY }]);
  assert.deepStrictEqual(
    res,
    [
      {
        tabId: 5,
        url: 'https://edu.example.com/web#action=menu',
        db: 'demo',
        version: '19.0', // viene de info.server_version
        uid: 2,
        username: 'admin',
        is_superuser: true,
        is_active: true,
      },
    ],
    'P5d: shape de 8 campos exacto (tabId/uid number, is_superuser/is_active bool, resto string) — congelado en odooregistry_test.go:67-91; alinear, no redefinir'
  );
});

// ── P6: guard de no-regresión del wire de odooRpc (spec §2.5, export §9.1bis) ──

test('P6 (§2.5): rpcRequest emite el wire intacto a /web/dataset/call_kw (POST + envelope con params model/method/args/kwargs)', () => {
  assert.ok(rpcRequest, GUARD('P6', 'rpcRequest'));
  const domain = [['is_company', '=', true]];
  const req = rpcRequest('res.partner', 'search_read', [domain], { fields: ['name'] });
  const captura = JSON.stringify(req);
  assert.equal(req.url, '/web/dataset/call_kw', `P6: url del RPC — captura completa: ${captura}`);
  assert.equal(req.init?.method, 'POST', `P6: method POST — captura completa: ${captura}`);
  assert.equal(
    req.init?.headers?.['Content-Type'],
    'application/json',
    `P6: Content-Type application/json — captura completa: ${captura}`
  );
  assert.equal(
    req.init?.credentials,
    'include',
    `P6: credentials include — captura completa: ${captura}`
  );
  assert.equal(typeof req.init?.body, 'string', `P6: body string JSON — captura completa: ${captura}`);
  const body = parseBody(req.init?.body);
  assert.ok(body, `P6: body JSON parseable — captura completa: ${captura}`);
  assert.equal(body.jsonrpc, '2.0', `P6: envelope jsonrpc 2.0 — body: ${JSON.stringify(body)}`);
  assert.equal(body.method, 'call', `P6: envelope method call — body: ${JSON.stringify(body)}`);
  assert.deepStrictEqual(
    body.params,
    { model: 'res.partner', method: 'search_read', args: [domain], kwargs: { fields: ['name'] } },
    `P6: params {model, method, args, kwargs} exacto (la presencia de "id" NO es parte del contrato — no se aserta) — body: ${JSON.stringify(body)}`
  );
});

// ── P7: guard de no-regresión de unwrapRpcResult (spec §2.5, export §9.1bis) ──

test('P7 (§2.5): unwrapRpcResult intacto (error→throw con ese mensaje; sin result→throw; con result→result)', () => {
  assert.ok(unwrapRpcResult, GUARD('P7', 'unwrapRpcResult'));

  let errBoom = null;
  try {
    unwrapRpcResult({ jsonrpc: '2.0', error: { code: 1, message: 'boom' } });
  } catch (e) {
    errBoom = e;
  }
  assert.ok(errBoom, 'P7: envelope con error debe lanzar');
  assert.equal(
    errBoom?.message,
    'boom',
    `P7: el throw lleva el mensaje del error del server — got: ${JSON.stringify(errBoom?.message)}`
  );

  let errNoRes = null;
  try {
    unwrapRpcResult({ jsonrpc: '2.0' });
  } catch (e) {
    errNoRes = e;
  }
  assert.ok(errNoRes, 'P7: envelope sin result debe lanzar (camino honesto, no colapso silencioso)');
  assert.equal(
    errNoRes?.message,
    'Odoo RPC returned no result',
    `P7: mensaje exacto del camino sin result — got: ${JSON.stringify(errNoRes?.message)}`
  );

  const r = unwrapRpcResult({ jsonrpc: '2.0', result: { x: 1 } });
  assert.deepStrictEqual(
    r,
    { x: 1 },
    `P7: con result devuelve el result — got: ${JSON.stringify(r)}`
  );
});

// ── P16: listFieldsParams — export de construcción (enmienda §9.1bis-bis,
//    fb-019-002, post-AUDIT F-8) ─────────────────────────────────────────────
// El handler odooListFields de background.js consume este export (misma
// inyección serializable que la sonda): `listFieldsParams(model, attributes?)`
// → `{model, attributes:[strings]}` — attributes string comma-separated o
// array se splitea/normaliza; sin attributes el default es
// ["string","type","required","help"] (el default observado de mcp.odoo que
// incluye `help` — D-9/C-4). GUARD-first: el export no existe aún → los 3
// tests fallan por AssertionError (ERR_ASSERTION) en RED, patrón P1–P7.
const listFieldsParams = mod?.listFieldsParams ?? null;

const GUARD_002 = (id, fn) =>
  `session-probe.js debe existir y exportar ${fn} (postcondición ${id}, enmienda §9.1bis-bis) — RED de fb-019-002`;

test('P16a (§9.1bis-bis): listFieldsParams sin attributes → default {model, attributes:[string,type,required,help]} (D-9: default con help)', () => {
  assert.ok(listFieldsParams, GUARD_002('P16', 'listFieldsParams'));
  const p = listFieldsParams('res.partner');
  assert.deepStrictEqual(
    p,
    { model: 'res.partner', attributes: ['string', 'type', 'required', 'help'] },
    `P16a: default nuevo de odooListFields con help incluido — got: ${JSON.stringify(p)}`
  );
});

test('P16b (§9.1bis-bis): listFieldsParams con attributes string comma-separated → split+trim', () => {
  assert.ok(listFieldsParams, GUARD_002('P16', 'listFieldsParams'));
  const p = listFieldsParams('res.partner', 'string, type');
  assert.deepStrictEqual(
    p,
    { model: 'res.partner', attributes: ['string', 'type'] },
    `P16b: "string, type" → ["string","type"] (split por coma + trim) — got: ${JSON.stringify(p)}`
  );
});

test('P16c (§9.1bis-bis): listFieldsParams con attributes array → normalizado', () => {
  assert.ok(listFieldsParams, GUARD_002('P16', 'listFieldsParams'));
  const p = listFieldsParams('res.partner', ['string ', ' type ']);
  assert.deepStrictEqual(
    p,
    { model: 'res.partner', attributes: ['string', 'type'] },
    `P16c: array → normalizado (trim de cada elemento) — got: ${JSON.stringify(p)}`
  );
});
