// dialog.js — fb-018-004-dialogo-y-fondo-inerte (content script, isolated world).
// Módulo compartido (spec §2.6): la detección del diálogo activo y el
// predicado de inertness viven ACÁ, no en serializer.js ni en act.js, para que
// la coherencia serializer↔act (I-4) sea estructural y no disciplinar.
//
// Read-only (I-D): solo lee atributos/roles/estilo computado, nunca escribe.

import { getRole } from 'dom-accessibility-api';

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

// fb-018-007 §2.6 — CANDIDATE_SELECTOR se muda ACÁ desde serializer.js:
// `isBlocking` (más abajo) necesita enumerar el mismo universo de candidatos
// que el serializer para construir W₀ (§2.2.3), y `act.js` necesita poder
// responder por un elemento sin depender de `serializer.js`. serializer.js ya
// importa de este módulo, así que la dependencia inversa sería circular.
export const CANDIDATE_SELECTOR = 'a[href],button,input,select,textarea,[role]';

// fb-018-005 §2.4.1 — constante SEPARADA que amplía CANDIDATE_SELECTOR con
// atributos estándar de accionabilidad (focusability, event handler content
// attribute, editing). La usa SÓLO el serializer para enumerar elementos del
// mapa; CANDIDATE_SELECTOR sigue siendo el universo de testigos de isBlocking
// y el que act.js consulta, sin cambios (§2.4.1: no tocar CANDIDATE_SELECTOR
// para no mover `blocking`/`inert` de fb-018-007 como efecto colateral).
// Enmienda 8 (corrige el sobrealcance de la enmienda 6): `tabindex="-1"` NO
// se excluye acá — el selector vuelve a `[tabindex]` sin discriminar. La
// exclusión de la enmienda 6 era GLOBAL y borraba del mapa, invisiblemente,
// cualquier `<div tabindex="-1">` con handler por `addEventListener` fuera de
// una tabla (I-B: falso negativo indetectable para el agente). La exclusión
// correcta es CONDICIONADA — sólo alcanza a celdas de tabla, donde el camino
// de grid se hace cargo del elemento con granularidad y `context` — y por eso
// vive como regla en el serializer (§2.4.1), no en este selector.
export const PROMOTABLE_SELECTOR =
  CANDIDATE_SELECTOR + ',[tabindex],[onclick],[contenteditable=""],[contenteditable="true"]';

// fb-018-007 §2.2.3 — roles que nunca pueden ser testigo. `dialog`/
// `alertdialog` porque son el propio diálogo activo (ya excluido por
// contención, pero un diálogo HERMANO no activo también queda afuera por
// diseño: no es candidato relevante); `presentation`/`none`/`generic` porque
// un backdrop sin rol semántico real no puede testificar su propia inocencia
// (ver recuadro del orquestador en el spec).
const NON_WITNESS_ROLES = new Set(['presentation', 'none', 'generic', 'dialog', 'alertdialog']);

// fb-018-007 §2.2 — K máximo de testigos y testigos máximos por cuadrante.
const MAX_TESTIGOS = 8;
const MAX_POR_CUADRANTE = 2;

// Único lugar donde vive el criterio de ocultamiento (fb-018-004 §2.6):
// serializer.js lo importa de acá en vez de mantener su propia copia, para
// que un ajuste futuro del criterio no pueda desincronizar la detección del
// diálogo activo del universo de elementos emitidos (lo que rompería I-4 en
// silencio). Un `role="dialog"` con display:none, visibility:hidden/collapse
// o aria-hidden="true" (propio o heredado) no cuenta como diálogo activo —
// si no, frameworks tipo Bootstrap que dejan nodos `.modal` ocultos en el DOM
// marcarían inerte la página entera sin ningún modal realmente abierto.
//
// Generalidad #1 (fb-018-006 — findings/generalidad-no-odoo-ishidden-
// visibility-override-2026-09-08.md): cada propiedad se resuelve en su dominio
// CSS, y son dominios distintos —
//  · `display` NO se hereda: un ancestro `display:none` oculta el subárbol sin
//    override posible y el computed del propio elemento nunca lo refleja — la
//    caminata de ancestros chequea SOLO display:none (caso Bootstrap
//    `.modal { display: none }` que motivó el criterio).
//  · `visibility` SÍ se hereda CON OVERRIDE: un descendiente
//    `visibility:visible` se renderiza visible bajo un ancestro `hidden`
//    (Gmail envuelve su compose en wrapper hidden + panel visible), y el
//    computed style DEL PROPIO elemento ya devuelve el valor final de la
//    cadena — la visibilidad se resuelve con ese valor, sin caminar ancestros
//    (caminarlos condenaba subárboles visibles: el compose entero salía
//    invisible al contrato, `dialog: null` y cero campos, estando en pantalla).
export function isHidden(el, win) {
  const own = win.getComputedStyle(el);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return true;
  let n = el;
  while (n && n.nodeType === 1) {
    if (win.getComputedStyle(n).display === 'none') return true;
    if (n.parentElement) {
      n = n.parentElement;
    } else {
      const rn = n.getRootNode ? n.getRootNode() : null;
      n = rn && rn.host ? rn.host : null;
    }
  }
  return false;
}

