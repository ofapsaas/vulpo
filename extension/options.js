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
// fb-026-001 §2.6): una sola noción de "config válida". El seam ya no falla por
// validación (fb-027-001 §2.3): siempre `{ok:true, profiles, warnings}`; el
// único `ok:false` vivo es infraestructura (bundle ausente).
function validateText(text) {
  const rules = globalThis.VulpoRules;
  if (!rules || typeof rules.parseRules !== 'function') {
    return { ok: false, error: 'motor de reglas no disponible (rules-bundle.js)' };
  }
  return rules.parseRules(text);
}

// fb-027-001 (P23): los warnings se muestran, no bloquean la carga.
function formatWarnings(warnings) {
  return warnings.map((w) => `⚠️ L${w.line}: ${w.message}`).join('\n');
}

// Save rules
async function saveRules() {
  const text = rulesInput.value.trim() || DEFAULT_RULES;

  // fb-027-001 (P23): la config SIEMPRE se guarda si el seam está disponible
  // (`ok`), aun con warnings (overlap/token inválido/glob ancho). Sólo un fallo
  // de infraestructura (bundle ausente) bloquea.
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

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length > 0) {
      showStatus(`⚠️ Perfiles guardados con avisos:\n${formatWarnings(warnings)}`, 'warning');
    } else {
      showStatus('✅ Perfiles guardados. La extensión se reconectará automáticamente.', 'success');
    }
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

// Live validation (fb-027-001 P23): rojo SÓLO por infraestructura (bundle
// ausente); los warnings se reflejan en amarillo y NO bloquean el guardado.
rulesInput.addEventListener('input', () => {
  const result = validateText(rulesInput.value);
  if (!result.ok) {
    rulesInput.style.borderColor = 'var(--danger)';
  } else if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    rulesInput.style.borderColor = 'var(--warning)';
  } else {
    rulesInput.style.borderColor = '';
  }
});

saveBtn.addEventListener('click', saveRules);
resetBtn.addEventListener('click', resetRules);
document.addEventListener('DOMContentLoaded', loadRules);
