// native-dialog-main.js — fb-020-003-native-dialog-policy, spec v3.3 P24/P25
// (§2.2 nota v3.3, §2.4.4-6). Fuente única del envoltorio de diálogos nativos.
//
// Script clásico (sin import/export): `manifest.json` lo carga en
// `background.scripts` antes de `background.js`, que inyecta cada función en
// la página con `browser.scripting.executeScript({world:"MAIN", func})`.
// Esa inyección serializa la función sola, sin nada del ámbito de este
// archivo: por eso cada una es autocontenida y repite sus propios literales.
// Sólo usan el `window` de su ámbito, sin código en string (I-3).
//
// Estado compartido entre ventanas (P25): cada `act click` es una inyección
// independiente, así que originales, envoltorios y cuenta de ventanas vivas
// viven en `window.__vulpoNativeDialogOriginals__`. La anotación de la
// pregunta pendiente va en el atributo `data-vulpo-native-dialog` del
// `documentElement`, el único canal que el isolated world también ve (§2.2).

/**
 * Abre una ventana del `act click` (P25). Devuelve `true` si queda registrada
 * como ventana viva (instaló, o se sumó a una instalación viva de este
 * archivo) y `false` si la global existe con otra forma; en ese caso no toca
 * confirm/alert/prompt.
 */
function installNativeDialogWatchMain() {
  const stateKey = '__vulpoNativeDialogOriginals__';
  const kinds = ['confirm', 'alert', 'prompt'];
  const isOwnState = (state) =>
    state !== null &&
    typeof state === 'object' &&
    typeof state.originals === 'object' &&
    state.originals !== null &&
    typeof state.wrappers === 'object' &&
    state.wrappers !== null &&
    kinds.every((kind) => typeof state.wrappers[kind] === 'function') &&
    Number.isInteger(state.liveWindows) &&
    state.liveWindows > 0;

  const existing = window[stateKey];
  if (existing !== undefined) {
    if (!isOwnState(existing)) return false;
    window[stateKey] = {
      originals: existing.originals,
      wrappers: existing.wrappers,
      liveWindows: existing.liveWindows + 1,
    };
    return true;
  }

  const originals = { confirm: window.confirm, alert: window.alert, prompt: window.prompt };
  const wrappers = {};
  for (const kind of kinds) {
    wrappers[kind] = function (...args) {
      const message = args.length > 0 ? String(args[0]) : '';
      window.document.documentElement.setAttribute(
        'data-vulpo-native-dialog',
        JSON.stringify({ type: kind, message, pending: true }),
      );
      try {
        return originals[kind].apply(window, args);
      } finally {
        window.document.documentElement.removeAttribute('data-vulpo-native-dialog');
      }
    };
    window[kind] = wrappers[kind];
  }
  window[stateKey] = { originals, wrappers, liveWindows: 1 };
  return true;
}

/**
 * Cierra una ventana del `act click` (P25). Descuenta una ventana viva; al
 * llegar a cero aplica la restauración selectiva de P4 (cada función vuelve a
 * su original sólo si sigue siendo el envoltorio) y borra la global. Sin
 * instalación, o con una global de otra forma, no hace nada.
 */
function restoreNativeDialogWatchMain() {
  const stateKey = '__vulpoNativeDialogOriginals__';
  const kinds = ['confirm', 'alert', 'prompt'];
  const isOwnState = (state) =>
    state !== null &&
    typeof state === 'object' &&
    typeof state.originals === 'object' &&
    state.originals !== null &&
    typeof state.wrappers === 'object' &&
    state.wrappers !== null &&
    kinds.every((kind) => typeof state.wrappers[kind] === 'function') &&
    Number.isInteger(state.liveWindows) &&
    state.liveWindows > 0;

  const saved = window[stateKey];
  if (!isOwnState(saved)) return;

  if (saved.liveWindows > 1) {
    window[stateKey] = {
      originals: saved.originals,
      wrappers: saved.wrappers,
      liveWindows: saved.liveWindows - 1,
    };
    return;
  }

  for (const kind of kinds) {
    if (window[kind] === saved.wrappers[kind]) window[kind] = saved.originals[kind];
  }
  delete window[stateKey];
}
