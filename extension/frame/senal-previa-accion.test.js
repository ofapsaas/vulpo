/**
 * senal-previa-accion.test.js — fb-024-senal-previa-accion (sub-fase RED).
 *
 * Verifica P1–P6 de docs/specs/fb-024-senal-previa-accion/spec.md §3.2
 * (D-1..D-7 en §3.1). T1: jsdom con `pretendToBeVisual:true` salvo el caso
 * de documento oculto de P6.
 *
 * Superficie pública bajo prueba (única interfaz declarada, D-2):
 *   signalAction(el, action, value, options) → {signaled: boolean}  (síncrona)
 *     action ∈ {click, type, focus, select, fill}; options = {force?, durationMs?}
 * más performActionAndObserve/performFill (fb-020-002) y serializeFrame
 * (./serializer.js) usados SOLO como oráculo/guarda de equivalencia con el
 * despacho real, igual que los tests existentes (precedente act-observe.test.js).
 * El test-writer no leyó ningún módulo de implementación (index.js, background.js,
 * ni el módulo de señal que creará el GREEN — no existe al escribir este RED).
 *
 * ── Guard de RED (por qué el import de index.js es dinámico) ────────────────
 * Precedente act-observe.test.js:38-57 / native-dialog-ventanas.test.js:42-66.
 * Import estático rompería la CARGA del archivo entero si index.js lanzara.
 * Se carga con catch y CADA test abre con `api(id, ...)`, que aserta
 * `typeof fn === 'function'`: hoy todos los tests caen por AssertionError
 * "signalAction no exportada (RED)". Si index.js no carga, el mensaje lo dice.
 *
 * ── Regla de tiempos del spec (§3.2, línea 78) ──────────────────────────────
 * SÓLO cotas inferiores: las esperas (600 ms de señal, 1000 ms de observer)
 * son pisos que el test AGUANTA antes de leer, nunca techos de tiempo de
 * pared asertados. Ninguna aserción de este archivo acota cuánto TARDA una
 * llamada (flakiness de techos de la base bajo carga, A.8 / test-audit §4).
 *
 * ── Condición C1 (test-audit, aprobada por el orquestador) ──────────────────
 * P1 aserta `getComputedStyle(H).pointerEvents === 'none'`. En jsdom eso
 * resuelve con estilo INLINE del host o con `<style>` a nivel documento, pero
 * NO con `<style>` dentro de un shadow root (jsdom no cascada cross-boundary).
 * Requisito para el implementer: `pointer-events:none` en estilo INLINE del
 * host. El chequeo real de hit-test (elementFromPoint, riesgo 5) va por
 * T-field/P14, donde cualquier forma da 'none'.
 *
 * ── Condición C2 (documental, test-audit): la reinyección de P3 es PARCIAL ──
 * El import con query (`./index.js?inst=2`) crea una instancia DISTINTA de
 * index.js (medido en el audit), pero los módulos hoja son compartidos por el
 * cache de ESM: jsdom no reproduce la reinyección del bundle en un mundo
 * aislado real (donde TODO el bundle se reevalúa). La postcondición observable
 * de P3 (≤ 1 elemento nuevo por documento + serialización de body
 * byte-idéntica, con las 5 llamadas devolviendo signaled:true) se verifica
 * igual porque la unicidad del host es POR DOCUMENTO; la reinyección real la
 * cubre T-field/P14.
 *
 * ── P6 / visibilityState (medido en el audit, lib jsdom 30.0.1) ─────────────
 * jsdom default da `visibilityState === 'prerender'` (NO 'hidden');
 * `pretendToBeVisual:true` da 'visible'. La precondición del caso oculto
 * aserta `!== 'visible'`, nunca `'hidden'`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';

// ── Guard de RED ────────────────────────────────────────────────────────────
let frame = null;
let errorDeCarga = null;
try {
  frame = await import('./index.js');
} catch (e) {
  frame = null;
  errorDeCarga = e;
}

/** Aserta que cada función nombrada está exportada por ./index.js antes de usarla. */
function api(id, ...nombres) {
  const fns = {};
  for (const nombre of nombres) {
    const fn = frame?.[nombre];
    assert.equal(
      typeof fn,
      'function',
      `${nombre} no exportada (RED) por ./index.js — ${id} de fb-024-senal-previa-accion` +
        (errorDeCarga ? `; además ./index.js no cargó: ${errorDeCarga.message}` : ''),
    );
    fns[nombre] = fn;
  }
  return fns;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Window jsdom nuevo. `visual:false` modela el documento oculto de P6. */
function makeWin(html, { visual = true } = {}) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    pretendToBeVisual: visual,
  }).window;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Instantánea de identidad de TODOS los elementos del documento (incl. documentElement). */
