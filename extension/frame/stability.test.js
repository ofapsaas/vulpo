// Tests de contrato de estabilidad — fb-017-003-refs-estables
// Spec: docs/specs/fb-017-003-refs-estables/spec.md (PC1–PC5, invariantes I4/I5/I6)
//
// Naturaleza RED/Guards (honestidad de contrato): 003 convierte en contrato
// verificado garantías que 001+002 ya implementan de facto (hallazgo central
// del discovery en contexto-tecnico.md). Es esperado y legítimo que PC1–PC5
// pasen a la primera: son GUARDS de contrato (precedente de 001: "M2 ya estaba
// correcto, se dejó como guard en vez de forzar un RED artificial"). Si alguno
// falla, es un defecto real surfaced (D3) → RED para el implementer; desde
// tests no se toca implementación.
//
// D2: los aria-labels/placeholders/textos/ids de los fixtures son oráculos del
// test; el serializer jamás los usa para construir refs (I4, pineado por
// 001-PC6/M2 y re-verificado aquí por PC2/PC3).
//
// Límite jsdom: verificado por probe black-box — jsdom SÍ soporta shadow DOM
// abierto anidado (host dentro del shadow de otro host); el serializer emite
// "host::shadow>span::shadow>button" y resolveRef lo resuelve. No hace falta
// skip ni estructura alternativa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { serializeFrame } from "./serializer.js";
import { resolveRef } from "./resolver.js";

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

function elementsOf(frame) {
  return frame.sections.flatMap((s) => s.elements);
}

// DOM no trivial compartido (PC1/PC2/PC3): secciones con hermanos repetidos del
// mismo tag + shadow host abierto con contenido interactivo + shadow anidado
// (host dentro del shadow de otro host). Determinista por construcción: mismo
// HTML + mismo armado programático de shadows en cada llamada.
// Devuelve { body, byName } donde byName es el mapa nombre→nodo (oráculo D2
// para la identidad de PC3; los nombres vienen de textContent para buttons y
// placeholder para inputs/textarea, contrato observable de 001-PC4).
function buildStableDom() {
  const doc = makeDom(`
    <main aria-label="raiz">
      <section aria-label="alpha">
        <div><button>btn-uno</button></div>
        <div><button>btn-dos</button></div>
        <div><input placeholder="campo-uno"></div>
        <div><input placeholder="campo-dos"></div>
      </section>
      <div id="host-externo"></div>
    </main>
  `);
  const body = doc.body;
  const section = body.querySelector("section");
  const [divUno, divDos, divTres, divCuatro] = Array.from(section.children);
  const hostExterno = body.querySelector("#host-externo");
  const shadow = hostExterno.attachShadow({ mode: "open" });
  shadow.innerHTML =
    '<p><textarea placeholder="sombra-texto"></textarea></p><span id="host-interno"></span>';
  const hostInterno = shadow.querySelector("#host-interno");
  const innerShadow = hostInterno.attachShadow({ mode: "open" });
  innerShadow.innerHTML = "<button>sombra-profunda</button>";
  const byName = new Map([
    ["btn-uno", divUno.querySelector("button")],
    ["btn-dos", divDos.querySelector("button")],
    ["campo-uno", divTres.querySelector("input")],
    ["campo-dos", divCuatro.querySelector("input")],
    ["sombra-texto", shadow.querySelector("textarea")],
    ["sombra-profunda", innerShadow.querySelector("button")],
  ]);
  return { body, byName };
}

// PC1 (I5): dado el mismo HTML, dos DOM independientes serializados producen
// refs idénticos elemento a elemento y en el mismo orden — el Frame JSON
// completo es idéntico entre ambos parseos.
test("PC1: determinismo entre parseos — mismo HTML en dos DOM independientes produce el mismo Frame JSON", () => {
  const dom1 = buildStableDom();
  const dom2 = buildStableDom();
  const frame1 = serializeFrame(dom1.body);
  const frame2 = serializeFrame(dom2.body);
  // Sanity de no-vacuidad: el fixture emite los 6 interactivos esperados
  // (2 buttons + 2 inputs + textarea en shadow + button en shadow anidado).
  assert.equal(elementsOf(frame1).length, 6);
  assert.equal(elementsOf(frame2).length, 6);
  // El Frame JSON completo — incluidos todos los refs — es idéntico.
  assert.equal(JSON.stringify(frame1), JSON.stringify(frame2));
});

// PC2: en un DOM no trivial (hermanos repetidos + shadow anidado), dos
// elementos interactivos distintos nunca producen el mismo ref.
test("PC2: unicidad — dos elementos distintos nunca comparten ref (hermanos repetidos + shadow anidado)", () => {
  const { body } = buildStableDom();
  const frame = serializeFrame(body);
  const refs = elementsOf(frame).map((e) => e.ref);
  // Sanity: el fixture emite los 6 interactivos, incluidos los de shadow anidado.
  assert.equal(refs.length, 6);
  assert.equal(new Set(refs).size, refs.length);
});

