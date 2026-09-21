/**
 * Vulpo — Profile-Based Extension
 *
 * Se conecta a bridge servers remotos via WSS. Un perfil por línea de config.
 * Cada perfil agrupa bridgeUrl + token + dominios.
 * Sin dependencias locales (no host.js). Configurable por dominio.
 *
 * La versión canónica vive en manifest.json; aquí se lee en runtime vía
 * browser.runtime.getManifest().version (ver EXT_VERSION).
 */
console.log(`🦊🦊🦊 VULPO BACKGROUND SCRIPT LOADED — v${browser.runtime.getManifest().version} 🦊🦊🦊`);

// Versión de la extensión, leída del manifest para no desincronizar nunca.
const EXT_VERSION = browser.runtime.getManifest().version;

// ============================================================
// Configuration
// ============================================================
// Set de tools de escritura (gate de Plan mode). Scope del módulo (no se recrea
// en cada guardedCommand — hot path, fb-013-001 review #3).
// fb-013-004 agrega los 5 commands write de Odoo (Contrato 3, plan L146-150).
const WRITE_TOOLS = new Set(['click', 'eval', 'navigate', 'injectCSS', 'activateTab', 'openTab', 'closeTab', 'fill',
  'odooCreate', 'odooWrite', 'odooUnlink', 'odooImportRecords', 'odooExportRecords',
  'odooExecuteKw', 'act']);
const CONFIG = {
  reconnectDelay: 1000,           // 1s initial, luego backoff
  maxReconnectAttempts: 0,        // 0 = ilimitado
  wsPingInterval: 30000,
  evalTimeout: 5000,
  maxEvalPerSecond: 10,
  maxDomSize: 1_000_000,
  logLevel: 'debug',
  storageKey: 'vlp_rules',  // key in storage.sync for domain rules
};

// fb-017-004 (enmienda HITL): diff stateless — último snapshot (JSON) del
// frame por tab, en background. El estado del isolated world NO persiste
// entre executeScript calls (verificado E2E), así que la generación por
// MutationObserver se resetea en cada call; el cambio se detecta comparando
// el JSON del frame serializado contra este snapshot. Primera llamada y
// resets ⇒ changedSinceLast:true, nunca falso negativo (I7).
const lastFrameByTab = new Map();

// fb-018-006 §2.2.7 (enmienda 2026-09-08, P14 falsado en campo): tabs con
// navegación de página completa EN VUELO. El executeScript durante la
// navegación aterriza en el DOCUMENTO PREVIO (Firefox lo mantiene vivo hasta
// el commit) y ese documento puede estar quieto (loader overlay CSS-animated:
// cero mutaciones, readyState complete) — el settle certificaría settled:true
// sobre contenido ya inexistente. El set alimenta la señal
// `invalidation.navigating` (§2.2.7-A) y la espera de commit del camino
// settle (§2.2.7-B). Mantenimiento: tabs.onUpdated status loading añade,
// complete remueve (+ onRemoved limpia); el handler `navigate` siembra al
// iniciar (comentario allí). SPA/pushState no dispara onUpdated — correcto:
// ahí el documento no se recambia. Set in-memory (sin persistencia): el
// event page que despierta a mitad de una navegación lo reconstruye con el
// próximo evento onUpdated del ciclo loading/complete.
const navigatingTabs = new Set();

// fb-020-007: eventos de navegación de página completa por pestaña
// ({type: 'loading'|'complete'|'removed', tabId}) para nav-guard.
const navEventListeners = new Set();
const navEvents = {
  subscribe(listener) {
    navEventListeners.add(listener);
    return () => navEventListeners.delete(listener);
  },
};

function emitNavEvent(type, tabId) {
  for (const listener of [...navEventListeners]) listener({ type, tabId });
}

const isTabNavigating = (tabId) => navigatingTabs.has(tabId);

// fb-020-007 (I-6): núcleo genérico (VulpoNav) y capa ORM (VulpoNavGuard).
const { watchInjection, routePageProgress, createDiagnosticRing, HEARTBEAT_MS } = globalThis.VulpoNav;
const { dispatchAfterNav, guardInjection, probeTabsGuarded, noResultError } = globalThis.VulpoNavGuard;

// fb-020-008 (act frame fold): módulo del pliegue de lectura en las acciones.
const { actWithFold, navigateWithFold } = globalThis.VulpoFrameFold || {};

// fb-020-007 §9.6: anillo de diagnóstico en memoria (≤ 200 entradas): onUpdated
// por pestaña, despachos, desenlaces y latidos de página. Cómo leerlo: cada
// entrada sale también por la consola del event page con el prefijo
// "[navguard]" (about:debugging → Inspect), y `navGuardLog(tabId?)` en esa
// misma consola devuelve el anillo completo o filtrado por pestaña.
const navGuardRing = createDiagnosticRing();
function recordNavGuard(entry) {
  console.info('[navguard]', JSON.stringify(navGuardRing.record(entry)));
}
globalThis.navGuardLog = (tabId) => navGuardRing.entries(tabId);

// fb-020-007 §9.4: estado real de la pestaña; una falla de lectura no saltea la espera.
const readTabStatus = (tabId) => browser.tabs.get(tabId).then((tab) => tab.status, () => 'loading');
const clearNavigating = (tabId) => navigatingTabs.delete(tabId);

// Rechazo por navegación de las inyecciones genéricas (§2.2). El de `act` va
// marcado para que finishDispatch no lo re-envuelva.
const GENERIC_NAVIGATION_ERRORS = {
  // fb-020-008 §2.7/P13: el rechazo genérico también va MARCADO. El pliegue
  // vigila su lectura con kind 'wait' y distingue "navegó durante la lectura"
  // de "la serialización falló" por esta marca; sin ella, el único mensaje
  // alcanzable sería el de serialización. `finishDispatch` sólo la consulta en
  // el camino de kind 'act', así que la marca es aditiva.
  wait: (tabId) => Object.assign(new Error(`tab ${tabId} navigated while the command was running; retry`), { navigatedWhileRunning: true }),
  act: () => Object.assign(writeOutcomeUnknownError('act', 'tab navigated while the action was running'), { navigatedWhileRunning: true }),
};

// fb-020-007 §2.2/§9.5: inyección vigilada — rechaza si una navegación la deja
// huérfana. `declaredWaitMs`: espera declarada del comando (timeout/waitMs).
// Sin latido (§9.2): solo ORM y sonda laten, desde la página.
function watchTabInjection(tabId, kind, inject, command, declaredWaitMs = 0) {
  recordNavGuard({ ev: 'dispatch', id: command?.id, kind, tabId });
  const options = {
    tabId, inject, declaredWaitMs,
    isNavigating: isTabNavigating,
    events: navEvents,
    onOutcome: ({ outcome, error }) => recordNavGuard({ ev: outcome, id: command?.id, kind, tabId, error: error?.message }),
  };
  const navigationError = GENERIC_NAVIGATION_ERRORS[kind];
  if (navigationError) return watchInjection({ ...options, orphanError: () => navigationError(tabId) });
  return guardInjection({ ...options, kind });
}

// fb-020-007 §9.4: `navigate` recambia el documento si la URL cambia fuera del
// fragmento o si recarga la misma URL.
function replacesDocument(previousUrl, nextUrl) {
  if (!previousUrl || previousUrl === nextUrl) return true;
  const withoutFragment = (href) => {
    try {
      const parsed = new URL(href);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return href;
    }
  };
  return withoutFragment(previousUrl) !== withoutFragment(nextUrl);
}

// fb-020-007 §9.5: espera declarada por el comando (ms finitos ≥ 0) o el default.
function declaredWait(ms, fallback) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

// fb-020-007 §9.2: despachos con latido de página pendientes, por token.
// token → {id, tabId, startedAt, beats, sendProgress}.
const pageDispatches = new Map();

function trackPageDispatch(tabId, kind, command) {
  const token = crypto.randomUUID();
  const dispatch = { id: command?.id, tabId, startedAt: Date.now(), beats: 0, sendProgress: command?.sendProgress };
  pageDispatches.set(token, dispatch);
  const release = () => {
    if (!pageDispatches.delete(token)) return;
    recordNavGuard({ ev: 'page-dispatch-end', id: dispatch.id, kind, tabId, beats: dispatch.beats });
  };
  return { token, release };
}

// fb-020-007 §2.1/§9.2: comandos ORM y sonda — esperan el commit antes del
// único despacho; `injectWithToken(token, heartbeatMs)` inyecta la función que
// late desde la página. El token deja de valer cuando el comando termina.
function injectAfterNav(tabId, kind, injectWithToken, command) {
  let tracked = null;
  const inject = () => {
    tracked = trackPageDispatch(tabId, kind, command);
    return injectWithToken(tracked.token, HEARTBEAT_MS);
  };
  const outcome = dispatchAfterNav({
    tabId,
    isNavigating: isTabNavigating,
    events: navEvents,
    getStatus: readTabStatus,
    clearNavigating,
    inject: () => watchTabInjection(tabId, kind, inject, command),
  });
  const finish = (error) => {
    if (tracked) tracked.release();
    else if (error) recordNavGuard({ ev: 'not-dispatched', id: command?.id, kind, tabId, error: error.message });
  };
  outcome.then(() => finish(), finish);
  return outcome;
}

// ============================================================
// Profiles — cada línea de config es un perfil
// ============================================================
const profiles = new Map();  // profileId -> Profile
const profileList = [];      // ordenado, para first-match-wins

// Profile = {
//   id: string,              // `${bridgeUrl}|${token}`
//   bridgeUrl: string,
//   token: string,
//   domains: string[],       // ['*.odoo.com', 'consultores.odoo.com']
//   ws: WebSocket|null,
//   connected: boolean,
//   connectedAt: number,
//   tabs: Set<tabId>,
//   reconnectAttempts: number,
//   superseded: boolean,       // otro device tomó la sesión (close 4002, fb-001-013)
//   reconnectTimer: timeout|null,
//   pingTimer: interval|null,
//   planMode: boolean,
//   pendingCommands: Map,     // msgId -> { resolve, reject, timer, command }
// }

const state = {
  active: true,
  stats: {
    connectionsTotal: 0,
    commandsProcessed: 0,
    commandsSent: 0,
    errors: 0,
    reconnects: 0,
    lastActivity: 0,
  },
  requestTimestamps: [],
  msgId: 0,
};