function elementosDe(doc) {
  return new Set(doc.querySelectorAll('*'));
}

/** Diferencia de elementos respecto de una instantánea previa del MISMO documento. */
function elementosNuevos(doc, antes) {
  return [...doc.querySelectorAll('*')].filter((e) => !antes.has(e));
}

/** Observer de página sobre documentElement (subtree/childList/attributes/characterData). */
function observarTodo(win) {
  const doc = win.document;
  const observer = new win.MutationObserver(() => {});
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return observer;
}

// Fixture de diálogo modal medido contra Odoo 19 (precedente dialogo-inerte.test.js):
// el fondo queda inerte bajo el diálogo activo. Sin `aria-modal` (caso Odoo).
const FIXTURE_MODAL =
  '<div role="dialog" class="modal d-block"><h4 class="modal-title">Diálogo</h4><button id="dialogo">del diálogo</button></div>' +
  '<button id="fondo">de fondo</button>';

// Modelo de "pregunta nativa pendiente" de P4: anotación DIRECTA del atributo
// que lee readNativeDialog (P24 de fb-020-003; precedente
// native-dialog-guard-act.test.js:77-82). Se escribe ANTES de observar.
const ATRIBUTO_PREGUNTA = 'data-vulpo-native-dialog';
const MENSAJE = '¿Seguro?';
const PREGUNTA_PENDIENTE = JSON.stringify({ type: 'confirm', message: MENSAJE, pending: true });

// ═══════════════════════════════════════════════════════════════════════════
// P1 — señal insertada sobre un despacho válido
// ═══════════════════════════════════════════════════════════════════════════

