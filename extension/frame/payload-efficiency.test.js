/**
 * payload-efficiency.test.js — fb-018-001-frame-payload-efficiency (sub-fase RED).
 *
 * Verifica P1, P2, P3, P3b, P4, P5, P5b, P6, P7(a/b/c/e) y P7d del spec
 * docs/specs/fb-018-001-frame-payload-efficiency/spec.md §2.
 *
 * Escrito SOLO contra el contrato observable de serializeFrame(root, options)
 * y resolveRef(ref, root) — aislamiento anti-trampa: el test-writer no leyó
 * serializer.js ni resolver.js. El oráculo de refs verbosos (P1) se construye
 * ACÁ (toVerbose más abajo), sin importar nada de la implementación.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 * Precedente del repo (estado-observable.test.js:12-24, mugre.test.js:15-16):
 * no todo test de una sub-fase RED tiene que fallar. Dos grupos:
 *
 *  · FALLAN por AssertionError (la funcionalidad no existe todavía):
 *    P1, P3, P3b, P4, P5, P5b, P6, P7a, P7b, P7c, y la mitad "con filtro" de P7d.
 *
 *  P7e se suma en etapa de review (id LOCAL, no numerado en el spec): cubre
 *  el invariante I-A de §2.4 para un caso que P7c no alcanza.
 *
 *  · PINES / anti-regresión — se espera que PASEN ya en RED:
 *    P2 (el resolver ya acepta refs verbosos; la postcondición es que los SIGA
 *    aceptando tras la reescritura del parser) y la mitad "sin filtro" de P7d
 *    (hoy `totalElements` no existe, así que su ausencia se cumple de hecho).
 *    Son guards: si alguno falla, es un defecto real surfaced.
 *
 * ── Guardas de no-vacuidad (deliberadas) ────────────────────────────────────
 * `fingerprint` no existe hoy, así que toda aserción de la forma "misma huella
 * bajo A y bajo B" sería `assert.equal(undefined, undefined)` — verde VACUO.
 * Por eso P5/P5b/P6/P7a abren con `assertHuella()`, que exige string no vacío:
 * esa línea es el AssertionError que hace el RED real, y sigue siendo
 * significativa después de GREEN (impide que un refactor borre el campo y deje
 * los tests verdes por ausencia). Mismo motivo para la guarda de compacidad de
 * P1: comparar un ref verboso contra sí mismo pasaría vacuamente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function serialized(html, options) {
  return serializeFrame(makeDom(html).body, options);
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}

/**
 * Oráculo INDEPENDIENTE del formato verboso previo a esta feature (§2.1).
 * Transforma un ref compacto en el ref que el serializer emitía antes:
 * `tag:N` → `tag:nth-of-type(N)`, respetando el separador `>` y el sufijo
 * `::shadow` (que se desprende ANTES de mirar el índice — §2.1.1).
 * Un segmento ya verboso (termina en `)`) queda intacto: la transformación es
 * idempotente sobre el formato viejo.
 */
function toVerbose(ref) {
  return ref
    .split('>')
    .map((seg) => {
      let sufijo = '';
      if (seg.endsWith('::shadow')) {
        sufijo = '::shadow';
        seg = seg.slice(0, -'::shadow'.length);
      }
      const m = /^(.*):(\d+)$/.exec(seg);
      if (m) seg = `${m[1]}:nth-of-type(${m[2]})`;
      return seg + sufijo;
    })
    .join('>');
}

/** Guarda de no-vacuidad: la huella tiene que existir y ser un digest usable. */
function assertHuella(frame, etiqueta) {
  assert.equal(
    typeof frame.fingerprint,
    'string',
    `${etiqueta}: serializeFrame debe devolver la huella interna \`fingerprint\` como string (§2.3). ` +
      'Sin esta guarda las aserciones de invariancia serían undefined === undefined (verdes vacuas).',
  );
  assert.ok(frame.fingerprint.length > 0, `${etiqueta}: la huella no puede ser el string vacío`);
  return frame.fingerprint;
}

// DOM rico: hermanos indexados, anidamiento, shadow abierta, tag terminado en
// dígito, y controles con estado (las cuatro claves de fb-018-002).
const HTML_RICO =
  '<main>' +
  '<h1>Titulo uno</h1><h1>Titulo dos</h1>' +
  '<form>' +
  '<div><label for="a">Alfa</label><input id="a" value="uno"></div>' +
  '<div><label for="b">Beta</label><input id="b" type="checkbox" checked></div>' +
  '<div><textarea id="t">contenido libre</textarea></div>' +
  '<button>Guardar</button><button>Descartar</button>' +
  '</form>' +
  '<p>texto suelto de la pagina</p>' +
  '</main>';

