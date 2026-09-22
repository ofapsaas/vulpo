// session-probe.js — fb-019-001-fix-no-odoo-tab (service worker + node).
// Sonda de sesión Odoo: construcción del wire (§2.1), clasificación de la
// respuesta (§2.2, tabla medida en vivo 2026-09-09), agregación honesta de la
// detección (§2.3), mapping de get_version (§2.4) y guard del unwrap RPC
// (§2.5). Módulo importable en node sin side effects ni APIs de browser
// (precedente frame/settle.js — spec §9); el event page lo consume vía bundle
// IIFE (session-probe-bundle.js, global VulpoSessionProbe, generado por
// odoo/build-probe.sh). Restricción MV3: la función inyectada en el tab es
// self-contained y recibe el wire como argumento serializable.
//
// Contrato (spec docs/specs/fb-019-001-fix-no-odoo-tab/spec.md):
//   · Estados literales: 'valid' | 'expired' | 'detection-failed' (§9.1).
//   · I-2 (conservadora): toda duda de clasificación → 'detection-failed';
//     nunca 'valid' sin uid numérico > 0.
//   · I-3 (exhaustiva y excluyente): toda observación cae en exactamente una
//     de las tres clases.
//   · Mensajes de clase distinguibles por inspección (§2.3.4): la clase (b)
//     nombra la sesión vencida y pide re-login; la clase (a) nombra un fallo
//     de detección y jamás contiene "session expired".

// ── Builders del wire (§2.1, §2.5) ──────────────────────────────────────────

// Sonda de sesión (§2.1): POST JSON-RPC a get_session_info. Sin `id` en el
// envelope (la presencia de id NO es parte del contrato; el body medido en
// vivo funcionó sin id). params {} vacío pinneado (I-1: la sonda es read-only).
function probeRequest() {
  return {
    url: '/web/session/get_session_info',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
    },
  };
}

// RPC Odoo (§2.5): wire de odooRpc, congelado por el guard P6. byte-parity con
// el builder inline histórico de background.js (incluye `id: Date.now()`, no
// pineado por el contrato).
function rpcRequest(model, method, args, kwargs) {
  return {
    url: '/web/dataset/call_kw',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: { model, method, args, kwargs },
        id: Date.now(),
      }),
    },
  };
}

// ── Clasificación (§2.2 — tabla medida) ─────────────────────────────────────

// `response` es la observación de frontera (§9.1): {rejected: true} (fetch
// rechaza), {noResult: true} (executeScript sin resultado) o {contentType,
// status, json?} (respuesta del endpoint). Devuelve {state, info?, message?}.
function classifyProbeResponse(response) {
  if (!response || typeof response !== 'object') {
    return { state: 'detection-failed' };
  }
  if (response.rejected) {
    return { state: 'detection-failed' };  // §2.2 caso 5: red/abort.
  }
  if (response.noResult) {
    return { state: 'detection-failed' };  // §2.2 caso 6: sin resultado.
  }
  const contentType = typeof response.contentType === 'string' ? response.contentType : '';
  if (!contentType.includes('application/json')) {
    return { state: 'detection-failed' };  // §2.2 caso 4: no-JSON ya NO es "expired".
  }
  const json = response.json;
  if (!json || typeof json !== 'object') {
    return { state: 'detection-failed' };  // JSON no parseable/objeto → I-2.
  }
  if (json.error) {
    // §2.2 caso 2 (medido en vivo: code:100 "Odoo Session Expired"):
    // envelope de error JSON-RPC → sesión vencida / no logueada. El mensaje
    // top-level expone la causa cruda del server cuando existe.
    const serverMessage = typeof json.error.message === 'string' ? json.error.message : '';
    const classified = { state: 'expired' };
    if (serverMessage) classified.message = serverMessage;
    return classified;
  }
  const result = json.result;
  if (!result || typeof result !== 'object') {
    return { state: 'detection-failed' };  // JSON que no es envelope JSON-RPC → I-2.
  }
  if (typeof result.uid === 'number' && result.uid > 0) {
    // §2.2 caso 1: sesión válida — info con los 6 campos de la tabla.
    // fb-019-002 (P17, review BLOQUEANTE-1): passthrough aditivo de
    // server_version_info (get_session_info lo trae; si una versión no lo
    // trae queda undefined y el merge del handler degrada — nunca rompe).
    return {
      state: 'valid',
      info: {
        uid: result.uid,
        username: result.username,
        db: result.db,
        server_version: result.server_version,
        server_version_info: result.server_version_info,
        is_superuser: result.is_superuser,
        user_context: result.user_context,
      },
    };
  }
  if (!result.uid) {
    // §2.2 caso 3 (rama defensiva): uid falsy (false/0/ausente) → no logueado.
    return { state: 'expired' };
  }
  // uid truthy pero no numérico>0 (p.ej. '2'): variante no medida → I-2 → (a).
  return { state: 'detection-failed' };
}

