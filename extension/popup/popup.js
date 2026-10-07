/**
 * Vulpo Popup
 * UI for multi-bridge management — status, toggle, bridge list, tab info.
 */

// DOM refs
const indicator = document.getElementById('indicator');
const statusText = document.getElementById('statusText');
const toggleBtn = document.getElementById('toggleBtn');
const bridgeList = document.getElementById('bridgeList');
const tabCount = document.getElementById('tabCount');
const cmdCount = document.getElementById('cmdCount');
const errCount = document.getElementById('errCount');
const killSwitch = document.getElementById('killSwitch');
const actionSignalToggle = document.getElementById('actionSignalToggle');

// fb-024-senal-previa-accion (D-3): único escritor de la preferencia.
// Ausente/true ⇒ encendida; false ⇒ apagada. Persiste en storage.local.
const ACTION_SIGNAL_KEY = 'vlp_action_signal';

async function loadActionSignalPref() {
  if (!actionSignalToggle) return;
  try {
    const data = await browser.storage.local.get(ACTION_SIGNAL_KEY);
    actionSignalToggle.checked = data[ACTION_SIGNAL_KEY] !== false;
  } catch {
    actionSignalToggle.checked = true;
  }
}

if (actionSignalToggle) {
  actionSignalToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [ACTION_SIGNAL_KEY]: actionSignalToggle.checked });
  });
}

// Versión dinámica desde el manifest (fuente única — nunca hardcodeada).
const versionEl = document.querySelector('.version');
if (versionEl) versionEl.textContent = `v${browser.runtime.getManifest().version}`;

// State
let allBridges = [];
let currentStatus = null;
// fb-026-003 D8: windowId de la ventana del popup (de la pestaña activa), para
// fijar el perfil a ESTA ventana sin depender de windows.getCurrent() (H2).
let currentWindowId = null;
// fb-026-004 P16 (D8): tabId de la pestaña del popup, para el pin a pestaña
// (misma query de abajo, el objeto `tab` ya trae `id`).
let currentTabId = null;

// ============================================================
// Main
// ============================================================
async function refresh() {
  try {
    // fb-026-003 D8: leer la ventana del popup ANTES de renderizar, para que el
    // toggle de pin tenga el windowId disponible en el primer render.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentWindowId = tab ? tab.windowId : null;
    currentTabId = tab ? tab.id : null;
    currentStatus = await browser.runtime.sendMessage({ type: 'getStatus' });
    render();
    if (tab && tabCount) {
      tabCount.textContent = tab.url || '-';
    }
  } catch (err) {
    indicator.className = 'status-dot disconnected';
    statusText.textContent = 'Error: ' + err.message;
  }
}

