/**
 * settle.test.js — fb-018-006-readiness-signal (sub-fase RED).
 *
 * Verifica P1–P9 (quiescencia/deadline y forma/límites/degradación) e I-C del
 * spec docs/specs/fb-018-006-readiness-signal/spec.md §3, sobre jsdom
 * (implementa MutationObserver por ventana) con timers REALES cortos
 * (precedente fb-017-004).
 *
 * ── Guard pattern de RED (por qué el import es dinámico) ────────────────────
 * El módulo `settle.js` NO existe todavía. Un `import './settle.js'` estático
 * rompería la CARGA de todo el archivo (error de compilación, que el gate
 * rechaza como RED). Por eso se carga con catch → null y CADA test abre con
 * `assert.ok(waitForSettle, ...)`: hoy TODOS los tests fallan por
 * AssertionError por la razón correcta (el comportamiento no existe), y
 * cuando GREEN cree el módulo pasan a ejercitar el contrato real.
 *
 * Ledger RED: los 18 tests FALLAN por AssertionError (guard de módulo).
 * No hay pines esperados verdes en RED: hasta el test I-C (que Assertiona
 * serializeFrame, que ya existe) abre con el guard para que la suite nueva
 * sea roja completa y el gate distinga "RED de esta feature" de "ruido".
 *
 * ── Cobertura de los gaps del audit (test-audit.md §5.5) ────────────────────
 * · I-C de los params nuevos: el test "I-C" itera settle/waitMs/quietMs sobre
 *   serializeFrame con el patrón P5b/P20c (payload-efficiency/contenido-
 *   asociado). Diferencia honesta con P20c: acá NO se exige que la opción
 *   "muerda" — que NO muerda ES el contrato (§2.4: serializeFrame no recibe
 *   ninguna opción nueva; §2.6: los params jamás entran al serializer). La
 *   guarda de no-vacuidad es el frame base real (huella + refs no vacíos).
 * · I-2 wire: la ausencia de invalidation.settled/waitedMs sin settle se
 *   arma en background.js (no importable en node — spec §8). El anclaje que
 *   SÍ es testeable en RED queda en la frontera MCP: el test Go
 *   TestGetFrame_SettleForwardOnlyIfPresent asserta AUSENCIA de las claves en
 *   el forward cuando el request no las trae (audit §5.3). El wire de
 *   invalidation completo es P10/P11 (fase E2E posterior).
 *
 * ── Notas de construcción ───────────────────────────────────────────────────
 * · serializeFn: el spec no pinea el argumento (¿doc o root?) → el adaptador
 *   `serReal` acepta ambos. Es un adaptador de TEST, no una relajación: las
 *   aserciones son sobre el Frame devuelto, nunca sobre plumbing.
 * · P3 usa el caso testigo del spec: serializeFn inyectado por el test que
 *   muta el DOM exactamente dentro del callback de serialización.
 * · P8 aísla el camino de espera con un serializeFn centinela que no toca el
 *   DOM: así toda llamada contada es del wait (el serializer legítimamente
 *   lee rects; mismo razonamiento que inert-generico.test.js "hasLayout
 *   DESACTIVADO a propósito"). Contadores sobre la plataforma de la propia
 *   ventana del fixture (patrón inert-generico.test.js:821), no mocks de
 *   plumbing.
 * · D-2 (shadow cerrado, ciega heredada) NO tiene test y no puede tenerlo:
 *   desde fuera ni siquiera se puede obtener una referencia a un shadow root
 *   cerrado para observarlo o mutarlo; la ceguera es de plataforma, no de
 *   implemento. Limitación nombrada en spec §7 D-2.
 * · P4b cláusula "su ausencia no bloquea": es exactamente el escenario de P1
 *   (documento sin indicadores ⇒ comportamiento temporal puro); por la
 *   convención de no-duplicar tests, P1 es ese testigo (cross-ref, no omisión).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';

// ── Guard de RED: el módulo todavía no existe ───────────────────────────────
let settleMod = null;
try {
  settleMod = await import('./settle.js');
} catch {
  settleMod = null; // RED: el import falla hasta que GREEN cree el módulo.
}
const waitForSettle = settleMod?.waitForSettle ?? null;

const GUARD = (id) =>
  `settle.js debe existir y exportar waitForSettle (${id}) — RED de fb-018-006`;

// ── helpers ─────────────────────────────────────────────────────────────────
function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adapter: acepta doc o root (el spec no pinea el argumento de serializeFn). */
function raizDe(arg) {
  return arg && arg.body ? arg.body : arg;
}
const serReal = (arg) => serializeFrame(raizDe(arg), {});

/**
 * Serializer centinela: cada llamada devuelve un objeto DISTINTO e identifica
 * la serialización sin tocar el DOM. Permite aserciones de IDENTIDAD sobre el
 * frame ("es el serializado, nunca undefined") y conteo de ciclos.
 */
function stubSer() {
  const llamadas = [];
  const fn = () => {
    const frame = { __frameCentinela: llamadas.length };
    llamadas.push(frame);
    return frame;
  };
  return { fn, llamadas };
}

