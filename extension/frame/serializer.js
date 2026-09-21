// serializer.js — fb-017-001 frame-serializer (content script, isolated world).
// Serializa el DOM accesible al contrato `Frame` del epic fb-017.
//
// Firma (contrato spec §2): serializeFrame(root, options?: { maxElementsPerPage?,
// page?, maxReadEntries?, maxReadFragmentLength? }) => Frame
//
// Regla de oro (I1, PC10): SOLO LECTURA. Única API de lectura de layout/estilo:
// querySelectorAll/querySelector, getComputedStyle, getBoundingClientRect,
// getClientRects + las APIs read-only de dom-accessibility-api. Cero escritura
// de atributos/nodos: el outerHTML del root queda idéntico antes/después.

import { getRole, computeAccessibleName } from 'dom-accessibility-api';
import {
  getActiveDialog,
  isInert,
  isBlocking,
  isHidden,
  isAriaHidden,
  containsAcrossShadow,
  CANDIDATE_SELECTOR,
  PROMOTABLE_SELECTOR,
} from './dialog.js';
import { readNativeDialog } from './native-dialog.js';
import { detectActiveProfile } from './validity-profiles.js';

// Rol landmark (html-aam) para seccionado semántico (D3).
const LANDMARK_ROLES = new Set([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SECTION_TAGS = new Set(['form', 'nav', 'main']);

// fb-018-002 §2.4 — datos que NUNCA se serializan: ni value, ni longitud, ni máscara.
const NEVER_VALUED_INPUT_TYPES = new Set(['password', 'file', 'hidden']);
// fb-018-002 §2.2 — su estado observable es `checked`, no `value` (el `.value`
// nativo, "on" por default, es ruido engañoso).
const CHECKABLE_INPUT_TYPES = new Set(['checkbox', 'radio']);
// fb-018-002 §2.3 — roles con semántica checkable declarada por ARIA.
const CHECKABLE_ROLES = new Set([
  'checkbox',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'switch',
]);
// Map (no objeto literal): el valor del atributo es arbitrario y un lookup sobre
// un objeto devolvería miembros heredados de Object.prototype.
const ARIA_CHECKED_VALUES = new Map([['true', true], ['false', false], ['mixed', 'mixed']]);
const ARIA_BOOLEAN_VALUES = new Map([['true', true], ['false', false]]);

// fb-018-005 §6 — esos roles no son name-from-content (ARIA 1.2); por eso hoy
// salen con name:"". §2.4.3(P16) deriva su name por contenido igual que un
// elemento promovido.
const NAME_FROM_CONTENT_FALLBACK_ROLES = new Set(['alert', 'status', 'log']);

// fb-018-005 §2.7 — cotas por default, todas configurables.
const DEFAULT_MAX_CONTEXT_ENTRIES = 3;
const DEFAULT_MAX_CONTEXT_LENGTH = 120;
const DEFAULT_MAX_OPTIONS = 50;
const DEFAULT_MAX_PROMOTED_CELLS = 300;
const DEFAULT_MAX_PROMOTED_CLICKABLES = 100;

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function windowOf(el) {
  return el.ownerDocument ? el.ownerDocument.defaultView : null;
}

function isSectionBoundary(el) {
  const tag = el.tagName.toLowerCase();
  if (SECTION_TAGS.has(tag) || HEADING_TAGS.has(tag)) return true;
  const role = getRole(el);
  return role != null && LANDMARK_ROLES.has(role);
}

// isHidden / isAriaHidden (PC1/PC2/PC5, D1, M1): criterio de ocultamiento
// compartido con `dialog.js` (fb-018-004 §2.6) — importado, no duplicado, para
// que la detección del diálogo activo nunca pueda desincronizarse del
// universo de elementos que este serializer emite (I-4 estructural).

function segFor(el) {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  let count = 0;
  for (let s = parent.firstElementChild; s; s = s.nextElementSibling) {
    if (s.tagName.toLowerCase() === tag) count++;
  }
  if (count <= 1) return tag;
  let n = 1;
  for (let s = parent.firstElementChild; s && s !== el; s = s.nextElementSibling) {
    if (s.tagName.toLowerCase() === tag) n++;
  }
  // fb-018-001 §2.1 — encoding compacto `tag:N`. El separador `:` es
  // obligatorio: ningún tag HTML lo contiene, pero sí pueden terminar en dígito
  // (`h1`…`h6`, custom elements), así que `tagN` colisionaría (`h1:2` → `h12`).
  return `${tag}:${n}`;
}

// Ref por selector path (PC6, D1): tags + índice compacto (omitido cuando único),
// anclado en `root`, excluye html. Retreat por ascendencia; soporta refs
// intra-shadow con segmento `::shadow` (D2). M2: nunca emite `::shadow>` con
// cola vacía — el path termina en el tag del elemento emitido.
function selectorPath(el, root) {
  const rn = el.getRootNode ? el.getRootNode() : null;
  const inShadow = rn != null && !!rn.host;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur === root || cur === el.ownerDocument?.documentElement) break;
    parts.unshift(segFor(cur));
    cur = cur.parentElement;
  }
  if (inShadow && parts.length) {
    const hostPath = selectorPath(rn.host, root);
    return hostPath ? `${hostPath}::shadow>${parts.join('>')}` : parts.join('>');
  }
  return parts.join('>');
}

