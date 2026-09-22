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

// State
let allBridges = [];
let currentStatus = null;

// ============================================================
// Main
// ============================================================
async function refresh() {
  try {
    currentStatus = await browser.runtime.sendMessage({ type: 'getStatus' });
    render();
    // Also get current tab info
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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

        item.appendChild(name);
        item.appendChild(info);
        item.appendChild(planBtn);
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
document.addEventListener('DOMContentLoaded', refresh);

// Auto-refresh every 3s
setInterval(refresh, 3000);
