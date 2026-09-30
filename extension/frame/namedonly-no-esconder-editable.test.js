/**
 * namedonly-no-esconder-editable.test.js — fb-023-003-namedonly-no-esconder-editable (RED).
 *
 * Verifica P1–P7 de docs/specs/fb-023-003-namedonly-no-esconder-editable/spec.md §3.2
 * (P8 NO se duplica acá: vive en `go test ./internal/docsguard`, cobertura vigente).
 *
 * Escrito SOLO contra el contrato del spec (§3.1 D-1..D-7, §3.2) y las condiciones
 * C-1/C-2/C-3 del test-audit.md aprobado: esta sesión NO leyó `serializer.js` ni
 * ningún módulo de producción (rol test-writer, aislamiento de fase, ADR-011).
 * `serializeFrame` y `resolveRef` son el oráculo observable, importados con la
 * MISMA forma verbatim del precedente de casa (encabezado-columna-tablas-simples
 * / payload-efficiency). Los fixtures F8/F1/FC/FN son verbatim del spec §3.2;
 * los textos ("Cantidad", "Precio", "Item A", "Enero", "Panel", "Guardar"…) son
 * datos inventados de fixture, sin nombres de cliente ni URLs de instancia (I-6).
 *
 * ── Naturaleza RED esperada (spec §5) ──────────────────────────────────────
 *  · FALLAN por AssertionError (la receta publicada esconde los inputs):
 *      P1 — cada una de las SEIS queries publicadas (2 Odoo + 4 genéricas),
 *        extraídas de los SKILL reales, aplicada a F8 elimina ambos inputs
 *        (hoy todas llevan `namedOnly:true` y los inputs tienen name:"");
 *      P2 — la receta de entrada de datos de Odoo (q2) sobre F1 elimina
 *        ambos inputs (la guarda de recorte por rol — botón excluido — pasa
 *        ya hoy, el rojo es por los inputs);
 *      P3 — la misma receta sobre FC elimina el input de la celda cruzada;
 *      P7 — RED documental: los SKILL todavía recomiendan `namedOnly` para
 *        listas editables; el test REGISTRA los incumplimientos actuales
 *        (lista de reglas D-3/D-4/D-5/D-6 ausentes, verificación semántica,
 *        no igualdad literal de párrafos).
 *  · PIN / anti-regresión — pasan YA en RED por diseño, con guardas de
 *    no-vacuidad:
 *      P4 — `namedOnly:true` conserva su semántica estricta (D-1): excluye
 *        los inputs de F8 y los cuatro descendientes anónimos de FN,
 *        conserva el botón con aria-label;
 *      P5 — la estrategia de paginación recomendada (roles + página 2)
 *        funciona hoy sobre F8;
 *      P6 — la huella es idéntica entre lectura completa, namedOnly y
 *        recorte por roles (I-3: cero goldens nuevos; reusa el pin de
 *        infraestructura `fingerprint` de payload-efficiency).
 *  · GUARDAS de infraestructura (C-2/C-3) — pasan en RED; si fallan es
 *    fallo de infraestructura (extractor en mal estado / layout cambiado),
 *    NO RED válido: corren fail-loud ANTES de las aserciones de P1/P2/P3.
 *
 * ── Extractor de recetas (C-1, condición crítica del audit) ────────────────
 * Descubre los bloques POR ESTRUCTURA, nunca por la presencia de
 * `namedOnly` (en GREEN el token desaparece de las 6 queries y el extractor
 * tiene que seguir encontrándolas):
 *  · vulpo-odoo-web/SKILL.md → los fences ```json que contienen la clave
 *    `"frame":` (exactamente 2); JSON.parse completo, se toma arguments.frame.
 *  · vulpo-web-navigation/SKILL.md → el ÚNICO fence de la sección
 *    `## 1b. One call per interaction`; dentro de él las líneas de query
 *    `getFrame {...}` / `frame: {...}` (exactamente 4), parseadas con un
 *    parser limitado al objeto de opciones (claves sin comillas, valores
 *    string/array/número/booleano). SIN eval.
 * Las opciones que ejecutan los tests salen del DOCUMENTO (I-5), comparadas
 * como estructuras parseadas, nunca como strings crudos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeFrame } from './serializer.js';
import { resolveRef } from './resolver.js';

// ── Helpers (patrón de encabezado-columna-tablas-simples.test.js) ────────────

function makeDom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}
function allElements(frame) {
  if (!Array.isArray(frame?.sections)) return [];
  return frame.sections.flatMap((s) => (Array.isArray(s.elements) ? s.elements : []));
}
function allRefs(frame) {
  return allElements(frame).map((e) => e.ref);
}
/**
 * Elemento emitido identificado por resolveRef (NUNCA por índice de sections
 * ni por posición de columna — spec §3.2 último párrafo). Si el nodo no está
 * emitido, AssertionError con la lista de refs emitidos: es EL punto de fallo
 * RED de P1/P2/P3 ("faltan los inputs esperados").
 */
