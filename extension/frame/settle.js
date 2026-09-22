// settle.js — fb-018-006-readiness-signal (content script, isolated world).
// Predicado temporal de quiescencia (spec §2.2): `waitForSettle(doc, opts,
// serializeFn)` observa el DOM con MutationObservers TRANSITORIOS por llamada
// hasta que el contenido observable se aquiesta `quietMs` (o vence `waitMs`) y
// devuelve {settled, waitedMs, frame} — el frame SIEMPRE (I-A: deadline o
// falla nunca devuelven respuesta sin mapa).
//
// Límites del contrato (spec §1.2/§7):
//   · `settled:true` es temporal, no semántico: afirma "ventana completa sin
//     mutaciones + serialización sin mutación concurrente", nunca "tu acción
//     ya se reflejó".
//   · Veto conservador de una sola dirección (§2.2.6): con un indicador de
//     carga nombrado por estándar ([aria-busy="true"], [role="progressbar"],
//     <progress>) jamás se declara settled:true — solo extiende la espera.
//   · Toda duda ⇒ settled:false (I-B): sin MutationObserver, excepción de
//     timers o falla interna ⇒ {settled:false, frame}. Si serializeFn misma
//     lanza ⇒ {settled:false, frame:null} (§2.2.5 enmendado — review
//     OPCIONAL-2 a contrato: una serialización fallida jamás es settled:true;
//     el background propaga el error). Nunca throw hacia el caller.
//
// Stateless por llamada (restricción dura #1): todos los observers se
// desconectan antes de resolver; no hay estado entre llamadas. Defaults de
// waitMs/quietMs viven SOLO acá (§2.1, un punto); el handler Go no los conoce.

// Defaults provisionales (§0.8/§7 D-6): a calibrar con los probes §8; los
// tests verifican comportamiento, no los números (precedente C-3 fb-018-007).
const DEFAULT_WAIT_MS = 5000;
const DEFAULT_QUIET_MS = 300;

// Selectores del veto §2.2.6 — nombrados por estándar (ARIA 1.2 + HTML),
// jamás clases ni texto de sitio (I-5). El veto extiende, nunca produce true.
const INDICADOR_SELECTOR = '[aria-busy="true"], [role="progressbar"], progress';

// Opciones del observer: supraconjunto del root serializado (document.body) —
// contar un supraconjunto es conservador (I-B). El observador de
// documentElement cubre light DOM completo (hermanos de body incluidos); los
// shadow roots abiertos se observan aparte (árboles separados del observer de
// documentElement).
const MO_OPTIONS = { subtree: true, childList: true, attributes: true, characterData: true };

// positiveMs: validación de waitMs/quietMs (§2.1): no-número, no-finito o ≤0
// cae al default. Defaults en UN punto (acá), no en el handler Go.
function positiveMs(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

// Recolecta los shadow roots ABIERTOS alcanzables desde `rootEl` (transitivo:
// un shadow root puede contener otro host). `el.shadowRoot` devuelve null para
// closed — la ciega de shadow cerrado es heredada del serializer (D-2).
function collectOpenShadows(rootEl, into) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
  let hosts;
  try {
    hosts = rootEl.querySelectorAll('*');
  } catch {
    return;
  }
  for (const el of hosts) {
    let sr = null;
    try {
      sr = el.shadowRoot;
    } catch {
      sr = null;
    }
    if (sr && !into.has(sr)) {
      into.add(sr);
      collectOpenShadows(sr, into);
    }
  }
}