function domRico() {
  const doc = makeDom(HTML_RICO);
  // Shadow abierta sobre el SEGUNDO div (host no único entre hermanos): es el
  // caso que ejercita el orden de parseo de §2.1.1.
  const divs = doc.querySelectorAll('form > div');
  divs[1].attachShadow({ mode: 'open' }).innerHTML = '<button>Dentro de shadow</button>';
  return doc;
}

// ── §2.1 Encoding compacto de refs ──────────────────────────────────────────

test('P1 (property): para TODO elemento del frame, resolveRef(compacto) === resolveRef(verboso)', () => {
  const doc = domRico();
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const refs = allRefs(frame);
  assert.ok(refs.length >= 6, 'precondición: el fixture emite varios elementos');

  // Guarda de no-vacuidad: si los refs siguen siendo verbosos, toVerbose() es
  // la identidad y la comparación de abajo sería un string contra sí mismo.
  const compactos = refs.filter((r) => /:\d+(?:$|>|::shadow)/.test(r));
  assert.ok(
    compactos.length >= 1,
    `el serializer debe emitir refs en formato compacto tag:N (§2.1); emitidos: ${JSON.stringify(refs)}`,
  );
  for (const r of refs) {
    assert.ok(!r.includes('nth-of-type'), `el ref emitido ya no lleva nth-of-type: ${r}`);
  }

  // La propiedad propiamente dicha, sobre TODOS los elementos.
  for (const ref of refs) {
    const verboso = toVerbose(ref);
    const porCompacto = resolveRef(ref, root);
    const porVerboso = resolveRef(verboso, root);
    assert.ok(porCompacto, `el ref compacto resuelve un nodo: ${ref}`);
    assert.equal(
      porCompacto,
      porVerboso,
      `mismo nodo por ambas formas — compacto ${ref} vs verboso ${verboso}`,
    );
  }
});

test('P2 (retrocompatibilidad, PIN): resolveRef acepta refs verbosos y compactos indistintamente', () => {
  const doc = makeDom('<main><form><div><input></div><div><input></div></form></main>');
  const root = doc.body;
  const esperado = doc.querySelectorAll('form > div')[1].querySelector('input');

  const porVerboso = resolveRef('main>form>div:nth-of-type(2)>input', root);
  assert.equal(porVerboso, esperado, 'un ref verboso (mapa cacheado por el agente) sigue resolviendo');

  const porCompacto = resolveRef('main>form>div:2>input', root);
  assert.equal(porCompacto, esperado, 'el ref compacto resuelve al MISMO nodo');
});

test('P3 (no ambigüedad): <h1> hermanos y un <h12> — ningún ref resuelve al elemento del otro', () => {
  const doc = makeDom(
    '<main>' +
      '<h1><a href="#1">uno</a></h1>' +
      '<h1><a href="#2">dos</a></h1>' +
      '<h12><a href="#12">doce</a></h12>' +
      '</main>',
  );
  const root = doc.body;
  const h1Segundo = doc.querySelectorAll('h1')[1];
  const h12 = doc.querySelector('h12');
  assert.notEqual(h1Segundo, h12, 'precondición: son dos elementos distintos');

  const refH1Segundo = resolveRef('main>h1:2>a', root);
  assert.equal(refH1Segundo, h1Segundo.querySelector('a'), 'main>h1:2>a resuelve al <a> del segundo <h1>');

  const refH12 = resolveRef('main>h12>a', root);
  assert.equal(refH12, h12.querySelector('a'), 'main>h12>a resuelve al <a> del <h12> (tag, no h1 índice 2)');

  assert.notEqual(refH1Segundo, refH12, 'el encoding no colapsa h1:2 con h12');
});

test('P3b (§2.1.1 orden de parseo): host indexado + ::shadow resuelve dentro del shadow del tercer div', () => {
  const doc = makeDom('<main><div>a</div><div>b</div><div>c</div></main>');
  const root = doc.body;
  const tercero = doc.querySelectorAll('main > div')[2];
  const shadow = tercero.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button>Dentro</button>';
  const esperado = shadow.querySelector('button');

  const porCompacto = resolveRef('main>div:3::shadow>button', root);
  assert.equal(porCompacto, esperado, 'main>div:3::shadow>button resuelve al button del shadow del 3er div');

  const porVerboso = resolveRef('main>div:nth-of-type(3)::shadow>button', root);
  assert.equal(
    porVerboso,
    esperado,
    'el equivalente verboso resuelve al MISMO nodo (defecto latente de §2.1.1 corregido)',
  );
});

