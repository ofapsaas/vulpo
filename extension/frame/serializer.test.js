/**
 * serializer.test.js — fb-017-001 frame-serializer (sub-fase RED).
 * Verifica PC1–PC10. PC11 (isolated world) es E2E en fb-017-006.
 * PC5 off-viewport no es observable en jsdom (sin layout real) — se testea
 * solo lo observable: display:none / visibility:hidden / visibility:collapse
 * se excluyen; un elemento visible se incluye con visible:true. El caso
 * viewport queda para E2E (spec PC5 + criterio de aceptación).
 * Decisiones del review incorporadas: H2 (PC7 paginación real por página, salida
 * es UNA sola página; read[] global), M1 (shadow visibility: isHidden cruza la
 * shadow boundary), M2 (refs sin ::shadow> de cola vacía), M3 (root como boundary
 * semántico: sus hijos caen en sección titulada, no en sección null).
 * Contrato de llamada: serializeFrame(root, options) donde root es un Element
 * jsdom; el serializer resuelve estilo/rect vía root.ownerDocument.defaultView
 * (no módulo globals). En RED los tests de paginación/shadow-visibility/root-
 * section fallan por assertion porque la implementación aún devuelve todo en
 * page 1, emite buttons de hosts ocultos y no titula la sección del root.
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
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}
function firstElement(html, options) {
  const el = allElements(serialized(html, options))[0];
  assert.ok(el, 'expected at least one element for this DOM');
  return el;
}

test('PC1: serializeFrame returns the Frame shape with exact fields and types', () => {
  // fb-018-001 §5.1 ed.1: `do` pasa a opt-in (§2.2). La aserción de :52 se
  // reubica bajo include:"both" sin cambiar su semántica.
  const frame = serialized('<button>OK</button>', { include: 'both' });
  assert.equal(typeof frame.page, 'number');
  assert.ok(Number.isInteger(frame.page) && frame.page >= 1, 'page int >= 1');
  assert.equal(typeof frame.totalPages, 'number');
  assert.ok(Number.isInteger(frame.totalPages) && frame.totalPages >= 1, 'totalPages int >= 1');
  assert.ok(frame.totalPages >= frame.page, 'totalPages >= page');
  assert.ok(Array.isArray(frame.sections), 'sections is array');
  assert.ok(Array.isArray(frame.read), 'read is array');
  assert.ok(Array.isArray(frame.do), 'do is array');
  const el = allElements(frame)[0];
  assert.ok(el, 'interactive DOM emits at least one element');
  assert.equal(typeof el.ref, 'string');
  assert.equal(typeof el.role, 'string');
  assert.equal(typeof el.name, 'string');
  assert.equal(typeof el.tag, 'string');
  assert.equal(typeof el.disabled, 'boolean');
  assert.equal(typeof el.visible, 'boolean');
});

test('PC2: interactive candidates appear; non-interactive div does not become an element', () => {
  const html =
    '<a href="/x">Link</a>' +
    '<button>Btn</button>' +
    '<input>' +
    '<select><option>a</option></select>' +
    '<textarea></textarea>' +
    '<div role="tab">Tab</div>' +
    '<div id="plain">Not interactive</div>' +
    '<p>plain paragraph</p>';
  const els = allElements(serialized(html));
  assert.equal(els.length, 6, 'exactly the 6 interactive candidates become elements');
  const tags = els.map((e) => e.tag);
  for (const expected of ['a', 'button', 'input', 'select', 'textarea', 'div']) {
    assert.ok(tags.includes(expected), `interactive tag <${expected}> present`);
  }
  const div = els.find((e) => e.tag === 'div');
  assert.ok(div, 'the only <div> emitted is the [role] one');
});

test('PC3: accessible role computed from tag / aria (getRole)', () => {
  const html =
    '<button>Btn</button>' +
    '<a href="#">Link</a>' +
    '<input type="checkbox">' +
    '<div role="tab">Tab</div>';
  const els = allElements(serialized(html));
  const byTag = Object.fromEntries(els.map((e) => [e.tag, e.role]));
  assert.equal(byTag['button'], 'button');
  assert.equal(byTag['a'], 'link');
  assert.equal(byTag['input'], 'checkbox');
  assert.equal(byTag['div'], 'tab');
});

test('PC4: name from aria-label > label[for] > wrapping label > placeholder; empty kept; textContent fallback for a/button', () => {
  assert.equal(firstElement('<button aria-label="Real">Fake</button>').name, 'Real');
  assert.equal(firstElement('<label for="user">User name</label><input id="user">').name, 'User name');
  assert.equal(firstElement('<label>Email<input></label>').name, 'Email');
  assert.equal(firstElement('<input placeholder="Type here">').name, 'Type here');
  const empty = firstElement('<input id="bare">');
  assert.ok(empty, 'input without computed name is still emitted');
  assert.equal(empty.name, '');
  assert.equal(firstElement('<a href="/go"><span>Go now</span></a>').name, 'Go now');
  assert.equal(firstElement('<button>Submit</button>').name, 'Submit');
});

test('PC5: display:none / visibility:hidden / collapse (own or ancestor) excluded; visible included with visible:true', () => {
  const html =
    '<button id="vis">Visible</button>' +
    '<button style="display:none">DisplayNone</button>' +
    '<button style="visibility:hidden">Hidden</button>' +
    '<button style="visibility:collapse">Collapsed</button>' +
    '<div style="display:none"><button>NestedHidden</button></div>';
  const els = allElements(serialized(html));
  assert.equal(els.length, 1, 'all invisible elements excluded');
  // fb-018-001 §5.1 ed.2: golden reescrito al encoding compacto (§2.1).
  assert.equal(els[0].ref, 'button:1', 'the remaining one is the visible button');
  assert.equal(els[0].visible, true);
});

test('PC6: refs are tag+nth-of-type selector paths, omit index when unique, no id/class/data/coords, deterministic', () => {
  const html =
    '<main><form>' +
    '<div><input></div>' +
    '<div><textarea></textarea></div>' +
    '</form></main>';
  const els = allElements(serialized(html));
  const byTag = Object.fromEntries(els.map((e) => [e.tag, e.ref]));
  // fb-018-001 §5.1 ed.2: goldens reescritos al encoding compacto (§2.1).
  assert.equal(byTag['input'], 'main>form>div:1>input');
  assert.equal(byTag['textarea'], 'main>form>div:2>textarea');
  const single = allElements(serialized('<main><button>Only</button></main>'))[0];
  assert.equal(single.ref, 'main>button');
  const attrHtml = '<main data-k="v" class="c"><div id="sec" class="c2"><input data-x="1"></div></main>';
  const attrEl = allElements(serialized(attrHtml))[0];
  assert.equal(attrEl.ref, 'main>div>input');
  for (const token of ['sec', 'c2', 'data-x']) {
    assert.ok(!attrEl.ref.includes(token), `ref must not contain injected identity "${token}"`);
  }
  const frameA = serialized(html);
  const frameB = serialized(html);
  assert.deepEqual(
    allElements(frameA).map((e) => e.ref),
    allElements(frameB).map((e) => e.ref),
  );
});

test('PC7 (decisión H2): output is a single page; page slice has exactly its share; union reconstructs the full set; totalPages is ceil; read[] is global', () => {
  const html = '<button>1</button><button>2</button><button>3</button><button>4</button><button>5</button><p>Global text</p>';
  // fb-018-001 §5.1 ed.1: include:"both" restituye `do` (§2.2) para conservar
  // la aserción de biyección de :169-170 sin cambiar su semántica.
  const opt = { maxElementsPerPage: 2, include: 'both' };
  const p1 = serialized(html, { ...opt, page: 1 });
  const p2 = serialized(html, { ...opt, page: 2 });
  const p3 = serialized(html, { ...opt, page: 3 });

  // Cada página devuelve SOLO su porción (no todo).
  assert.equal(allRefs(p1).length, 2, 'page 1 carries exactly 2 elements');
  assert.equal(p1.page, 1, 'page 1 reports page:1');
  assert.equal(allRefs(p2).length, 2, 'page 2 carries exactly 2 elements');
  assert.equal(p2.page, 2, 'page 2 reports page:2');
  assert.equal(allRefs(p3).length, 1, 'page 3 carries exactly 1 element');
  assert.equal(p3.page, 3, 'page 3 reports page:3');

  // totalPages refleja la partición en TODAS las páginas.
  for (const f of [p1, p2, p3]) {
    assert.equal(f.totalPages, 3, 'totalPages === ceil(5/2) on each page');
  }

  // do[] es biyección de la página actual (solo refs de la página).
  assert.equal(p1.do.length, 2, 'do[] has exactly 2 refs on page 1');
  assert.deepEqual([...p1.do].sort(), [...allRefs(p1)].sort(), 'do[] bijects with page-1 elements');

  // Unión de las 3 páginas reconstruye el frame completo: 5 refs únicos sin
  // pérdida ni duplicación.
  const union = new Set([...allRefs(p1), ...allRefs(p2), ...allRefs(p3)]);
  assert.equal(union.size, 5, 'union of all pages = 5 unique refs');

  // page por defecto (sin page) == page:1.
  const def = serialized(html, opt);
  assert.deepEqual(allRefs(def), allRefs(p1), 'default page equals page 1');

  // read[] es global (no se pagina): texto visible presente en una página escasa.
  assert.ok(p1.read.includes('Global text'), 'read[] keeps full-frame visible text even on a sparse page');
});

test('PC8: do[] equals emitted refs; read[] carries visible text without duplicating consumed names', () => {
  const html = '<h1>Dashboard</h1><button aria-label="Logout">\u00d7</button><p>You have 3 new messages</p>';
  // fb-018-001 \u00a75.1 ed.1: `do` bajo opt-in (\u00a72.2), aserci\u00f3n intacta.
  const frame = serialized(html, { include: 'both' });
  const refs = allElements(frame).map((e) => e.ref).sort();
  assert.ok(Array.isArray(frame.do), 'do is array');
  assert.deepEqual([...frame.do].sort(), refs, 'do equals emitted refs');
  assert.ok(frame.read.includes('Dashboard'), 'read includes heading text');
  assert.ok(frame.read.includes('You have 3 new messages'), 'read includes paragraph text');
  assert.ok(!frame.read.includes('Logout'), 'read does not duplicate a name emitted on an element');
});

test('PC9: serializing the same DOM twice yields identical JSON', () => {
  // La serialización debe ser no-trivial (reflejar al menos un element del DOM);
  // si no, el determinismo es vacuo (stub {} lo satisfaría). Foco: mismo DOM →
  // mismo JSON, refs orden estables.
  const html = '<form><input placeholder="Usuario"><button aria-label="Enviar">x</button></form><p>hola</p>';
  // fb-018-001 §5.1 ed.1: `do` bajo opt-in (§2.2), aserción intacta.
  const a = serialized(html, { include: 'both' });
  const b = serialized(html, { include: 'both' });
  assert.ok((Array.isArray(a.do) ? a.do : []).length >= 1, 'output encodes at least one element (non-trivial)');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('PC10: serialization does not mutate the DOM (root outerHTML identical)', () => {
  const doc = makeDom('<main><form><div><input placeholder="U"><button aria-label="Go">OK</button></div></form></main>');
  const root = doc.body;
  const before = root.outerHTML;
  // fb-018-001 §5.1 ed.1: `do` bajo opt-in (§2.2), aserción intacta.
  const frame = serializeFrame(root, { include: 'both' });
  assert.deepEqual(frame.do, allElements(frame).map((e) => e.ref));
  assert.equal(root.outerHTML, before, 'root outerHTML unchanged after serialization');
});

test('M1 (decisión review): isHidden cruza la shadow boundary — un button en el shadow root de un host display:none NO se emite', () => {
  const doc = makeDom('<main><div id="host" style="display:none"></div></main>');
  const host = doc.getElementById('host');
  host.attachShadow({ mode: 'open' }).innerHTML = '<button>X</button>';
  const frame = serializeFrame(doc.body, {});
  const refs = allRefs(frame);
  assert.deepEqual(refs, [], 'un host oculto oculta a sus descendientes de shadow root (ninguna element)');
  assert.ok(!refs.some((r) => r.includes('::shadow')), 'ningún ref proviene del shadow root del host oculto');
});

test('M2 (decisión review): selectorPath no emite "::shadow>" con cola vacía — el ref termina en el tag del elemento', () => {
  const doc = makeDom('<main><my-widget></my-widget></main>');
  const host = doc.querySelector('my-widget');
  host.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow btn</button>';
  const el = allElements(serializeFrame(doc.body, {}))[0];
  assert.ok(el, 'el button del shadow root se emite');
  assert.ok(el.ref.includes('::shadow>'), 'el ref refleja la shadow boundary');
  assert.ok(!el.ref.endsWith('::shadow>'), 'el ref no termina en ::shadow> (cola vacía)');
  assert.ok(!el.ref.endsWith('>'), 'el ref no termina en un ">" desnudo (segmento final vacío)');
  assert.ok(el.ref.endsWith('button'), 'el ref termina en el tag del elemento emitido');
});

test('M3 (decisión review): root como boundary semántico — los hijos de un <main> caen en sección titulada, no en sección null', () => {
  const doc = makeDom('<main><button>Inside main</button></main>');
  const main = doc.querySelector('main');
  const frame = serializeFrame(main, {});
  const btnRef = allRefs(frame).find((r) => r.includes('button'));
  assert.ok(btnRef, 'el button del <main> se emite');
  const section = (frame.sections || []).find((s) =>
    Array.isArray(s.elements) && s.elements.some((e) => e.ref === btnRef),
  );
  assert.ok(section, 'el button pertenece a una sección');
  assert.ok(section.title, 'la sección tiene título (nombre accesible → id → tag de <main>)');
  assert.equal(section.title, 'main', 'el título de la sección es el tag <main> (fallback)');
});