// waitForSettle: única función pública (§2.4). `serializeFn` la provee el
// caller (background.js cierra sobre el root y las opciones — settle.js no
// conoce serializeFrame); se invoca con `doc` como argumento de cortesía: el
// closure de producción puede ignorarlo, y los adaptadores de test (serReal)
// lo usan para cerrar sobre el root. Devuelve Promise<{settled, waitedMs,
// frame}> — jamás rechaza (§2.2.5).
export async function waitForSettle(doc, opts, serializeFn) {
  const t0 = Date.now();
  const waitMs = positiveMs(opts && opts.waitMs, DEFAULT_WAIT_MS);
  const quietMs = positiveMs(opts && opts.quietMs, DEFAULT_QUIET_MS);
  const deadline = t0 + waitMs;

  // safeSerialize: la serialización jamás rompe el wait (falla interna ⇒
  // conservador, §2.2.5). Devuelve el Frame o null; si serializeFn LANZA,
  // marca `serializeThrew` (§2.2.5 enmendado: el ciclo resuelve de inmediato
  // {settled:false, frame:null} — una serialización fallida jamás puede
  // declararse settled:true, I-B; no se reintenta hasta el deadline).
  let serializeThrew = false;
  const safeSerialize = () => {
    serializeThrew = false;
    try {
      if (typeof serializeFn !== 'function') return null;
      return serializeFn(doc) ?? null;
    } catch {
      serializeThrew = true;
      return null;
    }
  };

  // El observer se toma de la ventana del documento (P6: en node no hay
  // MutationObserver global; el stub del test es doc.defaultView.MutationObserver).
  const win = doc && doc.defaultView;
  const MO = win ? win.MutationObserver : undefined;
  if (typeof MO !== 'function') {
    // Sin evidencia posible ⇒ settled:false + frame igual (I-B; nunca throw).
    return { settled: false, waitedMs: 0, frame: safeSerialize() };
  }

  return new Promise((resolve) => {
    let quietTimer = null;
    let deadlineTimer = null;
    let mo = null;
    let finished = false;
    let serializing = false;
    let deadlineHit = false;
    let dirty = false;
    let lastFrame = null;
    const shadowRoots = new Set();
    const observedShadows = new WeakSet();

    // Observa todo shadow root del set aún no bajo observación (idempotente:
    // el WeakSet evita re-observar; el Set `shadowRoots` es la única fuente
    // compartida con el veto §2.2.6).
    const observeNewShadows = () => {
      for (const sr of shadowRoots) {
        if (observedShadows.has(sr)) continue;
        observedShadows.add(sr);
        try { mo.observe(sr, MO_OPTIONS); } catch { /* target gone */ }
      }
    };

    // §2.2.1-iii (enmienda review 2026-09-08): re-escan incremental del set
    // de shadows — attachShadow posterior a la instalación no dispara récord
    // de mutación, así que la única vía de descubrimiento es re-consultar.
    // El Set deduplica (barato). Devuelve true si el set CRECIÓ: territorio
    // nuevo ⇒ la ventana de quietud se reinicia (nunca settled:true sobre
    // algo que aún no estuvo observado, I-B). El veto hereda la cobertura al
    // compartir el set.
    const rescanShadows = () => {
      const antes = shadowRoots.size;
      collectOpenShadows(doc.documentElement, shadowRoots);
      if (doc.documentElement.shadowRoot) shadowRoots.add(doc.documentElement.shadowRoot);
      observeNewShadows();
      return shadowRoots.size > antes;
    };

    const cleanup = () => {
      if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      try { if (mo) mo.disconnect(); } catch { /* noop */ }
    };

    // finishWith: ÚNICO punto de resolución. Desconecta TODO antes de resolver
    // (P7: stateless — una mutación tardía no re-abre nada) y nunca lanza.
    const finishWith = (settled, frame) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({
        settled,
        waitedMs: Math.max(0, Math.round(Date.now() - t0)),
        frame: frame === undefined ? null : frame,
      });
    };

    // Degrade conservador (I-B): deadline/falla ⇒ settled:false, y el frame
    // SIEMPRE (I-A): el último serializado, o uno fresco si nunca hubo.
    const degrade = () => finishWith(false, lastFrame != null ? lastFrame : safeSerialize());

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(safeOnQuiet, quietMs);
    };

    // onMutation: cualquier mutación en los scopes cubiertos reinicia la
    // ventana (§2.2.2). Por cada nodo elemento añadido se escanea el
    // SUBÁRBOL COMPLETO con el colector de open shadows (§2.2.1-iii, enmienda
    // review 2026-09-08): el chequeo solo de primer nivel dejaba sombras
    // ANIDADAS en el subárbol insertado serializadas-pero-no-observadas. El
    // Set deduplica; el veto hereda la cobertura al compartir el set. Durante
    // la serialización SOLO marca dirty — el ciclo de serialización es dueño
    // del flujo de timers.
    const onMutation = (mutations) => {
      if (finished) return;
      dirty = true;
      try {
        for (const m of mutations) {
          const added = m.addedNodes;
          if (!added || added.length === 0) continue;
          for (const n of added) {
            if (!n || n.nodeType !== 1) continue;
            try {
              if (n.shadowRoot) shadowRoots.add(n.shadowRoot);
            } catch { /* noop */ }
            collectOpenShadows(n, shadowRoots); // transitivo: subárbol completo
          }
        }
        observeNewShadows();
      } catch { /* el reinicio de ventana ya quedó registrado */ }
      if (!serializing) armQuiet();
    };

    // Veto §2.2.6: presente el indicador ⇒ la quietud no declara settled:true.
    // Consulta el árbol observable (documento + shadow roots seguidos). Una
    // excepción de consulta cuenta como indicador (veto de una sola dirección:
    // extiende, jamás fuerza settled:true).
    const hasLoadingIndicator = () => {
      try {
        if (doc && typeof doc.querySelector === 'function' && doc.querySelector(INDICADOR_SELECTOR)) return true;
        for (const sr of shadowRoots) {
          if (typeof sr.querySelector === 'function' && sr.querySelector(INDICADOR_SELECTOR)) return true;
        }
      } catch {
        return true;
      }
      return false;
    };

    // Paso de serialización (§2.2.3): serializeFn con los observers AÚN
    // activos; cero mutaciones concurrentes ⇒ settled:true; una mutación ⇒
    // repetir ciclo hasta el deadline. El yield (macrotask) garantiza que los
    // callbacks del observer disparados dentro de serializeFn (microtask o
    // task encolada antes) se entreguen antes de la lectura de `dirty`.
    const runSerializeStep = async () => {
      serializing = true;
      dirty = false;
      const frame = safeSerialize();
      if (serializeThrew) {
        // §2.2.5 enmendado (OPCIONAL-2 del review a contrato): serializeFn
        // lanzó ⇒ {settled:false, frame:null} — resolución INMEDIATA y
        // conservadora (sin reintentar hasta el deadline: un serializeFn que
        // siempre lanza no hace girar el ciclo; una serialización fallida
        // jamás puede declararse settled:true, I-B). El frame es null
        // explícito — el background propaga error con esta forma.
        serializing = false;
        finishWith(false, null);
        return;
      }
      if (frame) lastFrame = frame;
      await new Promise((r) => setTimeout(r, 0));
      serializing = false;
      if (finished) return;
      if (deadlineHit || Date.now() >= deadline) {
        degrade(); // conservador: venció ⇒ settled:false con el último frame (I-A)
        return;
      }
      if (dirty) {
        armQuiet(); // repetir desde 2: ventana + serialización de nuevo
        return;
      }
      // H-RE1 (re-review 2026-09-08): cierre exacto del residuo de 1 macrotask.
      // El yield setTimeout(0) es código de página: su único efecto observable
      // pudo ser attachShadow sobre un elemento pre-existente (+ mutaciones
      // solo dentro de esa sombra nueva — attachShadow no dispara récord y la
      // sombra no está aún observada), dejando dirty=false. Re-escan final:
      // si el set creció ⇒ territorio NUNCA observado ⇒ otro ciclo de quietud
      // le da su ventana completa (I-B); solo si nada creció se resuelve
      // settled:true. Entre el re-escan y el resolve no corre código de página
      // (bloque síncrono) — "nunca settled:true sobre algo que aún no estuvo
      // observado" (§2.2.1-iii) queda literalmente cierto en todos los caminos.
      if (rescanShadows()) { armQuiet(); return; }
      finishWith(true, frame);
    };

    const safeOnQuiet = () => {
      try {
        if (finished) return;
        if (Date.now() >= deadline) { degrade(); return; }
        if (dirty) { dirty = false; armQuiet(); return; } // defensa: reinicio tardío
        // §2.2.1-iii: re-escan incremental del set de shadows en CADA
        // evaluación de quietud — un attachShadow post-instalación descubierto
        // acá reinicia la ventana (territorio que aún no se observó no puede
        // declararse quieto, I-B). El veto de abajo hereda la cobertura.
        if (rescanShadows()) { armQuiet(); return; }
        if (hasLoadingIndicator()) { armQuiet(); return; } // veto §2.2.6: extiende
        runSerializeStep();
      } catch {
        degrade(); // excepción de timers ⇒ settled:false + frame (§2.2.5)
      }
    };

    const onDeadline = () => {
      if (finished) return;
      if (serializing) { deadlineHit = true; return; } // el paso en curso decide
      degrade();
    };

    try {
      // (i) documentElement con opciones supraconjunto (§2.2.1-i).
      mo = new MO(onMutation);
      mo.observe(doc.documentElement, MO_OPTIONS);
      // (ii) todo open shadow root alcanzable al instalar (§2.2.1-ii),
      // transitivo dentro de shadows ya hallados — mismo colector/re-escan
      // que las evaluaciones de quietud (§2.2.1-iii).
      rescanShadows();
      // Ventana inicial + deadline absoluto (§2.2.2/§2.2.4).
      armQuiet();
      deadlineTimer = setTimeout(onDeadline, waitMs);
    } catch {
      degrade(); // sin observer instalable ⇒ conservador (§2.2.5)
    }
  });
}