// Recorre `root` y sus shadow roots abiertos (D2) aplanando, matcheando
// `selector`. fb-018-005: generalizado desde `queryCandidates` para reusarlo
// también en la enumeración de tablas y de raíces de corrida de cursor —
// mismo criterio de recorrido, selector parametrizado.
function queryAllDeep(root, selector) {
  const all = [];
  const collect = (scope) => {
    for (const el of scope.querySelectorAll(selector)) all.push(el);
    for (const el of scope.querySelectorAll('*')) {
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(root);
  return all;
}

// Candidatos + elementos promovibles por estándar (PC2 + fb-018-005 §2.4.1):
// a[href], button, input, select, textarea, [role], [tabindex], [onclick],
// [contenteditable]. Recorre shadow roots abiertas (D2) aplanando.
function queryCandidates(root) {
  return queryAllDeep(root, PROMOTABLE_SELECTOR);
}

function inputTypeOf(el) {
  return (el.getAttribute('type') || 'text').toLowerCase();
}

// §2.2 (enmienda HITL): detección por ATRIBUTO PROPIO. jsdom no implementa
// `isContentEditable`, y la herencia a descendientes queda fuera de alcance.
function hasOwnContentEditable(el) {
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr === 'true';
}

function selectLabel(option) {
  return normalizeText(option.textContent) || normalizeText(option.value);
}

// §2.5 — mismo criterio que `read[]`: slice(0, N) + U+2026. Un valor truncado
// mide exactamente N+1; uno de largo exactamente N no se toca.
function truncateValue(value, limit) {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '…';
}

// §2.5 — devuelve el valor crudo (sin truncar) o `null` si el elemento no tiene
// la dimensión `value`. `null` significa "clave ausente", nunca "campo vacío".
function rawValueOf(el, tag) {
  if (tag === 'input') {
    const type = inputTypeOf(el);
    if (NEVER_VALUED_INPUT_TYPES.has(type)) return null;
    if (CHECKABLE_INPUT_TYPES.has(type)) return null;
    return normalizeText(el.value);
  }
  if (tag === 'textarea') return normalizeText(el.value);
  if (tag === 'select') {
    const selected = Array.from(el.options || []).filter((o) => o.selected);
    if (!selected.length) return '';
    if (el.multiple) return selected.map(selectLabel).join(', ');
    return selectLabel(selected[0]);
  }
  if (hasOwnContentEditable(el)) return normalizeText(el.textContent);
  return null;
}

// §2.3 — despacho por tipo de elemento, sin cláusula de precedencia. `undefined`
// = clave ausente (el autor de la página no declaró estado).
function checkedOf(el, tag, role) {
  if (tag === 'input' && CHECKABLE_INPUT_TYPES.has(inputTypeOf(el))) {
    if (el.indeterminate === true) return 'mixed';
    return el.checked === true;
  }
  if (!CHECKABLE_ROLES.has(role)) return undefined;
  return ARIA_CHECKED_VALUES.get(el.getAttribute('aria-checked'));
}

function ariaBooleanOf(el, attribute) {
  return ARIA_BOOLEAN_VALUES.get(el.getAttribute(attribute));
}

// fb-020-009 §2.1/§8.1 — `expands`: sólo input/botón (§8.2, D-3: restricción
// declarada sin postcondición propia, no relajar sin un test delante). Emite
// el aria-expanded del ANCESTRO más cercano que lo tenga (P3), pero SÓLO si
// el elemento mismo no lleva aria-expanded propio — ese caso ya lo cubre la
// clave `expanded` preexistente (fb-018-002 §3) y las dos NUNCA coexisten en
// el mismo elemento (§8.1). Un valor que no sea "true"/"false" en un ancestro
// cuenta como ausente y la búsqueda sigue subiendo (§8.3, mismo criterio que
// `ariaBooleanOf`).
function expandsOf(el, tag, root) {
  if (tag !== 'input' && tag !== 'button') return undefined;
  if (el.hasAttribute('aria-expanded')) return undefined;
  let cur = el.parentElement;
  while (cur && cur !== root) {
    const value = ariaBooleanOf(cur, 'aria-expanded');
    if (value !== undefined) return value;
    cur = cur.parentElement;
  }
  return undefined;
}

// fb-018-005 §2.4/§2.2 — computa `disabled` con la misma regla vigente
// (aria-disabled o ancestro con `.disabled === true`), factorizada para
// reusarla también en celdas de grid y elementos promovidos por presentación.
function disabledOf(el, root) {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  let d = el;
  while (d && d !== root) {
    if (d.disabled === true) return true;
    d = d.parentElement;
  }
  return false;
}

// fb-018-005 §2.7/P19 — la DECISIÓN de promover nunca llama a esto; sólo se
// aplica DESPUÉS, a los elementos ya incorporados a `children` (uniformidad de
// claves, no dependencia). Misma regla que hoy: sin layout real, `visible`
// degrada a `true` sin excluir; con layout, zero-size excluye y off-viewport
// da `visible:false`.
function visibilityOf(el, hasLayout, win) {
  if (!hasLayout) return { include: true, visible: true };
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return { include: false, visible: true };
    if (rect.right < 0 || rect.bottom < 0 || rect.left > win.innerWidth || rect.top > win.innerHeight) {
      return { include: true, visible: false };
    }
    return { include: true, visible: true };
  } catch {
    return { include: true, visible: true };
  }
}

// fb-018-005 §2.4.3 — recolecta, en orden de documento, los nodos de texto
// descendientes de `el` (recorriendo elementos, no shadow: no hace falta para
// los casos declarados del carril especializado).
function collectDescendantTextNodes(el) {
  const nodes = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (normalizeText(child.data)) nodes.push(child);
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(el);
  return nodes;
}

// fb-018-005 §2.4.3 — name derivado: concatenación de los nodos de texto
// descendientes, unidos por un espacio simple. CRUDO, sin truncar (I-C,
// enmienda post-review P20b): igual que `value`, el truncado por
// `maxValueLength` es una decisión de la QUERY, no del contenido observable —
// truncar acá metería una opción de query dentro del `name` que participa de
// la huella, y `changedSinceLast` daría falsos positivos al variar
// `maxValueLength` sin que el DOM cambiara (H5). El truncado se aplica recién
// en `emitElement`, con el mismo patrón dual que `value` (Infinity para la
// huella, el límite real para la respuesta). Devuelve también los nodos
// consumidos (costura P15b: se acumulan por elemento y se unen con
// `collectValueTextNodes`, no con una función paralela).
function joinedNameOf(el) {
  const textNodes = collectDescendantTextNodes(el);
  const joined = textNodes.map((n) => normalizeText(n.data)).join(' ');
  return { name: joined, textNodes };
}

// fb-018-005 §2.4.2 regla 6 — cota contra el contenedor gigante: body, html,
// o un landmark (html-aam) nunca se promueven por presentación.
function isLandmarkOrRoot(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'body' || tag === 'html') return true;
  const role = getRole(el);
  return role != null && LANDMARK_ROLES.has(role);
}

// fb-018-005 §2.3/§2.4.2 regla 2 — subárbol table/grid/treegrid: la promoción
// por presentación no se aplica adentro (precedencia contractual de grid).
// La subida CRUZA la frontera de shadow, con el mismo walk que
// `containsAcrossShadow` (dialog.js): al agotar el árbol propio salta del
// shadow root a su `host` y sigue. Sin ese salto, un elemento dentro de un
// shadow root cuyo host vive en una celda se cree fuera de toda tabla y se
// promueve por presentación, violando la precedencia de grid de §2.3
// «cualquiera sea la puerta de entrada».
function isWithinTableSubtree(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.tagName.toLowerCase() === 'table') return true;
    const role = getRole(cur);
    if (role === 'grid' || role === 'treegrid' || role === 'table') return true;
    if (cur.parentElement) {
      cur = cur.parentElement;
    } else {
      const rn = cur.getRootNode ? cur.getRootNode() : null;
      cur = rn && rn.host ? rn.host : null;
    }
  }
  return false;
}

// fb-018-005 §2.2.1/§2.5 cláusula 0 — ¿el elemento ES una celda? (`td`, o
// `getRole` ∈ {cell, gridcell}). Compartida entre `contextFor` y
// `computeGridPromotions` (única fuente de verdad, enmienda 6).
function isCellLike(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'td') return true;
  const role = getRole(el);
  return role === 'cell' || role === 'gridcell';
}

// fb-018-005 §2.2 — sube por ancestros hasta encontrar el `table` (o elemento
// con `getRole` ∈ {table, grid, treegrid}) que contiene a la celda. `null` si
// la celda no está dentro de ningún subárbol de grid.
function closestGridRoot(el) {
  let cur = el.parentElement;
  while (cur) {
    if (cur.tagName.toLowerCase() === 'table') return cur;
    const role = getRole(cur);
    if (role === 'grid' || role === 'treegrid' || role === 'table') return cur;
    cur = cur.parentElement;
  }
  return null;
}

// fb-018-005 §2.2.2/§2.2.5 — etiqueta de fila/columna de UNA celda, con el
// MISMO discriminante de cruce (§4.9.12) que usa `computeGridPromotions` para
// decidir granularidad. Simple ⇒ [nombreDeFila]; cruzada ⇒ [encabezadoDeFila,
// encabezadoDeColumna]. `undefined` si la celda no está dentro de ningún
// subárbol table/grid/treegrid. Único punto de cómputo (enmienda 6, §2.3):
// tanto `contextFor` (candidatos, cláusula 0) como `computeGridPromotions`
// (celdas promovidas, vía `contextFor`) usan esta función, así que las dos
// puertas de entrada nunca pueden calcular un `context` distinto para la
// misma celda.
function gridRowColContext(cell) {
  const table = closestGridRoot(cell);
  if (!table) return undefined;
  const tr = cell.parentElement;
  if (!tr) return undefined;

  const allRows = Array.from(table.querySelectorAll('tr'));
  const bodyRows = allRows.filter((r) => !r.closest('thead'));
  const headRow = table.querySelector('thead tr');

  const isCrossed = bodyRows.some((r) => {
    const cells = Array.from(r.children);
    if (cells.some((c) => c.tagName.toLowerCase() === 'th' && c.getAttribute('scope') === 'row')) return true;
    if (cells.length && cells[0].tagName.toLowerCase() === 'th') return true;
    if (cells.some((c) => c.hasAttribute('headers'))) return true;
    return false;
  });

  if (isCrossed) {
    const cells = Array.from(tr.children);
    const colIndex = cells.indexOf(cell);
    const rowHeaderEl = tr.children[0];
    const rowHeader =
      rowHeaderEl && rowHeaderEl.tagName.toLowerCase() === 'th' ? normalizeText(rowHeaderEl.textContent) : null;
    const colHeader = headRow ? normalizeText((headRow.children[colIndex] || {}).textContent || '') : null;
    return [rowHeader, colHeader];
  }

  const rowName = normalizeText(computeAccessibleName(tr));
  return rowName ? [rowName] : undefined;
}