// ── §2.2 do[] opt-in ────────────────────────────────────────────────────────

test('P4 (do opt-in): sin parámetro y con include:"sections" NO existe la clave `do`; include:"both" la restituye', () => {
  const html = '<button>Uno</button><button>Dos</button><input>';

  const porDefault = serialized(html);
  assert.equal('do' in porDefault, false, 'sin parámetro: la clave `do` NO está presente (no `do: []`)');

  const explicito = serialized(html, { include: 'sections' });
  assert.equal('do' in explicito, false, 'include:"sections": la clave `do` NO está presente');

  // No-vacuidad: la ausencia de `do` no puede deberse a un frame vacío.
  assert.ok(allRefs(porDefault).length >= 3, 'el frame por default sigue emitiendo sus elementos');

  const ambos = serialized(html, { include: 'both' });
  assert.ok(Array.isArray(ambos.do), 'include:"both": `do` es un array');
  assert.deepEqual(
    ambos.do,
    allRefs(ambos),
    '`do` es exactamente los refs de sections[].elements[] de la página, en orden de documento',
  );
});

// ── §2.3 Huella (`fingerprint`) ─────────────────────────────────────────────

test('P5 (independencia de paginación): misma huella en page 1 y page 2 del mismo DOM', () => {
  const html = '<button>1</button><button>2</button><button>3</button><button>4</button><button>5</button>';
  const doc = makeDom(html);
  const root = doc.body;

  const p1 = serializeFrame(root, { page: 1, maxElementsPerPage: 2 });
  const p2 = serializeFrame(root, { page: 2, maxElementsPerPage: 2 });

  const h1 = assertHuella(p1, 'page 1');
  const h2 = assertHuella(p2, 'page 2');

  // No-vacuidad: k < candidatos, así que efectivamente hay más de una página.
  assert.ok(p1.totalPages > 1, 'precondición: el fixture se pagina en más de una página');
  assert.notDeepEqual(allRefs(p1), allRefs(p2), 'precondición: las páginas devuelven elementos distintos');

  assert.equal(h2, h1, 'la huella no depende de la página pedida (§2.3, cierra H5)');
});

test('P5b (property): la huella es función pura del DOM — invariante ante la lista cerrada de opciones de §2.3', () => {
  const doc = domRico();
  const root = doc.body;

  const base = serializeFrame(root, {});
  const referencia = assertHuella(base, 'opciones vacías');

  const variantes = [
    { page: 1 },
    { page: 2, maxElementsPerPage: 2 },
    { maxElementsPerPage: 1 },
    { include: 'both' },
    { include: 'sections' },
    { roles: ['button'] },
    { namedOnly: true },
    { maxValueLength: 1 },
    { maxReadFragmentLength: 1 },
    { maxReadEntries: 1 },
    { page: 3, maxElementsPerPage: 2, include: 'both', roles: ['button'], namedOnly: true, maxValueLength: 2 },
  ];

  for (const opciones of variantes) {
    const frame = serializeFrame(root, opciones);
    const huella = assertHuella(frame, `opciones ${JSON.stringify(opciones)}`);
    assert.equal(
      huella,
      referencia,
      `ninguna opción de la lista cerrada puede influir la huella (§2.3/P5b): ${JSON.stringify(opciones)}`,
    );
  }
});

test('P6 (nunca falsos negativos): los cuatro testigos de mutación cambian la huella', () => {
  // (a) texto que solo afecta read[]
  {
    const doc = makeDom('<main><p id="p">texto original</p><button>Ir</button></main>');
    const root = doc.body;
    const antes = assertHuella(serializeFrame(root, {}), '(a) antes');
    doc.getElementById('p').textContent = 'texto cambiado';
    const despues = assertHuella(serializeFrame(root, {}), '(a) despues');
    assert.notEqual(despues, antes, '(a) un cambio de texto puro (solo read[]) cambia la huella');
  }
  // (b) value de un <input>
  {
    const doc = makeDom('<main><input id="i" value="uno"></main>');
    const root = doc.body;
    const antes = assertHuella(serializeFrame(root, {}), '(b) antes');
    doc.getElementById('i').value = 'dos';
    const despues = assertHuella(serializeFrame(root, {}), '(b) despues');
    assert.notEqual(despues, antes, '(b) cambiar el value de un input cambia la huella (§2.3.1)');
  }
  // (c) checked de un <input type=checkbox>
  {
    const doc = makeDom('<main><input id="c" type="checkbox"></main>');
    const root = doc.body;
    const antes = assertHuella(serializeFrame(root, {}), '(c) antes');
    doc.getElementById('c').checked = true;
    const despues = assertHuella(serializeFrame(root, {}), '(c) despues');
    assert.notEqual(despues, antes, '(c) cambiar checked cambia la huella (§2.3.1)');
  }
  // (d) alta/baja de un elemento candidato
  {
    const doc = makeDom('<main><button>Uno</button></main>');
    const root = doc.body;
    const antes = assertHuella(serializeFrame(root, {}), '(d) antes');
    const nuevo = doc.createElement('button');
    nuevo.textContent = 'Dos';
    doc.querySelector('main').appendChild(nuevo);
    const conAlta = assertHuella(serializeFrame(root, {}), '(d) tras alta');
    assert.notEqual(conAlta, antes, '(d) el alta de un candidato cambia la huella');
    nuevo.remove();
    const trasBaja = assertHuella(serializeFrame(root, {}), '(d) tras baja');
    assert.equal(trasBaja, antes, '(d) la baja devuelve la huella al estado previo (huella = función del DOM)');
  }
});

