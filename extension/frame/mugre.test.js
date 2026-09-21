/**
 * mugre.test.js — fb-017-005-dom-mugre (sub-fase RED).
 * Verifica PC1–PC9 del spec fb-017-005: heurísticas anti-basura del mapa.
 * - PC1/PC2: filtro aria-hidden (candidatos y read[]), "false" explícito no filtra.
 * - PC3/PC4: presupuesto de read[] (cap 400 default / truncado 300 chars + '…',
 *   marcador explícito de truncado como último elemento).
 * - PC5: nameless-generic suppression (role 'generic' + name '' no se emite;
 *   button sin nombre SÍ, con name '').
 * - PC6 (pin): texto oculto (display:none / visibility:hidden) ya filtrado de
 *   read[] — pin de corrección DEF-2 (misdiagnosis de 004).
 * - PC7 (pin): iframes opacos por construcción (contenido no emitido).
 * - PC8 (pin): shadow root cerrado opaco en read[].
 * - PC9 (pin M4): names no dedup en elements; read[] excluye fragmento idéntico
 *   a un name (dedup readNames pineado).
 * Estados esperados en RED (serializer sin filtros nuevos): PC1–PC5 fallan por
 * AssertionError; PC6–PC9 (pines) pasan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serializeFrame } from './serializer.js';

function makeDom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}
function serialized(html, options) {
  return serializeFrame(makeDom(html).body, options);
}
function allElements(frame) {
  if (!Array.isArray(frame.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}

test('PC1_postcondition_aria_hidden_filtra_candidatos_propios_heredados_y_false_explicito_no_filtra', () => {
  const frame = serialized(
    '<main><button aria-hidden="true">oculto</button><button>visible</button>' +
      '<div aria-hidden="true"><button>heredado</button></div></main>',
  );
  const names = allElements(frame).map((e) => e.name);
  assert.ok(!names.includes('oculto'), 'button aria-hidden="true" propio no se emite');
  assert.ok(!names.includes('heredado'), 'button bajo ancestro aria-hidden="true" no se emite');
  assert.ok(names.includes('visible'), 'button sin aria-hidden SÍ se emite');

  // Sub-case: aria-hidden="false" explícito NO filtra.
  const namesFalse = allElements(serialized('<button aria-hidden="false">explicito</button>')).map((e) => e.name);
  assert.ok(namesFalse.includes('explicito'), 'aria-hidden="false" explícito no filtra el candidato');
});

test('PC2_postcondition_aria_hidden_filtra_read_propio_y_heredado', () => {
  const frame = serialized('<main><p aria-hidden="true">secreto-aria</p><p>normal</p></main>');
  assert.ok(Array.isArray(frame.read), 'read es array');
  assert.ok(!frame.read.includes('secreto-aria'), 'texto de elemento aria-hidden="true" no entra a read[]');
  assert.ok(frame.read.includes('normal'), 'texto de elemento sin aria-hidden SÍ entra a read[]');
});

test('PC3_postcondition_cap_de_read_con_marcador_explicito_y_maxReadEntries_configurable', () => {
  const html = Array.from({ length: 500 }, (_, i) => `<p>fragmento-${i}</p>`).join('');
  const frame = serialized(html);
  assert.ok(frame.read.length <= 401, `read[] acotado a cap+marcador (400 + 1), got ${frame.read.length}`);
  const last = frame.read[frame.read.length - 1];
  assert.match(
    last,
    /\[read truncado: \d+ de 500 fragmentos\]/,
    'el ÚLTIMO elemento de read[] truncado es el marcador [read truncado: N de M fragmentos]',
  );

  // Sub-case: maxReadEntries configurable.
  const frame10 = serialized(html, { maxReadEntries: 10 });
  assert.ok(frame10.read.length <= 11, `con maxReadEntries:10 read[] acotado a 11, got ${frame10.read.length}`);
  assert.match(
    frame10.read[frame10.read.length - 1],
    /\[read truncado: \d+ de 500 fragmentos\]/,
    'marcador de truncado presente también con cap custom',
  );
});

test('PC4_postcondition_fragmento_de_mas_de_300_chars_se_trunca_a_301_con_ellipsis', () => {
  const long = 'x'.repeat(400);
  const frame = serialized(`<p>${long}</p>`);
  const entry = frame.read.find((t) => typeof t === 'string' && t.startsWith('x'));
  assert.ok(entry, 'el fragmento largo está en read[]');
  assert.equal(entry.length, 301, '300 chars + "…" = 301');
  assert.ok(entry.endsWith('…'), 'el fragmento truncado termina en "…"');
});

test('PC5_postcondition_nameless_generic_suprimido_y_button_sin_nombre_emitido_con_name_vacio', () => {
  // div[role=generic] con name '' no se emite.
  const generic = allElements(serialized('<div role="generic">solo contenido</div>'));
  assert.equal(generic.length, 0, 'un [role] genérico sin nombre NO se emite');

  // button sin nombre SÍ se emite (name '').
  const btns = allElements(serialized('<button></button>'));
  assert.equal(btns.length, 1, 'el button sin nombre se emite');
  assert.equal(btns[0].name, '', 'el button sin nombre tiene name vacío');
});

test('PC6_postcondition_pin_texto_de_display_none_y_visibility_hidden_no_entra_a_read', () => {
  const frame = serialized(
    '<main><p style="display:none">oculto-display</p><p style="visibility:hidden">oculto-visibility</p><p>visible-texto</p></main>',
  );
  assert.ok(!frame.read.includes('oculto-display'), 'display:none no aporta texto a read[]');
  assert.ok(!frame.read.includes('oculto-visibility'), 'visibility:hidden no aporta texto a read[]');
  assert.ok(frame.read.includes('visible-texto'), 'texto visible sigue en read[]');
});

test('PC7_postcondition_pin_iframe_opaco_contenido_no_emitido_ni_en_elements_ni_en_read', () => {
  const frame = serialized('<main><iframe srcdoc="<button>inner</button>"></iframe></main>');
  const names = allElements(frame).map((e) => e.name);
  const readText = (frame.read || []).join('\n');
  assert.ok(!names.includes('inner'), 'el contenido del iframe no se emite como element');
  assert.ok(!readText.includes('inner'), 'el contenido del iframe no entra a read[]');
});

test('PC8_postcondition_pin_shadow_cerrado_opaco_en_read', () => {
  const doc = makeDom('<main><div id="host"></div><p>texto-abierto</p></main>');
  doc.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<p>texto-cerrado</p>';
  const frame = serializeFrame(doc.body, {});
  const readText = (frame.read || []).join('\n');
  assert.ok(!readText.includes('texto-cerrado'), 'el texto de un shadow root cerrado no entra a read[]');
  assert.ok(frame.read.includes('texto-abierto'), 'el texto fuera del shadow cerrado sigue en read[]');
});

test('PC9_postcondition_pin_M4_names_no_dedup_en_elements_y_read_excluye_fragmento_idéntico_a_un_name', () => {
  const frame = serialized('<main><button>duplicado</button><p>duplicado</p></main>');
  const dupes = allElements(frame).filter((e) => e.name === 'duplicado');
  assert.equal(dupes.length, 1, 'solo el button (candidato) se emite como element — names no dedup');
  assert.ok(!frame.read.includes('duplicado'), 'read[] excluye el fragmento idéntico a un name (dedup readNames, M4)');
});
