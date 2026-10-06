/**
 * Vulpo Options Page
 * UI for configuring bridge connection profiles.
 */

const STORAGE_KEY = 'vlp_rules';
const DEFAULT_RULES = `# Config examples:
# Formato: bridgeUrl token dominio1 dominio2 ...
# Cada línea = un perfil. El orden define prioridad (first match wins).
#
# https://bridge.example.com YOUR_TOKEN_HERE *.example.com
# https://bridge.example.com ANOTHER_TOKEN *.other-example.com
`;

// DOM
const rulesInput = document.getElementById('rulesInput');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusMsg = document.getElementById('statusMsg');

// Load current rules
async function loadRules() {
  try {
    let data = {};
    try {
      data = await browser.storage.sync.get(STORAGE_KEY);
    } catch (e) {
      data = await browser.storage.local.get(STORAGE_KEY);
    }
    const current = data[STORAGE_KEY];
    if (current !== undefined && current !== null) {
      rulesInput.value = current;
    } else {
      rulesInput.value = DEFAULT_RULES;
    }
  } catch (err) {
    rulesInput.value = DEFAULT_RULES;
  }
}

// Show status message
function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = `status ${type}`;
  setTimeout(() => { statusMsg.className = 'status'; }, 5000);
}

// Validación — consume el MISMO seam que el background (VulpoRules.parseRules,
// fb-026-001 §2.6): una sola noción de "config válida". Fail-loud si el bundle
// no está cargado (options.html lo carga antes que este script).
function validateText(text) {
  const rules = globalThis.VulpoRules;
  if (!rules || typeof rules.parseRules !== 'function') {
    return { ok: false, error: 'motor de reglas no disponible (rules-bundle.js)' };
  }
  return rules.parseRules(text);
}

// Save rules
async function saveRules() {
  const text = rulesInput.value.trim() || DEFAULT_RULES;

  // Fail-loud: no se guarda una config inválida (solapamiento, `*` pelado, dos `**`).
  const result = validateText(text);
  if (!result.ok) {
    showStatus(`⚠️ ${result.error}`, 'error');
    return;
  }

  try {
    // Try sync first, fallback to local for temporary addons
    try {
      await browser.storage.sync.set({ [STORAGE_KEY]: text });
    } catch (e) {
      await browser.storage.local.set({ [STORAGE_KEY]: text });
    }

    // Notify background script to reload rules
    try {
      await browser.runtime.sendMessage({
        type: 'updateRules',
        rules: text
      });
    } catch {
      // Background might not be running, still saved
    }

    showStatus('✅ Perfiles guardados. La extensión se reconectará automáticamente.', 'success');
  } catch (err) {
    showStatus(`❌ Error al guardar: ${err.message}`, 'error');
  }
}

// Reset to defaults
async function resetRules() {
  rulesInput.value = DEFAULT_RULES;
  await saveRules();
}

// Keyboard shortcut
rulesInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveRules();
  }
});

// Live validation
rulesInput.addEventListener('input', () => {
  rulesInput.style.borderColor = validateText(rulesInput.value).ok ? '' : 'var(--danger)';
});

saveBtn.addEventListener('click', saveRules);
resetBtn.addEventListener('click', resetRules);
document.addEventListener('DOMContentLoaded', loadRules);