function emitido(frame, root, nodo, etiqueta) {
  const el = allElements(frame).find((e) => resolveRef(e.ref, root) === nodo);
  assert.ok(
    el,
    `${etiqueta}: el frame NO emite el nodo esperado — faltan los inputs esperados (RED, AssertionError). ` +
      `refs emitidos=${JSON.stringify(allRefs(frame))}`,
  );
  return el;
}
/** Guarda de no-vacuidad de huella (mismo patrón que payload-efficiency P5b). */
function assertHuella(frame, etiqueta) {
  assert.equal(
    typeof frame.fingerprint,
    'string',
    `${etiqueta}: serializeFrame debe devolver la huella \`fingerprint\` como string (§3.2 P6). ` +
      'Sin esta guarda las comparaciones de huella serían undefined === undefined (verdes vacuas).',
  );
  assert.ok(frame.fingerprint.length > 0, `${etiqueta}: la huella no puede ser el string vacío`);
  return frame.fingerprint;
}

// ── C-3: rutas de los SKILL resueltas relativas a ESTE test ──────────────────

const DIR_TEST = path.dirname(fileURLToPath(import.meta.url));
const PATH_ODOO = path.resolve(DIR_TEST, '../../agent-kit/skills/vulpo-odoo-web/SKILL.md');
const PATH_NAV = path.resolve(DIR_TEST, '../../agent-kit/skills/vulpo-web-navigation/SKILL.md');

function leerDoc(ruta, etiqueta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(
      `fallo de infraestructura (C-3): no se encontró ${etiqueta} en ${ruta} — ` +
        'cambió el layout de agent-kit/skills/*/SKILL.md respecto de extension/frame/ (fail-loud, no RED)',
    );
  }
  return fs.readFileSync(ruta, 'utf8');
}

// ── Parser limitado al objeto de opciones (sin eval — spec §3.2 / C-2) ───────

/**
 * Parsea el PRIMER objeto balanceado {...} de `linea` (respeta strings entre
 * comillas dobles, tolera llaves de cierre extra de la llamada contenedora,
 * p.ej. `frame: {roles: ["textbox"]}}`). Devuelve el string del objeto.
 */
function extraerObjetoBalanceado(linea, etiquetaOrigen) {
  const inicio = linea.indexOf('{');
  if (inicio < 0) {
    throw new Error(`fallo de infraestructura (C-2): ${etiquetaOrigen} — la línea no contiene un objeto de opciones`);
  }
  let profundidad = 0;
  let enCadena = false;
  let escape = false;
  for (let i = inicio; i < linea.length; i++) {
    const c = linea[i];
    if (enCadena) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') enCadena = true;
    else if (c === '{') profundidad++;
    else if (c === '}') {
      profundidad--;
      if (profundidad === 0) return linea.slice(inicio, i + 1);
    }
  }
  throw new Error(`fallo de infraestructura (C-2): ${etiquetaOrigen} — objeto de opciones sin cerrar`);
}

/**
 * Parser de opciones: claves identificador SIN comillas, valores string "…",
 * array de strings [...], número o true/false. Limitado AL OBJETO DE OPCIONES
 * mostrado en los SKILL; sin eval (C-2 / spec §3.2).
 */