// fb-018-005 §2.5 — `context`: etiquetas de los grupos que contienen al
// elemento, de afuera hacia adentro, filtrando vacíos.
// Cláusula 0 (enmienda 6, §2.3/§2.5): si `el` es una celda dentro de un
// subárbol table/grid/treegrid, aporta la etiqueta de fila/columna de
// `gridRowColContext` SIN IMPORTAR la puerta de entrada — es la corrección
// que hace que `contextFor` sea la ÚNICA fuente de `context` de fila/columna,
// tanto para candidatos (`role="gridcell"` explícito) como para celdas
// promovidas por `computeGridPromotions` (que ahora llama a esta función).
// Reglas 2 y 4 (§2.5): diálogo activo primero (más externo), luego el
// `role=group`/`region` con nombre no vacío más cercano. La regla 3 (límite
// de sección) siempre coincide con el boundary que ya usa `sectionOf` para
// armar `sections[]` — por construcción nunca aporta una etiqueta DISTINTA de
// `sections[].title`, así que no se implementa por separado (decisión HITL
// citada en el spec §2.5).
// CRUDO y sin cap (enmienda post-review, P20c/§2.7): la cota de cardinalidad
// (`maxContextEntries`) y de longitud por etiqueta (`maxContextLength`) son
// del PAYLOAD, no del contenido — se aplican en `emitElement`, no acá, para
// que la huella (que recibe Infinity) vea siempre el `context` completo (I-C).
function contextFor(el, root, activeDialog, dialogName) {
  const labels = [];
  if (activeDialog && dialogName && containsAcrossShadow(activeDialog, el)) {
    labels.push(dialogName);
  }
  if (isCellLike(el)) {
    const rowCol = (gridRowColContext(el) || []).filter(Boolean);
    if (rowCol.length) {
      labels.push(...rowCol);
      return labels;
    }
  }
  let cur = el.parentElement;
  while (cur && cur !== root) {
    const role = getRole(cur);
    if (role === 'group' || role === 'region') {
      const name = normalizeText(computeAccessibleName(cur));
      if (name) {
        labels.push(name);
        break;
      }
    }
    cur = cur.parentElement;
  }
  return labels.length ? labels : undefined;
}

// fb-018-005 §2.7, enmienda post-review (P20c) — cap de cardinalidad de un
// array de etiquetas (`context`), conservando las MÁS INTERNAS (últimas) al
// superar `maxEntries`. `Infinity` ⇒ sin cap (huella).
function capEntries(arr, maxEntries) {
  if (!arr) return arr;
  if (maxEntries === Infinity || arr.length <= maxEntries) return arr;
  return arr.slice(-maxEntries);
}

// fb-018-005 §2.6/§2.7, enmienda post-review (P20c) — cap de `options` con
// marcador (mismo patrón que `read[]`, pin `mugre` PC3). `Infinity` ⇒ sin cap
// ni marcador (huella): la lista de etiquetas COMPLETA es contenido
// observable; el recorte a `maxOptions` es una decisión de payload, no de la
// huella (I-C).
function capOptions(labels, maxOptions) {
  if (!labels) return labels;
  if (maxOptions === Infinity || labels.length <= maxOptions) return labels;
  const kept = labels.slice(0, maxOptions);
  kept.push(`[options truncado: ${kept.length} de ${labels.length} opciones]`);
  return kept;
}

// fb-018-001 §2.1 — forma canónica de un elemento del mapa. `maxValueLength`
// Infinity ⇒ sin truncar (el uso de la huella, §2.3). Clave ausente = "el
// elemento no tiene esa dimensión", nunca false/vacío.
// fb-018-007 §7.5 (enmienda post-review) — `inert` SÍ participa del
// `fingerprint`, igual que `visible`: ambas dependen del viewport
// (`visible` ya lo hacía vía `getBoundingClientRect`, `inert` ahora vía
// `blocking`), y excluir `inert` dejaba un falso negativo — un scroll que
// cambia `blocking` alteraría los flags sin cambiar la huella, y el agente
// reusaría un mapa desactualizado. I-C se cumple igual: es independiente de
// la QUERY (page/roles/namedOnly/maxElementsPerPage), no del viewport.
// fb-018-005 §2.1 — orden canónico ampliado: `clickable`/`context`/`options`
// van entre `inert` y `value`.
// fb-018-005 §2.4.3 (enmienda post-review, P20b/P20c) — `name`/`context`/
// `options` siguen el mismo patrón dual que `value`: se guardan CRUDOS y SIN
// CAP en el candidato, y se truncan/capean ACÁ, con `limits` = { value,
// contextEntries, contextLength, options }. La huella llama a `emitElement`
// con las CUATRO en `Infinity` (sin recorte); la respuesta con los límites
// reales de la query (§2.7). `name` sólo se trunca cuando `c.nameDerived` es
// true (derivado por §2.4.3: grid, presentación, PROMOTABLE-sólo, o
// alert/status/log sin nombre) — un `name` de la cascada de accesibilidad
// (fb-017-001 PC4) nunca se trunca por `maxValueLength`, comportamiento
// vigente que no se toca (P11b). Ninguna de estas cuatro cotas es contenido
// observable: son decisiones de PAYLOAD, así que la huella no puede depender
// de ellas (I-C, H5 — regla general de §2.7 "toda cota de esta feature acota
// el payload emitido, nunca el conjunto sobre el que se computa la huella").
function emitElement(c, limits) {
  const name = c.nameDerived ? truncateValue(c.name, limits.value) : c.name;
  // fb-020-009 §2.2/§8.4 — adyacencia estricta: `expands` va INMEDIATAMENTE
  // después de `role`, antes incluso de `name`/`tag`.
  const out = { ref: c.ref, role: c.role };
  if (c.expands !== undefined) out.expands = c.expands;
  out.name = name;
  out.tag = c.tag;
  out.disabled = c.disabled;
  out.visible = c.visible;
  if (c.inert === true) out.inert = true;
  if (c.clickable === true) out.clickable = true;
  if (c.context && c.context.length) {
    const capped = capEntries(c.context, limits.contextEntries);
    out.context = capped.map((label) => truncateValue(label, limits.contextLength));
  }
  if (c.options && c.options.length) out.options = capOptions(c.options, limits.options);
  if (c.value != null) out.value = truncateValue(c.value, limits.value);
  if (c.checked !== undefined) out.checked = c.checked;
  if (c.selected !== undefined) out.selected = c.selected;
  if (c.expanded !== undefined) out.expanded = c.expanded;
  if (c.invalid === true) out.invalid = true;
  return out;
}

// fb-020-004 §2.4 — estado de validación estándar: `aria-invalid` con valor
// distinto de ausente/""/"false", o `:user-invalid` (ignorado si el motor no
// soporta el selector, p.ej. jsdom).
function isInvalid(el) {
  const ariaInvalid = el.getAttribute('aria-invalid');
  if (ariaInvalid != null && ariaInvalid !== '' && ariaInvalid !== 'false') return true;
  try {
    return el.matches(':user-invalid');
  } catch {
    return false;
  }
}

// fb-020-005 §3.2 — marcadores visibles del perfil activo, misma regla de
// visibilidad que el resto del mapa (isHidden/isAriaHidden — P11).
function visibleMarkersOf(root, win, selector) {
  return queryAllDeep(root, selector).filter((el) => !isHidden(el, win) && !isAriaHidden(el));
}

