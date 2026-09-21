// resolver.js — fb-017-002 frame-map-api (content script, isolated world).
// Resuelve el `ref` (formato de 001) a un Element dentro del DOM, partiendo de
// `root` (típicamente document.body). Read-only (I1/I4): solo lee children,
// tagName y shadowRoot; nunca escribe atributos/nodos, y resuelve por posición
// (tag + nth-of-type + shadow path), nunca por id/class/data-*.
//
// Formato de ref (espejo del emitido por selectorPath en 001):
//   segmentos separados por '>' ; cada segmento es `tag`, `tag:n` (compacto,
//   fb-018-001 §2.1), `tag:nth-of-type(n)` (verboso, retrocompatible P2) o
//   cualquiera de ellos con sufijo `::shadow` (cruza a un shadow root ABIERTO).
//   Ej: `main>form>div:1>input`, `main>form>div:nth-of-type(1)>input`,
//   `main>my-widget::shadow>button`, `main>div:3::shadow>button`.
//
// NO usa querySelector ni `::shadow` (no es selector CSS válido): walk custom
// por `children`/`firstElementChild` + `shadowRoot`.

// findChild: entre los element-children de `scope`, el que matchea `tag`.
// - sin índice (`nth === null`): primer hijo con ese tag.
// - con índice (`nth-of-type(n)`): el enésimo hijo con ese tag.
function findChild(scope, tag, nth) {
  if (!scope || !scope.children) return null;
  let n = 0;
  for (const child of scope.children) {
    if (child.nodeType !== 1) continue;
    if (child.tagName.toLowerCase() !== tag) continue;
    n++;
    if (nth == null && n === 1) return child; // índice omitido → primer match
    if (nth != null && n === nth) return child; // nth-of-type(n)
  }
  return null;
}

// resolveRef: resuelve un ref a un Element partiendo de `root`; null si algún
// segmento no resuelve (elemento inexistente, shadow cerrado o sin shadow).
export function resolveRef(ref, root) {
  const segments = String(ref || '').split('>').filter((s) => s.length > 0);

  // Review H1 (fb-017-002): un ref malformado/vacío que produce CERO segmentos
  // (">" o ">>>" pasan el gate Go "act requires ref") es "no resoluble" → null
  // (act lo compone como stale, PC11). NUNCA devolver el root.
  if (segments.length === 0) return null;

  let current = root;

  for (const seg of segments) {
    // fb-018-001 §2.1.1 — ORDEN DE PARSEO: primero se desprende el sufijo
    // `::shadow`, después se parsea el índice sobre el resto. El orden inverso
    // (el previo) no resolvía `div:nth-of-type(3)::shadow` —el segmento no
    // termina en `)`— y dejaba `tag = "div:nth-of-type(3)"` como nombre de tag
    // literal. Alcance acotado (§2.1.1): solo el orden, nada más del resolver.
    let rest = seg;
    let shadow = false;
    const shadowMatch = rest.match(/^(.+)::shadow$/);
    if (shadowMatch) {
      rest = shadowMatch[1];
      shadow = true;
    }

    // Índice: verboso `tag:nth-of-type(N)` (refs en vuelo, P2) o compacto
    // `tag:N` (§2.1, el que emite el serializer desde fb-018-001). El separador
    // `:` es seguro: ningún tag HTML lo contiene, mientras que sí pueden
    // terminar en dígito (`h1`, `h12`) — por eso `tagN` está prohibido (P3).
    let tag = rest;
    let nth = null;
    const verboseMatch = rest.match(/^(.+):nth-of-type\((\d+)\)$/);
    const indexMatch = verboseMatch || rest.match(/^(.+):(\d+)$/);
    if (indexMatch) {
      tag = indexMatch[1];
      nth = parseInt(indexMatch[2], 10);
    }

    const el = findChild(current, tag, nth);
    if (!el) return null;

    if (shadow) {
      // shadow root cerrado o sin shadow → el.shadowRoot es null → null (PC6).
      const sr = el.shadowRoot;
      if (!sr) return null;
      current = sr;
    } else {
      current = el;
    }
  }

  // El resultado final es un Element (nodeType 1). Si el ref terminó en un
  // shadow root (colgante), no es un elemento accionable → null.
  return current && current.nodeType === 1 ? current : null;
}