// ============================================================
// Log Buffer
// ============================================================
const logBuffer = [];
const MAX_LOG_BUFFER = 500;
const startTime = Date.now();

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, msg, data = null) {
  if (LOG_LEVELS[level] < LOG_LEVELS[CONFIG.logLevel]) return;
  const entry = { ts: Date.now(), level, msg, data };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  const prefix = `[Vulpo v${EXT_VERSION}]`;
  const line = `${prefix} ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line, data || '');
  else if (level === 'warn') console.warn(line, data || '');
  else console.log(line, data || '');
}

// ============================================================
// Domain Matching
// ============================================================
function matchDomain(hostname, pattern) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .domain.com
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

function getProfileForUrl(url) {
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith('http')) return null;
    const hostname = u.hostname;

    for (const pid of profileList) {
      const profile = profiles.get(pid);
      if (!profile) continue;
      for (const domain of profile.domains) {
        if (matchDomain(hostname, domain)) {
          return profile;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Config Parser
// ============================================================
function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

// ============================================================
// Profile Helpers
// ============================================================

function getOrCreateProfile(profileId, bridgeUrl, token) {
  if (!profiles.has(profileId)) {
    profiles.set(profileId, {
      id: profileId,
      bridgeUrl,
      token,
      domains: [],
      ws: null,
      connected: false,
      connectedAt: 0,
      tabs: new Set(),
      reconnectAttempts: 0,
      superseded: false,
      reconnectTimer: null,
      pingTimer: null,
      planMode: true,
      pendingCommands: new Map(),
    });
  }
  return profiles.get(profileId);
}

// ============================================================
// Security Proxy — all agent commands pass through here
// ============================================================
async function guardedCommand(cmdName, params, profileId, command) {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error(`Profile "${profileId}" not found`);

  // — Pre: tab access control —
  if (params.tabId != null) {
    // Normalizar: el server manda tabId como string ("9"), pero el Set guarda
    // números de Firefox (9). Aceptar ambos y pasar número a los handlers.
    const tabIdNum = Number(params.tabId);
    const hasTab = profile.tabs.has(params.tabId) || profile.tabs.has(tabIdNum);
    if (!hasTab) {
      throw new Error(`Access denied: tab ${params.tabId} is not assigned to this agent`);
    }
    params.tabId = tabIdNum;
  }

  // — Pre: navigate/openTab destination domain check —
  if ((cmdName === 'navigate' || cmdName === 'openTab') && params.url) {
    const match = getProfileForUrl(params.url);
    if (!match || match.id !== profileId) {
      throw new Error(`Access denied: cannot navigate to "${params.url}" — domain not assigned to this agent`);
    }
  }

  // — Future: rate limiting, command blacklist, param sanitization —

  // — Pre: Plan mode — block write tools
  if (profile.planMode && WRITE_TOOLS.has(cmdName)) {
    throw new Error(`Tool "${cmdName}" blocked in Plan mode. Switch to Build mode to execute.`);
  }

  // — Execute handler —
  const handler = handlers[cmdName];
  if (!handler) throw new Error(`Unknown command: ${cmdName}`);
  // El profile ya resuelto arriba (profileId) se pasa al handler — evita que el
  // handler re-haga lookup con un id incompleto (fb-013-001: togglePlanMode
  // recibe params.profileId="dev-token" pero las keys del Map son
  // "bridgeUrl|token").
  let result = await handler(params, profile, command);

  // — Post: filter listTabs to agent's tabs —
  if (cmdName === 'listTabs' && Array.isArray(result)) {
    result = result.filter(t => profile.tabs.has(t.id));
  }

  return result;
}

// ============================================================
// Config Parser — new format:
//   bridgeUrl token domain1 domain2 ...
// ============================================================
function parseRules(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    // Each line: bridgeUrl token domain1 domain2 ...
    if (parts.length < 3) {
      log('warn', `Skipping line ${i + 1}: expected bridgeUrl token domain...`, lines[i]);
      continue;
    }

    const bridgeUrl = parts[0].replace(/\/+$/, '');
    const token = parts[1];
    const domains = parts.slice(2);

    if (!isValidUrl(bridgeUrl)) {
      log('warn', `Skipping line ${i + 1}: invalid bridgeUrl`, bridgeUrl);
      continue;
    }

    const profileId = `${bridgeUrl}|${token}`;
    seenIds.add(profileId);

    const profile = getOrCreateProfile(profileId, bridgeUrl, token);
    profile.domains = domains;

    // Add to profileList if not already there (preserve order)
    if (!profileList.includes(profileId)) {
      profileList.push(profileId);
    }
  }

  // Detect removed profiles — disconnect them
  const removed = [];
  for (const pid of profileList) {
    if (!seenIds.has(pid)) {
      removed.push(pid);
    }
  }
  // Clean up removed profiles from profileList
  for (let i = profileList.length - 1; i >= 0; i--) {
    if (!seenIds.has(profileList[i])) {
      profileList.splice(i, 1);
    }
  }

  log('info', `Rules parsed: ${seenIds.size} profiles, ${removed.length} removed`);
  return { profileIds: [...seenIds], removed };
}

// ============================================================
// Config Loading
// ============================================================
async function loadConfig() {
  try {
    let data = {};
    try {
      data = await browser.storage.sync.get(CONFIG.storageKey);
    } catch (e) {
      // Fallback to local storage for temporary addons
      data = await browser.storage.local.get(CONFIG.storageKey);
    }
    const text = data[CONFIG.storageKey] || '* None\n';
    parseRules(text);
    log('info', 'Config loaded', { profiles: profileList.length });
  } catch (err) {
    log('error', 'Failed to load config', err.message);
  }
}

browser.storage.onChanged.addListener((changes) => {
  if (changes[CONFIG.storageKey]) {
    log('info', 'Config changed in storage, reloading');
    const { removed } = parseRules(changes[CONFIG.storageKey].newValue || '');
    // Disconnect removed profiles
    for (const pid of removed) {
      disconnectProfile(pid);
    }
    // Reconnect all profiles
    reconnectAllProfiles();
  }
});

// ============================================================
// Icon / Badge
// ============================================================
function updateBadge(connected) {
  try {
    browser.action.setBadgeText({ text: connected ? '' : 'OFF' });
    browser.action.setBadgeBackgroundColor({ color: connected ? '#4CAF50' : '#666' });
  } catch (e) { /* ignore early init */ }
}

// ============================================================
// Rate Limiting
// ============================================================
function checkRateLimit() {
  const now = Date.now();
  state.requestTimestamps = state.requestTimestamps.filter(t => now - t < 1000);
  if (state.requestTimestamps.length >= CONFIG.maxEvalPerSecond) return false;
  state.requestTimestamps.push(now);
  return true;
}

// ============================================================
// Connection — per profile
// ============================================================

/**
 * Connect a profile to its bridge server.
 */
function connectProfile(profile) {
  if (!state.active) return;

  if (profile.ws && (profile.ws.readyState === WebSocket.OPEN || profile.ws.readyState === WebSocket.CONNECTING)) {
    return; // already connected or connecting
  }

  // Reactivación explícita (toggle/tab): el device desplazado vuelve a
  // intentar y suplanta simétricamente al otro (fb-001-013). Se limpia DESPUÉS
  // del early-return para que un connect no-op no borre el flag.
  profile.superseded = false;

  const url = `${profile.bridgeUrl}/extension`;
    log('info', `Connecting profile: ${profile.bridgeUrl} (attempt ${profile.reconnectAttempts + 1})`);

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log('error', `Failed to create WebSocket for profile: ${profile.bridgeUrl}`, err.message);
    scheduleProfileReconnect(profile);
    return;
  }

  profile.ws = ws;

  ws.onopen = () => {
    log('info', `Connected profile: ${profile.bridgeUrl}`);
    profile.connected = true;
    profile.reconnectAttempts = 0;
    profile.connectedAt = Date.now();
    state.stats.connectionsTotal++;

    // Register as extension role with token
    ws.send(JSON.stringify({
      type: 'register', role: 'extension', version: EXT_VERSION, token: profile.token,
    }));
    if (!profile.token) {
      log('warn', 'Registered without token — ensure domain rules include a token');
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      log('warn', 'Invalid JSON from bridge', event.data.slice(0, 200));
      return;
    }

    state.stats.lastActivity = Date.now();

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'pong':
        break;

      case 'superseded':
        // UX (best-effort): el server avisa que otro device tomó la sesión. La
        // decisión de NO reconectar la toma SOLO el close code 4002 en onclose.
        log('warn', `Profile superseded by another device: ${profile.bridgeUrl}`, { reason: msg.reason });
        break;

      case 'welcome':
        log('info', `Registered with bridge`, { clientId: msg.clientId, server: msg.server, bridgeUrl: profile.bridgeUrl });
        // Send all registered tabs to bridge after successful registration
        profile.tabs.forEach(tid => {
          browser.tabs.get(tid).then(tab => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'event', event: 'tabCreated',
                tab: { id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId },
              }));
            }
          }).catch(() => {});
        });
        break;

      case 'response':
      case 'result': {
        const pending = profile.pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          profile.pendingCommands.delete(msg.id);
          pending.resolve(msg.result || msg);
        } else {
          log('debug', `Unhandled response: id=${msg.id} hasText=${!!msg.result?.text}`);
        }
        break;
      }

      case 'error': {
        const pending = profile.pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          profile.pendingCommands.delete(msg.id);
          pending.reject(new Error(msg.error || 'Command failed'));
        } else {
          log('debug', `Unhandled error: id=${msg.id} error=${msg.error}`);
        }
        break;
      }

      case 'command': {
        // Bridge forwards a command from the agent → execute it
        const cmdName = msg.command;
        if (!handlers[cmdName]) {
          log('warn', `Unknown command: ${cmdName}`);
          ws.send(JSON.stringify({ type: 'error', id: msg.id, error: `Unknown command: ${cmdName}` }));
          break;
        }
        log('debug', `Executing command: ${cmdName}`, msg.params);
        state.stats.commandsProcessed++;
        // fb-020-007 §9.2: el latido de página de este comando sale por su WS.
        const command = {
          id: msg.id,
          sendProgress: (progress) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify(progress));
          },
        };
        guardedCommand(cmdName, msg.params || {}, profile.id, command).then(result => {
          ws.send(JSON.stringify({ type: 'response', id: msg.id, result }));
        }).catch(err => {
          log('error', `Command ${cmdName} failed`, err.message);
          ws.send(JSON.stringify({ type: 'error', id: msg.id, error: err.message }));
        });
        break;
      }

      default:
        log('warn', `Unknown message type from bridge`, msg.type);
    }
  };

  ws.onclose = (event) => {
    log('warn', `Disconnected profile: ${profile.bridgeUrl} (code: ${event.code})`);
    profile.connected = false;
    // Reject all pending commands (común a cualquier cierre)
    for (const [id, pending] of profile.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge disconnected'));
    }
    profile.pendingCommands.clear();
    profile.ws = null;
    if (event.code === 4002) {
      // Superseded: otro device tomó esta conexión. NO reconectar:
      // la reactivación es solo por acción explícita del usuario (toggle/tab).
      profile.superseded = true;
      // Cancela un timer de reconexión previo (caída de red) que, si dispara,
      // reconectaría sin acción del usuario y rompería la supersession.
      clearTimeout(profile.reconnectTimer);
      profile.reconnectAttempts = 0;
      return;
    }
    scheduleProfileReconnect(profile);
  };

  ws.onerror = (err) => {
    log('error', `WebSocket error on profile: ${profile.bridgeUrl}`, err.message || 'unknown');
    state.stats.errors++;
  };

  // Keepalive ping
  clearInterval(profile.pingTimer);
  profile.pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }
  }, CONFIG.wsPingInterval);
}

/**
 * Schedule reconnect for a profile.
 */
function scheduleProfileReconnect(profile) {
  if (profile.reconnectTimer) clearTimeout(profile.reconnectTimer);
  if (CONFIG.maxReconnectAttempts > 0 && profile.reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    log('error', `Max reconnect attempts reached for profile: ${profile.bridgeUrl}`);
    return;
  }
  profile.reconnectAttempts++;
  state.stats.reconnects++;
  // Backoff: 1s, 2s, 3s... hasta max 10s
  const delay = Math.min(CONFIG.reconnectDelay * profile.reconnectAttempts, 10000);
  log('info', `Reconnecting profile: ${profile.bridgeUrl} in ${delay}ms (attempt ${profile.reconnectAttempts})`);
  profile.reconnectTimer = setTimeout(() => connectProfile(profile), delay);
}

/**
 * Disconnect a profile.
 */
function disconnectProfile(profileId) {
  const profile = profiles.get(profileId);
  if (!profile) return;
  if (profile.reconnectTimer) clearTimeout(profile.reconnectTimer);
  if (profile.pingTimer) clearInterval(profile.pingTimer);
  if (profile.ws) {
    try { profile.ws.close(1000, 'User disconnected'); } catch {}
    profile.ws = null;
  }
  profile.connected = false;
  profile.tabs.clear();
  // No eliminar del Map: el perfil debe poder reconectarse
}

/**
 * Reconnect all active profiles (called when config changes).
 */
function reconnectAllProfiles() {
  // Connect to profiles needed by current tabs AND re-send tab events
  refreshAllTabs();
}

// ============================================================
// Tab Management
// ============================================================

/**
 * Register a tab with its corresponding profile.
 */
function registerTab(tabId, url) {
  const profile = getProfileForUrl(url);
  if (!profile) {
    // Remove from any old profile
    for (const p of profiles.values()) {
      p.tabs.delete(tabId);
    }
    return;
  }

  // Remove from old profile if different
  for (const p of profiles.values()) {
    if (p.tabs.has(tabId) && p.id !== profile.id) {
      p.tabs.delete(tabId);
    }
  }

  profile.tabs.add(tabId);

  // Connect if not already
  if (!profile.connected) {
    connectProfile(profile);
  }
}

/**
 * Remove a tab from its profile.
 */
function unregisterTab(tabId) {
  for (const profile of profiles.values()) {
    if (profile.tabs.has(tabId)) {
      profile.tabs.delete(tabId);
      if (profile.ws && profile.ws.readyState === WebSocket.OPEN) {
        profile.ws.send(JSON.stringify({
          type: 'event',
          event: 'tabRemoved',
          tabId: tabId,
        }));
      }
      break;
    }
  }
}

/**
 * Scan all existing tabs and register them.
 */
async function refreshAllTabs() {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      registerTab(tab.id, tab.url);
    }
  } catch (err) {
    log('error', 'Failed to refresh tabs', err.message);
  }
}

// ============================================================
// Tab Event Listeners
// ============================================================
browser.tabs.onCreated.addListener((tab) => {
  registerTab(tab.id, tab.url);
});

browser.tabs.onRemoved.addListener((tabId) => {
  unregisterTab(tabId);
  navigatingTabs.delete(tabId); // fb-018-006 §2.2.7: sin tab no hay navegación que esperar
  recordNavGuard({ ev: 'removed', tabId });
  emitNavEvent('removed', tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // fb-018-006 §2.2.7 (enmienda P14): ciclo de vida de la navegación de
  // página completa — status loading añade, complete remueve. Único dueño del
  // ciclo junto al seed del handler `navigate` (mismo set, mismos dueños).
  // fb-020-007: los mismos eventos alimentan la espera previa y el watchdog
  // de inyecciones (SPA/pushState no cambia status: no deja huérfana nada).
  if (changeInfo.status || changeInfo.url) {
    recordNavGuard({ ev: 'updated', tabId, status: changeInfo.status, url: changeInfo.url });
  }
  if (changeInfo.status === 'loading') {
    navigatingTabs.add(tabId);
    emitNavEvent('loading', tabId);
  } else if (changeInfo.status === 'complete') {
    navigatingTabs.delete(tabId);
    emitNavEvent('complete', tabId);
  }
  if (changeInfo.url) {
    // URL changed — may need to switch profile
    registerTab(tabId, tab.url);
  } else if (changeInfo.title && tab.url) {
    // Title changed — send update to bridge
    const profile = getProfileForUrl(tab.url);
    if (profile && profile.ws && profile.ws.readyState === WebSocket.OPEN) {
      profile.ws.send(JSON.stringify({
        type: 'event',
        event: 'tabUpdated',
        tab: { id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId },
      }));
    }
  }
});

// fb-018-006 §2.2.7-B: espera el COMMIT de la navegación en vuelo del tab
// (tabs.onUpdated status complete — el nuevo documento recién existe como
// target del executeScript a partir del commit), con techo `ceilingMs`.
// Resuelve {committed, waitedMs}: committed=false si el techo venció — el
// caller corre el executeScript igual y FUERZA settled:false en la respuesta
// (I-A: nunca una respuesta de éxito sin frame; el veredicto in-page obtenido
// sobre el documento que le tocó no surfacea como true — el background manda,
// I-B conservador). Re-chequeo del set tras attach del listener: el commit
// pudo ocurrir entre el chequeo del caller y el attach (carrera de eventos).
// Registro/remoción one-shot: el listener solo vive durante la espera.
function waitForNavCommit(tabId, ceilingMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (committed) => {
      if (done) return;
      done = true;
      try { browser.tabs.onUpdated.removeListener(listener); } catch { /* noop */ }
      clearTimeout(timer);
      resolve({ committed, waitedMs: Math.max(0, Math.round(Date.now() - t0)) });
    };
    const listener = (updTabId, changeInfo) => {
      if (updTabId === tabId && changeInfo.status === 'complete') finish(true);
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), Math.max(0, ceilingMs));
    if (!navigatingTabs.has(tabId)) finish(true);
  });
}

// fb-020-002 §2.2 (P22): una escritura cuya inyección no devuelve resultado de
// página (documento descargado durante la espera, P-3) NUNCA surfacea como
// éxito vacío: es un error de la tool que declara el desenlace desconocido y
// manda a releer. `cause` conserva el mensaje original (si lo hubo) para no
// confundir un documento descargado con un bundle que no se inyectó.
function writeOutcomeUnknownError(tool, cause) {
  const detail = cause ? ` (${cause})` : '';
  return new Error(`${tool}: the page returned no result${detail} — the write may or may not have been dispatched; re-read the page with getFrame before retrying`);
}

// ============================================================
// fb-020-003 §2.2, §2.4: envoltorio de diálogos nativos (act click)
// ============================================================
// `installNativeDialogWatchMain` y `restoreNativeDialogWatchMain` vienen de
// `native-dialog-main.js`, cargado antes que este archivo en
// `background.scripts` (P24, fuente única). Se inyectan en `world:"MAIN"` con
// `func`; comparten con `readNativeDialog` (isolated world, mismo DOM) el
// atributo 'data-vulpo-native-dialog' como único canal entre mundos (§2.2).

// Latencia de sondeo del detector isolated (§2.4.1-2, R-3): la ventana de un
// click síncrono sin diálogo suele resolver el despacho antes del primer
// tick, así que el costo típico es UN executeScript de detección de más.
const NATIVE_DIALOG_DETECT_POLL_MS = 50;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instala el envoltorio MAIN antes del despacho (§2.4.6). Devuelve el booleano
// que devolvió la función MAIN (P25): `true` sólo si esta llamada quedó
// registrada como ventana viva. Si la instalación lanza (CSP u otro) o
// devuelve `false` (global ajena), el `act click` sigue como en 0.4.30 — sin
// envoltorio, sin detector, sin restore pendiente — y el caller no distingue
// el motivo.
async function installMainWorldNativeDialogWatch(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installNativeDialogWatchMain,
    });
    const installed = results?.[0]?.result === true;
    if (!installed) log('warn', 'act click: el envoltorio MAIN no quedó registrado, sigue sin él');
    return installed;
  } catch (err) {
    log('warn', 'act click: install del envoltorio MAIN falló, sigue sin él', err?.message || err);
    return false;
  }
}

// Cierra la ventana de este `act click` al terminar (§2.4.6, P25): la función
// MAIN descuenta una ventana viva y sólo restaura al llegar a cero. Tab
// inexistente o navegado: se ignora (I-2 no cierra nada, sólo intenta dejar
// la página como estaba).
async function restoreMainWorldNativeDialogWatch(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: restoreNativeDialogWatchMain,
    });
  } catch {
    /* tab cerrado o navegado: nada que restaurar (§2.4.6) */
  }
}

// Detector de la ventana del click (§2.4.1-2): sondea con executeScript
// isolated hasta encontrar una pregunta pendiente o hasta que `stopSignal`
// diga que el despacho ya terminó. Nunca rechaza: un tab cerrado/navegado
// durante el sondeo simplemente deja de encontrar nada más que reportar.
async function detectNativeDialog(tabId, stopSignal) {
  while (!stopSignal.stopped) {
    let results;
    try {
      results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => VulpoFrame.readNativeDialog(document),
      });
    } catch {
      return null; // tab cerrado/navegado durante el sondeo
    }
    if (stopSignal.stopped) return null;
    const nativeDialog = results?.[0]?.result;
    if (nativeDialog) return nativeDialog;
    await delay(NATIVE_DIALOG_DETECT_POLL_MS);
  }
  return null;
}

// act click con envoltorio + carrera despacho/detección (§2.4). El despacho
// (isolated, performActionAndObserve) corre en carrera con el detector; el
// que resuelva primero decide la respuesta. Si gana el detector, la llamada
// vuelve YA con {ok:true, nativeDialog} y el despacho sigue solo: cuando
// termine (o rechace, tarde, incluido por closeTab) sólo dispara la
// restauración — nunca una segunda respuesta ni writeOutcomeUnknownError
// (§2.4.3, I-7).
// fb-020-008 §2.3.2: `declaredWaitMs` explícito — con pliegue la espera
// declarada es la SUMA de los techos (§2.3.1), no sólo la del campo escrito.
// Ausente ⇒ el valor vigente, byte-idéntico (I-2).
function dispatchClick(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs = declaredWait(waitMs, 0)) {
  // fb-020-007 §2.2: el despacho se vigila; su rechazo por navegación ya es
  // writeOutcomeUnknownError (finishDispatch no lo re-envuelve).
  const dispatchPromise = watchTabInjection(tabId, 'act', () => browser.scripting.executeScript({
    target: { tabId },
    func: (r, a, v, f, wm, qm) => {
      const el = VulpoFrame.resolveRef(r, document.body);
      const options = { force: !!f };
      if (wm != null) options.waitMs = wm;
      if (qm != null) options.quietMs = qm;
      return VulpoFrame.performActionAndObserve(el, a, v, options);
    },
    args: [ref, 'click', value, !!force, waitMs ?? null, quietMs ?? null],
  }), command, declaredWaitMs);
  // Nunca deja la promesa original sin manejar: convierte el rechazo (p.ej.
  // closeTab, -32000) en un resultado, así una vuelta tardía nunca produce
  // un unhandled rejection ni, por sí sola, writeOutcomeUnknownError (§2.4.3).
  return dispatchPromise.then(
    (results) => ({ failed: false, results }),
    (err) => ({ failed: true, err }),
  );
}

async function performClickWithNativeDialogWatch(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs = declaredWait(waitMs, 0)) {
  const installed = await installMainWorldNativeDialogWatch(tabId);

  // P25: cada `act click` cuya instalación devolvió `true` cierra su ventana
  // exactamente una vez; una instalación que devolvió `false` o lanzó no
  // restaura. Por eso el default de `restore` es `installed`: el único camino
  // con `installed === false` es el de abajo, y todos los demás restauran.
  const finishDispatch = async (outcome, { restore = installed } = {}) => {
    if (restore) await restoreMainWorldNativeDialogWatch(tabId);
    if (outcome.failed && outcome.err?.navigatedWhileRunning) throw outcome.err;
    if (outcome.failed) throw writeOutcomeUnknownError('act', outcome.err?.message || String(outcome.err));
    const result = outcome.results?.[0]?.result;
    if (result == null) throw writeOutcomeUnknownError('act');
    if (result && navigatingTabs.has(tabId)) {
      return { ...result, invalidation: { ...(result.invalidation || {}), navigating: true } };
    }
    return result;
  };

  if (!installed) {
    // §2.4.6: instalación fallida ⇒ sigue como 0.4.30 (sin detector ni
    // restore: `restore` vale `installed`, o sea `false`).
    return finishDispatch(await dispatchClick(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs));
  }

  // §2.4.1: el disparo temprano es por DETECCIÓN dentro de ESTA ventana, no
  // por una pregunta que ya estaba pendiente al llegar la llamada — esa la
  // resuelve el guard de performActionAndObserve (P5) con ok:false, y no
  // puede competir por la carrera con el detector (si el detector ganara,
  // devolvería ok:true para lo que en realidad es un rechazo, P12). Por eso
  // esta lectura corre ANTES del despacho, no en paralelo con él.
  let alreadyPending;
  try {
    const pendingResults = await browser.scripting.executeScript({
      target: { tabId },
      func: () => VulpoFrame.readNativeDialog(document),
    });
    alreadyPending = !!pendingResults?.[0]?.result;
  } catch {
    alreadyPending = false; // tab cerrado/navegado: que decida el despacho
  }
  if (alreadyPending) {
    // La pregunta pendiente es de la ventana de un click ANTERIOR. Este
    // llamado igual abrió su propia ventana (su install devolvió `true` y
    // sumó una ventana viva, P25), así que la cierra una vez tras su despacho.
    // Es seguro: su restore sólo descuenta, y los envoltorios siguen puestos
    // mientras la ventana del dueño siga viva, incluido un segundo diálogo
    // abierto tras la respuesta humana (§2.4.4).
    return finishDispatch(await dispatchClick(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs));
  }

  const dispatchOutcome = dispatchClick(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs);
  const stopSignal = { stopped: false };
  const detectorPromise = detectNativeDialog(tabId, stopSignal);

  const winner = await Promise.race([
    dispatchOutcome.then((outcome) => ({ kind: 'dispatch', outcome })),
    detectorPromise.then((nativeDialog) => (nativeDialog ? { kind: 'dialog', nativeDialog } : null)),
  ]);

  stopSignal.stopped = true; // §2.4.2: el detector no sondea más allá de esto

  if (!winner) {
    // El detector no encontró nada (tab cerrado/navegado durante el sondeo,
    // §2.4.2) sin que el despacho hubiera resuelto todavía: el despacho
    // sigue siendo la única fuente de verdad.
    return finishDispatch(await dispatchOutcome);
  }

  if (winner.kind === 'dialog') {
    // §2.3, H-6: vuelta temprana con EXACTAMENTE estas dos claves. El
    // despacho sigue solo; su desenlace (o rechazo) tardío se descarta y
    // sólo dispara la restauración (§2.4.3, §2.4.6) — sin await acá, para
    // no bloquear la vuelta.
    dispatchOutcome.then(() => restoreMainWorldNativeDialogWatch(tabId));
    return { ok: true, nativeDialog: winner.nativeDialog };
  }

  // El despacho ganó la carrera (con o sin diálogo detectado a tiempo — L-1
  // incluido): la ventana terminó, se restaura y se responde su resultado.
  return finishDispatch(winner.outcome);
}

// fb-020-008 §1.3/I-1: ÚNICA ruta de lectura del mapa. La consumen el handler
// `getFrame` y el pliegue de `act`/`navigate`; no existe una segunda ruta de
// serialización. Devuelve el resultado CRUDO de la página (con `fingerprint`):
// con settle, `{frame, settled, waitedMs}`; sin settle, el mapa directo. La
// interpretación —marcador, `invalidation`, y la divergencia deliberada de
// §2.7 (throw en getFrame vs. degradación a `frameError` en el pliegue)— vive
// en cada caller.
// `options`: SOLO las claves de acotamiento presentes (§2.1.1/P8); las
// ausentes toman acá el mismo default que el camino vigente de `getFrame`.
async function injectFrameRead({
  tabId, options = {}, settle, waitMs, quietMs, command,
  kind = 'wait', declaredWaitMs = declaredWait(waitMs, 5000),
}) {
  const { page, maxElementsPerPage, include, roles, namedOnly } = options;
  // fb-018-006 §2.1: type-assert defensivo (precedente `force`) — settle no
  // booleano ⇒ camino plain (la espera no corre; settled/waitedMs nunca
  // aparecen, I-2). La barrera vive ACÁ, en la ruta compartida, así que vale
  // para el handler `getFrame` y para el pliegue por igual.
  const wantSettle = settle === true;
  await browser.scripting.executeScript({
    target: { tabId },
    files: ['frame-serializer.js'],   // re-inyectado (stateless)
  });
  const serialize = () => browser.scripting.executeScript({
    target: { tabId },
    func: (pg, limit, inc, rls, named, st, wm, qm) => {
      const opts = { page: pg, maxElementsPerPage: limit };
      // Los params opcionales llegan como null cuando el cliente MCP no los
      // manda (el handler Go inserta la clave igual): se omiten, nunca se
      // pasan como null — un filtro por default violaría I-A.
      if (inc != null) opts.include = inc;
      if (Array.isArray(rls)) opts.roles = rls;
      if (named != null) opts.namedOnly = named;
      if (!st) return VulpoFrame.serializeFrame(document.body, opts);
      // fb-020-003 §2.3 (Q7), premisa P-4: con una pregunta nativa pendiente
      // NO se llama a waitForSettle — cuelga con el diálogo abierto (medido).
      // Se serializa directo y se fuerza settled:false, sin esperar nada.
      if (VulpoFrame.readNativeDialog(document)) {
        return { frame: VulpoFrame.serializeFrame(document.body, opts), settled: false, waitedMs: 0 };
      }
      // fb-018-006 §2.2: settle:true — espera de quiescencia con observers
      // transitorios (settle.js) y UNA serialización por ciclo. serializeFn
      // cierra sobre root+options: los params de settle NUNCA entran a
      // serializeFrame (I-C — la huella sigue siendo función pura del DOM).
      return VulpoFrame.waitForSettle(document, { waitMs: wm, quietMs: qm },
        () => VulpoFrame.serializeFrame(document.body, opts));
    },
    args: [page ?? 1, maxElementsPerPage ?? 200, include ?? null, roles ?? null, namedOnly ?? null,
           wantSettle, waitMs ?? null, quietMs ?? null],
  });
  // fb-020-007 §2.2: sólo el camino settle devuelve una promesa in-page, y es
  // el único que se vigila (el plain no puede quedar huérfano esperando).
  const results = await (wantSettle
    ? watchTabInjection(tabId, kind, serialize, command, declaredWaitMs)
    : serialize());
  return results?.[0]?.result;
}

// fb-020-008 §2.7: la lectura del pliegue. Reusa `injectFrameRead` (I-1) y
// normaliza el desenlace a la forma que espera frame-fold.js: `{frame,
// settled?, waitedMs?}` con la huella incluida, `undefined` si la página no
// devolvió nada, o un rechazo marcado con `navigated` si la inyección quedó
// huérfana por una navegación (P13 — nunca writeOutcomeUnknownError('act')).
async function readFrameForFold(args, command, declaredWaitMs) {
  let result;
  try {
    result = await injectFrameRead({
      tabId: args.tabId,
      options: args.options,
      settle: args.settle,
      waitMs: args.waitMs,
      quietMs: args.quietMs,
      command,
      kind: args.kind,            // 'wait' (§2.7/P13)
      declaredWaitMs,
    });
  } catch (err) {
    if (err?.navigatedWhileRunning) throw Object.assign(new Error(err.message), { navigated: true });
    throw err;
  }
  if (!result) return undefined;  // sin resultado de inyección ⇒ frameError (P12)
  // El camino plain devuelve el mapa DIRECTO; sólo el settle lo envuelve. Se
  // ramifica por el settle PEDIDO (mismo type-assert que injectFrameRead), no
  // por la forma del resultado: con diálogo nativo el pliegue lee sin settle y
  // recibe un mapa pelado que una inspección de forma leería al revés.
  if (args.settle !== true) return { frame: result };
  return { frame: result.frame, settled: result.settled, waitedMs: result.waitedMs };
}

// fb-020-008 §2.2.7-A/I-1: el mapa plegado es el que habría devuelto getFrame,
// y getFrame marca `navigating` present-only cuando hay una navegación de
// página completa en vuelo al construir la respuesta. El módulo del pliegue no
// ve `navigatingTabs`: la marca se agrega acá, DENTRO de `frame.invalidation`
// (nunca colgando del nivel superior de la respuesta de la acción, §2.2).
function withNavigatingFlag(result, tabId) {
  if (!result?.frame || !navigatingTabs.has(tabId)) return result;
  return {
    ...result,
    frame: { ...result.frame, invalidation: { ...result.frame.invalidation, navigating: true } },
  };
}

// fb-017-002/fb-020-002: despacho vigente de `act` para las acciones que no
// son `click` (el click corre con el envoltorio de diálogo nativo, §2.4).
// Extraído del handler para que el pliegue despache por el MISMO camino.
async function performActInjection(tabId, ref, action, value, force, waitMs, quietMs, command, declaredWaitMs = declaredWait(waitMs, 0)) {
  // fb-020-007 §2.2: el rechazo por navegación ya es writeOutcomeUnknownError.
  const results = await watchTabInjection(tabId, 'act', () => browser.scripting.executeScript({
    target: { tabId },
    func: (r, a, v, f, wm, qm) => {
      const el = VulpoFrame.resolveRef(r, document.body);
      const options = { force: !!f };
      if (wm != null) options.waitMs = wm;
      if (qm != null) options.quietMs = qm;
      return VulpoFrame.performActionAndObserve(el, a, v, options);
    },
    args: [ref, action, value, !!force, waitMs ?? null, quietMs ?? null],
  }).catch((err) => {
    throw writeOutcomeUnknownError('act', err?.message || String(err));
  }), command, declaredWaitMs);
  const result = results?.[0]?.result;
  if (result == null) throw writeOutcomeUnknownError('act');
  // fb-018-006 §2.2.7-A (enmienda P14, 2026-09-08): act NO espera (solo el
  // settle de getFrame espera el commit) — pero la respuesta CARGA la
  // señal: `navigating: true` presente SOLO con navegación de página
  // completa en vuelo (I-2); sin ella la respuesta es byte-idéntica a la
  // vigente. Un act durante la navegación puede aterrizar en el documento
  // previo (el race de P14) — el flag lo hace visible para el agente.
  if (navigatingTabs.has(tabId)) {
    return { ...result, invalidation: { ...(result.invalidation || {}), navigating: true } };
  }
  return result;
}

// ============================================================
// Command Handlers (same as v0.2.1)
// ============================================================
const handlers = {
  async listTabs(params) {
    const queryInfo = params?.query || {};
    const tabs = await browser.tabs.query(queryInfo);
    return tabs.map(t => ({
      id: t.id, windowId: t.windowId, title: t.title, url: t.url,
      active: t.active, pinned: t.pinned, index: t.index,
    }));
  },

  async activateTab(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    const tab = await browser.tabs.get(tabId);
    await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tabId, { active: true });
    return { success: true, tabId, title: tab.title, url: tab.url };
  },

  async eval(params) {
    const { tabId, code } = params;
    if (!tabId) throw new Error('tabId required');
    if (!code) throw new Error('code required');
    if (!checkRateLimit()) throw new Error('Rate limit exceeded');
    if (code.length > CONFIG.maxEvalPerSecond * 2000) throw new Error('Code too large');

    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (agentCode) => {
        // Devuelve un objeto con { result, error } para que el host
        // pueda distinguir entre errores de ejecución reales y
        // valores de retorno undefined/null.
        try {
          const result = (0, eval)(agentCode);
          // If it's a promise, we can't wait for it in executeScript
          return { result: result !== undefined ? String(result) : undefined };
        } catch (e) {
          const errMsg = e.message || String(e);
          // Keep error message under 4KB
          return { error: errMsg.length > 4000 ? errMsg.substring(0, 4000) + '…[truncated]' : errMsg };
        }
      },
      args: [code],
    });
    return results?.[0]?.result || { html: '', length: 0 };
  },

  async getDom(params) {
    const { tabId, selector } = params;
    if (!tabId) throw new Error('tabId required');
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (sel, maxSize) => {
        const root = sel ? document.querySelector(sel) : document.body;
        if (!root) throw new Error('Element not found: ' + sel);
        const html = root.outerHTML || root.innerHTML || root.textContent || '';
        if (html.length > maxSize) {
          return { html: html.substring(0, maxSize) + `\n…[truncated at ${maxSize}]`, length: html.length };
        }
        return { html, length: html.length };
      },
      args: [selector || null, CONFIG.maxDomSize],
    });
    return results?.[0]?.result || { html: '', length: 0 };
  },

  // fb-020-008: `command` llega para que la inyección del pliegue se vigile
  // con el id real del comando (correlación del anillo de diagnóstico).
  async navigate(params, _profile, command) {
    const { tabId, url } = params;
    if (!tabId) throw new Error('tabId required');
    if (!url) throw new Error('url required');
    const previousUrl = await browser.tabs.get(tabId).then((tab) => tab.url, () => undefined);

    // fb-020-008 §2.6: el despacho y el sembrado son UNA sola definición,
    // compartida por el camino vigente y por el del pliegue — no hay una
    // segunda ruta de navegación que pueda divergir.
    const dispatchNavigation = async () => {
      await browser.tabs.update(tabId, { url });
      return { success: true, tabId, url };
    };
    // fb-018-006 §2.2.7 (enmienda P14): siembra el set ANTES de responder (o,
    // con pliegue, antes de cualquier lectura). Determinismo de la señal: un
    // getFrame/act posterior llega a este event page DESPUÉS de que esta
    // respuesta salió (los comandos viajan en orden por el mismo WS), así que
    // ve `navigating:true` aunque el onUpdated 'loading' aún no se haya
    // entregado. El ciclo de vida sigue siendo dueño de onUpdated (complete
    // remueve; onRemoved limpia).
    // fb-020-007: mismo determinismo para el watchdog — una inyección
    // pendiente queda huérfana ya, sin depender de cuándo llegue el onUpdated.
    const seedNavigating = (tid) => {
      navigatingTabs.add(tid);
      emitNavEvent('loading', tid);
    };

    // fb-020-008: con `frame`, el pliegue; sin él, la semántica de despacho
    // vigente, byte-idéntica (I-2/P20).
    if (params.frame && navigateWithFold) {
      // §2.3.2/P14: el módulo calcula la suma de los techos y la declara acá
      // ANTES de leer; el valor viaja como espera declarada del watchdog.
      let declaredMs = 0;
      const result = await navigateWithFold({
        params,
        navigateTab: dispatchNavigation,
        // fb-020-007 §9.4: un cambio solo de fragmento no recambia el
        // documento — ni marca ni loading sintético ni espera de commit (P19).
        replacesDocument: () => replacesDocument(previousUrl, url),
        seedNavigating,
        // §2.6/P18: se reusa la ÚNICA ruta de espera de commit del código, la
        // misma que consume el camino settle de getFrame. Techo: frame.waitMs.
        waitForNavCommit: ({ tabId: navTabId, waitMs }) => waitForNavCommit(navTabId, waitMs),
        readFrame: (args) => readFrameForFold(args, command, declaredMs),
        lastFrameByTab,
        declareWait: (ms) => { declaredMs = ms; },
      });
      return withNavigatingFlag(result, tabId);
    }

    const navResult = await dispatchNavigation();
    if (!replacesDocument(previousUrl, url)) return navResult;
    seedNavigating(tabId);
    return navResult;
  },

  async getCookies(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    const tab = await browser.tabs.get(tabId);
    const url = tab.url;
    if (!url || url === 'about:blank' || url.startsWith('about:') || url.startsWith('moz-extension://')) {
      throw new Error('Cannot get cookies for this tab URL: ' + (url || 'empty'));
    }
    const cookies = await browser.cookies.getAll({ url });
    return cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, session: c.session, sameSite: c.sameSite,
    }));
  },

  async click(params) {
    const { tabId, selector, flashDuration } = params;
    if (!tabId) throw new Error('tabId required');
    if (!selector) throw new Error('selector required');
    const duration = flashDuration ?? 1200; // ms, default ~1.2s
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (sel, dur) => {
        // Find the element first
        const el = document.querySelector(sel);
        if (!el) throw new Error('Element not found: ' + sel);
        el.scrollIntoView({ behavior: 'instant', block: 'center' });

        // ---- Visual click indicator ----
        // Three-stage sequence: large ring → medium ring → center flash
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const size = Math.max(rect.width * 2, rect.height * 2, 60);

        // Container for the overlay elements
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:999999;';
        document.body.appendChild(container);

        // Create overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:absolute;top:${cy - size / 2}px;left:${cx - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;border:4px solid transparent;box-sizing:border-box;`;
        container.appendChild(overlay);

        // Animate with requestAnimationFrame for smoothness
        const start = performance.now();
        const mainFlash = document.createElement('div');
        mainFlash.style.cssText = `position:absolute;top:${cy - 4}px;left:${cx - 4}px;width:8px;height:8px;border-radius:50%;background:#ff4444;opacity:0;box-sizing:border-box;`;
        container.appendChild(mainFlash);

        return new Promise(resolve => {
          function animate(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / dur, 1);

            if (progress < 0.3) {
              // Phase 1: Large expanding ring (red → green)
              const p = progress / 0.3;
              const r = p * 0.8 + 0.6;
              overlay.style.borderColor = `rgba(255, ${Math.floor(68 + (76 - 68) * p)}, ${Math.floor(68 + (175 - 68) * p)}, ${1 - p * 0.5})`;
              overlay.style.transform = `translate(-50%, -50%) scale(${r})`;
              overlay.style.top = `${cy}px`;
              overlay.style.left = `${cx}px`;
              overlay.style.width = `${size}px`;
              overlay.style.height = `${size}px`;
            } else if (progress < 0.6) {
              // Phase 2: Shrinking ring
              const p = (progress - 0.3) / 0.3;
              const r = 1.4 - p * 0.6;
              overlay.style.borderColor = `rgba(76, 175, 80, ${1 - p * 0.5})`;
              overlay.style.transform = `translate(-50%, -50%) scale(${r})`;
            } else {
              // Phase 3: Center flash + fade out
              const p = (progress - 0.6) / 0.4;
              overlay.style.opacity = `${1 - p}`;
              mainFlash.style.opacity = `${p < 0.5 ? p * 2 : (1 - p) * 2}`;
              mainFlash.style.backgroundColor = `rgba(255, ${Math.floor(255 - p * 100)}, ${Math.floor(200 - p * 200)}, ${p < 0.5 ? p * 2 : (1 - p) * 2})`;
            }

            if (progress >= 1) {
              container.remove();
              // ---- Click ----
              el.click();
              resolve({ clicked: true });
            } else {
              requestAnimationFrame(animate);
            }
          }
          requestAnimationFrame(animate);
        });
      },
      args: [selector, duration],
    });
    return results?.[0]?.result || { clicked: true };
  },

  async injectCSS(params) {
    const { tabId, css } = params;
    if (!tabId) throw new Error('tabId required');
    if (!css) throw new Error('css required');
    await browser.scripting.insertCSS({ target: { tabId }, css });
    return { success: true };
  },

  async highlight(params) {
    const { tabId, selector, x, y, width, height, color, label, duration, action } = params;
    if (!tabId) throw new Error('tabId required');

    // Visual-only indicator: NO modifica contenido ni estado de la página, por lo
    // que NO está en WRITE_TOOLS y queda usable en Plan mode (spec fb-002-003 §2.4).
    const borderColor = color || '#ff4400';
    const boxWidth = width ?? 50;
    const boxHeight = height ?? 50;
    const showFor = duration ?? 5000;

    if (action === 'clear') {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => {
          const nodes = window.__vulpoHighlights || [];
          nodes.forEach((n) => n.remove());
          window.__vulpoHighlights = [];
          return { success: true, cleared: true, count: nodes.length };
        },
      });
      return results?.[0]?.result || { success: true, cleared: true };
    }

    if (!selector && (x == null || y == null)) {
      throw new Error('selector or coordinates required');
    }

    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (sel, px, py, w, h, border, badgeText, ms) => {
        // Helper: añade canal alfa solo a colores hex (los no-hex se usan tal cual).
        const withAlpha = (c, a) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c + a : c);
        window.__vulpoHighlights = window.__vulpoHighlights || [];

        let box;
        let mode = 'coords';
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) throw new Error('Element not found: ' + sel);
          box = el.getBoundingClientRect();
          mode = 'selector';
        } else {
          box = { left: px, top: py, width: w, height: h };
        }

        const overlay = document.createElement('div');
        overlay.style.cssText =
          `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;` +
          `box-sizing:border-box;border:3px solid ${withAlpha(border, '80')};border-radius:4px;` +
          `background:${withAlpha(border, '26')};pointer-events:none;z-index:999999;`;
        document.body.appendChild(overlay);
        window.__vulpoHighlights.push(overlay);

        let badge = null;
        if (badgeText) {
          badge = document.createElement('div');
          badge.textContent = badgeText;
          badge.style.cssText =
            `position:fixed;left:${box.left}px;top:${box.top - 24}px;background:${border};color:#fff;` +
            `font:11px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;` +
            `pointer-events:none;z-index:999999;`;
          document.body.appendChild(badge);
          window.__vulpoHighlights.push(badge);
        }

        if (ms > 0) {
          setTimeout(() => {
            overlay.remove();
            if (badge) badge.remove();
            window.__vulpoHighlights = window.__vulpoHighlights.filter((n) => n !== overlay && n !== badge);
          }, ms);
        }

        return { success: true, mode, count: 1 };
      },
      args: [selector || null, x ?? null, y ?? null, boxWidth, boxHeight, borderColor, label || null, showFor],
    });
    if (!results?.[0]) {
      return { success: false, error: 'Execution failed' };
    }
    return results?.[0]?.result || { success: true, mode: selector ? 'selector' : 'coords', count: 0 };
  },

  async screenshot(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    try {
      // Captura SOLO el viewport visible (no full page). tabs.captureTab() requiere host_permission <all_urls> (ya declarado), NO un permiso 'captureTab'.
      const dataUrl = await browser.tabs.captureTab(tabId, { format: 'png' });
      return { dataUrl };
    } catch (error) {
      throw new Error('Capture failed: ' + (error?.message || String(error)));
    }
  },

  async getCurrentTab(params) {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return tab ? { id: tab.id, title: tab.title, url: tab.url } : null;
  },

  async openTab(params) {
    const { url, active } = params;
    if (!url) throw new Error('url required');
    const tab = await browser.tabs.create({ url, active: active ?? true });
    return { id: tab.id, title: tab.title, url: tab.url };
  },

  async closeTab(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    await browser.tabs.remove(tabId);
    return { success: true, tabId };
  },

  async goBack(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    try {
      await browser.tabs.goBack(tabId);
      return { success: true, wentBack: true };
    } catch (err) {
      // No hay historial previo: no es un error, solo no se navegó.
      log('warn', 'goBack failed (no history?)', err);
      return { success: true, wentBack: false };
    }
  },

  async goForward(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    try {
      await browser.tabs.goForward(tabId);
      return { success: true, wentForward: true };
    } catch (err) {
      // No hay historial siguiente: no es un error, solo no se navegó.
      log('warn', 'goForward failed (no history?)', err);
      return { success: true, wentForward: false };
    }
  },

  async fill(params) {
    const { tabId, selector, value } = params;
    if (!tabId) throw new Error('tabId required');
    if (selector === undefined || selector === null) throw new Error('selector required');
    if (value === undefined || value === null) throw new Error('value required');
    // fb-020-002 §2.2: fill escribe y observa vía VulpoFrame.performFill
    // (guard :disabled + claves de observación); el bundle se re-inyecta
    // (stateless, igual que act). `selector` se agrega a toda respuesta.
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['frame-serializer.js'],
    });
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (sel, val) => {
        // fb-020-004 §2.5: selector inválido o sin coincidencia es un
        // resultado explícito (sin escribir), no un throw — un throw llega
        // como "desenlace desconocido" (writeOutcomeUnknownError).
        let el;
        try {
          el = document.querySelector(sel);
        } catch (e) {
          return { success: false, invalidSelector: true, error: 'Invalid selector: ' + sel + ' (' + e.message + ')', selector: sel };
        }
        if (!el) return { success: false, notFound: true, error: 'Element not found: ' + sel, selector: sel };
        return VulpoFrame.performFill(el, val).then((response) => ({ ...response, selector: sel }));
      },
      args: [selector, value],
    });
    const result = results?.[0]?.result;
    if (result == null) throw writeOutcomeUnknownError('fill');
    return result;
  },

  async waitForElement(params, _profile, command) {
    const { tabId, selector, timeout = 5000, visible = true } = params;
    if (!tabId) throw new Error('tabId required');
    if (!selector) throw new Error('selector required');
    // fb-020-007 §2.2: una navegación deja huérfana la espera in-page.
    const results = await watchTabInjection(tabId, 'wait', () => browser.scripting.executeScript({
      target: { tabId },
      func: (sel, maxWait, requireVisible) =>
        new Promise((resolve) => {
          const POLL_MS = 200;
          const start = Date.now();
          const check = () => {
            const el = document.querySelector(sel);
            if (el && (!requireVisible || (el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0))) {
              resolve({ found: true });
              return;
            }
            if (Date.now() - start >= maxWait) {
              resolve({ found: false, timeout: true });
              return;
            }
            setTimeout(check, POLL_MS);
          };
          check();
        }),
      args: [selector, timeout, visible],
    }), command, declaredWait(timeout, 0));
    return results?.[0]?.result;
  },

  // fb-017-002 (frame-map-api). getFrame: read — serializa el Frame contract
  // (sections/read paginado, `do` opt-in vía `include`) inyectando el bundle
  // del frame (isolated world) y llamando VulpoFrame.serializeFrame sobre
  // document.body. NO está en WRITE_TOOLS: es lectura pura (D2).
  // fb-017-004 (enmienda HITL): diff stateless — el estado del isolated world
  // no persiste entre executeScript calls (verificado E2E), así que la
  // generación por MutationObserver se resetea en cada call.
  // fb-018-001 §2.3: el cambio se detecta comparando la HUELLA del contenido
  // observable completo del documento (`fingerprint`, función pura del DOM)
  // contra la última por tab — no el JSON del payload ya paginado, que hacía
  // que un cambio de query se reportara como cambio de página (H5). La huella
  // NO viaja al cliente: se elimina de la respuesta acá (I7: primera llamada y
  // resets ⇒ changedSinceLast:true, nunca falso negativo; I9: no muta nada).
  async getFrame(params, _profile, command) {
    const { tabId, page, maxElementsPerPage, include, roles, namedOnly, settle, waitMs, quietMs } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-018-006 §2.2.7-B (enmienda 2026-09-08, P14 falsado en campo): con
    // settle:true y una navegación de página completa en vuelo, el
    // executeScript aterrizaría en el DOCUMENTO PREVIO (quieto si el loader
    // es overlay CSS-animated: cero mutaciones ⇒ el wait certificaría
    // settled:true sobre contenido ya inexistente). Se espera el commit de
    // la navegación ANTES de seguir — techo waitMs (vencido ⇒ se corre igual
    // y abajo se FUERZA settled:false: el veredicto in-page obtenido sobre el
    // documento que le tocó no surfacea como true, I-A/I-B). La INYECCIÓN
    // también espera: un bundle inyectado en el doc previo se pierde con él
    // y el documento nuevo quedaría sin VulpoFrame. El camino plain NUNCA
    // espera (misma carrera preexistente — ahora visible vía `navigating`,
    // §2.2.7-A). SPA/pushState no dispara onUpdated ⇒ nunca entra acá.
    let commitTimedOut = false;
    if (settle === true && navigatingTabs.has(tabId)) {
      // Techo del commit-wait: waitMs explícito, o el default de settle.js
      // (DEFAULT_WAIT_MS=5000) — duplicado acá a propósito: los defaults de
      // waitMs/quietMs viven SOLO en settle.js (§2.1) y el background no
      // puede leer constantes del content script.
      const ceiling = typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0
        ? waitMs : 5000;
      const commit = await waitForNavCommit(tabId, ceiling);
      commitTimedOut = !commit.committed;
    }
    // fb-018-006 §2.1: type-assert defensivo (precedente `force`) — settle no
    // booleano ⇒ camino plain (la espera no corre; settled/waitedMs nunca
    // aparecen, I-2). El handler Go ya degrada no-booleanos a clave ausente;
    // `=== true` es la segunda barrera.
    const wantSettle = settle === true;
    // fb-020-008 §1.3/I-1: la serialización corre por la ruta compartida con
    // el pliegue (injectFrameRead). Espera declarada: waitMs, o el default de
    // settle.js (5000, ver arriba).
    const result = await injectFrameRead({
      tabId,
      options: { page, maxElementsPerPage, include, roles, namedOnly },
      settle: wantSettle,
      waitMs,
      quietMs,
      command,
      kind: 'wait',
      declaredWaitMs: declaredWait(waitMs, 5000),
    });
    if (!result) return result;
    if (!wantSettle) {
      // Camino plain: byte-idéntico al vigente (§0.2 — sin settle, ni espera
      // ni claves nuevas) SALVO la ÚNICA aditiva de la enmienda P14
      // (§2.2.7-A, 2026-09-08): `navigating: true` presente SOLO con
      // navegación de página completa en vuelo (I-2 — ausente, nunca false).
      const { fingerprint, ...payload } = result;
      const prev = lastFrameByTab.get(tabId);
      const changedSinceLast = prev === undefined ? true : fingerprint !== prev;
      lastFrameByTab.set(tabId, fingerprint);
      const invalidation = { changedSinceLast };
      if (navigatingTabs.has(tabId)) invalidation.navigating = true;
      return { ...payload, invalidation };
    }
    // fb-018-006 §2.3: settle → {settled, waitedMs, frame}. El frame settled
    // ES el mapa estable: actualiza la huella por tab igual que el camino
    // plain (P13 — la re-lectura plain inmediata ⇒ changedSinceLast:false).
    // settled/waitedMs presentes SI Y SOLO SI se pidió settle (I-2: presentes
    // ⇔ pedido; nunca false/0 por defecto).
    // §2.2.5 enmendado (review OPCIONAL-2 a contrato): frame == null ⇒ la
    // serialización falló (serializeFn lanzó). Se PROPAGA error — misma clase
    // que el camino plain, donde un serializer roto es una excepción — en vez
    // de emitir una respuesta con forma de éxito sin mapa: el agente leería
    // el mapa vacío como "página vacía genuina" (estado (a) de la tabla de
    // decisión §1.3).
    if (result.frame == null) {
      throw new Error('getFrame(settle): serialization failed — no frame produced (settled:false)');
    }
    const { fingerprint, ...payload } = result.frame;
    const prev = lastFrameByTab.get(tabId);
    const changedSinceLast = prev === undefined ? true : fingerprint !== prev;
    lastFrameByTab.set(tabId, fingerprint);
    // fb-018-006 §2.2.7-B: si el techo del commit-wait venció, el veredicto
    // in-page NO surfacea como true — el background FUERZA settled:false
    // (se corrió sobre el documento que le tocó, no sobre el destino).
    // Sin vencimiento, el veredicto in-page vale tal cual.
    const invalidation = {
      changedSinceLast,
      settled: !commitTimedOut && result.settled === true,
      waitedMs: result.waitedMs,
    };
    // §2.2.7-A: `navigating: true` presente SOLO si la navegación sigue en
    // vuelo al construir la respuesta (I-2) — p.ej. commit vencido por
    // waitMs con la carga aún pendiente.
    if (navigatingTabs.has(tabId)) invalidation.navigating = true;
    return { ...payload, invalidation };
  },

  // fb-017-002 (frame-map-api). act: write (gated por WRITE_TOOLS / Plan mode).
  // Re-resuelve el ref con VulpoFrame.resolveRef y ejecuta la acción vía
  // VulpoFrame.performAction; si el ref no resuelve → {ok:false, stale:true}.
  // fb-018-004 §2.7: pasa `force` a través de executeScript hasta performAction.
  // fb-020-002 §2.2: la acción corre vía performActionAndObserve (type con
  // ok:true espera y observa el campo; el resto responde como performAction).
  // Se devuelve la Promise desde la func inyectada (patrón getFrame/settle).
  // waitMs/quietMs viajan sólo si vienen; los defaults viven en el bundle.
  async act(params, _profile, command) {
    const { tabId, ref, action, value, force, waitMs, quietMs } = params;
    if (!tabId) throw new Error('tabId required');
    if (!ref) throw new Error('ref required');
    if (!action) throw new Error('action required');
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['frame-serializer.js'],
    });
    // fb-020-003 §1.3, §2.4, H-7: SÓLO `click` instala el envoltorio y corre
    // en carrera con el detector (§2.2, §14). `type`/`focus`/`select` no
    // cambian: el guard de pregunta pendiente ya corre dentro del bundle
    // (`performActionAndObserve`, `observe.js`).
    // fb-020-008: el pliegue despacha por ESTE mismo camino (las dos ramas),
    // no por una copia — incluido el click, que es el caso central de la
    // feature (§2.4/P23: un click que ABRE un diálogo devuelve ok:true y el
    // pliegue corre igual, sin esperar).
    const dispatchAct = (declaredWaitMs) => (action === 'click'
      ? performClickWithNativeDialogWatch(tabId, ref, value, force, waitMs, quietMs, command, declaredWaitMs)
      : performActInjection(tabId, ref, action, value, force, waitMs, quietMs, command, declaredWaitMs));

    // Sin `frame`: respuesta y timing vigentes, byte-idénticos (I-2).
    if (!params.frame || !actWithFold) return dispatchAct(declaredWait(waitMs, 0));

    // fb-020-008 §2.3.2/P14: la espera declarada del pliegue es la SUMA de los
    // techos; el módulo la calcula y la declara ANTES de despachar, y el valor
    // viaja como espera declarada de las DOS inyecciones (acción y lectura).
    let declaredMs = declaredWait(waitMs, 0);
    const result = await actWithFold({
      params,
      performAction: () => dispatchAct(declaredMs),
      readFrame: (args) => readFrameForFold(args, command, declaredMs),
      lastFrameByTab,
      declareWait: (ms) => { declaredMs = ms; },
      // Bloqueante cerrado (review fb-020-008 §1): reproduce la precondición
      // de getFrame(settle) también en el pliegue de `act` — reusa la ÚNICA
      // ruta de espera de commit (misma que navigateWithFold/getFrame,
      // §2.6/§1.3/I-1). El techo lo calcula el módulo (frame.waitMs).
      waitForNavCommit: ({ tabId: actTabId, waitMs: ceilingMs }) => waitForNavCommit(actTabId, ceilingMs),
    });
    return withNavigatingFlag(result, tabId);
  },

  async axSnapshot(params) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const MAX_ELEMENTS = 200;
        const MAX_LABEL_LEN = 120;
        const MAX_PAYLOAD = 100000;

        const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const truncate = (s) => (s.length <= MAX_LABEL_LEN ? s : s.slice(0, MAX_LABEL_LEN) + '…');

        const roleOf = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'button') return 'button';
          if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
          if (tag === 'input') {
            const type = (el.type || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'button' || type === 'submit' || type === 'reset' || type === 'file') return 'button';
            if (type === 'range') return 'slider';
            return 'textbox';
          }
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'summary') return 'button';
          if (el.isContentEditable) return 'textbox';
          return 'generic';
        };

        const labelOf = (el) => {
          let label = cleanText(el.getAttribute('aria-label'));
          if (!label) {
            const ids = el.getAttribute('aria-labelledby');
            if (ids) {
              label = ids
                .split(/\s+/)
                .map((id) => {
                  const ref = document.getElementById(id);
                  return ref ? cleanText(ref.textContent) : '';
                })
                .filter(Boolean)
                .join(' ');
            }
          }
          if (!label && el.id) {
            const forLabel = labelsByFor.get(el.id);
            if (forLabel) label = cleanText(forLabel.textContent);
          }
          if (!label) {
            const wrapLabel = el.closest('label');
            if (wrapLabel) label = cleanText(wrapLabel.textContent);
          }
          if (!label) label = cleanText(el.getAttribute('title'));
          if (!label) {
            const tag = el.tagName.toLowerCase();
            const role = roleOf(el);
            if (tag === 'button' || tag === 'a' || tag === 'summary' || role === 'button' || role === 'link') {
              label = cleanText(el.textContent);
            }
          }
          if (!label) label = cleanText(el.getAttribute('placeholder'));
          return truncate(label);
        };

        const selectorOf = (el) => {
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
            const tag = node.tagName.toLowerCase();
            let nth = 1;
            let sib = node.previousElementSibling;
            while (sib) {
              if (sib.tagName.toLowerCase() === tag) nth += 1;
              sib = sib.previousElementSibling;
            }
            parts.unshift(`${tag}:nth-of-type(${nth})`);
            node = node.parentElement;
          }
          return `html > ${parts.join(' > ')}`;
        };

        const valueOf = (el) => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'input') {
            const type = (el.type || '').toLowerCase();
            if (type === 'checkbox' || type === 'radio') return { checked: !!el.checked };
            // Privacy: password/hidden values (credentials, CSRF tokens) never leave the page.
            // File inputs expose only a fake local path (C:\fakepath\...) — omit entirely.
            if (type === 'password' || type === 'hidden') return { masked: true };
            if (type === 'file') return {};
            return { value: el.value };
          }
          if (tag === 'textarea') return { value: el.value };
          if (tag === 'select') {
            const option = el.options[el.selectedIndex];
            return { value: option ? cleanText(option.textContent) : '' };
          }
          return null;
        };

        // Build the label[for] lookup once instead of re-scanning all <label> elements per unlabeled element.
        const labelsByFor = new Map();
        for (const labelEl of document.querySelectorAll('label')) {
          if (labelEl.htmlFor) labelsByFor.set(labelEl.htmlFor, labelEl);
        }

        const nodes = Array.from(
          document.querySelectorAll(
            'a[href], button, input, select, textarea, [role], [tabindex], [onclick], summary, [contenteditable]'
          )
        ).filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
        if (nodes.length > MAX_ELEMENTS) nodes.length = MAX_ELEMENTS;

        const info = new Map(); // el -> { ref, depth, parentEl, role, label } (role/label memoized once)
        const nearestInteractive = (el) => {
          let anc = el.parentElement;
          while (anc) {
            if (info.has(anc)) return anc;
            anc = anc.parentElement;
          }
          return null;
        };

        for (let i = 0; i < nodes.length; i += 1) {
          const el = nodes[i];
          const ref = `e${i + 1}`;
          const nearest = nearestInteractive(el);
          let depth = nearest ? info.get(nearest).depth + 1 : 0;
          let parentEl = nearest;
          if (depth > 8) {
            let anc = nearest;
            while (anc && info.get(anc).depth > 8) anc = nearestInteractive(anc);
            parentEl = anc;
            depth = 9;
          }
          info.set(el, { ref, depth, parentEl, role: roleOf(el), label: labelOf(el) });
        }

        const elements = nodes.map((el) => {
          const { ref, role, label } = info.get(el);
          const entry = { ref, role, label };
          const value = valueOf(el);
          if (value) Object.assign(entry, value);
          entry.tag = el.tagName.toLowerCase();
          entry.selector = selectorOf(el);
          return entry;
        });

        const childrenByRef = new Map();
        for (const [el, d] of info) {
          if (d.parentEl) {
            const parentRef = info.get(d.parentEl).ref;
            if (!childrenByRef.has(parentRef)) childrenByRef.set(parentRef, []);
            childrenByRef.get(parentRef).push(d.ref);
          }
        }
        const snapshot = nodes.map((el) => {
          const { ref, role, label } = info.get(el);
          return { ref, role, name: label, children: childrenByRef.get(ref) || [] };
        });

        const result = { snapshot, elements };
        if (JSON.stringify(result).length > MAX_PAYLOAD) {
          let bestCount = 0;
          for (let n = 0; n <= nodes.length; n += 1) {
            const partial = { snapshot: snapshot.slice(0, n), elements: elements.slice(0, n), truncated: true };
            if (JSON.stringify(partial).length <= MAX_PAYLOAD) bestCount = n;
            else break;
          }
          const kept = new Set(elements.slice(0, bestCount).map((e) => e.ref));
          return {
            snapshot: snapshot
              .slice(0, bestCount)
              .map((node) => ({ ...node, children: node.children.filter((c) => kept.has(c)) })),
            elements: elements.slice(0, bestCount),
            truncated: true,
          };
        }
        return result;
      },
      args: [],
    });
    return results?.[0]?.result;
  },

  async togglePlanMode(params, profile) {
    const profileId = profile.id;
    if (!profile) throw new Error(`Profile "${profileId}" not found`);
    profile.planMode = !profile.planMode;
    log('info', `Plan mode for ${profileId}: ${profile.planMode ? 'ON' : 'OFF'}`);
    return { profileId, planMode: profile.planMode };
  },

  // ---- Odoo Bridge (fb-013-002) ----
  // 12 commands wire. Los helpers internos (odooRpc/odooSessionInfo) están
  // definidos fuera de `handlers` (funciones de módulo, NO invocables desde
  // el agente). La construcción del wire, la clasificación de la respuesta y
  // la agregación de detección viven en el módulo session-probe (fb-019-001,
  // testado en node — spec §9.1), cargado como bundle previo del event page
  // (manifest background.scripts).

  // No requiere tabId obligatorio: itera los tabs del perfil ya domain-matchetos,
  // sondea cada uno y clasifica (fb-019-001 §2.3). Sin tabs candidatos → []
  // sin error; ≥1 candidato y NINGUNO con sesión válida → throw clasificado
  // por tab (el error sobrevive el round-trip hasta el agente — §2.3.3).
  // fb-020-007 §2.1/§2.2 (P14): sondas en paralelo, cada una con espera previa
  // y watchdog; toda falla (tab cerrado, huérfana, espera vencida) → clase (a).
  async odooDetectTabs(params, profile, command) {
    const tabs = await Promise.all([...profile.tabs].map(async (tabId) => ({
      tabId,
      url: await browser.tabs.get(tabId).then((tab) => tab.url, () => undefined),
    })));
    // fb-020-007 §9.2: cada sonda late desde su página con el id de este comando.
    const tracked = [];
    const probe = async (tabId) => {
      recordNavGuard({ ev: 'dispatch', id: command?.id, kind: 'probe', tabId });
      const dispatch = trackPageDispatch(tabId, 'probe', command);
      tracked.push(dispatch);
      const { state, info, message } = await probeSession(tabId, dispatch.token, HEARTBEAT_MS);
      const entry = { tabId, url: tabs.find((tab) => tab.tabId === tabId).url, state };
      if (state === 'valid') entry.info = info;
      if (message) entry.message = message;
      return entry;
    };
    const entries = await probeTabsGuarded({
      tabs, probe, isNavigating: isTabNavigating, events: navEvents, getStatus: readTabStatus, clearNavigating,
      // §9.6: el anillo registra el desenlace de cada sonda, por pestaña.
      onOutcome: ({ outcome, error, tabId }) => recordNavGuard({ ev: outcome, id: command?.id, kind: 'probe', tabId, error: error?.message }),
    });
    tracked.forEach((dispatch) => dispatch.release());
    return aggregateDetection(entries);
  },

  async odooGetVersion(params, _profile, command) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    // Mapeo por clase (fb-019-001 §2.4): 'valid' → shape actual; 'expired'/
    // 'detection-failed' → throw clasificado. Jamás success con campos null.
    // fb-019-002 (C-1 parity-plus, F-7 ruta a): merge ADITIVO sobre el shape
    // pineado de versionResult (P4a) — server_version/server_version_info
    // viajan SOLO si el probe del tab los trae (mixed-version degrada, nunca
    // rompe — spec §2.0.3).
    const probe = await odooSessionInfo(tabId, command);
    const result = versionResult(probe);
    if (probe && probe.state === 'valid' && probe.info) {
      if (probe.info.server_version !== undefined) {
        result.server_version = probe.info.server_version;
      }
      if (probe.info.server_version_info !== undefined) {
        result.server_version_info = probe.info.server_version_info;
      }
      // fb-020-002 §2.2: merge ADITIVO de lang/decimal_point/thousands_sep
      // (presencia opcional, nunca null — I-8). Una falla de la lectura de
      // res.lang degrada a {lang}; get_version no falla por esto.
      Object.assign(result, await sessionLanguageConvention(tabId, probe.info, command));
    }
    return result;
  },

  async odooSearchRead(params, _profile, command) {
    const { tabId, model, domain, fields, limit, offset, order } = params;
    if (!tabId) throw new Error('tabId required');
    const r = await odooRpc(tabId, model, 'search_read', [domain], { fields, limit, offset, order }, { command });
    return unwrapRpcResult(r);
  },

  async odooSearchCount(params, _profile, command) {
    const { tabId, model, domain } = params;
    if (!tabId) throw new Error('tabId required');
    const r = await odooRpc(tabId, model, 'search_count', [domain], {}, { command });
    return unwrapRpcResult(r);
  },

  async odooListModels(params, _profile, command) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    const r = await odooRpc(tabId, 'ir.model', 'search_read', [[]], { fields: ['model', 'name'], limit: 200 }, { command });
    return unwrapRpcResult(r);
  },

  async odooListFields(params, _profile, command) {
    const { tabId } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-019-002 (D-9/C-4): attributes opcional + default con help. La
    // construcción de params vive en el módulo session-probe (listFieldsParams,
    // enmienda §9.1bis-bis — testada en node); la func inyectada recibe el
    // request como argumento serializable (mismo patrón de la sonda).
    const listParams = listFieldsParams(params.model, params.attributes);
    const r = await odooRpc(tabId, listParams.model, 'fields_get', [], { attributes: listParams.attributes }, { command });
    return unwrapRpcResult(r);
  },

  async odooCreate(params, _profile, command) {
    const { tabId, model, values } = params;
    if (!tabId) throw new Error('tabId required');
    const r = await odooRpc(tabId, model, 'create', [values], {}, { kind: 'orm-write', command });
    return unwrapRpcResult(r);
  },

  async odooWrite(params, _profile, command) {
    const { tabId, model, ids, values } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-019-002 field-verification: single-wrap — el wire ya trae los arrays
    // (el doble-wrap histórico producía browse([[ids]]) → Odoo Server Error).
    const r = await odooRpc(tabId, model, 'write', [ids, values], {}, { kind: 'orm-write', command });
    return unwrapRpcResult(r);
  },

  async odooUnlink(params, _profile, command) {
    const { tabId, model, ids } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-019-002 field-verification: single-wrap (doble-wrap → browse([[ids]])).
    const r = await odooRpc(tabId, model, 'unlink', [ids], {}, { kind: 'orm-write', command });
    return unwrapRpcResult(r);
  },

  async odooImportRecords(params, _profile, command) {
    const { tabId, model, fields, records } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-019-002 field-verification: single-wrap (doble-wrap → Server Error en load).
    const r = await odooRpc(tabId, model, 'load', [fields, records], {}, { kind: 'orm-write', command });
    return unwrapRpcResult(r);
  },

  async odooExportRecords(params, _profile, command) {
    const { tabId, model, ids, fields } = params;
    if (!tabId) throw new Error('tabId required');
    // fb-019-002 field-verification: single-wrap (doble-wrap → Server Error en export_data).
    const r = await odooRpc(tabId, model, 'export_data', [ids, fields], {}, { command });
    return unwrapRpcResult(r);
  },

  async odooExecuteKw(params, _profile, command) {
    const { tabId, model, method, args, kwargs } = params;
    if (!tabId) throw new Error('tabId required');
    const r = await odooRpc(tabId, model, method, args, kwargs, { kind: 'orm-write', command });
    return unwrapRpcResult(r);
  },
};