// ── Perfiles y mensajes clasificados (§2.3, §2.4) ───────────────────────────

// Entrada 'valid' utilizable: state 'valid' + info con uid numérico > 0
// (I-2: jamás se informa sesión válida sin uid > 0; un 'valid' sin info
// utilizable se re-clasifica a 'detection-failed' en los consumidores).
function isUsableValid(entry) {
  return Boolean(entry) && entry.state === 'valid'
    && entry.info && typeof entry.info === 'object'
    && typeof entry.info.uid === 'number' && entry.info.uid > 0;
}

// Mensaje por tab para el throw de agregación (§2.3.3). Los literales son los
// del spec: clase (b) "Odoo session expired in tab N. Please re-login in the
// tab." (+ causa del server cuando existe); clase (a) "Odoo detection failed
// for tab N (no usable response); retry or inspect the tab." (§2.3.4: jamás
// contiene "session expired"). Un 'valid' sin info utilizable se reporta
// como clase (a) — I-2.
function classifiedTabMessage(entry) {
  if (entry && entry.state === 'expired') {
    const detail = typeof entry.message === 'string' && entry.message
      ? ` (server: ${entry.message})`
      : '';
    return `Odoo session expired in tab ${entry.tabId}. Please re-login in the tab.${detail}`;
  }
  return `Odoo detection failed for tab ${entry && entry.tabId} (no usable response); retry or inspect the tab.`;
}

// ── Agregación de la detección (§2.3) ───────────────────────────────────────

// Input: lista de {tabId, state, info?, message?, url?}. Sin candidatos → []
// sin error (§2.3.1); ≥1 'valid' → perfiles de los válidos con el shape de 8
// campos congelado en el server (odooregistry_test.go:67-91, §2.3.2); ≥1
// candidato y NINGUNO utilizable → throw cuyo mensaje enumera cada tab con su
// clase (§2.3.3) — el único cambio de comportamiento del command wire.
function aggregateDetection(results) {
  const valid = results.filter((entry) => isUsableValid(entry));
  if (valid.length > 0) {
    return valid.map((entry) => ({
      tabId: entry.tabId,
      url: entry.url,
      db: entry.info.db,
      version: entry.info.server_version,
      uid: entry.info.uid,
      username: entry.info.username,
      is_superuser: !!entry.info.is_superuser,
      is_active: true,
    }));
  }
  if (results.length === 0) return [];
  throw new Error(results.map(classifiedTabMessage).join(' '));
}

// ── Mapping de odooGetVersion (§2.4) ────────────────────────────────────────

// 'valid' → shape actual {version, db, uid, username, is_superuser}
// (server_version→version, is_superuser normalizado con !!). 'expired' →
// throw clase (b); 'detection-failed' → throw clase (a). NUNCA resuelve un
// success con campos null/undefined (el colapso a {} de hoy está prohibido —
// audit §8); un 'valid' sin info utilizable lanza clase (a) — I-2.
function versionResult(probe) {
  if (isUsableValid(probe)) {
    return {
      version: probe.info.server_version,
      db: probe.info.db,
      uid: probe.info.uid,
      username: probe.info.username,
      is_superuser: !!probe.info.is_superuser,
    };
  }
  if (probe && probe.state === 'expired') {
    const detail = typeof probe.message === 'string' && probe.message
      ? ` (server: ${probe.message})`
      : '';
    throw new Error(`Odoo session expired. Please re-login in the tab.${detail}`);
  }
  throw new Error('Odoo detection failed (no usable session state); retry or inspect the tab.');
}

// ── Convención numérica del usuario (§2.2 "get_version", §3.3 P15–P17) ─────