function parsearOpciones(linea, etiquetaOrigen) {
  const s = extraerObjetoBalanceado(linea, etiquetaOrigen);
  const fin = s.length - 1; // índice del '}' final
  let pos = 1; // tras '{'
  const obj = {};
  const saltarEsp = () => {
    while (pos < fin && /\s/.test(s[pos])) pos++;
  };
  const FALLA = (que) => {
    throw new Error(
      `fallo de infraestructura (C-2): parser de opciones en ${etiquetaOrigen} — ${que} cerca de "${s.slice(pos, pos + 24)}"`,
    );
  };
  function valor(clave) {
    if (s[pos] === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(s.slice(pos));
      if (!m) FALLA(`string mal cerrado para ${clave}`);
      pos += m[0].length;
      return JSON.parse(`"${m[1]}"`);
    }
    if (s[pos] === '[') {
      const cierre = s.indexOf(']', pos);
      if (cierre < 0) FALLA(`array sin cerrar para ${clave}`);
      const items = s
        .slice(pos + 1, cierre)
        .split(',')
        .map((x) => x.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      pos = cierre + 1;
      return items;
    }
    const mN = /^-?\d+(\.\d+)?/.exec(s.slice(pos));
    if (mN) {
      pos += mN[0].length;
      return Number(mN[0]);
    }
    if (s.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (s.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    FALLA(`valor no soportado para ${clave}`);
  }
  saltarEsp();
  if (pos >= fin) return obj; // {}
  for (;;) {
    saltarEsp();
    const m = /^[A-Za-z_][\w]*/.exec(s.slice(pos));
    if (!m) FALLA('clave inválida');
    const clave = m[0];
    pos += clave.length;
    saltarEsp();
    if (s[pos] !== ':') FALLA(`se esperaba ":" tras la clave ${clave}`);
    pos++;
    saltarEsp();
    obj[clave] = valor(clave);
    saltarEsp();
    if (s[pos] === ',') {
      pos++;
      continue;
    }
    if (pos === fin) break;
    FALLA('separador inesperado');
  }
  return obj;
}

// ── Extractor (C-1: descubrimiento ESTRUCTURAL, independiente de namedOnly) ──

function extraerRecetasOdoo(doc) {
  // Los fences ```json que contienen la clave "frame": — exactamente 2 en
  // TODO el archivo (audit §2: los otros fences son menúitem y write, sin frame).
  const fences = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  const conFrame = fences.filter((f) => /"frame"\s*:/.test(f));
  if (conFrame.length !== 2) {
    throw new Error(
      `fallo de infraestructura (C-1/C-2): se esperaban EXACTAMENTE 2 recetas Odoo ` +
        `(fences json con "frame":) — hallados ${conFrame.length}`,
    );
  }
  return conFrame.map((cuerpo, i) => {
    let obj;
    try {
      obj = JSON.parse(cuerpo);
    } catch (e) {
      throw new Error(`fallo de infraestructura (C-2): el fence json Odoo #${i + 1} no parsea — ${e.message}`);
    }
    const frame = obj?.arguments?.frame;
    if (!frame || typeof frame !== 'object') {
      throw new Error(`fallo de infraestructura (C-2): el fence json Odoo #${i + 1} no lleva arguments.frame`);
    }
    return frame;
  });
}

function extraerQueriesGenericas(doc) {
  // El ÚNICO fence dentro de la sección "## 1b. One call per interaction".
  const inicio = doc.indexOf('## 1b. One call per interaction');
  if (inicio < 0) {
    throw new Error('fallo de infraestructura (C-1): no se encuentra la sección "## 1b. One call per interaction"');
  }
  const corteFin = doc.indexOf('\n## ', inicio);
  const seccion = doc.slice(inicio, corteFin < 0 ? undefined : corteFin);
  const fences = [...seccion.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length !== 1) {
    throw new Error(
      `fallo de infraestructura (C-1): la sección §1b debe contener EXACTAMENTE 1 fence — hallados ${fences.length}`,
    );
  }
  const queries = [];
  for (const linea of fences[0].split('\n')) {
    // Query = llamada getFrame {...} o el frame {...} plegado de un act {...}
    // (multi-línea: la línea del frame arranca con `frame:`). Las líneas de
    // act sin fold y los comentarios # no son queries.
    if (/(^|\s)getFrame\s*\{/.test(linea) || /^\s*frame:\s*\{/.test(linea)) {
      queries.push(parsearOpciones(linea, 'nav §1b'));
    }
  }
  if (queries.length !== 4) {
    throw new Error(
      `fallo de infraestructura (C-1/C-2): se esperaban EXACTAMENTE 4 queries genéricas en el fence de §1b — halladas ${queries.length}`,
    );
  }
  return queries;
}

let CACHE_RECETAS = null;
/** Extracción con cache; TODO fallo es de infraestructura (C-2), nunca RED. */
function obtenerRecetas() {
  if (CACHE_RECETAS) return CACHE_RECETAS;
  const docOdoo = leerDoc(PATH_ODOO, 'vulpo-odoo-web/SKILL.md');
  const docNav = leerDoc(PATH_NAV, 'vulpo-web-navigation/SKILL.md');
  const odoo = extraerRecetasOdoo(docOdoo);
  const nav = extraerQueriesGenericas(docNav);
  const todas = [
    ...odoo.map((o, i) => ({ etiqueta: `receta Odoo q${i + 1}`, opciones: o })),
    ...nav.map((q, i) => ({ etiqueta: `query genérica #${i + 1}`, opciones: q })),
  ];
  // Guarda de cardinalidad + roles no vacío (C-2), fail-loud.
  if (todas.length !== 6) {
    throw new Error(
      `fallo de infraestructura (C-2): se esperaban 6 recetas publicadas (2 Odoo + 4 genéricas) — halladas ${todas.length}`,
    );
  }
  for (const r of todas) {
    assert.ok(
      Array.isArray(r.opciones.roles) && r.opciones.roles.length > 0,
      `fallo de infraestructura (C-2): ${r.etiqueta} sin roles no vacío — ${JSON.stringify(r.opciones)}`,
    );
  }
  CACHE_RECETAS = { odoo, nav, todas };
  return CACHE_RECETAS;
}

/** La receta de entrada de datos de Odoo (q2): roles textbox+combobox, paginada a 50. */
function recetaOdooDatos() {
  const { odoo } = obtenerRecetas();
  const candidatas = odoo.filter(
    (o) =>
      JSON.stringify(o.roles) === JSON.stringify(['textbox', 'combobox']) &&
      o.maxElementsPerPage === 50,
  );
  assert.equal(
    candidatas.length,
    1,
    `fallo de infraestructura (C-2): se esperaba UNA receta Odoo de entrada de datos (textbox+combobox, maxElementsPerPage 50) — halladas ${candidatas.length}: ${JSON.stringify(odoo)}`,
  );
  return candidatas[0];
}

// ── Fixtures (spec §3.2, verbatim; I-6: sin clientes ni URLs) ────────────────

/** F8 — literal de 002/E1: fila nueva sin nombre accesible (solo inputs anónimos). */
const F8 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_uom_qty"><span>Cantidad</span></th>' +
  '<th data-name="price_unit"><span>Precio</span></th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_uom_qty"><input type="text" id="cantidad"></td>' +
  '<td name="price_unit"><input type="text" id="precio"></td>' +
  '</tr></tbody></table></main>';

/** F1 — fila con nombre (Item A) y control ajeno al recorte (button Guardar). */
const F1 =
  '<main><table>' +
  '<thead><tr>' +
  '<th data-name="product_id">Producto</th>' +
  '<th data-name="product_uom_qty">Cantidad</th>' +
  '<th data-name="price_unit">Precio</th>' +
  '</tr></thead>' +
  '<tbody><tr>' +
  '<td name="product_id">Item A</td>' +
  '<td name="product_uom_qty"><input type="text" id="cantidad"></td>' +
  '<td name="price_unit"><input type="text" id="precio"></td>' +
  '</tr></tbody>' +
  '</table><button>Guardar</button></main>';

/** FC — tabla cruzada: th[scope=row] + celda sin campo técnico. */
const FC =
  '<main><table>' +
  '<thead><tr><th></th><th>Enero</th></tr></thead>' +
  '<tbody><tr>' +
  '<th scope="row">Item A</th><td><input id="v"></td>' +
  '</tr></tbody>' +
  '</table></main>';

/** FN — contexto ambiental (region "Panel") y compañero nombrado (Guardar). */
const FN =
  '<main><div role="region" aria-label="Panel">' +
  '<input id="anon">' +
  '<button></button>' +
  '<div role="img"></div>' +
  '<div role="gridcell"></div>' +
  '</div><button aria-label="Guardar"></button></main>';

// ── Guardas de infraestructura (C-2 / C-3) ───────────────────────────────────

test('Guarda C-3 (infraestructura): las rutas de los SKILL resuelven relativas a este test', () => {
  // fail-loud si el layout de agent-kit cambia (G-5 del precedente docsguard).
  for (const [ruta, etiqueta] of [
    [PATH_ODOO, 'vulpo-odoo-web/SKILL.md'],
    [PATH_NAV, 'vulpo-web-navigation/SKILL.md'],
  ]) {
    assert.ok(
      fs.existsSync(ruta),
      `fallo de infraestructura (C-3): no se encontró ${etiqueta} en ${ruta} (resuelto con import.meta.url desde ${DIR_TEST})`,
    );
  }
});

test('Guarda C-2 (infraestructura): el extractor descubre 2 recetas Odoo + 4 genéricas POR ESTRUCTURA', (t) => {
  // C-1: el descubrimiento NO keya en namedOnly (en GREEN el token desaparece
  // y el extractor tiene que seguir encontrando las 6 queries). El fallo acá
  // es de infraestructura, nunca RED válido.
  const { odoo, nav, todas } = obtenerRecetas();
  assert.equal(odoo.length, 2, 'infra (C-1): exactamente 2 fences json con "frame": en el SKILL de Odoo');
  assert.equal(nav.length, 4, 'infra (C-1): exactamente 4 queries en el fence de §1b del SKILL de navegación');
  assert.equal(todas.length, 6, 'infra (C-2): 6 recetas publicadas en total');
  for (const r of todas) {
    assert.ok(
      Array.isArray(r.opciones.roles) && r.opciones.roles.length > 0,
      `infra (C-2): ${r.etiqueta} con roles no vacío — ${JSON.stringify(r.opciones)}`,
    );
  }
  // Evidencia para el reporte: las seis queries TAL COMO las extrajo el extractor.
  t.diagnostic('Las seis queries extraídas de los SKILL (I-5, estructuras parseadas):');
  for (const r of todas) t.diagnostic(`  ${r.etiqueta}: ${JSON.stringify(r.opciones)}`);
});

// ── P1 (RED): las seis recetas publicadas conservan los inputs sin nombre ────

test('P1: cada una de las seis queries publicadas aplicada a F8 conserva exactamente los dos inputs sin nombre', async (t) => {
  // C-2: guardas de cardinalidad fail-loud ANTES de las aserciones RED.
  const { todas } = obtenerRecetas();

  await t.test('guarda previa ({} sobre F8): emite ambos inputs con column Cantidad/Precio y sin context', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const cantidad = emitido(frame, root, doc.getElementById('cantidad'), 'guarda previa: input#cantidad');
    const precio = emitido(frame, root, doc.getElementById('precio'), 'guarda previa: input#precio');
    assert.equal(cantidad.name, '', 'guarda previa: el input sigue sin nombre accesible (name "")');
    assert.equal(precio.name, '', 'guarda previa: el input sigue sin nombre accesible (name "")');
    assert.equal(cantidad.column, 'Cantidad', 'guarda previa (fb-023-002): column "Cantidad" heredada de la celda');
    assert.equal(precio.column, 'Precio', 'guarda previa (fb-023-002): column "Precio" heredada de la celda');
    assert.equal(
      'context' in cantidad && 'context' in precio,
      false,
      'guarda previa: la fila de F8 no aporta context (sin celda con nombre en la fila)',
    );
  });

  for (const receta of todas) {
    await t.test(`${receta.etiqueta} conserva ambos inputs (name "", column, sin context; refs correctos)`, () => {
      const doc = makeDom(F8);
      const root = doc.body;
      const frame = serializeFrame(root, receta.opciones);
      const cantidad = emitido(frame, root, doc.getElementById('cantidad'), `P1/${receta.etiqueta}: input#cantidad`);
      const precio = emitido(frame, root, doc.getElementById('precio'), `P1/${receta.etiqueta}: input#precio`);
      // Identidad por resolveRef: el ref emitido resuelve el nodo correcto
      // (la búsqueda de `emitido` ya es por identidad; se pinea explícito).
      assert.equal(resolveRef(cantidad.ref, root), doc.getElementById('cantidad'), `P1/${receta.etiqueta}: el ref de cantidad resuelve input#cantidad`);
      assert.equal(resolveRef(precio.ref, root), doc.getElementById('precio'), `P1/${receta.etiqueta}: el ref de precio resuelve input#precio`);
      assert.equal(cantidad.name, '', `P1/${receta.etiqueta}: el input conserva name "" (D-5: name:"" no impide actuar)`);
      assert.equal(precio.name, '', `P1/${receta.etiqueta}: el input conserva name ""`);
      assert.equal(cantidad.column, 'Cantidad', `P1/${receta.etiqueta}: column "Cantidad" intacta`);
      assert.equal(precio.column, 'Precio', `P1/${receta.etiqueta}: column "Precio" intacta`);
      assert.equal('context' in cantidad, false, `P1/${receta.etiqueta}: sin context (la fila no aporta)`);
      assert.equal('context' in precio, false, `P1/${receta.etiqueta}: sin context (la fila no aporta)`);
    });
  }
});

// ── P2 (RED): la receta de datos de Odoo sobre F1 conserva inputs + context ──

test('P2: la receta de entrada de datos de Odoo sobre F1 conserva ambos inputs con context ["Item A"] y excluye el botón', async (t) => {
  const receta = recetaOdooDatos(); // guarda C-2 fail-loud antes de las aserciones RED

  await t.test('guarda previa ({} sobre F1): existen los dos inputs Y el botón', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    emitido(frame, root, doc.getElementById('cantidad'), 'guarda previa: input#cantidad');
    emitido(frame, root, doc.getElementById('precio'), 'guarda previa: input#precio');
    const boton = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Guardar');
    emitido(frame, root, boton, 'guarda previa: button Guardar');
  });

  await t.test('con la receta: ambos inputs conservados (context ["Item A"], columnas correctas)', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, receta);
    const cantidad = emitido(frame, root, doc.getElementById('cantidad'), 'P2: input#cantidad');
    const precio = emitido(frame, root, doc.getElementById('precio'), 'P2: input#precio');
    assert.deepEqual(cantidad.context, ['Item A'], 'P2 (D-5): context de la fila ["Item A"]');
    assert.deepEqual(precio.context, ['Item A'], 'P2 (D-5): context de la fila ["Item A"]');
    assert.equal(cantidad.column, 'Cantidad', 'P2: column "Cantidad" intacta');
    assert.equal(precio.column, 'Precio', 'P2: column "Precio" intacta');
  });

  await t.test('la receta sigue recortando por rol: el botón Guardar queda fuera', () => {
    const doc = makeDom(F1);
    const root = doc.body;
    const frame = serializeFrame(root, receta);
    const boton = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Guardar');
    const el = allElements(frame).find((e) => resolveRef(e.ref, root) === boton);
    assert.equal(
      el,
      undefined,
      `P2: el recorte por roles sigue funcionando (button fuera de roles ["textbox","combobox"]); refs=${JSON.stringify(allRefs(frame))}`,
    );
  });
});

// ── P3 (RED): la receta sobre FC conserva el input con context cruzado ───────

test('P3: la receta de Odoo sobre FC conserva el input con context ["Item A","Enero"] y sin column', async (t) => {
  const receta = recetaOdooDatos(); // guarda C-2 fail-loud antes de las aserciones RED

  await t.test('guarda previa ({} sobre FC): el input se emite con el context cruzado EXACTO', () => {
    const doc = makeDom(FC);
    const root = doc.body;
    const frame = serializeFrame(root, {});
    const input = emitido(frame, root, doc.getElementById('v'), 'guarda previa: input#v');
    assert.deepEqual(
      input.context,
      ['Item A', 'Enero'],
      `guarda previa: el context cruzado exacto (fila + columna); recibido ${JSON.stringify(input)}`,
    );
    assert.equal(
      'column' in input,
      false,
      'guarda previa: la cruzada no emite column (sin campo técnico — fb-023-002 D-2)',
    );
  });

  await t.test('con la receta: el input sobrevive con su context cruzado intacto', () => {
    const doc = makeDom(FC);
    const root = doc.body;
    const frame = serializeFrame(root, receta);
    const input = emitido(frame, root, doc.getElementById('v'), 'P3: input#v');
    assert.deepEqual(
      input.context,
      ['Item A', 'Enero'],
      'P3 (D-5): el context cruzado exacto se conserva — evita resolver únicamente el caso con column',
    );
    assert.equal('column' in input, false, 'P3: sin column (la cruzada no lo emite)');
  });
});

// ── P4 (PIN): namedOnly:true conserva su semántica estricta (D-1) ────────────

test('P4 (PIN): namedOnly:true sigue excluyendo los inputs de F8 y los cuatro descendientes anónimos de FN; conserva el botón Guardar', async (t) => {
  await t.test('F8 con namedOnly:true: los dos inputs quedan fuera (guarda: existen sin filtro)', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const sinFiltro = serializeFrame(root, {});
    emitido(sinFiltro, root, doc.getElementById('cantidad'), 'guarda P4/F8: input#cantidad existe sin filtro');
    emitido(sinFiltro, root, doc.getElementById('precio'), 'guarda P4/F8: input#precio existe sin filtro');
    const filtrado = serializeFrame(root, { namedOnly: true });
    for (const [id, nodo] of [
      ['cantidad', doc.getElementById('cantidad')],
      ['precio', doc.getElementById('precio')],
    ]) {
      const el = allElements(filtrado).find((e) => resolveRef(e.ref, root) === nodo);
      assert.equal(el, undefined, `P4/F8 (D-1): input#${id} (name "") queda fuera con namedOnly:true; refs=${JSON.stringify(allRefs(filtrado))}`);
    }
  });

  await t.test('FN con namedOnly:true: los cuatro descendientes anónimos de la región quedan fuera (guarda: existen y llevan context ["Panel"])', () => {
    const doc = makeDom(FN);
    const root = doc.body;
    const sinFiltro = serializeFrame(root, {});
    const anonimos = [
      ['input#anon', doc.getElementById('anon')],
      ['button sin nombre', doc.querySelector('div[role="region"] > button')],
      ['div role=img', doc.querySelector('div[role="img"]')],
      ['div role=gridcell', doc.querySelector('div[role="gridcell"]')],
    ];
    for (const [etiqueta, nodo] of anonimos) {
      const el = emitido(sinFiltro, root, nodo, `guarda P4/FN: ${etiqueta} existe sin filtro`);
      assert.deepEqual(
        el.context,
        ['Panel'],
        `guarda P4/FN (fb-023-001): ${etiqueta} lleva el context ambiental ["Panel"]; recibido ${JSON.stringify(el)}`,
      );
    }
    const filtrado = serializeFrame(root, { namedOnly: true });
    for (const [etiqueta, nodo] of anonimos) {
      const el = allElements(filtrado).find((e) => resolveRef(e.ref, root) === nodo);
      assert.equal(el, undefined, `P4/FN (D-1): ${etiqueta} (name "") queda fuera con namedOnly:true`);
    }
  });

  await t.test('FN con namedOnly:true: el botón con aria-label "Guardar" se conserva', () => {
    const doc = makeDom(FN);
    const root = doc.body;
    const filtrado = serializeFrame(root, { namedOnly: true });
    const guardar = [...doc.querySelectorAll('main > button')].find((b) => b.getAttribute('aria-label') === 'Guardar');
    const el = emitido(filtrado, root, guardar, 'P4/FN: button[aria-label="Guardar"]');
    assert.equal(el.name, 'Guardar', 'P4/FN (D-1): el filtro estricto conserva el nombre accesible no vacío');
  });
});