// ============================================================
// Odoo Bridge helpers (fb-013-002) — funciones de módulo, NO commands wire.
// No se exponen al agente (no están en `handlers` ni en WRITE_TOOLS).
// fb-019-001: la construcción del wire, la clasificación de la respuesta, la
// agregación de detección, el mapping de get_version y el unwrap RPC viven en
// el módulo session-probe (testado en node — spec §9.1/§9.1bis), cargado como
// bundle previo del event page: manifest background.scripts
// [session-probe-bundle.js, background.js] (script clásico, mismo scope).
// ============================================================

const {
  probeRequest,
  rpcRequest,
  classifyProbeResponse,
  aggregateDetection,
  versionResult,
  languageConvention,
  unwrapRpcResult,
  listFieldsParams,
  classifyInjectionFailure,
} = globalThis.VulpoSessionProbe;

// fb-020-002 §2.2 (get_version): convención numérica del usuario de la
// sesión. `lang` sale de la sonda (validada por languageConvention); con
// `lang`, UNA lectura de res.lang por code. Cualquier falla (inyección
// rechazada, error RPC, sin result) degrada a languageConvention(info,
// undefined); una forma inesperada la descarta languageConvention misma.
async function sessionLanguageConvention(tabId, info, command) {
  const { lang } = languageConvention(info, undefined);
  if (!lang) return {};
  try {
    const r = await odooRpc(tabId, 'res.lang', 'search_read', [[['code', '=', lang]]],
      { fields: ['decimal_point', 'thousands_sep'] }, { command });
    return languageConvention(info, unwrapRpcResult(r));
  } catch {
    return languageConvention(info, undefined);
  }
}