// PC3 (I6): para cada elemento emitido, resolveRef(ref) devuelve el MISMO nodo
// que lo emitió — identidad directa de nodo (jsdom devuelve los mismos
// objetos); la identidad es el oráculo más fuerte, no hacen falta ids.
test("PC3: round-trip ref→elemento — resolveRef(ref) devuelve el MISMO nodo que emitió el ref", () => {
  const { body, byName } = buildStableDom();
  const frame = serializeFrame(body);
  const elements = elementsOf(frame);
  // Biyección por cardinalidad: se emite exactamente un elemento por nodo
  // interactivo del fixture (ni más ni menos).
  assert.equal(elements.length, byName.size);
  for (const el of elements) {
    const expectedNode = byName.get(el.name);
    assert.ok(expectedNode, `elemento con name inesperado: ${JSON.stringify(el)}`);
    const resolved = resolveRef(el.ref, body);
    assert.equal(resolved, expectedNode, `ref ${el.ref} (name "${el.name}") debe re-resolver al mismo nodo`);
    assert.equal(el.tag, expectedNode.tagName.toLowerCase());
  }
});

// PC4: una mutación en un subtree NO relacionado no altera los refs de los
// elementos intactos. Los refs de alpha se comparan por prefijo de name
// (oráculo de fixture), sin depender del agrupamiento de secciones.
test("PC4: estabilidad ante mutación ajena — un append en otra sección no altera los refs de los elementos intactos", () => {
  const doc = makeDom(`
    <main>
      <section aria-label="alpha">
        <div><button>alpha-boton</button></div>
        <div><input placeholder="alpha-campo"></div>
      </section>
      <section aria-label="beta">
        <div><button>beta-boton</button></div>
      </section>
    </main>
  `);
  const body = doc.body;
  const refsOf = (prefix, frame) =>
    elementsOf(frame)
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => e.ref);
  const before = serializeFrame(body);
  // Sanity del fixture antes de mutar.
  assert.equal(refsOf("alpha", before).length, 2);
  assert.equal(refsOf("beta", before).length, 1);
  // Mutación AJENA: append de un subtree nuevo dentro de beta (alpha intacto).
  const beta = body.querySelectorAll("section")[1];
  const nuevo = doc.createElement("div");
  nuevo.innerHTML = "<button>beta-nuevo</button>";
  beta.appendChild(nuevo);
  const after = serializeFrame(body);
  // Los refs de alpha NO cambian tras la mutación ajena.
  assert.deepEqual(refsOf("alpha", after), refsOf("alpha", before));
  // Control de no-vacuidad: la re-serialización SÍ reflejó la mutación en beta.
  assert.equal(refsOf("beta", after).length, 2);
});

// PC5 — boundary posicional PINEADO: insertar un hermano PREVIO del mismo tag
// desplaza el nth-of-type. El ref es posicional y el desplazamiento es
// comportamiento ESPERADO del diseño (spec 003 PC5); lo cubren el contrato
// stale→re-snapshot de 002 y la invalidación por mutación de 004. NO es un bug.
// Nota del boundary: el string del ref viejo es reutilizado por el recién
// llegado — la unicidad (PC2) es por snapshot, no entre snapshots.
test("PC5: boundary posicional pineado — insertar un hermano previo del mismo tag desplaza el nth-of-type (esperado, no bug)", () => {
  const doc = makeDom(`
    <main>
      <div><button>objetivo</button></div>
      <div><input placeholder="relleno"></div>
    </main>
  `);
  const body = doc.body;
  const objetivo = body.querySelector("main > div:nth-of-type(1) > button");
  const refDe = (nombre, frame) => {
    const el = elementsOf(frame).find((e) => e.name === nombre);
    assert.ok(el, `elemento "${nombre}" debe ser emitido`);
    return el.ref;
  };
  const antes = serializeFrame(body);
  const refAntes = refDe("objetivo", antes);
  // fb-018-001 §5.1 ed.2: golden reescrito al encoding compacto (§2.1).
  // (El querySelector de arriba NO se toca: es CSS real, no un ref del Frame.)
  assert.equal(refAntes, "main>div:1>button");
  // Insertar un hermano PREVIO del mismo tag antes del div del botón.
  const main = body.querySelector("main");
  const recien = doc.createElement("div");
  recien.innerHTML = "<button>recien-llegado</button>";
  main.insertBefore(recien, main.firstElementChild);
  const despues = serializeFrame(body);
  // El MISMO botón ahora es nth-of-type(2): desplazamiento posicional esperado.
  const refDespues = refDe("objetivo", despues);
  // fb-018-001 §5.1 ed.2: golden reescrito al encoding compacto (§2.1).
  assert.equal(refDespues, "main>div:2>button");
  // El ref nuevo resuelve al mismo nodo (el sistema queda auto-consistente).
  assert.equal(resolveRef(refDespues, body), objetivo);
  // Control del boundary: el recién llegado ocupa el hueco posicional y hereda
  // exactamente el string del ref viejo (de ahí el stale de 002).
  assert.equal(refDe("recien-llegado", despues), refAntes);
});