// ── P5 (PIN): la estrategia de paginación recomendada funciona sobre F8 ──────

test('P5 (PIN): F8 con roles+maxElementsPerPage:1 — dos páginas con un input cada una; refs disjuntos y unión = los dos inputs', () => {
  const doc = makeDom(F8);
  const root = doc.body;

  const sinFiltro = serializeFrame(root, {});
  const refCantidad = emitido(sinFiltro, root, doc.getElementById('cantidad'), 'P5: input#cantidad (sin filtro)').ref;
  const refPrecio = emitido(sinFiltro, root, doc.getElementById('precio'), 'P5: input#precio (sin filtro)').ref;

  const opciones = { roles: ['textbox'], maxElementsPerPage: 1 };
  const p1 = serializeFrame(root, { ...opciones, page: 1 });
  const p2 = serializeFrame(root, { ...opciones, page: 2 });

  assert.equal(p1.totalPages, 2, 'P5: totalPages===2 (dos textboxes, una por página)');
  assert.equal(allElements(p1).length, 1, 'P5: la página 1 no está vacía (un elemento)');
  assert.equal(allElements(p2).length, 1, 'P5: la página 2 no está vacía (un elemento)');

  const ref1 = allElements(p1)[0].ref;
  const ref2 = allElements(p2)[0].ref;
  assert.notEqual(ref1, ref2, 'P5: los refs de ambas páginas son disjuntos');
  assert.deepEqual(
    [ref1, ref2].sort(),
    [refCantidad, refPrecio].sort(),
    'P5: la unión de ambas páginas es exactamente los dos inputs completos (identidad por ref)',
  );
});