// Ejecuta el RPC Odoo DENTRO del tab vía executeScript. El content script
// (isolated world) ejecuta fetch same-origin → la session cookie del navegador
// (SameSite=Lax) viaja y autentica la llamada. El wire lo construye rpcRequest
// (módulo session-probe, guard P6 — §2.5); la func inyectada es self-contained
// (recibe el request como argumento serializable) y conserva el guard HTML de
// content-type como fallback conservador (D-4).
// fb-020-006 §2.4: si la inyección rechaza o no devuelve resultado, lanza
// `odoo_tab_unreachable: …` (classifyInjectionFailure) en vez del texto
// genérico de Firefox; los errores RPC de Odoo siguen por unwrapRpcResult.
// fb-020-007 §2.1/§2.2: espera la navegación en vuelo antes del único
// despacho y rechaza si la navegación deja la inyección huérfana. `kind`:
// 'orm-write' para create/write/unlink/load/execute_kw, 'orm-read' el resto.
async function odooRpc(tabId, model, method, args, kwargs, { kind = 'orm-read', command } = {}) {
  const req = rpcRequest(model, method, args, kwargs);
  const inject = (token, heartbeatMs) => browser.scripting.executeScript({
    target: { tabId },
    func: pageOdooFetch,
    args: ['rpc', req, token, heartbeatMs],
  }).then((results) => {
    // Sin resultado es una falla de la inyección (fb-020-006 §2.4): así el
    // watchdog la reporta como navegación si la pestaña navegó (I-3). Una
    // escritura sin resultado pudo haberse despachado (§9.3).
    const result = results?.[0]?.result;
    if (result === undefined || result === null) throw noResultError(tabId, kind);
    return result;
  }, (cause) => {
    throw new Error(classifyInjectionFailure(tabId, cause));
  });
  return injectAfterNav(tabId, kind, inject, command);
}