// fb-020-005 §3.2 — marcador ancestro-o-propio MÁS CERCANO de `el` presente en
// `markerSet`. Cruza shadow con el mismo patrón que containsAcrossShadow/
// isHidden (dialog.js). Es la base de "sin doble conteo jerárquico" (P7): cada
// elemento del mapa se atribuye a UN solo marcador, el más interno.
function closestMarker(el, markerSet) {
  let n = el;
  while (n && n.nodeType === 1) {
    if (markerSet.has(n)) return n;
    if (n.parentElement) {
      n = n.parentElement;
    } else {
      const rn = n.getRootNode ? n.getRootNode() : null;
      n = rn && rn.host ? rn.host : null;
    }
  }
  return null;
}

// fb-020-005 §3.3 — `field`: valor de `fieldNameAttribute` (declarado por el
// perfil) en el marcador ancestro-o-propio MÁS CERCANO que lo tenga. Recorre
// TODA la cadena de marcadores (no solo el más cercano de `closestMarker`):
// un marcador interno sin el atributo no bloquea a uno externo que sí lo
// tenga (P10b).
function nearestFieldValue(el, attribute, markerSet) {
  if (!attribute) return undefined;
  let n = el;
  while (n && n.nodeType === 1) {
    if (markerSet.has(n) && n.hasAttribute(attribute)) return n.getAttribute(attribute);
    if (n.parentElement) {
      n = n.parentElement;
    } else {
      const rn = n.getRootNode ? n.getRootNode() : null;
      n = rn && rn.host ? rn.host : null;
    }
  }
  return undefined;
}

// fb-020-005 §3.3 — forma canónica de una entrada de `invalidElements`:
// orden fijo ref/name/context/field/notInMap (PC9 de fb-017-001). `name` es
// obligatoria en TODA entrada (§12.1: puede valer "" pero la clave siempre
// está, para que el agente no tenga que ramificar según el tipo de entrada).
// `context`, `field` y `notInMap` siguen present-only (I-6, sin tocar).
function makeInvalidEntry({ ref, name = '', context, field, notInMap }) {
  const entry = { ref, name };
  if (context !== undefined) entry.context = context;
  if (field !== undefined) entry.field = field;
  if (notInMap) entry.notInMap = true;
  return entry;
}