function render() {
  if (!currentStatus) return;

  const anyConnected = currentStatus.profiles?.some(b => b.connected);

  // Indicator
  if (!currentStatus.active) {
    indicator.className = 'status-dot disconnected';
    statusText.textContent = 'Desactivado (kill switch)';
  } else if (anyConnected) {
    indicator.className = 'status-dot connected';
    statusText.textContent = 'Conectado';
  } else {
    indicator.className = 'status-dot disconnected';
    statusText.textContent = 'Sin conexiones';
  }

  // Kill switch
  if (killSwitch) {
    killSwitch.textContent = currentStatus.active ? '🔴 Desactivar' : '🟢 Activar';
  }

  // Stats
  if (cmdCount) cmdCount.textContent = currentStatus.stats?.commandsSent || 0;
  if (errCount) errCount.textContent = currentStatus.stats?.errors || 0;

  // Bridges list
  if (bridgeList) {
    bridgeList.innerHTML = '';
    const bridges = currentStatus.profiles || [];

    if (bridges.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bridge-item';
      empty.innerHTML = '<div class="bridge-name">Sin bridges configurados</div><div class="bridge-tabs">Agregá reglas en Configuración</div>';
      bridgeList.appendChild(empty);
    } else {
      for (const b of bridges) {
        const item = document.createElement('div');
        item.className = 'bridge-item';

        const name = document.createElement('div');
        name.className = 'bridge-name';
        name.innerHTML = `<span class="bridge-dot ${b.connected ? 'green' : 'gray'}"></span> ${b.bridgeUrl}`;

        const info = document.createElement('div');
        info.className = 'bridge-tabs';
        info.textContent = `${b.tabs || 0} tabs`;

        const discBtn = document.createElement('button');
        discBtn.className = 'bridge-disconnect';
        discBtn.textContent = '✕';
        discBtn.title = 'Desconectar';
        discBtn.onclick = async () => {
          await browser.runtime.sendMessage({ type: 'disconnectBridge', profileId: b.id });
          refresh();
        };

        const planBtn = document.createElement('button');
        planBtn.className = 'bridge-plan-btn';
        planBtn.textContent = b.planMode !== false ? '🧠 Plan' : '🔨 Build';
        planBtn.title = b.planMode !== false ? 'Plan mode: read-only' : 'Build mode: write enabled';
        planBtn.onclick = async () => {
          const res = await browser.runtime.sendMessage({ type: 'togglePlanMode', profileId: b.id });
          if (res && res.planMode !== undefined) {
            planBtn.textContent = res.planMode ? '🧠 Plan' : '🔨 Build';
            planBtn.title = res.planMode ? 'Plan mode: read-only' : 'Build mode: write enabled';
          }
        };

        // fb-027-003 (F2): control de pin de 3 estados — none→window→tab→none.
        // Etiqueta = ESTADO actual (inequívoca, derivada de getStatus); `title` =
        // ACCIÓN siguiente. El clic decide la transición desde una lectura FRESCA
        // de getStatus (P3) y, ante `{error}`, saltea a `none` con clearPin (P6).
        const pinState = b.pin?.mode === 'window' ? 'window' : b.pin?.mode === 'tab' ? 'tab' : 'none';
        const pinBtn = document.createElement('button');
        pinBtn.className = 'bridge-pin-btn' + (pinState !== 'none' ? ' pinned' : '');
        pinBtn.textContent = pinState === 'window' ? '📌 ventana' : pinState === 'tab' ? '📌 pestaña' : '📍 sin pin';
        pinBtn.title = pinState === 'window'
          ? 'Fijar a esta pestaña'
          : pinState === 'tab'
            ? 'Desfijar'
            : 'Fijar a esta ventana';
        pinBtn.disabled = pinState === 'none' ? currentWindowId == null
          : pinState === 'window' ? currentTabId == null
            : false;
        pinBtn.onclick = async () => {
          // P3: el modo sobre el que se actúa proviene de una lectura FRESCA de
          // getStatus (no del valor capturado en el render) — cierra la carrera
          // con un release externo y evita actuar sobre un render viejo.
          const fresh = await browser.runtime.sendMessage({ type: 'getStatus' });
          const freshPin = fresh?.profiles?.find(p => p.id === b.id)?.pin;
          const mode = freshPin?.mode === 'window' ? 'window' : freshPin?.mode === 'tab' ? 'tab' : 'none';
          const res = mode === 'none'
            ? await browser.runtime.sendMessage({ type: 'setPin', profileId: b.id, mode: 'window', windowId: currentWindowId })
            : mode === 'window'
              ? await browser.runtime.sendMessage({ type: 'setPin', profileId: b.id, mode: 'tab', tabId: currentTabId })
              : await browser.runtime.sendMessage({ type: 'clearPin', profileId: b.id });
          // P6/P7 (núcleo de F2): si la transición falla, el control NO se traba —
          // saltea el estado fallido aplicando clearPin (⇒ none). ORDEN vinculante:
          // detectar el {error} → clearPin → refresh (no dejar el refresh sin rama).
          if (res && res.error) {
            await browser.runtime.sendMessage({ type: 'clearPin', profileId: b.id });
          }
          // P2: tras CUALQUIER clic (éxito o fallo) re-leer getStatus y re-renderizar.
          await refresh();
          // P8: el error del backend se sigue mostrando (no silencioso).
          if (res && res.error && statusText) statusText.textContent = 'Pin: ' + res.error;
        };

        item.appendChild(name);
        item.appendChild(info);
        item.appendChild(planBtn);
        item.appendChild(pinBtn);
        if (b.connected) item.appendChild(discBtn);
        bridgeList.appendChild(item);
      }
    }
  }
}

// Toggle button
if (toggleBtn) {
  toggleBtn.addEventListener('click', async () => {
    const result = await browser.runtime.sendMessage({ type: 'toggle' });
    await refresh();
  });
}

// Kill switch
if (killSwitch) {
  killSwitch.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'toggle' });
    await refresh();
  });
}

// Refresh on open
document.addEventListener('DOMContentLoaded', () => {
  loadActionSignalPref();
  refresh();
});

// Auto-refresh every 3s
setInterval(refresh, 3000);