// fb-020-007 §9.2: función inyectada de los fetch ORM ('rpc') y de la sonda
// ('probe'). Autocontenida: executeScript no transporta closures, por eso
// lleva una copia textual de pageHeartbeat (canónica y testeada en
// extension/nav-guard.js) y late desde la página mientras su fetch sigue
// pendiente. Si el documento muere, el latido se corta con él.
function pageOdooFetch(mode, req, token, heartbeatMs) {
  const pageHeartbeat = function pageHeartbeat({ token, sendMessage, heartbeatMs, run, setInterval, clearInterval }) {
    const beat = () => {
      try {
        Promise.resolve(sendMessage({ type: 'fb-progress', token })).catch(() => {});
      } catch (_) {
        // latido perdido: el hub decide por inactividad
      }
    };
    // O-1: latido inicial en t=0, antes del primer intervalo — recupera margen
    // frente al throttling de timers de las pestañas en segundo plano.
    beat();
    const handle = setInterval(beat, heartbeatMs);
    let pending;
    try {
      pending = Promise.resolve(run());
    } catch (err) {
      pending = Promise.reject(err);
    }
    return pending.then(
      (value) => {
        clearInterval(handle);
        return value;
      },
      (err) => {
        clearInterval(handle);
        throw err;
      },
    );
  };
  const rpc = async () => {
    const res = await fetch(req.url, req.init);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // Odoo session expired → HTML redirect to /web/login
      return { error: { message: 'Odoo session expired. Please re-login in the tab.' } };
    }
    return res.json();
  };
  const probe = async () => {
    try {
      const res = await fetch(req.url, req.init);
      const contentType = res.headers.get('content-type') || '';
      let json;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { contentType, status: res.status, json };
    } catch {
      return { rejected: true };
    }
  };
  return pageHeartbeat({
    token,
    heartbeatMs,
    sendMessage: (message) => browser.runtime.sendMessage(message),
    run: mode === 'probe' ? probe : rpc,
    setInterval,
    clearInterval,
  });
}

