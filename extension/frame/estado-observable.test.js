/**
 * estado-observable.test.js — fb-018-002-estado-observable (sub-fase RED).
 *
 * Verifica las 24 postcondiciones del spec
 * docs/specs/fb-018-002-estado-observable/spec.md §3: las claves nuevas
 * `value` / `checked` / `selected` / `expanded` del elemento del Frame.
 *
 * Escrito SOLO contra el contrato observable de serializeFrame(root, options)
 * (aislamiento anti-trampa: el test-writer no leyó serializer.js). Ningún test
 * inspecciona estructura interna; todos assertan sobre el Frame devuelto.
 *
 * ── Naturaleza RED esperada ─────────────────────────────────────────────────
 * Precedente del repo (mugre.test.js:15-16, "PC6–PC9 (pines) pasan"): no todos
 * los tests de una sub-fase RED tienen que fallar. Se dividen en dos grupos:
 *
 *  · FALLAN por AssertionError (la funcionalidad no existe todavía):
 *    P1, P2, P3, P4, P4b, P5, P8, P9, P10, P11, P14, P15, P16a, P16b,
 *    y las mitades `value` de P17, P17b y P18.
 *
 *  · PINES / anti-regresión — se espera que PASEN ya en RED, porque assertan
 *    AUSENCIA de las claves nuevas o invariantes que hoy se cumplen de hecho:
 *    P6, P7, P12, P13, P19, P19b, P19c, P20. Son guards: si alguno falla,
 *    es un defecto real surfaced, no un RED artificial. No se los contorsiona
 *    para forzar un fallo.
 *
 * ── Notas de construcción ───────────────────────────────────────────────────
 * · P3 setea `.value` como PROPIEDAD (no como contenido HTML) para no invocar
 *   el strip del newline inicial de <textarea> y aislar la normalización.
 * · P17 hace lo contrario a propósito: el contenido va como NODO DE TEXTO hijo,
 *   que es lo único que hace no-trivial la regla de dedup targeted de §2.6.
 * · P6/P7 assertan primero que el elemento SÍ se emite, para que "no tiene la
 *   clave value" no quede satisfecho por la no-emisión del elemento (§6 del
 *   spec afirma que estos tests son significativos, no vacuos).
 * · P7 no asserta a nivel elemento para input[type=hidden]: §2.4 dice que hoy
 *   ya queda fuera del mapa por la UA stylesheet; solo vale la ausencia global
 *   del string, que es como el spec redactó la postcondición.
 * · P20 compara PROPIEDADES (value/checked/indeterminate), no solo outerHTML:
 *   `input.value` no es un atributo reflejado, así que outerHTML no lo pinea.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';
import { performAction } from './act.js';
// fb-018-005 §9.2: P19b pasa de asserear un PROXY (el conjunto emitido) a
// asserear la propiedad directamente sobre la constante.
import { CANDIDATE_SELECTOR } from './dialog.js';

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
function byRef(frame, ref) {
  return allElements(frame).find((e) => e.ref === ref);
}
function byTag(frame, tag) {
  return allElements(frame).find((e) => e.tag === tag);
}
function firstElement(html, options) {
  const el = allElements(serialized(html, options))[0];
  assert.ok(el, 'se esperaba al menos un elemento emitido para este DOM');
  return el;
}

// Fixture golden de §2.7 del spec (reproduce G1 y G2).
const FIXTURE_27 =
  '<div><label for="v">Proveedor</label><input id="v" value="Ferretería Vulpo SA"></div>' +
  '<div role="radiogroup" aria-label="Barra de estado">' +
  '<button role="radio" aria-checked="true"  disabled>SdP</button>' +
  '<button role="radio" aria-checked="false" disabled>SdP enviada</button>' +
  '</div>' +
  '<input type="checkbox" id="c" checked><label for="c">Pedir confirmación</label>';

// fb-018-001 §5.1 ed.2 + §5.2 (supersesión de formato de los goldens de
// fb-018-002 §2.7/P19): mismos elementos, mismas propiedades verificadas,
// ref reescrito al encoding compacto de §2.1. REF_CHECKBOX no lleva índice.
const REF_INPUT_PROVEEDOR = 'div:1>input';
const REF_RADIO_1 = 'div:2>button:1';
const REF_RADIO_2 = 'div:2>button:2';
const REF_CHECKBOX = 'input';
const REF_RADIOGROUP = 'div:2';

// ── value: quién la lleva (§2.2) ────────────────────────────────────────────

test('P1 (value): un <input> de texto con valor expone ese valor en la clave `value`', () => {
  const el = firstElement('<input id="v" value="Ferretería Vulpo SA">');
  assert.equal(el.value, 'Ferretería Vulpo SA');
});

test('P2 (value presente aunque vacío): un <input> con .value "" TIENE la clave `value` y vale ""', () => {
  const el = firstElement('<input id="vacio">');
  assert.ok(
    Object.prototype.hasOwnProperty.call(el, 'value'),
    'la clave `value` debe estar PRESENTE (ausente != vacío, §2.1)',
  );
  assert.equal(el.value, '', 'un campo vacío se declara con value:"" , no con ausencia');
});

test('P3 (value normalizado): un <textarea> con .value "linea uno\\n  linea dos" expone "linea uno linea dos"', () => {
  // .value como PROPIEDAD (no contenido HTML): aísla la normalización del
  // strip de newline inicial que aplica el parser a <textarea>.
  const doc = makeDom('<textarea id="t"></textarea>');
  doc.getElementById('t').value = 'linea uno\n  linea dos';
  const el = byTag(serializeFrame(doc.body, {}), 'textarea');
  assert.ok(el, 'el <textarea> se emite');
  assert.equal(el.value, 'linea uno linea dos', 'whitespace colapsado a un espacio + trim');
});

test('P4 (value de select): un <select> expone la ETIQUETA visible de la opción seleccionada, no su value', () => {
  const el = firstElement('<select><option value="a">Alfa</option><option value="b" selected>Beta</option></select>');
  assert.equal(el.value, 'Beta', 'la etiqueta visible ("Beta"), nunca el value crudo ("b")');
});

test('P4b (round-trip escritura->lectura): tras performAction(select, "select", "a") el `value` reserializado es "Alfa"', () => {
  // Mismo DOM en ambas serializaciones (el helper `serialized` construiría un
  // JSDOM nuevo por llamada y el round-trip sería vacuo).
  const doc = makeDom('<select id="s"><option value="a">Alfa</option><option value="b" selected>Beta</option></select>');
  const body = doc.body;
  const select = doc.getElementById('s');

  const antes = byTag(serializeFrame(body, {}), 'select');
  assert.ok(antes, 'el <select> se emite antes de actuar');
  assert.equal(antes.value, 'Beta', 'precondición: arranca en la opción seleccionada por HTML');

  // Guard: un fallo de act.js no debe disfrazarse de fallo del serializer.
  const res = performAction(select, 'select', 'a');
  assert.deepEqual(res, { ok: true }, 'precondición: la acción `select` se ejecutó ok');

  const despues = byTag(serializeFrame(body, {}), 'select');
  assert.ok(despues, 'el <select> se emite después de actuar');
  assert.equal(despues.value, 'Alfa', 'el contrato cierra el lazo escribir->verificar (G1)');
});

test('P5 (value de select[multiple]): las etiquetas seleccionadas van unidas por ", " en orden de documento', () => {
  const el = firstElement(
    '<select multiple>' +
      '<option value="a" selected>Alfa</option>' +
      '<option value="b">Beta</option>' +
      '<option value="g" selected>Gamma</option>' +
      '</select>',
  );
  assert.equal(el.value, 'Alfa, Gamma');
});

// ── Seguridad: datos que NUNCA se serializan (§2.4) ─────────────────────────

test('P6 (seguridad, dura): el valor de un input[type=password] no aparece en ninguna parte del frame', () => {
  const doc = makeDom('<input type="password" id="p"><label for="p">Contraseña</label>');
  doc.getElementById('p').value = 's3cr3t-unico';
  assert.equal(doc.getElementById('p').value, 's3cr3t-unico', 'precondición: jsdom expone el valor (test no vacuo)');

  const frame = serializeFrame(doc.body, {});
  assert.ok(
    !JSON.stringify(frame).includes('s3cr3t-unico'),
    'el secreto no aparece en value, name, read[] ni ninguna otra clave del frame',
  );

  // No vacuidad: el elemento del password SÍ se emite; lo que falta es la clave.
  const el = byTag(frame, 'input');
  assert.ok(el, 'el input[type=password] se emite como elemento (si no, la ausencia sería vacua)');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(el, 'value'),
    'el elemento del password NO tiene la clave `value`',
  );
});

test('P7 (seguridad): input[type=file] no lleva `value`; el valor de un input[type=hidden] no aparece en el frame', () => {
  const frameFile = serialized('<input type="file" id="f"><label for="f">Adjunto</label>');
  const file = byTag(frameFile, 'input');
  assert.ok(file, 'el input[type=file] se emite como elemento (no vacuidad)');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(file, 'value'),
    'el elemento del file NO tiene la clave `value` (la ruta local no es de la página)',
  );

  // Para hidden solo vale la ausencia global del string: §2.4 dice que hoy ya
  // queda fuera del mapa por la UA stylesheet, así que no se asserta a nivel
  // elemento (sería una aserción sobre algo que puede no existir).
  const doc = makeDom('<input type="hidden" value="csrf-token-unico">');
  assert.equal(
    doc.querySelector('input').value,
    'csrf-token-unico',
    'precondición: jsdom expone el valor del hidden (test no vacuo)',
  );
  assert.ok(
    !JSON.stringify(serializeFrame(doc.body, {})).includes('csrf-token-unico'),
    'ningún token CSRF / session id de un input[type=hidden] entra al frame',
  );
});

// ── checked / selected / expanded (§2.3) ────────────────────────────────────

test('P8 (checked nativo): input[type=checkbox] expone `checked` booleano y NO lleva `value`', () => {
  const tildado = firstElement('<input type="checkbox" checked id="c"><label for="c">Uno</label>');
  assert.equal(tildado.checked, true, 'checkbox tildado -> checked:true');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(tildado, 'value'),
    'el .value nativo ("on") es ruido engañoso: la clave `value` está ausente',
  );

  const destildado = firstElement('<input type="checkbox" id="d"><label for="d">Dos</label>');
  assert.equal(destildado.checked, false, 'checkbox destildado -> checked:false');
});

test('P9 (checked mixed nativo): un checkbox con el.indeterminate = true expone checked === "mixed" (el string)', () => {
  const doc = makeDom('<input type="checkbox" id="c"><label for="c">Parcial</label>');
  doc.getElementById('c').indeterminate = true;
  const el = byTag(serializeFrame(doc.body, {}), 'input');
  assert.ok(el, 'el checkbox se emite');
  assert.equal(el.checked, 'mixed', 'indeterminate tiene precedencia sobre .checked');
  assert.equal(typeof el.checked, 'string', 'es el STRING "mixed", no un boolean');
});

test('P10 (statusbar, G2): entre los dos radios ARIA exactamente uno tiene checked:true, y ambos siguen disabled:true', () => {
  const frame = serialized(FIXTURE_27);
  const radios = allElements(frame).filter((e) => e.role === 'radio');
  assert.equal(radios.length, 2, 'el fixture §2.7 emite exactamente dos elementos de rol radio');

  const tildados = radios.filter((e) => e.checked === true);
  const destildados = radios.filter((e) => e.checked === false);
  assert.equal(tildados.length, 1, 'exactamente UN radio con checked:true (la statusbar deja de ser ilegible)');
  assert.equal(destildados.length, 1, 'el otro radio tiene checked:false');
  assert.equal(tildados[0].name, 'SdP', 'el radio activo es el que declara aria-checked="true"');

  for (const r of radios) {
    assert.equal(r.disabled, true, 'el estado de selección es INDEPENDIENTE de disabled (refuta la guía vieja)');
  }
});

test('P11 (checked por aria-checked): role=checkbox aria-checked="mixed" -> "mixed"; role=switch aria-checked="true" -> true', () => {
  const parcial = firstElement('<div role="checkbox" aria-checked="mixed" tabindex="0">Parcial</div>');
  assert.equal(parcial.checked, 'mixed');

  const encendido = firstElement('<div role="switch" aria-checked="true">On</div>');
  assert.equal(encendido.checked, true);
});

test('P12 (rol checkable sin declarar): un role=checkbox SIN aria-checked no tiene la clave `checked`', () => {
  const el = firstElement('<div role="checkbox">Sin declarar</div>');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(el, 'checked'),
    'el autor de la página no declaró estado -> clave ausente (no false)',
  );
});

test('P13 (ausencia = no aplica): button, link y radiogroup no llevan value/checked/selected/expanded', () => {
  const frame = serialized('<button>Guardar</button><a href="/x">Ir</a>');
  const boton = byTag(frame, 'button');
  const link = byTag(frame, 'a');
  assert.ok(boton && link, 'el <button> y el <a> se emiten (no vacuidad)');
  for (const el of [boton, link]) {
    for (const clave of ['value', 'checked', 'selected', 'expanded']) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(el, clave),
        `<${el.tag}> no tiene dimensión de estado "${clave}" -> clave ausente`,
      );
    }
  }

  // El radiogroup: rama condicional porque el spec dice "si se emite".
  const grupo = byRef(serialized(FIXTURE_27), REF_RADIOGROUP);
  if (grupo) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(grupo, 'checked'),
      'radiogroup NO está en el conjunto de roles checkable -> sin clave `checked`',
    );
  }
});

test('P14 (selected): role=tab con aria-selected mapea directo; sin el atributo, la clave está ausente', () => {
  const frame = serialized(
    '<button role="tab" aria-selected="true">Uno</button><button role="tab" aria-selected="false">Dos</button>',
  );
  const tabs = allElements(frame).filter((e) => e.role === 'tab');
  assert.equal(tabs.length, 2, 'los dos tabs se emiten');
  assert.equal(tabs.find((t) => t.name === 'Uno').selected, true);
  assert.equal(tabs.find((t) => t.name === 'Dos').selected, false);

  const sinAtributo = firstElement('<button role="tab">Tres</button>');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(sinAtributo, 'selected'),
    'un tab sin aria-selected no tiene la clave `selected`',
  );
});

test('P15 (expanded): role=combobox con aria-expanded mapea directo; sin el atributo, la clave está ausente', () => {
  const cerrado = firstElement('<input role="combobox" aria-expanded="false">');
  assert.equal(cerrado.expanded, false);

  const abierto = firstElement('<input role="combobox" aria-expanded="true">');
  assert.equal(abierto.expanded, true);

  const sinAtributo = firstElement('<input role="combobox">');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(sinAtributo, 'expanded'),
    'un combobox sin aria-expanded no tiene la clave `expanded`',
  );
});

// ── Truncado (§2.5) ─────────────────────────────────────────────────────────

test('P16 (truncado, default 300): un value de 500 chars queda en 301 = 300 primeros + "…"', () => {
  const original = 'x'.repeat(500);
  const doc = makeDom('<textarea id="t"></textarea>');
  doc.getElementById('t').value = original;
  const el = byTag(serializeFrame(doc.body, {}), 'textarea');
  assert.ok(el, 'el <textarea> se emite');
  assert.equal(el.value.length, 301, '300 chars + "…" = 301 (mismo default que maxReadFragmentLength)');
  assert.equal(el.value.slice(0, 300), original.slice(0, 300), 'los primeros 300 chars son los del original');
  assert.equal(el.value[el.value.length - 1], '…', 'el último carácter es U+2026');
});

test('P16 (truncado, maxValueLength:10 y borde exacto): con el límite en 10 la longitud es 11; un value de largo 300 NO se trunca', () => {
  const original = 'x'.repeat(500);
  const doc = makeDom('<textarea id="t"></textarea>');
  doc.getElementById('t').value = original;
  const el = byTag(serializeFrame(doc.body, { maxValueLength: 10 }), 'textarea');
  assert.ok(el, 'el <textarea> se emite');
  assert.equal(el.value.length, 11, '10 chars + "…" = 11');
  assert.equal(el.value, 'x'.repeat(10) + '…');

  // Borde: exactamente el límite no se trunca.
  const docBorde = makeDom('<textarea id="b"></textarea>');
  docBorde.getElementById('b').value = 'y'.repeat(300);
  const borde = byTag(serializeFrame(docBorde.body, {}), 'textarea');
  assert.ok(borde, 'el <textarea> del borde se emite');
  assert.equal(borde.value.length, 300, 'un value de longitud exactamente 300 NO se trunca');
  assert.ok(!borde.value.endsWith('…'), 'no se le agrega "…" a un value que no supera el límite');
});

// ── Interacción con read[] (§2.6) ───────────────────────────────────────────

test('P17 (read[] dedup targeted): el contenido de un contenteditable y de un <textarea> viaja en `value` y no se duplica en read[]', () => {
  // Detección por ATRIBUTO propio (enmienda HITL §2.2): jsdom no implementa
  // isContentEditable, así que la regla vinculante es getAttribute.
  const editable = serialized('<div role="textbox" contenteditable="true">contenido-editable</div>');
  const elEditable = byTag(editable, 'div');
  assert.ok(elEditable, 'el div[role=textbox] es candidato y se emite');
  assert.equal(elEditable.value, 'contenido-editable', 'su value es su propio textContent normalizado');
  assert.ok(
    !editable.read.includes('contenido-editable'),
    'read[] no repite el texto que ya viaja en el `value` de su contenedor',
  );

  // Contenido como NODO DE TEXTO hijo: es el caso que hace no-trivial la regla.
  const conTexto = serialized('<textarea>texto-inicial</textarea>');
  const elTextarea = byTag(conTexto, 'textarea');
  assert.ok(elTextarea, 'el <textarea> se emite');
  assert.equal(elTextarea.value, 'texto-inicial');
  assert.ok(!conTexto.read.includes('texto-inicial'), 'read[] no duplica el contenido inicial del textarea');
});

// MODIFICADO por fb-018-005 §9.1 (justificación escrita en el spec).
// Qué asserteaba: `frame.read.includes('Alfa')` — la etiqueta de la opción NO
// seleccionada seguía legible en read[]. §2.6 de fb-018-005 revierte
// deliberadamente esa decisión de fb-018-002: el motivo original
// ("excluirlo borraría de read[] las opciones no seleccionadas") se INVIERTE al
// emitir `options`, porque ese texto pasa a viajar dentro del elemento y
// dejarlo también en read[] sería pagarlo dos veces.
// El test conserva la propiedad que de verdad protegía —las opciones no
// seleccionadas siguen siendo legibles para el agente— y muda la aserción de
// `read[]` a `options`. Lo que se pierde no es cobertura: es una ubicación.
test('P17b (<select>, anti-regresión — REESCRITO fb-018-005 §9.1): las opciones NO seleccionadas siguen legibles, ahora en `options`', () => {
  const doc = makeDom('<select><option>Alfa</option><option selected>Beta</option></select><button>Guardar</button>');
  const root = doc.body;
  const frame = serializeFrame(root, {});
  const el = byTag(frame, 'select');
  assert.ok(el, 'el <select> se emite');
  assert.equal(el.value, 'Beta', '`value` sigue siendo la selección actual, sin cambios');
  assert.ok(
    (el.options || []).includes('Alfa'),
    'la etiqueta de la opción NO seleccionada sigue legible para el agente: ahora en `options` (§2.6)',
  );
  assert.ok(
    !frame.read.includes('Alfa'),
    'y ya no se paga dos veces: sale de read[] porque viaja en el elemento',
  );

  // Mitad complementaria (P15 / I-A): un <select> descartado por el filtro NO
  // borra sus opciones de read[] — unión después del filtro, patrón P7c.
  const filtrado = serializeFrame(root, { roles: ['button'] });
  assert.ok(
    !allElements(filtrado).some((e) => e.tag === 'select'),
    'precondición: el <select> no sobrevive al filtro roles:["button"]',
  );
  assert.ok(
    (filtrado.read || []).some((frag) => String(frag).includes('Alfa')),
    'si el <select> es descartado por el filtro, sus opciones vuelven a read[]: nada desaparece (I-A)',
  );
});

test('P18 (read[] sin filtro global por valor): un <p> con el mismo texto que un `value` sigue en read[]', () => {
  // El input NO lleva label/aria-label/placeholder a propósito: su `name` es ""
  // y por lo tanto el dedup de readNames no interviene. Agregarle una etiqueta
  // invertiría lo que la postcondición afirma.
  const frame = serialized('<input value="Ferretería"><p>Ferretería</p>');
  const el = byTag(frame, 'input');
  assert.ok(el, 'el <input> se emite');
  assert.equal(el.name, '', 'precondición: el input no tiene nombre accesible (si no, actuaría readNames)');
  assert.equal(el.value, 'Ferretería');
  assert.ok(
    frame.read.includes('Ferretería'),
    'los `value` NO actúan como set de exclusión global, a diferencia de los `name`',
  );
});

// ── No regresión / límites de alcance ───────────────────────────────────────

test('P19 (no regresión, datos golden §2.7): los seis campos originales de los cuatro elementos valen literalmente lo especificado', () => {
  const frame = serialized(FIXTURE_27);
  const golden = [
    { ref: REF_INPUT_PROVEEDOR, role: 'textbox', name: 'Proveedor', tag: 'input', disabled: false, visible: true },
    { ref: REF_RADIO_1, role: 'radio', name: 'SdP', tag: 'button', disabled: true, visible: true },
    { ref: REF_RADIO_2, role: 'radio', name: 'SdP enviada', tag: 'button', disabled: true, visible: true },
    { ref: REF_CHECKBOX, role: 'checkbox', name: 'Pedir confirmación', tag: 'input', disabled: false, visible: true },
  ];

  for (const esperado of golden) {
    const el = byRef(frame, esperado.ref);
    assert.ok(el, `el elemento de ref "${esperado.ref}" debe seguir emitiéndose`);
    for (const campo of ['role', 'name', 'tag', 'disabled', 'visible']) {
      assert.equal(el[campo], esperado[campo], `${esperado.ref}: ${campo} sin cambios respecto de la salida previa`);
    }
  }

  // El conjunto de refs no se ensancha: solo los cuatro golden, más el
  // radiogroup si el serializer lo emite (§2.7 lo deja como opcional).
  const refs = allElements(frame).map((e) => e.ref);
  const extras = refs.filter((r) => !golden.some((g) => g.ref === r));
  assert.deepEqual(
    extras.filter((r) => r !== REF_RADIOGROUP),
    [],
    'no aparece ningún ref nuevo más allá de los cuatro golden y el radiogroup',
  );

  // El input de Proveedor sí gana la clave nueva (control de no vacuidad: esto
  // no es un test de "nada cambió", es "las claves VIEJAS no cambiaron").
  assert.equal(byRef(frame, REF_INPUT_PROVEEDOR).value, 'Ferretería Vulpo SA');
});

// MODIFICADO por fb-018-005 §9.2 (justificación escrita en el spec).
// Qué asserteaba: `assert.deepEqual(divs, [])` para `<div contenteditable>` —
// es decir, asserteaba el CONJUNTO EMITIDO usándolo como proxy de "la constante
// de candidatos no se movió". §2.4.1 de fb-018-005 agrega
// `[contenteditable="true"]` a una constante SEPARADA (`PROMOTABLE_SELECTOR`) y
// P11 exige que ese div entre al mapa: el proxy deja de ser válido, aunque la
// propiedad de fondo sigue intacta —`CANDIDATE_SELECTOR` no se tocó—.
// El test gana precisión: pasa de un proxy a la propiedad.
test('P19b (CANDIDATE_SELECTOR intacto — REESCRITO fb-018-005 §9.2): la constante de candidatos no se modifica', () => {
  assert.equal(
    CANDIDATE_SELECTOR,
    'a[href],button,input,select,textarea,[role]',
    'CANDIDATE_SELECTOR es el universo de testigos de isBlocking (fb-018-007 §2.2.3) y el que act consulta: ' +
      'moverlo cambiaría `blocking`/`inert` en todo frame con diálogo abierto como efecto colateral. ' +
      'fb-018-005 §2.4.1 agrega los atributos nuevos a PROMOTABLE_SELECTOR, que usa SÓLO el serializer.',
  );
  // Lo que sí cambia, y es contrato de fb-018-005 P11: el div entra al mapa por
  // PROMOTABLE_SELECTOR. Se assertea acá para que la reescritura no pierda la
  // guarda de no-vacuidad que tenía el proxy.
  const frame = serialized('<div contenteditable="true">texto</div>');
  const divs = allElements(frame).filter((e) => e.tag === 'div');
  assert.equal(divs.length, 1, 'el div[contenteditable] SÍ entra al mapa vía PROMOTABLE_SELECTOR (fb-018-005 P11)');
  assert.equal(divs[0].role, '', 'sin rol declarado ⇒ role ""');
  assert.equal(
    Object.prototype.hasOwnProperty.call(divs[0], 'clickable'),
    false,
    'es candidato por ESTÁNDAR (HTML editing), no inferencia por presentación: no lleva `clickable`',
  );
});

test('P19c (herencia de contenteditable fuera de alcance): un hijo sin el atributo propio no lleva `value`', () => {
  const frame = serialized('<div role="textbox" contenteditable="true"><span role="button">Hijo</span></div>');
  const hijo = byTag(frame, 'span');
  assert.ok(hijo, 'el <span role="button"> es candidato y se emite (no vacuidad)');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(hijo, 'value'),
    'la detección es por atributo PROPIO: estar dentro de una región editable no alcanza',
  );
});

test('P20 (regla de oro I1): serializar es solo lectura (DOM y propiedades intactos) y determinista', () => {
  const doc = makeDom(
    '<input id="i" value="valor-inicial">' +
      '<input type="checkbox" id="c" checked>' +
      '<input type="checkbox" id="m">' +
      '<select id="s"><option value="a">Alfa</option><option value="b" selected>Beta</option></select>' +
      '<div role="textbox" contenteditable="true">editable</div>',
  );
  const body = doc.body;
  doc.getElementById('m').indeterminate = true;

  // Snapshot de PROPIEDADES: `input.value` no es un atributo reflejado, así que
  // outerHTML por sí solo no pinea que el serializer no las toque.
  const nodos = Array.from(body.querySelectorAll('input, select, textarea, div'));
  const snapshot = (n) => ({ value: n.value, checked: n.checked, indeterminate: n.indeterminate });
  const antes = nodos.map(snapshot);
  const htmlAntes = body.outerHTML;

  const a = serializeFrame(body, {});
  const b = serializeFrame(body, {});

  assert.equal(body.outerHTML, htmlAntes, 'el outerHTML del root queda idéntico');
  assert.deepEqual(nodos.map(snapshot), antes, 'no se alteró value / checked / indeterminate de ningún elemento');

  // No vacuidad del determinismo: la salida codifica al menos las claves nuevas.
  assert.ok(allElements(a).some((e) => Object.prototype.hasOwnProperty.call(e, 'value')), 'la salida es no trivial');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'serializar dos veces el mismo DOM da el mismo string JSON');
});