export function isAriaHidden(el) {
  let n = el;
  while (n && n.nodeType === 1) {
    if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
    if (n.parentElement) {
      n = n.parentElement;
    } else {
      const rn = n.getRootNode ? n.getRootNode() : null;
      n = rn && rn.host ? rn.host : null;
    }
  }
  return false;
}

// Recorre root y sus shadow roots abiertos (mismo criterio que
// queryCandidates de serializer.js) buscando elementos con
// role dialog/alertdialog, en orden de documento.
function collectDialogCandidates(root) {
  const out = [];
  const walk = (scope) => {
    for (const el of scope.querySelectorAll('*')) {
      if (DIALOG_ROLES.has(getRole(el))) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

// getActiveDialog — spec §2.1, regla ordenada:
// 1. D = candidatos con role dialog/alertdialog, no descartados por
//    isHidden/isAriaHidden. Vacío → sin diálogo activo (null).
// 2. M = subconjunto de D con aria-modal="true". No vacío → el último de M
//    en orden de documento.
// 3. M vacío → el último de D en orden de documento.
export function getActiveDialog(root) {
  const win = (root.ownerDocument ? root.ownerDocument.defaultView : null) || globalThis;
  const d = collectDialogCandidates(root).filter((el) => !isHidden(el, win) && !isAriaHidden(el));
  if (d.length === 0) return null;
  const m = d.filter((el) => el.getAttribute('aria-modal') === 'true');
  const pool = m.length ? m : d;
  return pool[pool.length - 1];
}

// containsAcrossShadow — fb-018-004 §2.4 (enmienda post-review): contención
// COMPUESTA. `Node.contains()` no cruza la shadow boundary, pero el
// serializer sí aplana y emite elementos de shadow roots abiertos — con
// `Element.contains` puro, un elemento dentro de un shadow root anidado en el
// diálogo activo salía falso-negativo (marcado inerte, `act` lo rechazaba)
// pese a estar realmente contenido en él (I-B). Mismo walk que `isHidden`/
// `isAriaHidden` de acá arriba: sube por `parentElement` y, al agotar el
// árbol propio, salta del shadow root a su `host` y sigue. Reflexivo: `n`
// arranca en `el`, así que `el === ancestor` cuenta como contenido.
export function containsAcrossShadow(ancestor, el) {
  let n = el;
  while (n && n.nodeType === 1) {
    if (n === ancestor) return true;
    if (n.parentElement) {
      n = n.parentElement;
    } else {
      const rn = n.getRootNode ? n.getRootNode() : null;
      n = rn && rn.host ? rn.host : null;
    }
  }
  return false;
}

// isInert — spec §2.4 (fb-018-004) + §2.3 (fb-020-004): `e` es inerte
// respecto de `activeDialog` sii `blocking` ∧ NO containsAcrossShadow(
// activeDialog, e) ∧ NO ownedPopup(activeDialog, e). Sin diálogo activo, o sin
// evidencia de tapado, nada es inerte.
export function isInert(activeDialog, blocking, el) {
  if (!activeDialog || !blocking) return false;
  if (containsAcrossShadow(activeDialog, el)) return false;
  return !ownedPopup(activeDialog, el);
}

// fb-020-004 §2.3 cond. 1 — roles ARIA de popup (atributo `role` explícito) o
// atributo HTML `popover`.
const POPUP_ROLES = new Set(['menu', 'listbox', 'tree', 'grid']);

function isPopupContainer(el) {
  if (el.hasAttribute('popover')) return true;
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  return POPUP_ROLES.has(role);
}

function parentAcrossShadow(n) {
  if (n.parentElement) return n.parentElement;
  const rn = n.getRootNode ? n.getRootNode() : null;
  return rn && rn.host ? rn.host : null;
}

// Rama (i): ids referidos por aria-controls/aria-owns desde dentro del diálogo.
function idsControlledFrom(activeDialog) {
  const ids = new Set();
  const owners = [activeDialog, ...activeDialog.querySelectorAll('[aria-controls],[aria-owns]')];
  for (const owner of owners) {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (owner.getAttribute(attr) || '').split(/\s+/)) {
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

function isControlledFromDialog(activeDialog, popup) {
  const ids = idsControlledFrom(activeDialog);
  if (ids.size === 0) return false;
  for (let n = popup; n && n.nodeType === 1; n = parentAcrossShadow(n)) {
    if (n.id && ids.has(n.id)) return true;
  }
  return false;
}

// Rama (ii): el popup sigue al diálogo en orden de documento y el diálogo
// tiene algo desplegado (aria-expanded="true").
function isExpandedFromDialog(activeDialog, popup) {
  const follows = activeDialog.compareDocumentPosition(popup) & 4; // DOCUMENT_POSITION_FOLLOWING
  return !!follows && activeDialog.querySelector('[aria-expanded="true"]') !== null;
}

// ownedPopup — fb-020-004 §2.3: existe P ancestro-o-sí-mismo de `el` (cruzando
// shadow) que es contenedor de popup, no contiene al diálogo activo (que no lo
// contiene a él lo garantiza isInert antes de llamar) y está vinculado al
// diálogo por la rama (i) o la (ii). Sin hit-test (I-4).
function ownedPopup(activeDialog, el) {
  for (let p = el; p && p.nodeType === 1; p = parentAcrossShadow(p)) {
    if (!isPopupContainer(p)) continue;
    if (containsAcrossShadow(p, activeDialog)) continue;
    if (isControlledFromDialog(activeDialog, p) || isExpandedFromDialog(activeDialog, p)) return true;
  }
  return false;
}

// Recorre root y sus shadow roots abiertos matcheando CANDIDATE_SELECTOR
// (mismo criterio que queryCandidates de serializer.js/isBlocking).
function queryCandidatesFlat(root) {
  const out = [];
  const collect = (scope) => {
    for (const el of scope.querySelectorAll(CANDIDATE_SELECTOR)) out.push(el);
    for (const el of scope.querySelectorAll('*')) {
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(root);
  return out;
}

// isBlocking — spec fb-018-007 §2.2: gate de modalidad, booleano único por
// frame. Ninguna decisión de inertness de un elemento depende del hit-test de
// ESE elemento (H4, §1.2): la evidencia se junta sobre un conjunto acotado de
// testigos y el veredicto vale para todo el frame por igual.
export function isBlocking(root, activeDialog) {
  // 1. Sin diálogo activo, no hay inertness — igual que hoy, costo cero.
  if (!activeDialog) return false;

  const doc = root.ownerDocument || root;
  const win = doc.defaultView || globalThis;

  // 2. Capacidad. Sin `elementFromPoint`, degrada a `true` (§2.3): protege
  // Odoo y deja el comportamiento idéntico a v0.4.4 sin ese hit-testing.
  if (typeof doc.elementFromPoint !== 'function') return true;

  // 3. Universo de testigos W₀ — candidatos CRUDOS (un solo querySelectorAll
  // nativo, barato). Los filtros de exclusión (isHidden/isAriaHidden/
  // contención/rol) se aplican PEREZOSAMENTE dentro del loop fusionado de
  // abajo, no acá: aplicarlos por adelantado a TODO W₀ (enmienda post-review,
  // hallazgo de costo del orquestador contra la página de referencia) es el
  // mismo defecto de forma que ya se corrigió para los rects (I2) — isHidden
  // camina ancestros llamando getComputedStyle en cada uno, así que filtrar
  // los ~69 candidatos de fondo por adelantado fuerza esa resolución de
  // estilo aunque el corte del loop ya esté resuelto mucho antes. Perezoso:
  // sólo se evalúa para los candidatos que el loop realmente visita antes de
  // cortar. Mismo orden de documento, mismo resultado — optimización, no
  // cambio de comportamiento.
  const w0 = queryCandidatesFlat(root);

  // 4-7 FUSIONADOS en una sola pasada (enmienda post-review — el reviewer
  // encontró que fusionar SÓLO elegibilidad+selección no alcanza: medido con
  // un fixture de 30 candidatos, esa fusión seguía leyendo 20 rects, porque
  // "cortar cuando los 4 cuadrantes estén llenos" puede exigir recorrer casi
  // todo W₀ si un cuadrante no aparece hasta tarde en el documento — la cota
  // de §5 es ≤ K sobre el COSTO, no una garantía de que la diversidad
  // aparezca temprano).
  //
  // La evidencia (paso 6) se evalúa AL VUELO, testigo por testigo, apenas se
  // acepta uno — no después de juntar la selección completa. Esto permite
  // cortar en el instante en que aparece un testigo alcanzable (§2.2.7: uno
  // solo basta) sin gastar más lecturas de las necesarias.
  //
  // Para el caso `blocking=true` (todos covered) hace falta un criterio de
  // corte propio, porque agotar el presupuesto de lecturas sin haber visto
  // más que UN cuadrante es precisamente la trampa que el propio §2.2.5
  // señala ("un popover anclado arriba a la izquierda taparía exactamente
  // esos" — un popover real puede, de la misma manera, dejar toda la
  // evidencia examinada en un solo cuadrante y esconder el cuadrante libre
  // más adelante en el documento). Por eso el presupuesto de lecturas
  // (≈ K) sólo autoriza cortar por agotamiento cuando la evidencia YA cubre
  // ≥ 2 cuadrantes distintos; si toda la evidencia vino de un único
  // cuadrante, se seguye leyendo más allá del presupuesto hasta encontrar un
  // segundo cuadrante con veredicto o agotar W₀ — es el mismo caso que
  // vuelve necesaria la selección esparcida en primer lugar, y no tiene
  // salida barata: entre bloquear con evidencia insuficiente (falso
  // positivo que sólo `force` resuelve) y pagar el costo real de un caso
  // adversarial minoritario, gana la corrección (I-B).
  //
  // Nota de proceso: esta regla de corte (presupuesto + diversidad de
  // cuadrante) NO está en el spec §2.2.5 tal cual — es la resolución que
  // hizo falta para que la cota de costo declarada (§5) y la regla de
  // selección esparcida (§2.2.5) fueran simultáneamente satisfacibles contra
  // el fixture de costo que agregó el reviewer. Reportado al orquestador
  // como decisión de diseño no cubierta por el spec.
  const innerWidth = win.innerWidth;
  const innerHeight = win.innerHeight;
  const halfW = innerWidth / 2;
  const halfH = innerHeight / 2;
  const porCuadrante = [0, 0, 0, 0];
  const cuadrantesConVeredicto = new Set();
  let testigosAceptados = 0;
  let lecturas = 0;

  for (const el of w0) {
    // Corte por agotamiento del presupuesto de lecturas: sólo válido con
    // evidencia repartida en ≥ 2 cuadrantes (ver nota arriba). `K alcanzado`
    // en testigos ACEPTADOS es el otro corte, independiente del presupuesto
    // de lecturas.
    if (testigosAceptados >= MAX_TESTIGOS) break;
    if (lecturas >= MAX_TESTIGOS && cuadrantesConVeredicto.size >= 2) break;

    // Filtros de W₀ (§2.2.3), perezosos: contención primero (más barato,
    // sin getComputedStyle), después ocultamiento, después rol. Cualquiera
    // que descarte descarta ANTES de pagar el resto.
    if (containsAcrossShadow(activeDialog, el)) continue;
    if (isHidden(el, win)) continue;
    if (isAriaHidden(el)) continue;
    const role = getRole(el);
    if (role != null && NON_WITNESS_ROLES.has(role)) continue;

    let rect;
    try {
      rect = el.getBoundingClientRect();
      lecturas++;
    } catch {
      continue;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) continue; // degenerado: no elegible
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cx > innerWidth || cy < 0 || cy > innerHeight) continue; // fuera del viewport: no elegible

    const cuadrante = (cx < halfW ? 0 : 1) + (cy < halfH ? 0 : 2);
    if (porCuadrante[cuadrante] >= MAX_POR_CUADRANTE) continue; // cupo del cuadrante lleno: no se acepta
    porCuadrante[cuadrante]++;
    testigosAceptados++;

    // Evidencia (§2.2.6), al vuelo.
    const h = doc.elementFromPoint(cx, cy);
    if (h === null) continue; // no emite veredicto
    const covered = !containsAcrossShadow(el, h) && !containsAcrossShadow(h, el);
    if (!covered) return false; // un solo testigo alcanzable basta para declarar no-modal (§2.2.7)
    cuadrantesConVeredicto.add(cuadrante);
  }

  // Conclusión (§2.2.7): blocking ⟺ NO existe ningún testigo con veredicto
  // alcanzable. Se llega acá sin haber encontrado ninguno (cero veredictos o
  // todos `covered`) ⇒ `true`: status quo conservador.
  return true;
}