// languageConvention(info, langRecords) → object: presencia opcional, nunca
// null/undefined (I-8). `lang` sólo si info.user_context.lang es string no
// vacío (P17). `decimal_point`/`thousands_sep` sólo junto con `lang` y si
// langRecords es un array de exactamente un registro con decimal_point
// string no vacío y thousands_sep string (puede ser "") (P15/P16).
function languageConvention(info, langRecords) {
  const lang = info && info.user_context && typeof info.user_context.lang === 'string'
    ? info.user_context.lang
    : '';
  if (!lang) return {};
  const result = { lang };
  if (!Array.isArray(langRecords) || langRecords.length !== 1) return result;
  const [record] = langRecords;
  if (!record || typeof record !== 'object') return result;
  const { decimal_point: decimalPoint, thousands_sep: thousandsSep } = record;
  if (typeof decimalPoint !== 'string' || !decimalPoint) return result;
  if (typeof thousandsSep !== 'string') return result;
  result.decimal_point = decimalPoint;
  result.thousands_sep = thousandsSep;
  return result;
}

// ── Guard del unwrap RPC (§2.5, P7) ─────────────────────────────────────────

// Normaliza el resultado de odooRpc: lanza si hay error del server, lanza si
// no hay result (fallo silencioso de executeScript), o devuelve result.
// Extracción con el MISMO nombre de background.js — el wire queda intacto.
// fb-019-qw TO-02 (reporte de cliente 2026-09-09): los errores de validación
// de Odoo traen el diagnóstico real en data.arguments (p.ej. "Invalid field
// 'X' on 'model'") — se pierde si solo subimos `message` ("Odoo Server
// Error"). Adjuntamos los arguments no-vacíos al mensaje (formato compacto,
// sin debug/traceback — esos van al log del tab si hacen falta).
function unwrapRpcResult(r) {
  if (r && r.error) {
    throw new Error(rpcErrorMessage(r.error));
  }
  if (!r || r.result === undefined) {
    throw new Error('Odoo RPC returned no result');
  }
  return r.result;
}

// Mensaje de error de un envelope JSON-RPC de Odoo: message + data.arguments
// no vacíos (donde Odoo pone "Invalid field 'X' on 'model'", "Expected
// singleton", etc.). CERO alcance al traceback completo (data.debug).
function rpcErrorMessage(err) {
  const base = typeof err.message === 'string' && err.message ? err.message : 'Odoo RPC error';
  const args = err.data && Array.isArray(err.data.arguments)
    ? err.data.arguments.filter((a) => typeof a === 'string' && a)
    : [];
  if (!args.length) return base;
  const detail = args.join(' — ');
  return base === detail ? base : `${base}: ${detail}`;
}

// ── Falla de inyección de odooRpc (fb-020-006 §2.4, P13) ────────────────────

// classifyInjectionFailure(tabId, cause) → mensaje `odoo_tab_unreachable: …`
// para cuando executeScript rechaza o no devuelve resultado en la pestaña.
// cause: Error | string | undefined; su texto viaja sin cambios.
function classifyInjectionFailure(tabId, cause) {
  const detail = cause instanceof Error ? cause.message : cause;
  const causeText = detail ? String(detail) : 'no result from the injected script';
  return `odoo_tab_unreachable: tab ${tabId}: ${causeText}`;
}

// ── Params de odooListFields (§9.1bis-bis, fb-019-002 — D-9/C-4) ────────────

// listFieldsParams(model, attributes?) → {model, attributes:[strings]}:
// export de construcción que consume odooListFields en background.js (misma
// inyección serializable que la sonda). attributes string comma-separated o
// array se splitea/normaliza (split por coma + trim de cada elemento); sin
// attributes el default es ["string","type","required","help"] — el default
// observado de mcp.odoo, que incluye `help` (D-9/C-4).
function listFieldsParams(model, attributes) {
  const DEFAULT_ATTRS = ['string', 'type', 'required', 'help'];
  let attrs = DEFAULT_ATTRS;
  if (attributes !== undefined && attributes !== null) {
    const raw = Array.isArray(attributes) ? attributes : String(attributes).split(',');
    attrs = raw.map((a) => String(a).trim()).filter((a) => a.length > 0);
  }
  return { model, attributes: attrs };
}

export {
  probeRequest,
  rpcRequest,
  classifyProbeResponse,
  aggregateDetection,
  versionResult,
  languageConvention,
  unwrapRpcResult,
  listFieldsParams,
  classifyInjectionFailure,
};