function allElements(frame) {
  if (!Array.isArray(frame?.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}

/** Fixture no trivial compartido (P5/P9/I-C). */
const RICH_HTML =
  '<main aria-label="panel">' +
  '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Fila uno</td></tr><tr><td>Fila dos</td></tr></tbody></table>' +
  '<input aria-label="buscador" value="término">' +
  '<select aria-label="vista"><option>Lista</option><option>Pivot</option></select>' +
  '<button>Guardar</button>' +
  '<p>Texto de contexto para read[]</p>' +
  '</main>';

// ── Quiescencia y deadline (spec §3, bloque 1) ──────────────────────────────

test('P1: documento sin mutaciones durante quietMs ⇒ {settled:true} con waitedMs ≥ quietMs — y nunca antes de quietMs', async () => {
  assert.ok(waitForSettle, GUARD('P1'));
  const doc = makeDom('<main><button>Listo</button><input aria-label="nombre"></main>');
  const stub = stubSer();
  const p = waitForSettle(doc, { waitMs: 3000, quietMs: 150 }, stub.fn);
  // Control anti-cortocircuito: a los 60 ms (< quietMs=150) la promesa debe
  // seguir pendiente. Un implemento que declarara quietud sin esperar la
  // ventana caería acá, no solo en la aserción de abajo.
  const ganador = await Promise.race([
    p.then(() => 'resuelta', () => 'rechazada'),
    sleep(60).then(() => 'pendiente'),
  ]);
  assert.equal(ganador, 'pendiente', 'P1: no puede declararse quietud antes de transcurrir la ventana completa de quietMs');
  const res = await p;
  assert.equal(res.settled, true, 'P1: DOM sin mutaciones durante quietMs ⇒ settled:true');
  assert.equal(Number.isInteger(res.waitedMs), true, 'P1: waitedMs es un entero (§2.2)');
  assert.ok(res.waitedMs >= 150, `P1: waitedMs (${res.waitedMs}) ≥ quietMs (150)`);
  assert.equal(res.frame, stub.llamadas[stub.llamadas.length - 1], 'P1: el frame devuelto es el frame serializado');
});

test('P1 (reinicio): una mutación en quietMs−ε reinicia la ventana — no hay settled:true hasta una ventana completa desde la última actividad', async () => {
  assert.ok(waitForSettle, GUARD('P1'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  // Mutación a t≈60, bien dentro de la ventana (quietMs=180). Si el reloj NO
  // reiniciara, el settle caería a ≈180 (waitedMs≈180); si reinicia, el piso
  // es 60+180=240. Umbral 210: 30 ms de margen por lado, tolerante a carga.
  const mutacion = setTimeout(() => {
    doc.body.appendChild(doc.createElement('div'));
  }, 60);
  try {
    const res = await waitForSettle(doc, { waitMs: 3000, quietMs: 180 }, stub.fn);
    assert.equal(res.settled, true, 'P1: tras la ventana completa desde la última actividad ⇒ settled:true');
    assert.ok(
      res.waitedMs >= 210,
      `P1: la mutación (t≈60) debe reiniciar la ventana: piso esperado ≈240; waitedMs=${res.waitedMs}. ` +
        'Un settle a ≈180 indicaría un reloj que NO reinicia con la actividad.',
    );
  } finally {
    clearTimeout(mutacion);
  }
});

test('P2: sin quietud hasta waitMs ⇒ {settled:false}, waitedMs ≤ waitMs+TOL, y el frame devuelto ES el frame serializado (nunca undefined por timeout)', async () => {
  assert.ok(waitForSettle, GUARD('P2'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  const WAIT = 450;
  const TOL = 250; // valor provisional del spec (P2); se pinea con el probe 5.
  // Mutador persistente: cada 50 ms un append al body — la ventana nunca cierra.
  const mutador = setInterval(() => {
    doc.body.appendChild(doc.createElement('span'));
  }, 50);
  let res;
  try {
    res = await waitForSettle(doc, { waitMs: WAIT, quietMs: 200 }, stub.fn);
  } finally {
    clearInterval(mutador);
  }
  assert.equal(res.settled, false, 'P2: deadline vencido sin quietud ⇒ settled:false');
  assert.ok(res.waitedMs >= WAIT - 50, `P2: el deadline se respeta (waitedMs=${res.waitedMs} ≥ ${WAIT - 50})`);
  assert.ok(
    res.waitedMs <= WAIT + TOL,
    `P2: waitedMs (${res.waitedMs}) ≤ waitMs+TOL (${WAIT + TOL}) — nunca espera indefinidamente`,
  );
  assert.equal(
    res.frame,
    stub.llamadas[stub.llamadas.length - 1],
    'P2: por timeout el frame devuelto es el frame serializado — nunca frame undefined (I-A, caso 2 del insumo)',
  );
});

test('P3: mutación DENTRO de serializeFn ⇒ ese ciclo no declara settled:true: se repite ventana+serialización y resuelve en un ciclo posterior limpio', async () => {
  assert.ok(waitForSettle, GUARD('P3'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  // Caso testigo del spec: el observer dispara EXACTAMENTE dentro del callback
  // de serialización (inyectado por el test). Solo la primera serialización muta.
  let ciclos = 0;
  const serMutaUnaVez = (arg) => {
    ciclos++;
    if (ciclos === 1) doc.body.appendChild(doc.createElement('div'));
    return stub.fn(arg);
  };
  const res = await waitForSettle(doc, { waitMs: 2500, quietMs: 100 }, serMutaUnaVez);
  assert.equal(res.settled, true, 'P3: el ciclo posterior (quietud + serialización sin mutación concurrente) ⇒ settled:true');
  assert.ok(
    ciclos >= 2,
    `P3: serializeFn debe llamarse de nuevo tras la mutación concurrente (ciclos=${ciclos}) — ` +
      'si los observadores se desconectaran antes de serializar, la mutación interna pasaría inadvertida y habría un solo ciclo',
  );
  assert.equal(res.frame, stub.llamadas[stub.llamadas.length - 1], 'P3: el frame es el de la serialización que concluyó sin mutación');
});

test('P3 (deadline primero): serializeFn que SIEMPRE muta ⇒ ciclos repetidos hasta el deadline ⇒ settled:false con el ÚLTIMO frame serializado', async () => {
  assert.ok(waitForSettle, GUARD('P3'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  const serMutaSiempre = (arg) => {
    doc.body.appendChild(doc.createElement('i'));
    return stub.fn(arg);
  };
  const res = await waitForSettle(doc, { waitMs: 550, quietMs: 100 }, serMutaSiempre);
  assert.equal(res.settled, false, 'P3: si el deadline vence antes de una serialización limpia ⇒ settled:false');
  assert.ok(stub.llamadas.length >= 2, `P3: hubo reintentos antes del deadline (ciclos=${stub.llamadas.length})`);
  assert.equal(
    res.frame,
    stub.llamadas[stub.llamadas.length - 1],
    'P3: el frame devuelto es el ÚLTIMO frame serializado (nunca sin mapa)',
  );
});

// ── Cobertura de scopes (P4) ────────────────────────────────────────────────

test('P4 (i): mutación en light DOM bajo documentElement — FUERA del root serializado (body) — reinicia la ventana (supraconjunto conservador)', async () => {
  assert.ok(waitForSettle, GUARD('P4-i'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  // Testigo más fuerte de supraconjunto: un hijo DIRECTO de documentElement
  // (hermano de body, jamás serializado) muta a t≈60. Umbrales como P1-reinicio.
  const mutacion = setTimeout(() => {
    doc.documentElement.appendChild(doc.createElement('meta'));
  }, 60);
  try {
    const res = await waitForSettle(doc, { waitMs: 3000, quietMs: 180 }, stub.fn);
    assert.equal(res.settled, true, 'P4(i): settled:true tras la ventana completa desde la mutación');
    assert.ok(
      res.waitedMs >= 210,
      `P4(i): la mutación bajo documentElement (fuera de body) debe reiniciar la ventana ` +
        `(piso ≈240; waitedMs=${res.waitedMs} — un settle a ≈180 indicaría que ese scope no se cuenta)`,
    );
  } finally {
    clearTimeout(mutacion);
  }
});

test('P4 (ii): mutación dentro de un open shadow root PRESENTE al instalar reinicia la ventana', async () => {
  assert.ok(waitForSettle, GUARD('P4-ii'));
  const doc = makeDom('<main><div id="host"></div></main>');
  const shadow = doc.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button>En sombra</button>';
  const stub = stubSer();
  const mutacion = setTimeout(() => {
    shadow.appendChild(doc.createElement('span'));
  }, 60);
  try {
    const res = await waitForSettle(doc, { waitMs: 3000, quietMs: 180 }, stub.fn);
    assert.equal(res.settled, true, 'P4(ii): settled:true tras la ventana completa desde la mutación en sombra');
    assert.ok(
      res.waitedMs >= 210,
      `P4(ii): la mutación en el shadow abierto debe reiniciar la ventana (piso ≈240; waitedMs=${res.waitedMs})`,
    );
  } finally {
    clearTimeout(mutacion);
  }
});

test('P4 (iii): un nodo AÑADIDO durante la ventana con open shadow root — la mutación dentro de su sombra reinicia la ventana', async () => {
  assert.ok(waitForSettle, GUARD('P4-iii'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  let shadowAnadida = null;
  // t≈60: alta del host (mutación observable por sí misma). El host ya trae su
  // open shadow. t≈120: mutación DENTRO de esa sombra — solo cuenta si el
  // implemento registró un observador para la sombra del nodo añadido (§2.2.1-iii).
  const alta = setTimeout(() => {
    const host = doc.createElement('div');
    shadowAnadida = host.attachShadow({ mode: 'open' });
    shadowAnadida.innerHTML = '<p>tarjeta nueva</p>';
    doc.body.appendChild(host);
  }, 60);
  const mutacionEnSombra = setTimeout(() => {
    if (shadowAnadida) shadowAnadida.appendChild(doc.createElement('span'));
  }, 120);
  try {
    const res = await waitForSettle(doc, { waitMs: 3000, quietMs: 180 }, stub.fn);
    assert.ok(shadowAnadida, 'precondición: el host con shadow se añadió durante la espera');
    assert.equal(res.settled, true, 'P4(iii): settled:true tras la ventana completa desde la última mutación');
    // Piso: 120 (mutación en la sombra añadida) + 180 (quietMs) = 300, umbral 270.
    // Si la sombra del añadido NO se observara, la última actividad observable
    // sería el alta a ≈60 ⇒ settle a ≈240 < 270.
    assert.ok(
      res.waitedMs >= 270,
      `P4(iii): la mutación en la sombra del nodo añadido debe reiniciar la ventana ` +
        `(piso ≈300; waitedMs=${res.waitedMs} — un settle a ≈240 indicaría que solo se contó el alta)`,
    );
  } finally {
    clearTimeout(alta);
    clearTimeout(mutacionEnSombra);
  }
});

// ── Veto conservador de indicadores de carga (P4b, enmienda 2026-09-08) ─────

// Los TRES selectores nombrados por estándar (§2.2.6). Fixture ESTÁTICA a
// propósito: sin veto, el documento quieto daría settled:true a ≈quietMs —
// el discriminator es limpio. Un spinner CSS-animado no muta el DOM: esto
// reproduce exactamente ese caso (cero mutaciones + indicador presente).
const INDICADORES = [
  { id: 'aria-busy', html: '<div aria-busy="true"><span>Trabajando</span></div>', etiqueta: '[aria-busy="true"]' },
  { id: 'progressbar', html: '<div role="progressbar" aria-label="progreso"></div>', etiqueta: '[role="progressbar"]' },
  { id: 'progress', html: '<progress value="2" max="10"></progress>', etiqueta: '<progress>' },
];

for (const ind of INDICADORES) {
  test(`P4b (veto): ${ind.etiqueta} persistente ⇒ NUNCA settled:true mientras esté presente; deadline ⇒ settled:false con frame completo`, async () => {
    assert.ok(waitForSettle, GUARD('P4b'));
    const doc = makeDom(`<main><button>Base</button></main>${ind.html}`);
    const stub = stubSer();
    const res = await waitForSettle(doc, { waitMs: 400, quietMs: 80 }, stub.fn);
    assert.equal(
      res.settled,
      false,
      `P4b: con ${ind.etiqueta} presente en el árbol observable NO se declara settled:true (veto de una sola dirección: jamás lo produce; sin veto este DOM quieto daría true a ≈80 ms)`,
    );
    assert.ok(res.waitedMs <= 400 + 250, 'P4b: la espera sigue acotada por el deadline (waitMs+TOL)');
    assert.equal(
      res.frame,
      stub.llamadas[stub.llamadas.length - 1],
      'P4b: el frame sigue viniendo completo — el veto extiende la espera, nunca recorta el mapa (I-A/I-6)',
    );
  });
}

test('P4b (remoción): al REMOVER el indicador durante la espera, la ventana corre y el settle resuelve normalmente', async () => {
  assert.ok(waitForSettle, GUARD('P4b'));
  const doc = makeDom('<main><button>Base</button></main><div id="carga" aria-busy="true"><span>…</span></div>');
  const stub = stubSer();
  // A t≈120 (pasado el primer intento de quietud, quietMs=80) se remueve el
  // indicador. La remoción ES una mutación ⇒ reinicia la ventana; con el veto
  // levantado ya no bloquea ⇒ settle a ≈200 (120+80). Discrimina contra: (a)
  // veto inexistente (settle a ≈80, antes de la remoción) y (b) veto pegajoso
  // que latched false para siempre (settled:false).
  const remocion = setTimeout(() => {
    doc.getElementById('carga').remove();
  }, 120);
  try {
    const res = await waitForSettle(doc, { waitMs: 3000, quietMs: 80 }, stub.fn);
    assert.equal(
      res.settled,
      true,
      'P4b: removido el indicador, el settle resuelve normalmente (el veto extiende, jamás bloquea para siempre)',
    );
    assert.ok(
      res.waitedMs >= 190,
      `P4b: el settle ocurre tras la remoción + ventana completa (piso ≈200; waitedMs=${res.waitedMs})`,
    );
  } finally {
    clearTimeout(remocion);
  }
});
// Cláusula restante de P4b ("su ausencia no bloquea"): documento SIN
// indicadores ⇒ comportamiento temporal puro — es exactamente P1 (cross-ref,
// no se duplica por la convención de tests).

// ── Forma, límites y degradación (spec §3, bloque 2) ────────────────────────

test('P5 (I-D): la espera es read-only — outerHTML de documentElement idéntico antes y después; cero escrituras', async () => {
  assert.ok(waitForSettle, GUARD('P5'));
  const doc = makeDom(RICH_HTML);
  const antes = doc.documentElement.outerHTML;
  const stub = stubSer(); // serializeFn no toca el DOM: toda escritura sería del wait
  const res = await waitForSettle(doc, { waitMs: 1500, quietMs: 80 }, stub.fn);
  assert.equal(res.settled, true, 'precondición: la espera corrió completa (si no, la comparación no dice nada)');
  assert.equal(doc.documentElement.outerHTML, antes, 'P5: el árbol no cambia por esperar — el wait solo observa (I-D)');
});

test('P6: sin MutationObserver disponible (stub undefined) ⇒ {settled:false} + frame serializado; jamás throw hacia el caller', async () => {
  assert.ok(waitForSettle, GUARD('P6'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stub = stubSer();
  // Degradación de plataforma: en node no hay MutationObserver global (verificado
  // node ≥22), así que el implemento necesariamente lo toma de la ventana del
  // documento — stubear doc.defaultView.MutationObserver es la simulación fiel.
  const win = doc.defaultView;
  const moReal = win.MutationObserver;
  win.MutationObserver = undefined;
  let res;
  try {
    // Captura directa, NO assert.doesNotReject: en Node v24 resuelve undefined
    // (descarta el valor de fulfillment) y res.settled sería siempre TypeError.
    // Misma garantía "jamás throw": un rechazo de waitForSettle falla el test async.
    res = await waitForSettle(doc, { waitMs: 500, quietMs: 80 }, stub.fn);
  } finally {
    win.MutationObserver = moReal;
  }
  assert.equal(res.settled, false, 'P6: sin evidencia posible ⇒ settled:false (I-B: conservador, nunca true sin evidencia)');
  assert.equal(
    res.frame,
    stub.llamadas[stub.llamadas.length - 1],
    'P6: el frame igual se devuelve — nunca respuesta sin mapa',
  );
  // H1 (POST-AUDIT fb-018-006): el gate de presencia de §2.3 aplica en ambos outcomes.
  assert.ok(Number.isInteger(res.waitedMs) && res.waitedMs >= 0, 'P6: waitedMs entero ≥0 también en el path de falla interna (§2.2/§2.3)');
});

test('P7: stateless — tras resolver, una mutación tardía no reabre nada y una segunda llamada idéntica espera su ventana completa de nuevo', async () => {
  assert.ok(waitForSettle, GUARD('P7'));
  const doc = makeDom('<main><button>Base</button></main>');
  const stubUno = stubSer();
  const resUno = await waitForSettle(doc, { waitMs: 2000, quietMs: 120 }, stubUno.fn);
  assert.equal(resUno.settled, true, 'P7: la primera llamada resuelve normalmente');
  assert.ok(resUno.waitedMs >= 120, 'P7: la primera llamada esperó su ventana completa');
  // Mutación TARDÍA (post-resolución): los observadores deben estar ya
  // desconectados — no puede re-abrir ni retrasar nada de la llamada cerrada.
  doc.body.appendChild(doc.createElement('div'));
  const stubDos = stubSer();
  const resDos = await waitForSettle(doc, { waitMs: 2000, quietMs: 120 }, stubDos.fn);
  assert.equal(resDos.settled, true, 'P7: dos llamadas consecutivas con los mismos args se comportan idénticamente (I-1 análogo)');
  assert.ok(
    resDos.waitedMs >= 120,
    `P7: la segunda llamada espera una ventana COMPLETA nueva (waitedMs=${resDos.waitedMs}) — ` +
      'sin cortocircuito por estado residual entre llamadas (restricción dura #1: stateless por llamada)',
  );
  assert.equal(
    resDos.frame,
    stubDos.llamadas[stubDos.llamadas.length - 1],
    'P7: la segunda llamada serializa de nuevo — su frame es propio, sin reuso de estado',
  );
});

test('P8: cota dura de costo — el camino de espera hace 0 llamadas a getComputedStyle / getBoundingClientRect / elementFromPoint', async () => {
  assert.ok(waitForSettle, GUARD('P8'));
  const doc = makeDom(RICH_HTML);
  const win = doc.defaultView;
  // Contadores sobre la PLATAFORMA de la propia ventana del fixture (patrón
  // inert-generico.test.js:821): se envuelven las APIs estándar, sin mocks de
  // plumbing. serializeFn es el centinela (no toca el DOM) para que toda
  // llamada contada sea del camino de espera — el serializer legítimamente
  // lee rects y se lo aisla a propósito (mismo razonamiento que el hasLayout
  // desactivado de la cota de rects).
  let rects = 0;
  let estilos = 0;
  let hits = 0;
  const rectReal = win.Element.prototype.getBoundingClientRect;
  const estiloReal = win.getComputedStyle;
  const hitReal = doc.elementFromPoint;
  win.Element.prototype.getBoundingClientRect = function (...args) {
    rects++;
    return rectReal.apply(this, args);
  };
  win.getComputedStyle = (...args) => {
    estilos++;
    return estiloReal.apply(win, args);
  };
  doc.elementFromPoint = (...args) => {
    hits++;
    return hitReal ? hitReal.apply(doc, args) : null;
  };
  try {
    const stub = stubSer();
    const res = await waitForSettle(doc, { waitMs: 1200, quietMs: 80 }, stub.fn);
    assert.equal(res.settled, true, 'precondición: la espera corrió y declaró quietud (si no, no se midió nada)');
    assert.equal(rects, 0, `P8: 0 llamadas a getBoundingClientRect en el camino de espera (hubo ${rects})`);
    assert.equal(estilos, 0, `P8: 0 llamadas a getComputedStyle en el camino de espera (hubo ${estilos})`);
    assert.equal(hits, 0, `P8: 0 llamadas a elementFromPoint en el camino de espera (hubo ${hits})`);
  } finally {
    win.Element.prototype.getBoundingClientRect = rectReal;
    win.getComputedStyle = estiloReal;
    doc.elementFromPoint = hitReal;
  }
});

test('P9: serializeFrame sin cambios de firma ni comportamiento — la huella del mismo DOM es idéntica por el camino settle y por el camino plain', async () => {
  assert.ok(waitForSettle, GUARD('P9'));
  const doc = makeDom(RICH_HTML);
  const res = await waitForSettle(doc, { waitMs: 1500, quietMs: 80 }, serReal);
  assert.equal(res.settled, true, 'precondición: el settle corrió sobre DOM quieto');
  assert.ok(
    Array.isArray(res.frame?.sections) && res.frame.sections.length > 0,
    'precondición: el frame del camino settle es un Frame real (no vacío) — sin esto, comparar huellas no probaría nada',
  );
  const plain = serializeFrame(doc.body, {});
  assert.ok(typeof plain.fingerprint === 'string' && plain.fingerprint.length > 0, 'precondición: serializeFrame produce huella');
  assert.equal(
    res.frame.fingerprint,
    plain.fingerprint,
    'P9/I-C: misma huella por ambos caminos — la serialización no cambió con el wait',
  );
  assert.equal(
    JSON.stringify(res.frame),
    JSON.stringify(plain),
    'P9: el mapa completo es idéntico, no solo la huella (determinismo PC1 de 003)',
  );
});

// ── I-C: los params nuevos nunca influyen la huella ni el mapa (audit §5.5) ─

test('I-C (audit §5.5): settle/waitMs/quietMs nunca influyen la huella ni el mapa — serializeFrame no recibe opciones nuevas (patrón P5b/P20c)', () => {
  assert.ok(waitForSettle, GUARD('I-C'));
  const doc = makeDom(RICH_HTML);
  const base = serializeFrame(doc.body, {});
  // Guarda de no-vacuidad: comparar contra un frame vacío no probaría nada.
  assert.ok(typeof base.fingerprint === 'string' && base.fingerprint.length > 0, 'precondición: huella real no vacía');
  assert.ok(allElements(base).length > 0, 'precondición: el fixture emite elementos');
  // Diferencia honesta con P20c: acá NO se exige que la opción "muerda" — que
  // NO muerda ES el contrato (§2.4: serializeFrame no recibe ninguna opción
  // nueva; §2.6: settle/waitMs/quietMs jamás entran al serializer). La huella
  // es función pura del DOM; los params de settle viven en la capa de espera.
  const variantes = [
    { settle: true },
    { settle: false },
    { waitMs: 5000 },
    { quietMs: 300 },
    { waitMs: 1 },
    { quietMs: 1 },
    { settle: true, waitMs: 5000, quietMs: 300 },
    { settle: 'true', waitMs: '5000', quietMs: '300' }, // tipos crudos: tampoco entran
  ];
  for (const opciones of variantes) {
    const frame = serializeFrame(doc.body, opciones);
    assert.equal(
      frame.fingerprint,
      base.fingerprint,
      `I-C: la huella no cambia con opciones ${JSON.stringify(opciones)} — es función pura del DOM (P5b/P9)`,
    );
    assert.equal(
      JSON.stringify(frame),
      JSON.stringify(base),
      `I-C: el mapa completo no cambia con opciones ${JSON.stringify(opciones)} — los params de settle jamás entran a serializeFrame (§2.4/§2.6)`,
    );
  }
});

// ── RED review-fix (2026-09-08) — review.md hallazgo 1 (BLOQUEANTE) + OPCIONAL-2 a contrato ──
//
// El review Etapa 4 encontró que el scope OBSERVADO por el wait es estrictamente
// menor que el scope SERIALIZADO en dos estados alcanzables (viola I-B literal
// "los scopes contados son supraconjunto del serializado" y P4-iii, cuyo test
// existente solo ejercita el host de PRIMER nivel):
//   · caso 1 — host anidado dentro de un subárbol añadido durante la ventana;
//   · caso 2 — attachShadow post-instalación sobre un elemento ya presente
//     (attachShadow no dispara récord de mutación).
// La enmienda del spec §2.2.1-iii exige: escaneo del SUBÁRBOL completo de cada
// nodo añadido + re-escan incremental del set de shadows en cada evaluación de
// quietud. Estos tests pinean esas postcondiciones (RED antes del fix).
//
// ── Diseño del discriminador temporal (modelo-agnóstico) ────────────────────
// Medido en jsdom (2026-09-08): tras CUALQUIER actividad observable el settle
// cae a última_actividad + 2·quietMs, y sin actividad alguna cae a ≈quietMs.
// Un piso/umbral absoluto no discrimina de forma robusta: depende de esa
// mecánica del implemento (y de que el fix la conserve o no). Por eso P4-iv
// usa DISCRIMINADOR POR DELTA: dos esperas idénticas (misma alta del contenedor
// con su sombra anidada) CORRIENDO EN PARALELO sobre documentos propios, una
// con la mutación interior a t≈300 y otra sin ella — la diferencia
// waitedMs(test) − waitedMs(control) es ≈240 si la sombra anidada se observa y
// ≈0 si no, SEA CUAL SEA la mecánica interna (ambas corridas la sufren igual).
//
// Nota de alcance (premisa de serialización): el review verificó sobre
// serializer.js:132-142 (Firefox) que el serializer baja por cada el.shadowRoot
// alcanzable — la mitad "serializada" de I-B. En jsdom serializeFrame NO expone
// contenido de sombras (verificado 2026-09-08: ni anidadas ni de primer nivel),
// así que esa mitad no es pineable aquí; estos tests pinean la mitad
// OBSERVACIÓN (§2.2.1-iii), igual que ya lo hacen P4-ii/P4-iii para sus scopes.

test('P4 (iv): host ANIDADO en subárbol añadido durante la ventana — la mutación dentro de esa sombra EXTINDE la espera (delta en paralelo vs control ≥ 120 ms)', async () => {
  assert.ok(waitForSettle, GUARD('P4-iv'));
  // Alta común a ambas corridas: t≈60, contenedor de primer nivel SIN shadow
  // propio; el host de la sombra es un DESCENDIENTE suyo (widget dentro del
  // contenedor). Diferencia exacta con P4-iii (host de primer nivel): el chequeo
  // de `n.shadowRoot` sobre addedNodes de primer nivel NO alcanza — hace falta
  // el escaneo del subárbol completo de §2.2.1-iii (enmienda review 2026-09-08;
  // hallazgo 1, caso 1).
  const altaComun = (doc, registrar) =>
    setTimeout(() => {
      const contenedor = doc.createElement('section');
      const widget = doc.createElement('div');
      const sombraAnidada = widget.attachShadow({ mode: 'open' });
      sombraAnidada.innerHTML = '<p>widget anidado</p>';
      contenedor.appendChild(widget);
      doc.body.appendChild(contenedor);
      registrar(sombraAnidada);
    }, 60);
  const docTest = makeDom('<main><button>Base</button></main>');
  const docControl = makeDom('<main><button>Base</button></main>');
  let sombraTest = null;
  const altaTest = altaComun(docTest, (s) => { sombraTest = s; });
  const altaControl = altaComun(docControl, () => {});
  // Escenario TEST: además, t≈300 — mutación DENTRO de la sombra anidada. Solo
  // extiende la espera si el implemento registró un observador para ella.
  const mutacionTest = setTimeout(() => {
    if (sombraTest) sombraTest.appendChild(docTest.createElement('span'));
  }, 300);
  try {
    // En paralelo: misma carga del event loop ⇒ el ruido afecta a ambas por
    // igual y el delta queda limpio.
    const [resTest, resControl] = await Promise.all([
      waitForSettle(docTest, { waitMs: 3000, quietMs: 180 }, stubSer().fn),
      waitForSettle(docControl, { waitMs: 3000, quietMs: 180 }, stubSer().fn),
    ]);
    assert.equal(resTest.settled, true, 'precondición: el escenario test resuelve settled:true (si no, el delta no dice nada)');
    assert.equal(resControl.settled, true, 'precondición: el escenario control resuelve settled:true (si no, el delta no dice nada)');
    const delta = resTest.waitedMs - resControl.waitedMs;
    assert.ok(
      delta >= 120,
      `P4(iv): la mutación en la sombra del host ANIDADO en el subárbol añadido debe reiniciar la ventana: ` +
        `delta esperado ≈240 (la última actividad pasa de ≈60 a ≈300), recibido ${delta} ` +
        `(waitedMs test=${resTest.waitedMs} vs control=${resControl.waitedMs}) — delta ≈0 indicaría que la sombra anidada ` +
        'quedó serializada-pero-no-observada (hallazgo 1, caso 1; viola §2.2.1-iii e I-B)',
    );
  } finally {
    clearTimeout(altaTest);
    clearTimeout(altaControl);
    clearTimeout(mutacionTest);
  }
});

test('P4 (v): attachShadow POST-instalación sobre elemento ya presente — el re-escan de quietud lo incorpora (§2.2.1-iii): su mutación reinicia la ventana, sin settled:true prematuro', async () => {
  assert.ok(waitForSettle, GUARD('P4-v'));
  const doc = makeDom('<main><button>Base</button></main><div id="tardia"></div>');
  const stub = stubSer();
  let sombraTardia = null;
  // t≈60: attachShadow sobre un elemento que YA estaba al instalar. attachShadow
  // NO dispara récord de mutación (hallazgo 1, caso 2): sin re-escan del set de
  // shadows, esta sombra queda fuera del set para siempre.
  const altaTardia = setTimeout(() => {
    sombraTardia = doc.getElementById('tardia').attachShadow({ mode: 'open' });
    sombraTardia.innerHTML = '<p>contenido tardío</p>';
  }, 60);
  // t≈120: mutación dentro de la sombra tardía (sin récord observable directo:
  // la sombra aún no está en el set).
  const mutacionTardia = setTimeout(() => {
    if (sombraTardia) sombraTardia.appendChild(doc.createElement('span'));
  }, 120);
  try {
    const p = waitForSettle(doc, { waitMs: 3000, quietMs: 180 }, stub.fn);
    // Control "no prematuro": un implemento sin re-escan no ve NINGUNA actividad
    // (ni el attachShadow ni su contenido disparan récords observables) y
    // declararía settled:true a ≈quietMs (≈180). A t=260 la promesa debe seguir
    // PENDIENTE: el descubrimiento (primera evaluación de quietud) debe reiniciar
    // la ventana.
    const ganador = await Promise.race([
      p.then(() => 'resuelta', () => 'rechazada'),
      sleep(260).then(() => 'pendiente'),
    ]);
    assert.equal(
      ganador,
      'pendiente',
      'P4(v): NO puede haber settled:true a ≈180 — la sombra attachada post-instalación y mutada dentro de la ventana debe ser descubierta por el re-escan y reiniciar la ventana (hallazgo 1, caso 2; I-B)',
    );
    const res = await p;
    assert.equal(res.settled, true, 'P4(v): settled:true tras la ventana completa desde el descubrimiento');
    // Piso: el re-escan ocurre en la evaluación de quietud (≈180) ⇒ ventana
    // reiniciada ⇒ siguiente evaluación ≈360. Umbral 330 (floor−30, disciplina
    // P4). Un settle entre 180 y 330 indicaría que la sombra tardía quedó fuera
    // del set (settled:true sobre contenido serializado en mutación).
    assert.ok(
      res.waitedMs >= 330,
      `P4(v): el descubrimiento (evaluación ≈180) debe reiniciar la ventana: piso esperado ≈360; waitedMs=${res.waitedMs}`,
    );
  } finally {
    clearTimeout(altaTardia);
    clearTimeout(mutacionTardia);
  }
});

// ── Guard de contrato: serializeFn que lanza (spec §2.2.5 ENMENDADO) ────────
//
// OPCIONAL-2 del review elevada a contrato (enmienda 2026-09-08): si la propia
// serializeFn lanza, el resultado DEBE ser {settled:false, frame:null} y el
// background propaga error (misma clase que el camino plain) en vez de emitir
// una respuesta con forma de éxito sin mapa — un mapa vacío con HTTP-success
// sería leído por el agente como "página vacía genuina" (estado (a) de la tabla
// de decisión). ESTADO MEDIDO (2026-09-08): el implemento actual resuelve
// {settled:true, frame:null} — declarar settled:true sobre una serialización
// que falló es exactamente la promesa que la enmienda prohíbe, así que este
// guard es RED genuino: el fix debe corregir el valor de `settled` además de
// conservar frame:null (forma de guard de contrato PC5/M2, con la salvedad de
// que aquí el contrato enmendado todavía no está implementado).

test('P5b-guard (contrato §2.2.5 enmendado — OPCIONAL-2 del review a contrato): serializeFn que LANZA ⇒ {settled:false, frame:null}, waitedMs entero ≥0, jamás throw hacia el caller', async () => {
  assert.ok(waitForSettle, GUARD('P5b-guard'));
  const doc = makeDom('<main><button>Base</button></main>');
  const serLanza = () => {
    throw new Error('serializer roto (inyectado por el test)');
  };
  // Captura directa, NO assert.doesNotReject (mismo razonamiento que P6): si
  // waitForSettle rechazara, el await falla el test async — "jamás throw hacia
  // el caller" queda verificado por construcción.
  const res = await waitForSettle(doc, { waitMs: 1500, quietMs: 80 }, serLanza);
  assert.equal(
    res.settled,
    false,
    'P5b-guard: falla interna (serializeFn lanza) ⇒ settled:false — I-B: nunca true sin evidencia',
  );
  assert.equal(
    res.frame,
    null,
    'P5b-guard: frame === null con IDENTIDAD ESTRICTA (§2.2.5 enmendado: el background propaga error con esta forma — nunca undefined ni un objeto vacío, que el agente leería como página vacía genuina, estado (a))',
  );
  assert.ok(
    Number.isInteger(res.waitedMs) && res.waitedMs >= 0,
    `P5b-guard: waitedMs entero ≥0 también en el path de falla de serializeFn (recibido: ${res.waitedMs})`,
  );
});
// Nota de alcance: la PROPAGACIÓN de ese frame:null como error por el background
// (misma clase de error que el camino plain, enmienda §2.2.5) es de nivel
// background/wire — no importable ni testeable en jsdom (spec §8); su
// verificación queda cubierta por code review del handler getFrame de
// background.js.