// ── §2.4 Filtros opcionales ─────────────────────────────────────────────────

test('P7a (los filtros no contaminan la huella): huella idéntica con y sin roles/namedOnly', () => {
  const doc = domRico();
  const root = doc.body;

  const sinFiltro = serializeFrame(root, {});
  const referencia = assertHuella(sinFiltro, 'sin filtro');

  const porRoles = serializeFrame(root, { roles: ['button'] });
  const porNamedOnly = serializeFrame(root, { namedOnly: true });

  // No-vacuidad: los filtros tienen que recortar algo de verdad.
  assert.ok(
    allRefs(porRoles).length < allRefs(sinFiltro).length,
    'precondición: roles:["button"] efectivamente recorta elementos',
  );
  assert.ok(
    allElements(porRoles).every((e) => e.role === 'button'),
    'roles:["button"] deja solo elementos de rol button',
  );

  assert.equal(assertHuella(porRoles, 'roles'), referencia, 'la huella no cambia bajo roles[] (§2.4/P7a)');
  assert.equal(
    assertHuella(porNamedOnly, 'namedOnly'),
    referencia,
    'la huella no cambia bajo namedOnly (§2.4/P7a)',
  );
  assert.ok(
    allElements(porNamedOnly).every((e) => e.name !== ''),
    'namedOnly deja solo elementos con name no vacío',
  );
});

test('P7b (totalPages post-filtro, totalElements pre-filtro)', () => {
  const html =
    '<button>Uno</button><button>Dos</button><button>Tres</button>' +
    '<input id="x"><input id="y"><input id="z">';
  const doc = makeDom(html);
  const root = doc.body;

  const sinFiltro = serializeFrame(root, {});
  assert.equal(allRefs(sinFiltro).length, 6, 'precondición: 6 candidatos sin filtrar');

  const filtrado = serializeFrame(root, { roles: ['button'], maxElementsPerPage: 2 });
  assert.equal(allRefs(filtrado).length, 2, 'la página devuelve su porción del conjunto filtrado');
  assert.equal(filtrado.totalPages, 2, 'totalPages = ceil(3 buttons / 2) — refleja el conjunto POST-filtro');
  assert.equal(
    filtrado.totalElements,
    6,
    'totalElements = candidatos ANTES de filtrar y paginar (§2.4/P7b)',
  );
});

test('P7c (el dedup de read[] se aplica solo a los sobrevivientes del filtro)', () => {
  const html = '<textarea id="t">texto-inicial</textarea><button>Guardar</button>';
  const doc = makeDom(html);
  const root = doc.body;

  const filtrado = serializeFrame(root, { roles: ['button'] });
  // No-vacuidad: el textarea efectivamente quedó fuera de sections.
  assert.ok(
    !allElements(filtrado).some((e) => e.tag === 'textarea'),
    'precondición: el <textarea> no sobrevive al filtro roles:["button"]',
  );
  assert.ok(
    allElements(filtrado).some((e) => e.tag === 'button'),
    'precondición: el <button> sí sobrevive',
  );

  assert.ok(
    (filtrado.read || []).some((frag) => String(frag).includes('texto-inicial')),
    'read[] conserva el texto del elemento filtrado: su contenido no puede desaparecer de la respuesta (§2.4 P7c / I-A)',
  );
});