// fb-018-001 §2.3 — digest opaco de longitud fija (FNV-1a en dos carriles de
// 32 bits → 16 hex). Síncrono a propósito: `crypto.subtle.digest` es async y
// volvería async a `serializeFrame` (y al call site de executeScript). No es
// criptográfico: solo tiene que ser determinista y sensible a cualquier cambio
// del contenido observable.
function digest(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// read[] (PC8): texto visible global (no paginado), whitespace normalizado, en
// orden de documento, excluyendo el texto ya consumido como name y los nodos de
// `excludeNodes` (§2.6 dedup targeted). Parametrizada porque se llama DOS veces
// con conjuntos de exclusión y límites distintos: uno para la huella (todos los
// candidatos, sin truncar ni capear) y otro para la respuesta (solo los
// sobrevivientes del filtro, con los límites de la query) — fb-018-001 P7a/P7c.
function buildRead(root, win, readNames, excludeNodes, fragmentMax, maxEntries) {
  const read = [];
  const scopeEls = [root, ...root.querySelectorAll('*')];
  for (const el of scopeEls) {
    if (isHidden(el, win)) continue; // PC6 (pin DEF-2)
    if (isAriaHidden(el)) continue; // PC2 (D1): texto aria-hidden no entra a read[]
    if (!el.childNodes) continue;
    for (const child of el.childNodes) {
      if (child.nodeType !== 3) continue;
      let text = normalizeText(child.data);
      if (!text) continue;
      if (readNames.has(text)) continue;
      if (excludeNodes.has(child)) continue; // §2.6 dedup targeted
      if (text.length > fragmentMax) {
        text = text.slice(0, fragmentMax) + '…';
      }
      read.push(text);
    }
  }

  // PC3 (D2): cap de read[] entries (default 400). Si se trunca, el ÚLTIMO
  // elemento es el marcador explícito `[read truncado: N de M fragmentos]`
  // (N emitidos de M totales); el marcador cuenta dentro del cap.
  const totalFragments = read.length;
  if (totalFragments > maxEntries) {
    const kept = read.slice(0, maxEntries - 1);
    kept.push(`[read truncado: ${kept.length} de ${totalFragments} fragmentos]`);
    return kept;
  }
  return read;
}

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

// fb-018-004 §2.3 — name del diálogo: accessible name; si vacío, fallback al
// texto del primer heading del subárbol (h1-h6 o [role=heading], orden de
// documento, normalizado); si tampoco hay, "".
function dialogNameOf(dialogEl) {
  const accName = normalizeText(computeAccessibleName(dialogEl));
  if (accName) return accName;
  const heading = dialogEl.querySelector(HEADING_SELECTOR);
  if (heading) return normalizeText(heading.textContent);
  return '';
}

// fb-018-005 §2.2 — promoción estructural de grid. Devuelve `{ entries,
// crossedTables }`. `entries` es la lista COMPLETA, SIN degradar por
// `maxPromotedCells` — la tabla cruzada siempre se promueve entera acá (I-C,
// enmienda post-review P20c/§2.7: la huella tiene que ver el conjunto
// completo, la cota de `maxPromotedCells` es del payload emitido, no de lo
// que se computa). `crossedTables` trae, por cada tabla efectivamente
// cruzada, su cantidad de celdas y la alternativa DEGRADADA (granularidad
// simple) ya calculada, para que `serializeFrame` decida — sólo para la
// RESPUESTA — si sustituye una por otra al superar la cota.
function computeGridPromotions(ctx) {
  const { root, win, hasLayout, activeDialog, blocking, roleTables } = ctx;

  // §2.2 — "cada table (o elemento con getRole en {table, grid, treegrid})".
  // `roleTables` llega ya computado desde `serializeFrame` (enmienda 9): es el
  // mismo filtro sobre el mismo `queryAllDeep(root, '*')` de siempre, hoisteado
  // para que esa pasada produzca además el ordinal de orden de documento.
  const byTag = queryAllDeep(root, 'table');
  const tables = Array.from(new Set([...byTag, ...roleTables]));

  const entries = [];
  const crossedTables = [];

  // fb-018-005 §2.2.1, enmienda 6 (regla 3 del arreglo) — una celda elegible
  // NO puede matchear `CANDIDATE_SELECTOR` ella misma (además de no contener
  // ningún descendiente que matchee). Una celda con `role="gridcell"`
  // explícito ya entró al mapa por el loop principal como candidata; si
  // también se promoviera acá, el mismo `ref` se emitiría dos veces (P6c).
  // La cláusula 0 de `contextFor` es lo que le da `context` a esa celda sin
  // necesidad de promoverla.
  //
  // fb-018-005 §2.7, enmienda 11 ("UNA celda, UNA entrada") — la promoción de
  // grid SALTEA además toda celda que YA entró por el loop principal: la que
  // matchea `PROMOTABLE_SELECTOR` sin estar alcanzada por la exclusión
  // condicionada de §2.4.1 (`tabindex="-1"` en celda de grid). Sin esto, una
  // celda con `tabindex="0"`, `onclick` o `contenteditable="true"` se emitía
  // DOS veces con el mismo `ref` (rompiendo fb-017-003 PC2). La
  // de-duplicación va SIEMPRE hacia el candidato, nunca hacia el filtro: la
  // celda sigue en el mapa por el loop principal y recibe su `context` de
  // fila/columna por la cláusula 0 de §2.5 — el mismo camino que P6c ya
  // ejercía para `role="gridcell"`. Ampliar la exclusión de §2.4.1 la habría
  // BORRADO del mapa, reabriendo la clase de defecto de las enmiendas 6 y 8.
  const enteredByMainLoop = (c) =>
    c.matches(PROMOTABLE_SELECTOR) && c.getAttribute('tabindex') !== '-1';

  const eligibleCellsOf = (tr) =>
    Array.from(tr.children).filter(
      (c) =>
        isCellLike(c) &&
        !c.matches(CANDIDATE_SELECTOR) &&
        !enteredByMainLoop(c) &&
        !c.querySelector(CANDIDATE_SELECTOR),
    );

  const dialogName = activeDialog ? dialogNameOf(activeDialog) : '';

  for (const table of tables) {
    const allRows = queryAllDeep(table, 'tr');
    const bodyRows = allRows.filter((tr) => !tr.closest('thead'));
    if (!bodyRows.length) continue;

    const isCrossed = bodyRows.some((tr) => {
      const cells = Array.from(tr.children);
      if (cells.some((c) => c.tagName.toLowerCase() === 'th' && c.getAttribute('scope') === 'row')) return true;
      if (cells.length && cells[0].tagName.toLowerCase() === 'th') return true;
      if (cells.some((c) => c.hasAttribute('headers'))) return true;
      return false;
    });

    // fb-018-005 §2.3/§2.5, enmienda 6 — `context` se calcula con la MISMA
    // `contextFor` que usa el loop principal (única fuente de verdad): la
    // cláusula 0 reconoce que `cell` es una celda dentro de este `table` y
    // deriva [nombreDeFila] o [encabezadoDeFila, encabezadoDeColumna] sin que
    // esta función tenga que construir el array por su cuenta.
    const buildEntry = (cell) => {
      const vis = visibilityOf(cell, hasLayout, win);
      if (!vis.include) return null;
      const { name, textNodes } = joinedNameOf(cell);
      return {
        ref: selectorPath(cell, root),
        role: getRole(cell) || '',
        name,
        nameDerived: true,
        tag: cell.tagName.toLowerCase(),
        disabled: disabledOf(cell, root),
        visible: vis.visible,
        inert: isInert(activeDialog, blocking, cell),
        context: contextFor(cell, root, activeDialog, dialogName) || [],
        invalid: isInvalid(cell),
        ownValueTextNodes: textNodes,
        _gridTable: table,
        _el: cell,
      };
    };

    // fb-018-005 §2.2.3, enmienda 7 — entre las celdas elegibles de una fila,
    // se promueve la primera con TEXTO PROPIO no vacío (la que identifica el
    // registro en markup real: en Odoo 19 la primera elegible puede ser una
    // celda de avatar decorativa, `alt=""`, con texto vacío — 81 de 81 celdas
    // salían con `name:""` antes de esta corrección). Si ninguna elegible
    // tiene texto, fallback a la primera (I-B: no perder la direccionabilidad
    // de una fila enteramente decorativa). No cambia elegibilidad ni
    // granularidad: sólo la elección ENTRE celdas ya elegibles.
    const pickSimpleCell = (eligible) => {
      const conTexto = eligible.find((c) => joinedNameOf(c).name);
      return conTexto || eligible[0];
    };

    const buildSimpleEntries = () => {
      const out = [];
      for (const tr of bodyRows) {
        const eligible = eligibleCellsOf(tr);
        if (!eligible.length) continue;
        const entry = buildEntry(pickSimpleCell(eligible));
        if (entry) out.push(entry);
      }
      return out;
    };

    if (isCrossed) {
      const crossedEntries = [];
      bodyRows.forEach((tr) => {
        for (const cell of eligibleCellsOf(tr)) {
          const entry = buildEntry(cell);
          if (entry) crossedEntries.push(entry);
        }
      });
      entries.push(...crossedEntries);
      crossedTables.push({
        table,
        count: crossedEntries.length,
        simpleEntries: buildSimpleEntries(),
      });
    } else {
      entries.push(...buildSimpleEntries());
    }
  }

  return { entries, crossedTables };
}

// fb-018-005 §2.4.2 — promoción marcada por corrida de cursor. Recorre los
// elementos ya enumerados por `querySelectorAll('*')` (cero recorridos
// nuevos, §2.7). Devuelve TODAS las raíces de corrida elegibles, sin cap: la
// cota `maxPromotedClickables` es del payload emitido (§2.7, I-C), se aplica
// en `serializeFrame`.
function computeClickablePromotions(ctx) {
  const { root, win, hasLayout, activeDialog, blocking, allDeepElements } = ctx;
  const entries = [];
  const dialogName = activeDialog ? dialogNameOf(activeDialog) : '';

  // fb-018-005 §2.7, enmienda post-review (P20c) — SIN cap acá: `maxPromotedClickables`
  // recorta el PAYLOAD emitido, no el conjunto que ve la huella (I-C). El cap
  // se aplica en `serializeFrame`, igual que `maxElementsPerPage`/paginación.
  // `allDeepElements` es el MISMO `queryAllDeep(root, '*')` ya hoisteado en
  // `serializeFrame` (el que produce `documentOrder`): cruza shadow roots
  // abiertos y hace literalmente cierta la afirmación de §2.7 de "cero
  // recorridos nuevos" — antes acá había un `root.querySelectorAll('*')`
  // aparte, que además era ciego al shadow DOM.
  for (const el of allDeepElements) {
    if (el.matches(CANDIDATE_SELECTOR)) continue; // regla 1
    if (isWithinTableSubtree(el)) continue; // regla 2 (§2.3)
    const cursor = win.getComputedStyle(el).cursor;
    if (cursor !== 'pointer') continue; // regla 3
    const parent = el.parentElement;
    if (parent && win.getComputedStyle(parent).cursor === 'pointer') continue; // regla 4: no es raíz de corrida
    if (el.querySelector(CANDIDATE_SELECTOR)) continue; // regla 5
    if (isLandmarkOrRoot(el)) continue; // regla 6
    const { name, textNodes } = joinedNameOf(el);
    if (!name) continue; // regla 7

    const vis = visibilityOf(el, hasLayout, win);
    if (!vis.include) continue;

    const context =
      activeDialog && dialogName && containsAcrossShadow(activeDialog, el) ? [dialogName] : undefined;

    entries.push({
      ref: selectorPath(el, root),
      role: '',
      name,
      nameDerived: true,
      tag: el.tagName.toLowerCase(),
      disabled: disabledOf(el, root),
      visible: vis.visible,
      inert: isInert(activeDialog, blocking, el),
      clickable: true,
      context,
      invalid: isInvalid(el),
      ownValueTextNodes: textNodes,
      _el: el,
    });
  }

  return entries;
}

export function serializeFrame(root, options) {
  const win = windowOf(root) || globalThis;
  const maxElementsPerPage = (options && options.maxElementsPerPage) || 200;

  // fb-018-004 §2.1/§2.6 — el diálogo activo se computa UNA vez, desde el
  // módulo compartido, y se usa tanto para el campo `dialog` (§2.2) como para
  // marcar `inert` por elemento (§2.4).
  // fb-018-007 §2.2 — `blocking` es el gate de modalidad: un solo booleano por
  // frame, calculado UNA vez acá y consumido tanto para `dialog.modal` (§2.4)
  // como para `inert` por elemento (ninguna decisión depende del hit-test de
  // ESE elemento — H4, §1.2).
  const activeDialog = getActiveDialog(root);
  const blocking = isBlocking(root, activeDialog);
  const dialogName = activeDialog ? dialogNameOf(activeDialog) : '';

  // PC5 (H1/H3): detección de layout real. Con layout real (Firefox) aplicamos
  // zero-size→excluir y off-viewport (completamente fuera)→`visible:false`. Sin
  // layout (jsdom, tests unit) getClientRects() es vacío → degrada a
  // `visible:true` sin excluir por tamaño/posición.
  const hasLayout = (() => {
    try { return root.getClientRects().length > 0; }
    catch { return false; }
  })();

  const maxValueLength = (options && options.maxValueLength) || 300;
  const maxContextEntries = (options && options.maxContextEntries) || DEFAULT_MAX_CONTEXT_ENTRIES;
  const maxContextLength = (options && options.maxContextLength) || DEFAULT_MAX_CONTEXT_LENGTH;
  const maxOptions = (options && options.maxOptions) || DEFAULT_MAX_OPTIONS;
  const maxPromotedCells = (options && options.maxPromotedCells) || DEFAULT_MAX_PROMOTED_CELLS;
  const maxPromotedClickables = (options && options.maxPromotedClickables) || DEFAULT_MAX_PROMOTED_CLICKABLES;

  const children = [];
  for (const el of queryCandidates(root)) {
    // ancestor-candidate dedup (D6)
    let anc = el.parentElement;
    let dup = false;
    while (anc && anc !== root) {
      if (anc.matches && anc.matches(CANDIDATE_SELECTOR)) {
        const ancRole = getRole(anc);
        const elRole = getRole(el);
        if (ancRole === elRole) { dup = true; break; }
        break;
      }
      anc = anc.parentElement;
    }
    if (dup) continue;

    // fb-018-005 §2.4.1, enmienda 8 — `tabindex="-1"` se excluye del camino
    // [tabindex] SÓLO cuando `el` es una celda dentro de un subárbol
    // table/grid/treegrid: ahí el camino de grid (§2.2) se hace cargo del
    // elemento con granularidad y `context`, así que dejarlo entrar suelto
    // por acá duplicaría/preemptaría esa promoción (enmienda 6). Fuera de una
    // tabla, un `tabindex="-1"` con handler por `addEventListener` no tiene
    // NINGÚN otro camino que lo exponga: excluirlo ahí es filtrar de más
    // (I-B, principio de producto §2.4.1 — "el código de Vulpo no debe
    // filtrar de más"). No aplica a elementos que YA son candidatos por
    // CANDIDATE_SELECTOR (`role`, `href`, etc.): ésos siguen su camino normal.
    if (
      el.getAttribute('tabindex') === '-1' &&
      !el.matches(CANDIDATE_SELECTOR) &&
      isCellLike(el) &&
      closestGridRoot(el)
    ) {
      continue;
    }

    const tag = el.tagName.toLowerCase();
    if (isHidden(el, win)) continue;
    if (isAriaHidden(el)) continue; // PC1 (D1): aria-hidden propio/heredado → fuera del mapa

    const vis = visibilityOf(el, hasLayout, win);
    if (!vis.include) continue;
    const visible = vis.visible;

    const isGenuineCandidate = el.matches(CANDIDATE_SELECTOR);

    let name = computeAccessibleName(el) || '';
    if (!name && (tag === 'a' || tag === 'button')) {
      name = normalizeText(el.textContent);
    }
    // dom-accessibility-api 0.7.1 (pinned en package.json) no implementa
    // placeholder como fuente de nombre; el spec PC4 lo exige. Fallback
    // targeted: input/textarea con placeholder y sin nombre computado.
    if (!name && (tag === 'input' || tag === 'textarea') && el.hasAttribute('placeholder')) {
      name = normalizeText(el.getAttribute('placeholder'));
    }
    const role = getRole(el) || '';

    // fb-018-005 §2.4.3 — derivación de name por contenido: (b) elementos que
    // entran SÓLO por PROMOTABLE_SELECTOR (no matchean CANDIDATE_SELECTOR), o
    // el caso ARIA de role alert/status/log sin nombre (P16, §6). NO se le
    // aplica a button/a/input sin nombre (anti-regresión P11b/PC4).
    let derivedTextNodes = [];
    let nameDerived = false;
    if (!name && (!isGenuineCandidate || NAME_FROM_CONTENT_FALLBACK_ROLES.has(role))) {
      const derived = joinedNameOf(el);
      name = derived.name;
      derivedTextNodes = derived.textNodes;
      nameDerived = true;
    }

    // PC5 (D3): un [role] 'generic' sin nombre es ruido todo-divs → suprimido.
    // Solo 'generic': un button sin nombre SÍ se emite (name '').
    if (role === 'generic' && !name) continue;
    const disabled = disabledOf(el, root);

    const ref = selectorPath(el, root);
    const value = rawValueOf(el, tag);
    // §2.6 — alcance cerrado: contenteditable propio y <textarea> con contenido
    // inicial, cuyo `value` ES su propio texto. <select> queda explícitamente
    // fuera (excluirlo borraría de read[] las opciones no seleccionadas).
    // fb-018-001 P7c: el conjunto se guarda POR ELEMENTO y recién se une sobre
    // los que sobreviven al filtro. Si se uniera acá, un elemento excluido por
    // `roles`/`namedOnly` borraría su texto de read[] sin aportar su `value`:
    // su contenido desaparecería por completo de la respuesta (I-A).
    const ownValueTextNodes = [...derivedTextNodes];
    if (value && (tag === 'textarea' || hasOwnContentEditable(el))) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && normalizeText(node.data) === value) ownValueTextNodes.push(node);
      }
    }

    // fb-018-005 §2.6 — `options` de un <select>: etiquetas en orden de
    // documento. CRUDAS y SIN CAP acá (enmienda post-review, P20c/§2.7): el
    // recorte a `maxOptions` + marcador es del payload emitido, no de la
    // huella (I-C) — se aplica en `emitElement` (`capOptions`). Reversión de
    // fb-018-002: el texto de las opciones sale de read[] (union después del
    // filtro, P7c), para TODAS las opciones, truncadas o no.
    let selectOptions;
    if (tag === 'select') {
      const optEls = Array.from(el.options || []);
      if (optEls.length) {
        selectOptions = optEls.map(selectLabel);
        for (const opt of optEls) {
          const label = selectLabel(opt);
          for (const node of opt.childNodes) {
            if (node.nodeType === 3 && normalizeText(node.data) === label) ownValueTextNodes.push(node);
          }
        }
      }
    }

    // fb-018-005 §2.5 — `context`: CRUDO y sin cap acá (P20c/§2.7); el recorte
    // de cardinalidad/longitud se aplica en `emitElement`.
    const context = contextFor(el, root, activeDialog, dialogName);

    children.push({
      ownValueTextNodes,
      ref,
      role,
      name,
      nameDerived,
      tag,
      disabled,
      visible,
      inert: isInert(activeDialog, blocking, el),
      context,
      options: selectOptions,
      value,
      checked: checkedOf(el, tag, role),
      selected: ariaBooleanOf(el, 'aria-selected'),
      expanded: ariaBooleanOf(el, 'aria-expanded'),
      expands: expandsOf(el, tag, root),
      invalid: isInvalid(el),
      _el: el,
    });
  }

  // fb-018-005 §2.2/§2.4.2 — promociones de grid y de presentación se
  // incorporan a `children` ANTES de la huella, el filtro y la paginación: son
  // elementos del mapa como cualquier otro (I-2, I-A, uniformidad de claves).
  // Enmienda post-review (P20c/§2.7): las dos se computan SIN cap — la huella
  // ve siempre el conjunto completo. `maxPromotedCells`/`maxPromotedClickables`
  // se aplican más abajo, sólo al armar el `responsePool` (I-C).
  // fb-018-005 §2.7 (enmienda 9) — de acá sale el ordinal de orden de documento
  // que ordena el `responsePool`, SIN ningún recorrido nuevo: el
  // `queryAllDeep(root, '*')` que `computeGridPromotions` ya hacía para
  // enumerar las tablas por rol se hoistea acá y produce, en la MISMA pasada,
  // la lista de tablas por rol y el `Map<Element, ordinal>` monótono.
  const documentOrder = new Map();
  const roleTables = [];
  const allDeepElements = queryAllDeep(root, '*');
  allDeepElements.forEach((el, i) => {
    documentOrder.set(el, i);
    const role = getRole(el);
    if (role === 'table' || role === 'grid' || role === 'treegrid') roleTables.push(el);
  });

  const promotionCtx = { root, win, hasLayout, activeDialog, blocking, roleTables, documentOrder, allDeepElements };
  const gridResult = computeGridPromotions(promotionCtx);
  for (const entry of gridResult.entries) children.push(entry);
  const clickableEntries = computeClickablePromotions(promotionCtx);
  for (const entry of clickableEntries) children.push(entry);

  // fb-020-005 §3.1/§3.7 — perfil de convención de validez inyectado como dato
  // (I-2): se evalúa UNA vez por serialización, a lo sumo un perfil activo (el
  // primero del registro que detecte). Sin `options.validityProfiles` el
  // núcleo no reconoce ninguna convención de sitio (P14).
  const activeProfile = detectActiveProfile(root.ownerDocument, options && options.validityProfiles);
  const profileMarkers = activeProfile
    ? visibleMarkersOf(root, win, activeProfile.invalidMarkerSelector)
    : [];
  const markerSet = new Set(profileMarkers);

  // §11.1 — cuando un marcador contiene OTROS marcadores, los portadores son
  // SÓLO los de los marcadores internos: un elemento cuyo marcador más
  // cercano es uno que a su vez envuelve marcadores internos (p.ej. la celda
  // identificatoria de una fila, dentro del `div` que envuelve la lista
  // entera) NO es portador de ese marcador externo. `markersWithInner` marca
  // los marcadores que no pueden ser punto de atribución.
  const markersWithInner = new Set(
    profileMarkers.filter((m) => profileMarkers.some((other) => other !== m && containsAcrossShadow(m, other))),
  );

  // §3.2 — un elemento del mapa lleva `invalid:true` si tiene un marcador
  // ancestro-o-propio (propagación SOLO del perfil: el camino estándar de
  // `isInvalid` ya evaluado arriba, por elemento, no cambia — P4). Cada
  // candidato se atribuye a su marcador MÁS CERCANO ("sin doble conteo
  // jerárquico", P7): un widget marcador que contiene celdas marcadas nunca
  // compite con ellas por el mismo candidato. §11.1: si ese marcador más
  // cercano envuelve a su vez marcadores internos, el candidato no es
  // portador de nadie — ser portador es la única definición de invalidez por
  // perfil, y esto vale tanto para el resumen como para `invalid` por
  // elemento (consecuencia A de §11.1).
  const portadoresByMarker = new Map();
  if (activeProfile) {
    for (const c of children) {
      const marker = closestMarker(c._el, markerSet);
      if (!marker) continue;
      if (markersWithInner.has(marker)) continue;
      c.invalid = true;
      c._validityMarker = marker;
      if (!portadoresByMarker.has(marker)) portadoresByMarker.set(marker, []);
      portadoresByMarker.get(marker).push(c);
    }
  }

  // §3.2 — "marcador sin portador": ningún elemento del mapa cae dentro de M
  // (ni siquiera atribuido a un marcador más interno). Un marcador que SÍ
  // contiene elementos, pero todos atribuidos a un marcador interno, no aporta
  // entrada propia (evita el doble conteo jerárquico, P7).
  const orphanMarkers = profileMarkers.filter(
    (m) =>
      !markersWithInner.has(m) &&
      !portadoresByMarker.has(m) &&
      !children.some((c) => containsAcrossShadow(m, c._el)),
  );

  // readNames de la HUELLA: TODOS los elements (`read[]` no pagina, H2).
  // Deliberadamente NO se recorta por filtro: hacerlo filtraría `roles`/
  // `namedOnly` dentro de la huella y rompería P7a. La respuesta usa su propia
  // versión acotada a los sobrevivientes del filtro (P7e, I-A).
  const collectNames = (cs) => {
    const set = new Set();
    for (const c of cs) if (c.name) set.add(c.name);
    return set;
  };
  const allReadNames = collectNames(children);

  const collectValueTextNodes = (cs) => {
    const set = new Set();
    for (const c of cs) for (const node of c.ownValueTextNodes) set.add(node);
    return set;
  };

  // fb-018-001 §2.3 — huella del contenido observable COMPLETO del documento:
  // todos los candidatos antes de filtrar y paginar, con todas sus claves y sin
  // truncar valores, más el `read[]` completo (sin cap ni truncado de
  // fragmentos). Función pura del DOM (P5b): ninguna opción de la query
  // participa, así que `changedSinceLast` responde "¿cambió la página?" y no
  // "¿cambió mi query?" (H5). fb-018-005 §2.7 (enmienda post-review, P20c):
  // las CUATRO cotas nuevas de contenido (`name` derivado, `context`,
  // `options`) reciben `Infinity` acá — sin cap ni truncado — porque ninguna
  // es contenido observable, todas son decisiones de payload.
  const infiniteLimits = { value: Infinity, contextEntries: Infinity, contextLength: Infinity, options: Infinity };
  const responseLimits = { value: maxValueLength, contextEntries: maxContextEntries, contextLength: maxContextLength, options: maxOptions };
  const fingerprintInput = [
    children.map((c) => emitElement(c, infiniteLimits)),
    buildRead(root, win, allReadNames, collectValueTextNodes(children), Infinity, Infinity),
  ];
  // fb-020-005 §3.4 (P9b) — un marcador SIN portador también participa de la
  // huella: sin esto un formulario que pasa a inválido en un lugar sin
  // portador no movería `fingerprint`, y `changedSinceLast` mentiría. SOLO se
  // agrega este tercer elemento cuando hay perfil activo (I-3, P3): sin
  // perfil detectado la estructura de `fingerprintInput` —y por lo tanto el
  // digest— queda BYTE-IDÉNTICA a la de antes de esta feature.
  if (activeProfile) fingerprintInput.push(orphanMarkers.map((m) => selectorPath(m, root)));
  const fingerprint = digest(JSON.stringify(fingerprintInput));

  // fb-018-005 §2.7, enmienda post-review (P20c) — el POOL de la RESPUESTA:
  // `children` sustituyendo, para cada tabla cruzada que supera
  // `maxPromotedCells`, sus celdas por la alternativa degradada (granularidad
  // simple, ya calculada); y recortando los `clickable` a los primeros
  // `maxPromotedClickables` en orden de documento. Ninguna de las dos cotas
  // participa de la huella, ya calculada arriba sobre `children` sin recortar
  // (I-C) — mismo patrón que `maxElementsPerPage`/paginación.
  const degradedTables = new Map();
  for (const info of gridResult.crossedTables) {
    if (info.count > maxPromotedCells) degradedTables.set(info.table, info.simpleEntries);
  }
  const responsePool = [];
  const injectedDegraded = new Set();
  let clickablesKept = 0;
  for (const c of children) {
    if (c._gridTable && degradedTables.has(c._gridTable)) {
      if (!injectedDegraded.has(c._gridTable)) {
        injectedDegraded.add(c._gridTable);
        for (const simple of degradedTables.get(c._gridTable)) responsePool.push(simple);
      }
      continue;
    }
    if (c.clickable === true) {
      if (clickablesKept >= maxPromotedClickables) continue;
      clickablesKept++;
    }
    responsePool.push(c);
  }

  // fb-018-005 §2.7, enmienda 9 — ORDEN DE EMISIÓN = orden de documento,
  // promociones incluidas. Se ordena SÓLO el `responsePool`, y DESPUÉS de las
  // dos cotas de arriba: `children` (el conjunto de la huella, ya digerido) no
  // se toca, así que el `fingerprint` no se mueve (I-C, P23c(a)). El sort es
  // estable y un elemento ausente del mapa ordena al final (centinela finito:
  // con Infinity la resta daría NaN).
  // Centinela hoy INALCANZABLE por construcción: todo `_el` del pool sale del
  // mismo recorrido (`allDeepElements`) que llena `documentOrder`. No existe
  // una clase de elementos sin ordinal; queda como red de seguridad del sort.
  const SIN_ORDINAL = Number.MAX_SAFE_INTEGER;
  const ordinalOf = (c) => (documentOrder.has(c._el) ? documentOrder.get(c._el) : SIN_ORDINAL);
  responsePool.sort((a, b) => ordinalOf(a) - ordinalOf(b));

  // §2.4 — filtros opcionales, NUNCA por default (I-A). `visibleOnly` está
  // prohibido explícitamente: `visible:false` significa fuera de viewport, no
  // oculto, y filtrarlo rompería la navegación (H4).
  const roles = options && Array.isArray(options.roles) ? new Set(options.roles) : null;
  const namedOnly = !!(options && options.namedOnly);
  const filtered = responsePool.filter((c) => {
    if (roles && !roles.has(c.role)) return false;
    if (namedOnly && !c.name) return false;
    return true;
  });

  // Paginación (PC7, H2): totalPages sobre la partición completa POST-filtro
  // (ceil(count/limit)); `page` pedida se clamp a [1, totalPages]; la salida es
  // SOLO el slice de esa página (sin pérdida ni duplicación entre páginas).
  const requestedPage = (options && options.page != null) ? Math.max(1, Math.floor(options.page)) : 1;
  const totalPages = Math.max(1, Math.ceil(filtered.length / maxElementsPerPage));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * maxElementsPerPage;
  const slice = filtered.slice(start, start + maxElementsPerPage);

  // Seccionado semántico (D3) aplicado SOLO al slice. M3: distinguimos
  // `sec === root` (root es boundary → sección válida con título) de
  // `sec === null` (sin boundary → sección null).
  const sectionsOrder = [];
  const sectionsMap = new Map(); // key: sectionEl | nullMarker -> elements
  const nullMarker = {};
  const keyFor = (sectionEl) => (sectionEl ? sectionEl : nullMarker);
  const sectionOf = (child) => {
    let sec = child._el.parentElement;
    while (sec && sec !== root) {
      if (isSectionBoundary(sec)) break;
      sec = sec.parentElement;
    }
    if (!sec) return null;
    if (sec === root) return isSectionBoundary(root) ? root : null;
    return sec;
  };
  for (const child of slice) {
    const sec = sectionOf(child);
    const key = keyFor(sec);
    if (!sectionsMap.has(key)) {
      sectionsMap.set(key, []);
      sectionsOrder.push(key);
    }
    sectionsMap.get(key).push(child);
  }

  const makeTitle = (sec) => {
    if (!sec) return '';
    const named = normalizeText(computeAccessibleName(sec));
    if (named) return named;
    if (sec.id) return sec.id;
    return sec.tagName.toLowerCase();
  };

  const sections = [];
  for (const key of sectionsOrder) {
    const els = sectionsMap.get(key);
    sections.push({
      title: makeTitle(key === nullMarker ? null : key),
      // §2.1 — orden canónico: las claves nuevas van DESPUÉS de `visible`, en el
      // orden inert, clickable, context, options, value, checked, selected,
      // expanded (determinismo del JSON, PC9 de fb-017-001, ampliado por
      // fb-018-005 §2.1). Clave ausente = "el elemento no tiene esa dimensión",
      // nunca false/vacío.
      elements: els.map((c) => emitElement(c, responseLimits)),
    });
  }

  // read[] de la RESPUESTA: dedup targeted acotado a los sobrevivientes del
  // filtro (P7c), con los límites de la query. PC4 (D2): fragmento > 300 chars
  // se trunca a 300 + '…'.
  const read = buildRead(
    root,
    win,
    collectNames(filtered),
    collectValueTextNodes(filtered),
    (options && options.maxReadFragmentLength) || 300,
    (options && options.maxReadEntries) || 400,
  );

  const frame = { page, totalPages, sections, read };

  // fb-018-004 §2.2 — `dialog` de primer nivel, presente SOLO con diálogo
  // activo (I-2). `ref` en el mismo encoding compacto que los elementos.
  if (activeDialog) {
    frame.dialog = {
      ref: selectorPath(activeDialog, root),
      role: getRole(activeDialog) || '',
      name: dialogNameOf(activeDialog),
    };
    // fb-018-007 §2.4 — `modal` presente SI Y SÓLO SI `blocking` (I-2, nunca
    // `false`). `dialog` e `inert` dejan de ser complementarios por
    // construcción: con `blocking:false` el Frame trae `dialog` y cero
    // elementos `inert`.
    if (blocking) frame.dialog.modal = true;
  }

  // fb-020-004 §2.4, extendido por fb-020-005 §3.3/I-5 — `invalidCount` sobre
  // TODOS los candidatos y marcadores (antes de filtrar, paginar y aplicar los
  // caps de promoción `maxPromotedCells`/`maxPromotedClickables` — la trampa
  // de P6: `children` ya trae las promociones sin recortar, calculadas arriba
  // de esta línea). Portadores (estándar + perfil) más marcadores sin
  // portador. Presente SOLO con ≥1 inválido (I-6).
  const portadorEntries = children.filter((c) => c.invalid === true);
  const invalidCount = portadorEntries.length + orphanMarkers.length;
  if (invalidCount > 0) frame.invalidCount = invalidCount;

  // fb-020-005 §3.3 (I-5, I-6, I-7) — `invalidElements`: una entrada por
  // portador (§3.2, `ref`/`name`/`context` idénticos a los que el elemento
  // lleva en el mapa — se reusa `emitElement` con los límites de la RESPUESTA
  // para eso, P2) y una por marcador sin portador (`notInMap:true`, §3.2/P8).
  // Se computa sobre el mismo conjunto pre-recorte que `invalidCount` (I-5) y
  // se acota recién acá a 20 entradas (cota de PAYLOAD, no de `invalidCount`,
  // §9.2/P12). `invalidProfile` (§3.5, P13) nombra el perfil SOLO si ≥1
  // entrada vino de él (portador con marcador, o marcador sin portador).
  let invalidFromProfile = orphanMarkers.length > 0;
  const invalidEntries = [];
  for (const c of portadorEntries) {
    const emitted = emitElement(c, responseLimits);
    const field = nearestFieldValue(
      c._el,
      activeProfile && activeProfile.fieldNameAttribute,
      markerSet,
    );
    if (c._validityMarker) invalidFromProfile = true;
    invalidEntries.push(
      makeInvalidEntry({ ref: emitted.ref, name: emitted.name, context: emitted.context, field }),
    );
  }
  for (const m of orphanMarkers) {
    const field = nearestFieldValue(m, activeProfile && activeProfile.fieldNameAttribute, markerSet);
    // §12.1 — nombre accesible del marcador si lo tiene, "" si no (sin inventar valor).
    const name = normalizeText(computeAccessibleName(m) || '');
    invalidEntries.push(
      makeInvalidEntry({ ref: selectorPath(m, root), name, field, notInMap: true }),
    );
  }
  if (invalidEntries.length > 0) frame.invalidElements = invalidEntries.slice(0, 20);
  if (invalidFromProfile) frame.invalidProfile = activeProfile.id;

  // §2.4/P7d — `totalElements` (candidatos ANTES de filtrar y paginar) viaja
  // SOLO cuando difiere de lo devuelto: el caso común (página única sin filtro)
  // no paga bytes por una clave sin información nueva. Es derivado: NO participa
  // de la huella.
  if (responsePool.length !== slice.length) frame.totalElements = responsePool.length;

  // fb-020-003 §2.3 — `nativeDialog` de primer nivel, presente SOLO mientras
  // hay una pregunta nativa pendiente (I-6): sin pregunta la clave no existe
  // (nunca null/false, mismo patrón que `dialog`/`totalElements`). Coexiste
  // con `dialog`/`sections`/`read`/`inert` sin tocarlos. NO participa de la
  // huella: se agrega después de `fingerprint`, ya calculado arriba.
  const pendingNativeDialog = root.ownerDocument && readNativeDialog(root.ownerDocument);
  if (pendingNativeDialog) frame.nativeDialog = pendingNativeDialog;

  // §2.2 — `do[]` es opt-in: duplicación pura de los refs de `sections`, sin
  // consumidor. `include:"both"` restituye la clave (biyección con la página,
  // PC7); cualquier otro valor —incluido el default `"sections"`— la omite.
  if (options && options.include === 'both') frame.do = slice.map((c) => c.ref);

  // §2.3 — campo INTERNO: `background.js` lo consume para `invalidation` y lo
  // elimina antes de responder. Un hash en el payload sería autoderrota.
  frame.fingerprint = fingerprint;
  return frame;
}