// ── P6 (PIN): la huella es idéntica entre lectura completa y recortes (I-3) ──

test('P6 (PIN): en F8/F1/FC/FN la huella es idéntica entre lectura completa, namedOnly:true y recorte por roles', async (t) => {
  const variantes = [{}, { namedOnly: true }, { roles: ['textbox'] }];
  const etiquetas = ['{} (completa)', 'namedOnly:true', 'roles:["textbox"]'];
  let parDistinto = false;

  for (const [nombre, html] of [
    ['F8', F8],
    ['F1', F1],
    ['FC', FC],
    ['FN', FN],
  ]) {
    await t.test(`${nombre}: huella invariante bajo las tres lecturas`, () => {
      const doc = makeDom(html);
      const root = doc.body;
      const huellas = variantes.map((op, i) => {
        const frame = serializeFrame(root, op);
        return assertHuella(frame, `P6/${nombre} ${etiquetas[i]}`);
      });
      assert.equal(huellas[0], huellas[1], `P6/${nombre}: la huella no cambia bajo namedOnly:true (I-3)`);
      assert.equal(huellas[0], huellas[2], `P6/${nombre}: la huella no cambia bajo roles:["textbox"] (I-3)`);
      // Guarda de no-vacuidad: al menos un par de queries devuelve conjuntos
      // distintos (si las tres lecturas devolvieran lo mismo, la igualdad de
      // huellas sería trivial).
      const refs = variantes.map((op) => JSON.stringify(allRefs(serializeFrame(root, op)).sort()));
      if (refs[0] !== refs[1] || refs[0] !== refs[2]) parDistinto = true;
    });
  }

  await t.test('F8: la huella también es idéntica entre ambas páginas de P5', () => {
    const doc = makeDom(F8);
    const root = doc.body;
    const opciones = { roles: ['textbox'], maxElementsPerPage: 1 };
    const h1 = assertHuella(serializeFrame(root, { ...opciones, page: 1 }), 'P5 página 1');
    const h2 = assertHuella(serializeFrame(root, { ...opciones, page: 2 }), 'P5 página 2');
    assert.equal(h2, h1, 'P6/F8: la huella no depende de la página pedida (I-3)');
  });

  await t.test('guarda de no-vacuidad P6: al menos un par de queries devuelve conjuntos distintos', () => {
    assert.ok(
      parDistinto,
      'P6 (guarda): alguna lectura efectivamente recorta (namedOnly vs completa) — sin esto la invariancia sería trivial',
    );
  });
});