// Sonda de sesión (fb-019-001, spec §2.1): POST JSON-RPC a
// /web/session/get_session_info dentro del tab. Devuelve la CLASIFICACIÓN del
// módulo ({state, info?, message?} — §2.2): la func inyectada es self-contained
// (recibe el wire de probeRequest como argumento) y devuelve la observación
// cruda {contentType, status, json} o {rejected:true} si el fetch rechaza.
// Sin resultado de la inyección (tab cerrado/navegando) → {noResult:true} →
// 'detection-failed'. Jamás colapsa a {} (audit §8: prohibido el success con
// campos null).
// fb-020-007: la sonda también espera la navegación en vuelo y se vigila
// ('probe'); un rechazo por navegación se propaga con su mensaje.
function odooSessionInfo(tabId, command) {
  return injectAfterNav(tabId, 'probe', (token, heartbeatMs) => probeSession(tabId, token, heartbeatMs), command);
}

async function probeSession(tabId, token, heartbeatMs) {
  const req = probeRequest();
  let results;
  try {
    results = await browser.scripting.executeScript({
      target: { tabId },
      func: pageOdooFetch,
      args: ['probe', req, token, heartbeatMs],
    });
  } catch {
    // Tab cerrado o navegando: la inyección no corrió (§2.2 caso 6).
    return classifyProbeResponse({ noResult: true });
  }
  const observation = results?.[0]?.result;
  if (!observation) return classifyProbeResponse({ noResult: true });
  return classifyProbeResponse(observation);
}

