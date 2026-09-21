// native-dialog.js — fb-020-003-native-dialog-policy. Spec §2.1 (nativeDialog),
// §2.2 (superficie del bundle y nota v3.3).
//
// El envoltorio de confirm/alert/prompt ya no vive acá: su única fuente es
// `src/extension/native-dialog-main.js` (P24), que corre en `world:"MAIN"`.
// Este módulo conserva sólo el lector, que corre en el isolated world: los
// dos mundos comparten el DOM y no sus variables, así que el canal común es el
// atributo `data-vulpo-native-dialog` del `documentElement` (§2.2).

const NATIVE_DIALOG_TYPES = new Set(['confirm', 'alert', 'prompt']);

/**
 * Lee la pregunta pendiente anotada en `doc` (P26). La página también puede
 * escribir el atributo, así que se parsea en el borde: JSON inválido o una
 * forma distinta de {type ∈ confirm/alert/prompt, message string,
 * pending === true} cuentan como sin pregunta (`null`). Si es válida, devuelve
 * un objeto nuevo con exactamente esas tres claves.
 */
export function readNativeDialog(doc) {
  const raw = doc.documentElement.getAttribute('data-vulpo-native-dialog');
  if (raw === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') return null;
  if (!NATIVE_DIALOG_TYPES.has(parsed.type)) return null;
  if (typeof parsed.message !== 'string') return null;
  if (parsed.pending !== true) return null;

  return { type: parsed.type, message: parsed.message, pending: true };
}