// ── P7 (T-doc, RED documental): la regla en inglés en los SKILL ──────────────

test('P7 (T-doc, RED documental): los SKILL contienen la regla D-3/D-4/D-5 en inglés y no recomiendan namedOnly para listas editables', () => {
  const docOdoo = leerDoc(PATH_ODOO, 'vulpo-odoo-web/SKILL.md');
  const docNav = leerDoc(PATH_NAV, 'vulpo-web-navigation/SKILL.md');

  // Verificación SEMÁNTICA contra D-3/D-4/D-5/D-6 (no igualdad literal de
  // párrafos — spec §3.2 P7). Cada regla es una condición que debe estar
  // presente en GREEN; en RED se REGISTRAN los incumplimientos actuales.
  const reglas = [
    {
      id: 'O1 (odoo, D-6): la receta de formularios densos manda omitir namedOnly para listas editables',
      ok: /For editable lists, omit `namedOnly`/.test(docOdoo),
    },
    {
      id: 'O2 (odoo, D-6): los inputs sin nombre pueden llevar column y/o context',
      ok: /Blank-name inputs may still carry `column` and\/or `context`/.test(docOdoo),
    },
    {
      id: 'N1 (nav, D-6): el narrowing de formularios densos manda omitir namedOnly para listas editables',
      ok: /For editable lists, omit `namedOnly`/.test(docNav),
    },
    {
      id: 'N2 (nav, D-4): si falta el campo esperado, releer sin ninguno de los dos filtros y recorrer las páginas de totalPages',
      ok: /without either filter and inspect the pages reported by `totalPages`/.test(docNav),
    },
    {
      id: 'N3 (nav, D-4): la relectura no autoriza repetir la acción anterior',
      ok: /do not repeat the preceding action just to read/.test(docNav),
    },
    {
      id: 'N4 (nav, D-3): conservar los roles que se necesitan; omitir roles también si se desconocen',
      ok: /Keep the roles of the controls you need/.test(docNav),
    },
    {
      id: 'N5 (nav, D-1): la definición ESTRICTA de namedOnly se conserva como filtro optativo (nombre accesible NO vacío)',
      ok: /`namedOnly: true` keeps only elements with a non-empty accessible name/.test(docNav),
    },
    {
      id: 'N6 (nav, D-5): omitir namedOnly AUNQUE column o context estén presentes',
      ok: /omit `namedOnly`, even when `column` or `context` is/.test(docNav),
    },
    {
      id: 'N7 (nav, D-5): las etiquetas no garantizan una fila única — no adivinar entre filas ambiguas',
      ok: /Labels do not guarantee a unique row/.test(docNav),
    },
  ];

  const incumplimientos = reglas.filter((r) => !r.ok).map((r) => r.id);
  assert.deepEqual(
    incumplimientos,
    [],
    'P7 (T-doc, RED documental): los SKILL incumplen hoy las reglas del contrato. ' +
      'Incumplimientos actuales (registrados, spec §5):\n  - ' +
      incumplimientos.join('\n  - '),
  );
});