test('P7e (§2.4/I-A: un filtro no puede hacer desaparecer contenido no relacionado del read[])', () => {
  // P7e es un id LOCAL (el spec numera P7a..P7d); cubre el invariante I-A de
  // §2.4 en un caso que P7c no alcanza: un tercer elemento cuyo texto coincide
  // con el `name` de un elemento FILTRADO, sin ninguna otra relación con él.
  // Si el dedup de read[] se calcula sobre los nombres de TODOS los candidatos
  // (y no solo de los sobrevivientes del filtro), el texto del <p> se suprime
  // por coincidir con el name de un <button> que ya no está en la respuesta:
  // el string "Guardar" desaparece por completo del frame. Eso viola I-A.
  const html =
    '<button>Guardar</button>' + '<p>Guardar</p>' + '<input type="text" aria-label="algo">';
  const doc = makeDom(html);
  const root = doc.body;

  // Control sin filtro: el contenido SÍ está presente en la respuesta completa.
  // Es lo que convierte al test en una aserción de I-A (el filtro es lo que
  // pierde contenido) y no en un mero "read[] contiene un string".
  const sinFiltro = serializeFrame(root, {});
  const presenteSinFiltro =
    allElements(sinFiltro).some((e) => String(e.name || '').includes('Guardar')) ||
    (sinFiltro.read || []).some((frag) => String(frag).includes('Guardar'));
  assert.ok(presenteSinFiltro, 'precondición: sin filtro, "Guardar" está en la respuesta');

  const filtrado = serializeFrame(root, { roles: ['textbox'] });

  // No-vacuidad (a): el control que debe sobrevivir efectivamente sobrevive.
  // Si esto falla, el token de rol es otro y el test no reproduce el bug.
  assert.ok(
    allElements(filtrado).some((e) => e.role === 'textbox'),
    'precondición: el <input type="text"> sobrevive al filtro roles:["textbox"]',
  );
  // No-vacuidad (b): el <button> efectivamente fue filtrado — sin esta guarda
  // el test pasaría por accidente si el filtro no filtrara nada.
  assert.ok(
    !allElements(filtrado).some((e) => e.tag === 'button'),
    'precondición: el <button> NO sobrevive al filtro roles:["textbox"]',
  );

  assert.ok(
    (filtrado.read || []).some((frag) => String(frag).includes('Guardar')),
    'el texto del <p> sigue en read[] bajo el filtro: filtrar un <button> homónimo no puede ' +
      'borrar de la respuesta contenido que no tiene relación con lo filtrado (§2.4 / I-A)',
  );
});

test('P7d (presencia condicional de totalElements)', () => {
  const html = '<button>Uno</button><button>Dos</button><input id="x">';
  const doc = makeDom(html);
  const root = doc.body;

  // PIN: página única, sin filtros → la clave NO viaja.
  const simple = serializeFrame(root, { maxElementsPerPage: 50 });
  assert.equal(allRefs(simple).length, 3, 'precondición: los 3 candidatos entran en una sola página');
  assert.equal(simple.totalPages, 1, 'precondición: una sola página');
  assert.equal(
    'totalElements' in simple,
    false,
    'sin filtro y en página única, `totalElements` NO está presente (§2.4/P7d)',
  );

  // Con filtro que excluye al menos un elemento → la clave SÍ viaja.
  const conFiltro = serializeFrame(root, { roles: ['button'], maxElementsPerPage: 50 });
  assert.equal(allRefs(conFiltro).length, 2, 'precondición: el filtro excluyó el <input>');
  assert.equal('totalElements' in conFiltro, true, 'con filtro que recorta, `totalElements` SÍ está presente');
  assert.equal(conFiltro.totalElements, 3, '`totalElements` vale los candidatos antes de recortar');

  // Con más de una página → la clave SÍ viaja.
  const paginado = serializeFrame(root, { maxElementsPerPage: 2 });
  assert.ok(paginado.totalPages > 1, 'precondición: más de una página');
  assert.equal('totalElements' in paginado, true, 'con más de una página, `totalElements` SÍ está presente');
  assert.equal(paginado.totalElements, 3, '`totalElements` vale los candidatos antes de recortar');
});

test('PIN de infraestructura de P5/P5b/P6/P7a: serializeFrame devuelve `fingerprint` al llamador', () => {
  // NO es una postcondición propia: es el pin del canal del que dependen
  // P5, P5b, P6 y P7a. La eliminación de `fingerprint` antes de responder al
  // cliente ocurre en background.js (§2.3), que no es importable en jsdom, así
  // que esa mitad del contrato vive en el dev-harness (§3), no acá.
  const frame = serialized('<button>OK</button>');
  assertHuella(frame, 'contrato interno');
});