test('P1: signalAction(btn,"click",undefined,{durationMs:600}) ⇒ {signaled:true}, exactamente 1 elemento nuevo H fuera de body con pointerEvents "none"', () => {
  const { signalAction } = api('P1', 'signalAction');
  const win = makeWin('<button id="b">ok</button>');
  const doc = win.document;
  const btn = doc.getElementById('b');

  const antes = elementosDe(doc);
  const res = signalAction(btn, 'click', undefined, { durationMs: 600 });

  assert.equal(res.signaled, true, `P1: señal encendida para un despacho válido; recibido ${JSON.stringify(res)}`);

  const nuevos = elementosNuevos(doc, antes);
  assert.equal(
    nuevos.length,
    1,
    `P1: exactamente UN elemento nuevo tras la llamada (diff de querySelectorAll('*'), incl. documentElement); hubo ${nuevos.length}`,
  );
  const H = nuevos[0];
  assert.ok(
    !doc.body.contains(H),
    'P1: H NO es descendiente de body (host fuera del árbol serializable, I-3)',
  );
  assert.equal(
    win.getComputedStyle(H).pointerEvents,
    'none',
    'P1 (C1): el host no intercepta punteros — pointer-events:none resoluble por getComputedStyle (estilo inline o <style> top-level)',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — sin mutaciones después de la señal (I-4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escenario P2 (§3.2): señal de 600 ms → takeRecords() inmediato → espera de
 * 600 ms → despacho real (performActionAndObserve/performFill); el listener de
 * la acción llama a takeRecords() y descarta; a ≥ 1000 ms del despacho,
 * takeRecords() da 0 registros (devuelve el conteo para que el test aserte).
 *
 * Con `conNodoExtra`, el mismo flujo agrega un nodo a body a los 500 ms del
 * despacho: el MISMO observer debe registrar ≥ 1 (guarda anti-vacuidad: el
 * observer está vivo y la ventana de medición no está vacía).
 */
async function escenarioP2(apiFns, { html, id, accion, valor, esFill = false, conNodoExtra = false }, etiqueta) {
  const win = makeWin(html);
  const doc = win.document;
  const el = doc.getElementById(id);
  const observer = observarTodo(win);

  const resSenal = apiFns.signalAction(el, accion, valor, { durationMs: 600 });
  assert.equal(resSenal.signaled, true, `${etiqueta}: precondición — señal encendida`);
  observer.takeRecords(); // descarta la inserción del host (Q-1: la ÚNICA mutación de la señal, antes del despacho)

  await sleep(600); // cota inferior: la ventana de señal completa antes de despachar (D-1)

  let t0 = 0;
  let registrosNodoExtra = 0;
  const descarta = () => {
    if (t0 === 0) {
      t0 = performance.now();
      if (conNodoExtra) {
        // Guarda anti-vacuidad: mutación de la PÁGINA (no de la señal) a t0+500.
        // takeRecords() en el MISMO tick de la mutación: en jsdom los records
        // se entregan al callback del observer en la microtask siguiente, y un
        // takeRecords() hecho después de la entrega da 0 (medido con probe:
        // inmediato 1, tras 100 ms 0). Los sub-cases de arriba aserten
        // AUSENCIA (0 ⇒ cierto tanto con la cola pendiente como con los
        // records ya entregados); la guarda aserte PRESENCIA (≥ 1) y por eso
        // debe leer antes de la entrega.
        setTimeout(() => {
          doc.body.appendChild(doc.createElement('div'));
          registrosNodoExtra = observer.takeRecords().length;
        }, 500);
      }
    }
    observer.takeRecords(); // descarta lo acumulado hasta el despacho (p. ej. el fin de la animación)
  };
  if (esFill || accion === 'type') {
    el.addEventListener('input', descarta);
    el.addEventListener('change', descarta);
  } else {
    el.addEventListener('click', descarta);
  }

  const resAccion = esFill
    ? await apiFns.performFill(el, valor, { waitMs: 900, quietMs: 50 })
    : await apiFns.performActionAndObserve(el, accion, valor, { waitMs: 900, quietMs: 50 });
  if (esFill) {
    assert.equal(resAccion.success, true, `${etiqueta}: precondición de no-vacuidad — performFill despachó; recibido ${JSON.stringify(resAccion)}`);
  } else {
    assert.equal(resAccion.ok, true, `${etiqueta}: precondición de no-vacuidad — la acción despachó; recibido ${JSON.stringify(resAccion)}`);
  }

  // Cota inferior: la lectura es a ≥ t0+1000 ms del despacho (nunca antes).
  const restante = 1000 - (performance.now() - t0);
  await sleep(Math.max(0, restante) + 60);

  // Para los sub-cases (conNodoExtra:false) esto es el conteo final; para la
  // guarda (conNodoExtra:true) los records de la mutación del test ya fueron
  // entregados a esta altura, así que se devuelve lo capturado en el mismo
  // tick de la mutación (ver comentario en `descarta`).
  return Math.max(observer.takeRecords().length, registrosNodoExtra);
}

test('P2: tras despachar, el observer de la página registra 0 — click / type / performFill; guarda: con nodo extra a t0+500 registra ≥ 1', async () => {
  const fns = api('P2', 'signalAction', 'performActionAndObserve', 'performFill');

  // Sub-casos del camino real (I-4): la señal no deja mutaciones observables
  // después del despacho, en ninguna de las dos capas (act y fill).
  const subCasos = [
    { html: '<button id="b">ok</button>', id: 'b', accion: 'click', etiqueta: 'P2 click' },
    { html: '<input id="x" aria-label="campo">', id: 'x', accion: 'type', valor: 'abc', etiqueta: 'P2 type' },
    { html: '<input id="x" aria-label="campo">', id: 'x', accion: 'fill', esFill: true, valor: 'texto', etiqueta: 'P2 fill' },
  ];
  for (const c of subCasos) {
    const registros = await escenarioP2(fns, c, c.etiqueta);
    assert.equal(
      registros,
      0,
      `${c.etiqueta}: a ≥ 1000 ms del despacho el observer registra 0 (la señal no deja mutaciones observables, I-4); registró ${registros}`,
    );
  }

  // Guarda anti-vacuidad: el MISMO esquema con un nodo agregado por el TEST a
  // t0+500 ms ⇒ el observer registra ≥ 1 (un takeRecords 0 por defecto, un
  // signaled:false temprano o un observer muerto no pueden pasar esto en vacío).
  const registrosGuarda = await escenarioP2(
    fns,
    { html: '<button id="b">ok</button>', id: 'b', accion: 'click', conNodoExtra: true },
    'P2 guarda',
  );
  assert.ok(
    registrosGuarda >= 1,
    `P2 guarda (no-vacuidad): con un nodo extra a t0+500 ms el observer debe registrar ≥ 1; registró ${registrosGuarda}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P3 — un host por documento (reinyección parcial, condición C2)
// ═══════════════════════════════════════════════════════════════════════════

test('P3: 5 señales (3 de ./index.js + 2 de instancia nueva, separadas ≥ 60 ms) ⇒ ≤ 1 elemento nuevo y serializeFrame(body) byte-idéntico', async () => {
  const { signalAction } = api('P3', 'signalAction');

  const win = makeWin('<button id="b">ok</button><input id="x" aria-label="campo">');
  const doc = win.document;
  const btn = doc.getElementById('b');

  const antes = elementosDe(doc);
  const jsonInicial = JSON.stringify(serializeFrame(doc.body));

  const resultados = [];
  // 3 desde la instancia ./index.js ya cargada.
  for (let k = 0; k < 3; k++) {
    resultados.push(signalAction(btn, 'click', undefined, { durationMs: 50 }));
    await sleep(60); // separación ≥ 60 ms: cada señal termina antes de la siguiente
  }
  // 2 desde una instancia NUEVA del módulo (import con query distinto —
  // modela la reinyección del bundle; ver condición C2 en la cabecera).
  let frame2 = null;
  let error2 = null;
  try {
    frame2 = await import('./index.js?inst=2');
  } catch (e) {
    error2 = e;
  }
  assert.equal(
    typeof frame2?.signalAction,
    'function',
    'P3: la instancia nueva (./index.js?inst=2) también exporta signalAction' +
      (error2 ? `; además no cargó: ${error2.message}` : ''),
  );
  for (let k = 0; k < 2; k++) {
    resultados.push(frame2.signalAction(btn, 'click', undefined, { durationMs: 50 }));
    await sleep(60);
  }

  for (const [i, r] of resultados.entries()) {
    assert.equal(r.signaled, true, `P3 guarda: la llamada ${i + 1} de 5 devolvió signaled:true; recibido ${JSON.stringify(r)}`);
  }

  const nuevos = elementosNuevos(doc, antes);
  assert.ok(
    nuevos.length <= 1,
    `P3: al final hay como máximo 1 elemento nuevo respecto del inicio (un host por documento); hubo ${nuevos.length}`,
  );
  assert.equal(
    JSON.stringify(serializeFrame(doc.body)),
    jsonInicial,
    'P3: serializeFrame(doc.body) es byte-idéntico al del inicio (la señal no entra en la serialización, I-3)',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// P4 — rechazo ⇒ ni señal ni DOM, con guarda de equivalencia por caso
// ═══════════════════════════════════════════════════════════════════════════

test('P4: cada rechazo devuelve {signaled:false} sin elemento nuevo ni registros; el mismo caso por performActionAndObserve/performFill da ok:false/success:false', async () => {
  const fns = api(
    'P4',
    'signalAction',
    'performActionAndObserve',
    'performFill',
    'readNativeDialog',
  );

  // Cada caso: fixture, destino y preparación. La guarda de equivalencia corre
  // el MISMO caso por el camino real del despacho (D-2: signaled es el mismo
  // veredicto que ok/success del despacho — eso es el contrato, no vacuidad).
  const casos = [
    {
      nombre: 'el null',
      html: '<button id="b">ok</button>',
      sinEl: true,
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'el desconectado',
      html: '<button id="b">ok</button>',
      preparar: (doc, el) => el.remove(),
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'control deshabilitado',
      html: '<button id="b" disabled>no</button>',
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'control dentro de fieldset disabled',
      html: '<fieldset disabled><button id="b">no</button></fieldset>',
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'fondo inerte bajo diálogo modal sin force',
      html: FIXTURE_MODAL,
      id: 'fondo',
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'type sobre button',
      html: '<button id="b">ok</button>',
      accion: 'type',
      valor: 'x',
      viaFill: false,
    },
    {
      nombre: 'type sin value',
      html: '<input id="x" aria-label="campo">',
      accion: 'type',
      valor: undefined,
      viaFill: false,
    },
    {
      nombre: 'select sin value',
      html: '<select id="s"><option value="a">A</option></select>',
      accion: 'select',
      valor: undefined,
      viaFill: false,
    },
    {
      nombre: 'select con opción inexistente',
      html: '<select id="s"><option value="a">A</option></select>',
      accion: 'select',
      valor: 'noexiste',
      viaFill: false,
    },
    {
      nombre: 'pregunta nativa pendiente',
      html: '<button id="b">ok</button>',
      preparar: (doc) => doc.documentElement.setAttribute(ATRIBUTO_PREGUNTA, PREGUNTA_PENDIENTE),
      accion: 'click',
      viaFill: false,
    },
    {
      nombre: 'fill sobre input deshabilitado',
      html: '<input id="x" disabled aria-label="campo">',
      accion: 'fill',
      valor: 'texto',
      viaFill: true,
    },
  ];

  const fallos = [];
  for (const c of casos) {
    const etiqueta = `P4 (${c.nombre})`;
    try {
      const win = makeWin(c.html);
      const doc = win.document;
      const el = c.sinEl ? null : doc.getElementById('b') ?? doc.getElementById('fondo') ?? doc.getElementById('x') ?? doc.getElementById('s') ?? doc.getElementById('dialogo');
      if (c.preparar) c.preparar(doc, el);

      // Precondición de la pregunta pendiente: realmente está anotada.
      if (c.nombre === 'pregunta nativa pendiente') {
        assert.ok(
          fns.readNativeDialog(doc) !== null,
          `${etiqueta}: precondición de no-vacuidad — readNativeDialog ve la pregunta anotada`,
        );
      }
      // Precondición del inerte: el despacho REAL lo rechaza sin force (la
      // guarda de abajo); acá sólo fijamos el orden observer→llamada.
      const observer = observarTodo(win);
      const antes = elementosDe(doc);

      const res = fns.signalAction(el, c.accion, c.valor, { durationMs: 600 });
      assert.equal(res.signaled, false, `${etiqueta}: signalAction devuelve signaled:false; recibido ${JSON.stringify(res)}`);
      const nuevos = elementosNuevos(doc, antes);
      assert.equal(nuevos.length, 0, `${etiqueta}: ningún elemento nuevo; hubo ${nuevos.length}`);
      const registros = observer.takeRecords().length;
      assert.equal(registros, 0, `${etiqueta}: el observer registra 0; registró ${registros}`);

      // Guarda por caso (equivalencia con el despacho real): el MISMO caso vía
      // performActionAndObserve/performFill rechaza — un signaled:false por un
      // motivo distinto al del despacho (o un fixture que en realidad
      // despacharía) no puede pasar acá.
      //
      // EXCEPCIÓN — "el desconectado" (D-1 / spec discovery A.2): se omite la
      // guarda de paridad para ESTE caso, no el caso. El camino real del
      // despacho vuelve a resolver el ref y a re-evaluar los guards, de modo
      // que en producción un elemento desconectado se detecta como `stale`
      // ANTES de llegar al despacho; aquí el ref ya viene resuelto, así que
      // performActionAndObserve puede devolver ok:true (es exactamente el
      // falso positivo que motivó D-1: nodo quitado durante la señal ⇒
      // `{ok:true}` con el click en un nodo desconectado, discovery A.2).
      // La postcondición P4 del caso se mantiene intacta arriba
      // (signalAction ⇒ signaled:false, sin elemento nuevo ni registros).
      const opcionesGuarda = { waitMs: 500, quietMs: 30 };
      if (c.nombre !== 'el desconectado') {
        if (c.nombre === 'fondo inerte bajo diálogo modal sin force') {
          opcionesGuarda.force = false;
        }
        let resReal;
        if (c.viaFill) {
          resReal = await fns.performFill(el, c.valor, opcionesGuarda);
          assert.equal(
            resReal.success,
            false,
            `${etiqueta}: guarda — performFill con el mismo caso da success:false; recibido ${JSON.stringify(resReal)}`,
          );
        } else {
          resReal = await fns.performActionAndObserve(el, c.accion, c.valor, opcionesGuarda);
          assert.equal(
            resReal.ok,
            false,
            `${etiqueta}: guarda — performActionAndObserve con el mismo caso da ok:false; recibido ${JSON.stringify(resReal)}`,
          );
          if (c.nombre === 'pregunta nativa pendiente') {
            assert.ok(
              resReal.nativeDialog,
              `${etiqueta}: guarda — el rechazo del despacho nombra la pregunta (nativeDialog); recibido ${JSON.stringify(resReal)}`,
            );
          }
        }
      }
    } catch (e) {
      fallos.push(`${etiqueta}: ${e.message}`);
    }
  }
  assert.deepEqual(fallos, [], `P4: casos con fallo:\n${fallos.join('\n')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// P5 — paridad con force
// ═══════════════════════════════════════════════════════════════════════════

test('P5: inerte habilitado con {force:true} ⇒ signaled:true; deshabilitado con {force:true} ⇒ signaled:false (paridad con el despacho)', async () => {
  const fns = api('P5', 'signalAction', 'performActionAndObserve');

  // Inerte habilitado + force ⇒ señal (el despacho forzado sí ejecuta).
  {
    const win = makeWin(FIXTURE_MODAL);
    const doc = win.document;
    const fondo = doc.getElementById('fondo');
    const antes = elementosDe(doc);

    const resReal = await fns.performActionAndObserve(fondo, 'click', undefined, { force: true, waitMs: 300, quietMs: 30 });
    assert.equal(
      resReal.ok,
      true,
      `P5: precondición/guarda de no-vacuidad — el despacho forzado del fondo habilitado SÍ ejecuta (ok:true); recibido ${JSON.stringify(resReal)}`,
    );

    const res = fns.signalAction(fondo, 'click', undefined, { force: true, durationMs: 600 });
    assert.equal(
      res.signaled,
      true,
      `P5: fondo inerte habilitado con force:true ⇒ signaled:true (paridad con el despacho); recibido ${JSON.stringify(res)}`,
    );
    const nuevos = elementosNuevos(doc, antes);
    assert.equal(nuevos.length, 1, `P5: la señal inserta su host; hubo ${nuevos.length}`);
  }

  // Deshabilitado + force ⇒ sin señal (forzar no habilita un deshabilitado).
  {
    const win = makeWin('<button id="d" disabled>no</button>');
    const doc = win.document;
    const d = doc.getElementById('d');
    const antes = elementosDe(doc);

    const resReal = await fns.performActionAndObserve(d, 'click', undefined, { force: true, waitMs: 300, quietMs: 30 });
    assert.equal(
      resReal.ok,
      false,
      `P5: guarda de no-vacuidad — el despacho forzado de un deshabilitado sigue rechazando (ok:false); recibido ${JSON.stringify(resReal)}`,
    );

    const res = fns.signalAction(d, 'click', undefined, { force: true, durationMs: 600 });
    assert.equal(
      res.signaled,
      false,
      `P5: deshabilitado con force:true ⇒ signaled:false; recibido ${JSON.stringify(res)}`,
    );
    const nuevos = elementosNuevos(doc, antes);
    assert.equal(nuevos.length, 0, `P5: deshabilitado con force ⇒ sin elemento nuevo; hubo ${nuevos.length}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P6 — señal apagada u oculta
// ═══════════════════════════════════════════════════════════════════════════

test('P6: durationMs ausente/0/-1/NaN/"600" ⇒ signaled:false sin elemento nuevo; documento no visible con 600 ⇒ ídem', () => {
  const { signalAction } = api('P6', 'signalAction');

  // durationMs ausente: sin options y con options sin la clave.
  {
    const win = makeWin('<button id="b">ok</button>');
    const doc = win.document;
    const btn = doc.getElementById('b');
    const antes = elementosDe(doc);
    for (const [desc, llamada] of [
      ['sin options', () => signalAction(btn, 'click', undefined)],
      ['options sin durationMs', () => signalAction(btn, 'click', undefined, {})],
    ]) {
      const res = llamada();
      assert.equal(res.signaled, false, `P6: durationMs ${desc} ⇒ signaled:false; recibido ${JSON.stringify(res)}`);
    }
    const nuevos = elementosNuevos(doc, antes);
    assert.equal(nuevos.length, 0, `P6: durationMs ausente ⇒ sin elemento nuevo; hubo ${nuevos.length}`);
  }

  // Valores no finitos > 0.
  const invalidos = [['0', 0], ['-1', -1], ['NaN', NaN], ['"600" (string)', '600']];
  for (const [nombre, v] of invalidos) {
    const win = makeWin('<button id="b">ok</button>');
    const doc = win.document;
    const antes = elementosDe(doc);
    const res = signalAction(doc.getElementById('b'), 'click', undefined, { durationMs: v });
    assert.equal(res.signaled, false, `P6: durationMs ${nombre} ⇒ signaled:false; recibido ${JSON.stringify(res)}`);
    const nuevos = elementosNuevos(doc, antes);
    assert.equal(nuevos.length, 0, `P6: durationMs ${nombre} ⇒ sin elemento nuevo; hubo ${nuevos.length}`);
  }

  // Documento oculto (D-5): JSDOM SIN pretendToBeVisual. Medido en el audit:
  // visibilityState default es 'prerender' (NO 'hidden') — la precondición
  // aserta !== 'visible'.
  {
    const win = makeWin('<button id="b">ok</button>', { visual: false });
    const doc = win.document;
    assert.notEqual(
      doc.visibilityState,
      'visible',
      'P6: precondición — el documento del caso oculto NO es visible (jsdom default)',
    );
    const antes = elementosDe(doc);
    const res = signalAction(doc.getElementById('b'), 'click', undefined, { durationMs: 600 });
    assert.equal(res.signaled, false, `P6: documento no visible ⇒ signaled:false; recibido ${JSON.stringify(res)}`);
    const nuevos = elementosNuevos(doc, antes);
    assert.equal(nuevos.length, 0, `P6: documento no visible ⇒ sin elemento nuevo; hubo ${nuevos.length}`);
  }
});