// ============================================================
// Message Handlers (from popup or other contexts)
// ============================================================
browser.runtime.onMessage.addListener((msg, sender) => {
  // fb-020-007 §9.2: latido de una página con un fetch ORM/sonda pendiente.
  if (msg?.type === 'fb-progress') {
    routePageProgress(msg, sender, pageDispatches, (progress) => {
      const dispatch = pageDispatches.get(msg.token);
      dispatch.beats++;
      recordNavGuard({ ev: 'heartbeat', id: progress.id, tabId: progress.tabId, elapsedMs: progress.elapsedMs });
      dispatch.sendProgress?.(progress);
    });
    return undefined;
  }
  if (msg.type === 'getStatus') {
    return (async () => {
      const profileInfos = [];
      for (const profile of profiles.values()) {
        profileInfos.push({
          id: profile.id,
          bridgeUrl: profile.bridgeUrl,
          agent: profile.bridgeUrl.replace(/https?:\/\//, '').replace(/\/.*/, ''),
          connected: profile.connected,
          tabs: profile.tabs.size,
          planMode: profile.planMode,
          reconnectAttempts: profile.reconnectAttempts,
          domains: profile.domains,
        });
      }
      // Also include current active tab
      let activeTab = null;
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs[0] ? { id: tabs[0].id, url: tabs[0].url, title: tabs[0].title } : null;
      } catch (e) {}
      return {
        active: state.active,
        profiles: profileInfos,
        activeTab,
        stats: state.stats,
        version: EXT_VERSION,
        rules: profileList.length,
      };
    })();
  }

  if (msg.type === 'toggle') {
    state.active = !state.active;
    const anyConnected = [...profiles.values()].some(p => p.connected);
    updateBadge(state.active && anyConnected);
    if (state.active) {
      log('info', 'Vulpo activated');
      refreshAllTabs();
    } else {
      log('info', 'Vulpo deactivated (kill switch)');
      for (const pid of profileList) {
        disconnectProfile(pid);
      }
    }
    return Promise.resolve({ active: state.active });
  }

  if (msg.type === 'disconnectBridge') {
    // For backwards compatibility — support profileId or bridgeUrl
    if (msg.profileId) {
      disconnectProfile(msg.profileId);
    } else if (msg.bridgeUrl) {
      // Find profiles with this bridgeUrl
      for (const profile of profiles.values()) {
        if (profile.bridgeUrl === msg.bridgeUrl) {
          disconnectProfile(profile.id);
        }
      }
    }
    return Promise.resolve({ success: true });
  }

  if (msg.type === 'togglePlanMode') {
    if (msg.profileId) {
      const profile = profiles.get(msg.profileId);
      if (profile) {
        profile.planMode = !profile.planMode;
        log('info', `Plan mode for ${msg.profileId}: ${profile.planMode ? 'ON' : 'OFF'}`);
        return Promise.resolve({ profileId: msg.profileId, planMode: profile.planMode });
      }
    }
    return Promise.resolve({ error: 'Profile not found' });
  }

  if (msg.type === 'updateRules') {
    if (msg.rules) {
      const { removed } = parseRules(msg.rules);
      for (const pid of removed) {
        disconnectProfile(pid);
      }
      reconnectAllProfiles();
    }
    return Promise.resolve({ success: true, rules: profileList.length });
  }

  if (msg.type === 'getRules') {
    return Promise.resolve({
      rules: profileList.map(pid => {
        const p = profiles.get(pid);
        if (!p) return '';
        return `${p.bridgeUrl} ${p.token} ${p.domains.join(' ')}`;
      }).join('\n'),
    });
  }

  // ==========================================================
  // Sidebar handlers
  // ==========================================================

  return false;
});

