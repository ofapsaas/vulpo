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

// Validate URL
function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function validateLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return true;

  const parts = trimmed.split(/\s+/);

  // "* None" is always valid (backward compat)
  if (parts[0] === '*' && parts[1] === 'None') return true;

  // New format: bridgeUrl token dominio1 dominio2 ...
  // Requires at least 3 parts: url, token, and one domain
  if (parts.length < 3) return false;

  // First element must be a valid URL (bridgeUrl)
  if (!isValidUrl(parts[0])) return false;

  // Second element is the token (must be non-empty)
  if (!parts[1]) return false;

  return true;
}

// Save rules
async function saveRules() {
  const text = rulesInput.value.trim() || DEFAULT_RULES;

  const lines = text.split('\n').filter(l => l.trim());
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (!validateLine(lines[i])) {
      const trimmed = lines[i].trim();
      const parts = trimmed.split(/\s+/);
      let msg;
      if (parts.length < 3) {
        msg = 'se requieren al menos 3 elementos: bridgeUrl token dominio1 ...';
      } else if (!isValidUrl(parts[0])) {
        msg = `URL inválida "${parts[0]}"`;
      } else if (!parts[1]) {
        msg = 'token vacío';
      } else {
        msg = 'formato inválido';
      }
      errors.push(`Línea ${i + 1}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    showStatus(`⚠️ ${errors.join('; ')}`, 'error');
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
  const lines = rulesInput.value.split('\n').filter(l => l.trim());
  let allValid = true;
  for (const line of lines) {
    if (!validateLine(line)) { allValid = false; break; }
  }
  rulesInput.style.borderColor = allValid ? '' : 'var(--danger)';
});

saveBtn.addEventListener('click', saveRules);
resetBtn.addEventListener('click', resetRules);
document.addEventListener('DOMContentLoaded', loadRules);