// ============================================================
// MV3 Wake-up — garantiza que la extensión arranque
// ============================================================
browser.runtime.onInstalled.addListener((details) => {
  console.log('🦊 onInstalled:', details.reason);
  init().catch(err => console.error('🦊 init failed in onInstalled:', err.message));
});

browser.runtime.onStartup.addListener(() => {
  console.log('🦊 onStartup — browser started');
  init().catch(err => console.error('🦊 init failed in onStartup:', err.message));
});

// Keepalive alarm — despierta el background cada 15s
browser.alarms.create('vulpo-keepalive', { periodInMinutes: 0.25 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vulpo-keepalive') {
    // Keep background page alive
    browser.tabs.query({}).catch(() => {});
    // Reconnect any disconnected profiles that have tabs
    // Los perfiles superseded (close 4002) NO se reconectan solos:
    // solo una acción explícita del usuario (toggle/tab) los reactiva.
    for (const profile of profiles.values()) {
      if (!profile.connected && !profile.superseded && profile.tabs.size > 0) {
        connectProfile(profile);
      }
    }
  }
});

// ============================================================
// Init
// ============================================================
async function init() {
  /* sync con manifest.json */ console.log(`🦊🦊🦊 VULPO v${EXT_VERSION} STARTING 🦊🦊🦊`);
  log('info', `Vulpo v${EXT_VERSION} initializing (Profile mode)`);

  try {
    await loadConfig();
    console.log('🦊 Config loaded:', profileList.length, 'profiles');
  } catch(e) {
    console.error('🦊 Config load FAILED:', e.message);
  }

  try {
    await refreshAllTabs();
    console.log('🦊 Tabs refreshed');
  } catch(e) {
    console.error('🦊 refreshAllTabs FAILED:', e.message);
  }

  // Modo debug (dev harness): auto-conexión del primer perfil.
  // Fuerza connectProfile(profile) tras loadConfig — la extensión en Camoufox
  // headless no siempre recibe tabs.onCreated de las páginas de Playwright, así
  // que el matching de tab por dominio no alcanza para conectar. Este hook opt-in
  // (storage `vlp_debug_autoconnect`) conecta el perfil directamente.
  try {
    const ac = await browser.storage.sync.get('vlp_debug_autoconnect');
    if (ac.vlp_debug_autoconnect && profileList.length > 0) {
      const pid = profileList[0];
      const profile = profiles.get(pid);
      if (profile && !profile.connected) connectProfile(profile);
      log('debug', 'Modo debug fb-013-001: auto-conexión del primer perfil', { pid });
    }
  } catch (e) {
    log('warn', 'Modo debug fb-013-001 falló', e.message);
  }

  // Bootstrap de config vía URL localhost (fb-017-004 E2E): el seed por sqlite
  // de storage.sync no es leído por Firefox 154 (verificado empíricamente: el
  // bg corre, loadConfig da 0 perfiles, y el primer storage.sync.set del addon
  // DESCARTA la fila sembrada en storage-sync-v2.sqlite). El harness sirve
  // http://127.0.0.1:<port>/vulpo-bootstrap?rules=<urlencoded> como
  // start-url; el bg lo detecta, persiste en storage.local y reconecta.
  // SEGURIDAD: SOLO se aceptan URLs de 127.0.0.1/localhost, y SOLO en esta
  // rama bootstrap — el flujo normal de loadConfig/connectProfile no cambia.
  let bootstrapDone = false;
  const bootstrapURLRe = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/vulpo-bootstrap(\?|$)/;
  const tryBootstrap = async () => {
    if (bootstrapDone) return;
    let tabs = [];
    try {
      tabs = await browser.tabs.query({});
    } catch (e) {
      return;
    }
    for (const tab of tabs) {
      if (!tab.url || !bootstrapURLRe.test(tab.url)) continue;
      bootstrapDone = true;
      try {
        const rules = new URL(tab.url).searchParams.get('rules') || '';
        if (!rules.startsWith('ws://') && !rules.startsWith('wss://')) {
          log('warn', 'bootstrap fb-017-004: rules inválido (no ws://)', rules);
          return;
        }
        await browser.storage.local.set({
          vlp_rules: rules,
          vlp_debug_autoconnect: '1',
        });
        if (profileList.length === 0) await loadConfig();
        if (profileList.length === 0) {
          // FF154: storage.sync.get no lanza (devuelve {}) así que loadConfig
          // no llega al fallback local — parseRules directo con las reglas del
          // bootstrap (mismo pipeline que usa el listener storage.onChanged).
          parseRules(rules);
        }
        if (profileList.length > 0) {
          const pid = profileList[0];
          const profile = profiles.get(pid);
          if (profile && !profile.connected) connectProfile(profile);
          log('debug', 'bootstrap fb-017-004: config aplicada desde URL localhost', { rules });
        } else {
          log('warn', 'bootstrap fb-017-004: perfiles 0 tras aplicar rules');
        }
      } catch (e) {
        log('warn', 'bootstrap fb-017-004 falló', e.message);
      }
      return;
    }
  };
  // Scan inicial (el tab del start-url puede ya existir) + listener por si el
  // tab aparece DESPUÉS de que el bg arrancó (web-ext abre el start-url tras
  // instalar el addon — timing no determinista). bootstrapDone evita duplicar.
  tryBootstrap();
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      if (tab.url && bootstrapURLRe.test(tab.url)) tryBootstrap();
    }
  });

  console.log(`🦊 Vulpo v${EXT_VERSION} initialized`);
  log('info', `Profiles: ${profileList.length}`);
}

console.log('🦊 VULPO SCRIPT LOADED — calling init()');
init().catch(err => {
  console.error('🦊🦊🦊 INIT CRASHED:', err.message, err.stack);
  log('error', 'Init crashed', err.message);
});
