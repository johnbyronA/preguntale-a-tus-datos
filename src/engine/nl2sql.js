// Motor local de lenguaje natural → SQL (español).
//
// No usa IA ni servicios externos: entiende la pregunta a partir del esquema
// de la tabla (nombres de columnas, tipos y valores reales) y de un léxico de
// negocio genérico. Funciona con cualquier CSV/Excel que se cargue.
//
//   parse(pregunta, esquema)  → intención (métrica, dimensiones, filtros, periodo…)
//   buildSQL(intención, esquema) → SQL para DuckDB
//   explain(intención)        → explicación en lenguaje natural

import { normalize, phrase, pluralize, singularize, wordRegex, parseNumber, STOPWORDS, MONTH_NAMES } from './text.js';
import { findTimeExpressions, findGrains } from './time.js';

// ---------------------------------------------------------------------------
// Léxico de negocio: palabras → patrón de nombre de columna
// ---------------------------------------------------------------------------
const CONCEPTS = [
  { key: 'revenue', type: 'number', words: ['ingreso', 'ingresos', 'venta', 'ventas', 'vendido', 'vendidos', 'vende', 'venden', 'vendio', 'vendieron', 'vendemos', 'vendimos', 'vendi', 'vendiste', 'vendera', 'venderemos', 'facturacion', 'facturado', 'facturamos', 'revenue', 'sales', 'monto', 'montos', 'importe', 'valor vendido'], col: /ingreso|venta|revenue|sales|monto|importe|factur|valor_total|total_venta/ },
  { key: 'profit', type: 'number', words: ['utilidad', 'utilidades', 'ganancia', 'ganancias', 'beneficio', 'beneficios', 'profit', 'rentabilidad', 'ganamos'], col: /utilidad|ganancia|beneficio|profit/ },
  { key: 'cost', type: 'number', words: ['costo', 'costos', 'coste', 'costes', 'gasto', 'gastos', 'cost', 'costs'], col: /costo|coste|gasto|cost/ },
  { key: 'qty', type: 'number', words: ['cantidad', 'unidades', 'unidad', 'piezas', 'volumen', 'qty'], col: /cantidad|unidades|qty|quantity|piezas/ },
  { key: 'price', type: 'number', words: ['precio', 'precios', 'price'], col: /precio|price/ },
  { key: 'discount', type: 'number', words: ['descuento', 'descuentos', 'discount'], col: /descuento|discount|dcto/ },
  { key: 'rating', type: 'number', words: ['calificacion', 'calificaciones', 'satisfaccion', 'rating', 'puntuacion', 'puntaje', 'nota', 'nps', 'estrellas'], col: /calific|rating|satisf|puntu|puntaje|score|nps/ },
  { key: 'delivery', type: 'number', words: ['tiempo de entrega', 'tiempos de entrega', 'dias de entrega', 'demora', 'demoras', 'entrega', 'entregas'], col: /entrega|delivery|demora|lead_time/ },
  { key: 'city', type: 'text', words: ['ciudad', 'ciudades', 'city', 'municipio', 'municipios'], col: /ciudad|city|municipio/ },
  { key: 'region', type: 'text', words: ['region', 'regiones', 'zona', 'zonas'], col: /region|zona/ },
  { key: 'channel', type: 'text', words: ['canal', 'canales', 'medio de venta', 'medios de venta'], col: /canal|channel/ },
  { key: 'category', type: 'text', words: ['categoria', 'categorias', 'linea', 'lineas', 'familia', 'familias'], col: /categor|linea|familia|category/ },
  { key: 'product', type: 'text', words: ['producto', 'productos', 'articulo', 'articulos', 'referencia', 'referencias', 'item', 'items', 'sku'], col: /producto|articulo|referencia|item|sku|product/ },
  { key: 'seller', type: 'text', words: ['vendedor', 'vendedores', 'vendedora', 'vendedoras', 'asesor', 'asesores', 'asesora', 'comercial', 'comerciales', 'ejecutivo', 'ejecutivos'], col: /vendedor|asesor|comercial|ejecutivo|seller|rep/ },
  { key: 'client', type: 'text', words: ['cliente', 'clientes', 'customer', 'customers'], col: /cliente|customer/ },
  { key: 'status', type: 'text', words: ['estado', 'estados', 'status'], col: /estado|status/ },
];

// Palabras que cuentan registros ("¿cuántos pedidos…?")
const COUNT_ENTITIES = ['pedido', 'pedidos', 'orden', 'ordenes', 'transaccion', 'transacciones', 'registro', 'registros',
  'compra', 'compras', 'operacion', 'operaciones', 'factura', 'facturas', 'filas', 'fila', 'casos', 'caso', 'tickets', 'ticket'];

// Derivaciones frecuentes de estados ("devoluciones" → "Devuelto")
const VALUE_DERIVATIONS = { devolucion: 'devuelt', devoluciones: 'devuelt', devuelven: 'devuelt', cancelacion: 'cancelad', cancelaciones: 'cancelad', anulacion: 'anulad', anulaciones: 'anulad', entregadas: 'entregad' };

// Columnas cuyo agregado natural es el promedio
const AVG_COL = /pct|porcentaje|tasa|ratio|calific|rating|satisf|puntu|score|nps|dias|edad|precio|price|tiempo|demora|duracion|tarifa/;
const MONEY_COL = /ingreso|venta|revenue|sales|monto|importe|factur|costo|coste|gasto|utilidad|ganancia|beneficio|profit|precio|price|valor|salario|sueldo|pago|cop|usd/;
const ID_COL = /(^id_|_id$|^id$|^cod(igo)?_|_cod(igo)?$|^nro_|uuid|^key$)/;

const GRAIN_LABEL = { day: 'día', week: 'semana', month: 'mes', quarter: 'trimestre', year: 'año', dow: 'día de la semana', moy: 'mes del año' };

// ---------------------------------------------------------------------------
// Vocabulario a partir del esquema
// ---------------------------------------------------------------------------
const vocabCache = new WeakMap();

export function buildVocabulary(schema) {
  if (vocabCache.has(schema)) return vocabCache.get(schema);
  const cols = schema.columns;
  const entries = []; // {phrase, kind:'column'|'value', column, value?, concept?}
  const taken = new Set();
  const add = (p, e) => {
    p = p.trim();
    if (!p || p.length < 2) return;
    const key = `${e.kind}:${p}`;
    if (taken.has(key)) return;
    taken.add(key);
    entries.push({ phrase: p, ...e });
  };

  const countEntities = new Set(COUNT_ENTITIES);
  const idCols = cols.filter((c) => ID_COL.test(c.name.toLowerCase()));
  for (const c of idCols) {
    const words = phrase(c.name).split(' ').filter((w) => !/^(id|cod|codigo|nro|key|uuid)$/.test(w));
    for (const w of words) { countEntities.add(w); countEntities.add(pluralize(w)); }
  }

  // Nombres de columnas
  const firstTokens = {};
  for (const c of cols) {
    const t = phrase(c.name).split(' ')[0];
    firstTokens[t] = (firstTokens[t] || 0) + 1;
  }
  for (const c of cols) {
    if (idCols.includes(c)) continue;
    const base = phrase(c.name);
    const toks = base.split(' ').filter((w) => !/^(pct|perc|num|nro|cod|val|vlr|cant)$/.test(w));
    const variants = new Set([base, toks.join(' ')]);
    if (toks.length === 2) variants.add(`${toks[0]} de ${toks[1]}`);
    for (const v of [...variants]) {
      const parts = v.split(' ');
      variants.add([pluralize(parts[0]), ...parts.slice(1)].join(' '));
    }
    if (toks.length > 1 && toks[0].length >= 4 && firstTokens[toks[0]] === 1 && !STOPWORDS.has(toks[0])) {
      variants.add(toks[0]); variants.add(pluralize(toks[0]));
    }
    for (const v of variants) add(v, { kind: 'column', column: c.name });
  }

  // Conceptos de negocio → mejor columna disponible
  const conceptCol = {};
  for (const concept of CONCEPTS) {
    const cand = cols.filter((c) => !idCols.includes(c) && c.type === concept.type && concept.col.test(c.name.toLowerCase()));
    if (!cand.length) continue;
    const col = cand[0];
    conceptCol[concept.key] = col.name;
    for (const w of concept.words) add(w, { kind: 'column', column: col.name, concept: concept.key });
  }

  // Valores de columnas de texto
  const valueTokenCount = {};
  const textCols = cols.filter((c) => c.type === 'text' && Array.isArray(c.values) && c.values.length && !idCols.includes(c));
  for (const c of textCols) for (const v of c.values) for (const t of new Set(phrase(v).split(' '))) valueTokenCount[t] = (valueTokenCount[t] || 0) + 1;
  const columnPhrases = new Set(entries.filter((e) => e.kind === 'column').map((e) => e.phrase));
  for (const c of textCols) {
    for (const v of c.values) {
      const p = phrase(v);
      if (!p || /^\d+$/.test(p)) continue;
      add(p, { kind: 'value', column: c.name, value: v });
      const compact = p.replace(/\s+/g, '');
      if (compact !== p && compact.length >= 4) add(compact, { kind: 'value', column: c.name, value: v });
      const parts = p.split(' ');
      if (parts.length === 1) {
        add(pluralize(p), { kind: 'value', column: c.name, value: v });
        if (/o$/.test(p)) { add(p.replace(/o$/, 'a'), { kind: 'value', column: c.name, value: v }); add(p.replace(/o$/, 'as'), { kind: 'value', column: c.name, value: v }); }
      } else {
        for (const t of [parts[0], parts[parts.length - 1]]) {
          if (t.length >= 5 && valueTokenCount[t] === 1 && !STOPWORDS.has(t) && !columnPhrases.has(t) && !COUNT_ENTITIES.includes(t)) {
            add(t, { kind: 'value', column: c.name, value: v, partial: true });
            add(pluralize(t), { kind: 'value', column: c.name, value: v, partial: true });
          }
        }
      }
    }
  }
  // Derivaciones ("devoluciones" → valor que empieza con "devuelt")
  for (const [word, stem] of Object.entries(VALUE_DERIVATIONS)) {
    for (const c of textCols) {
      const hit = c.values.find((v) => phrase(v).startsWith(stem));
      if (hit) { add(word, { kind: 'value', column: c.name, value: hit, derived: true }); break; }
    }
  }

  const dateCols = cols.filter((c) => c.type === 'date');
  const vocab = { entries, countEntities, conceptCol, dateCols, idCols: idCols.map((c) => c.name) };
  vocabCache.set(schema, vocab);
  return vocab;
}

// ---------------------------------------------------------------------------
// Análisis de la pregunta
// ---------------------------------------------------------------------------
function findAll(n, p) {
  return [...n.matchAll(wordRegex(p))].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

function resolve(cands) {
  // más largo primero; a igual longitud, mayor prioridad
  cands.sort((a, b) => (b.end - b.start) - (a.end - a.start) || (b.priority || 0) - (a.priority || 0) || a.start - b.start);
  const kept = [];
  for (const c of cands) if (!kept.some((k) => overlaps(k, c))) kept.push(c);
  return kept.sort((a, b) => a.start - b.start);
}

const RE = (s) => new RegExp(`(?<![a-z0-9])(?:${s})(?![a-z0-9])`, 'g');
const RE1 = (s) => new RegExp(`(?<![a-z0-9])(?:${s})(?![a-z0-9])`);

const COMPARATORS = [
  ['>=', 'mayor(?:es)?\\s+o\\s+igual(?:es)?\\s+(?:a|que)|al\\s+menos|como\\s+minimo|>='],
  ['<=', 'menor(?:es)?\\s+o\\s+igual(?:es)?\\s+(?:a|que)|como\\s+maximo|a\\s+lo\\s+sumo|maximo|<='],
  ['>', 'mayor(?:es)?\\s+(?:a|que|de)(?:l)?|mas\\s+de|superior(?:es)?\\s+(?:a|al)|por\\s+encima\\s+de(?:l)?|arriba\\s+de|sobre|>'],
  ['<', 'menor(?:es)?\\s+(?:a|que|de)(?:l)?|menos\\s+de|inferior(?:es)?\\s+(?:a|al)|por\\s+debajo\\s+de(?:l)?|bajo|<'],
  ['=', 'igual(?:es)?\\s+a|exactamente|='],
];
const NUMBER = `(\\$?\\s?\\d[\\d.,]*\\s?(?:%|millones|millon|mil|k|mm)?|${'un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte'})`;

/** Analiza la pregunta y devuelve la intención estructurada. */
export function parse(question, schema) {
  const vocab = buildVocabulary(schema);
  const n = normalize(question);
  const dateCol = vocab.dateCols[0]?.name || null;
  const refDate = vocab.dateCols[0]?.max || null;
  const minDate = vocab.dateCols[0]?.min || null;
  const notes = [];
  const cands = [];

  // 1) Tiempo
  if (dateCol && refDate) {
    for (const t of findTimeExpressions(n, refDate, minDate)) cands.push({ ...t, type: 'time', priority: 9 });
    for (const g of findGrains(n)) cands.push({ ...g, type: 'grain', priority: 8 });
  }

  // 2) Límite / top N
  for (const m of n.matchAll(RE(`top\\s*(\\d+)|(?:los|las)\\s+(\\d+|${'dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte'})(?=\\s+[a-z])|(?:primer[oa]s|mejores|peores|principales)\\s+(\\d+)|(\\d+|${'tres|cinco|diez|veinte'})\\s+(?:mejores|peores|principales|primer[oa]s|mas|menos)`))) {
    const k = parseNumber(m[1] || m[2] || m[3] || m[4]);
    if (k > 0 && k <= 1000 && !(k >= 1900 && k <= 2100)) cands.push({ start: m.index, end: m.index + m[0].length, type: 'limit', limit: k, priority: 6 });
  }
  // "últimos 10 pedidos" → detalle
  for (const m of n.matchAll(RE(`(?:los|las)?\\s*ultim[oa]s\\s+(\\d+)\\s+(${[...vocab.countEntities].join('|')})`))) {
    cands.push({ start: m.index, end: m.index + m[0].length, type: 'latest', limit: Number(m[1]), priority: 10 });
  }

  // 3) Columnas y valores del esquema
  for (const e of vocab.entries) {
    for (const pos of findAll(n, e.phrase)) {
      cands.push({ ...pos, type: e.kind, column: e.column, value: e.value, concept: e.concept, partial: e.partial, priority: e.kind === 'value' ? (e.partial ? 3 : 5) : 4 });
    }
  }
  for (const w of vocab.countEntities) for (const pos of findAll(n, w)) cands.push({ ...pos, type: 'entity', priority: 2 });

  // 4) Comparadores numéricos: "<columna> mayor a N" o "más de N <columna>"
  const numericEntries = vocab.entries.filter((e) => e.kind === 'column' && schema.columns.find((c) => c.name === e.column)?.type === 'number');
  for (const [op, words] of COMPARATORS) {
    for (const m of n.matchAll(RE(`(?:${words})\\s*(?:el\\s+|la\\s+|a\\s+)?${NUMBER}`))) {
      const value = parseNumber(m[1]);
      if (!Number.isFinite(value) || (value >= 1900 && value <= 2100 && !/[%$.,]/.test(m[1]))) continue;
      const span = { start: m.index, end: m.index + m[0].length };
      // columna justo antes (hasta 3 palabras) o justo después
      const before = n.slice(Math.max(0, span.start - 40), span.start);
      const after = n.slice(span.end, span.end + 40);
      let col = null; let colSpan = null;
      for (const e of numericEntries.sort((a, b) => b.phrase.length - a.phrase.length)) {
        const reB = new RegExp(`(?<![a-z0-9])${e.phrase.replace(/\s+/g, '\\s+')}(?:\\s+(?:sea|es|fue|de|del|con))?\\s*(?:con\\s+)?$`);
        const reA = new RegExp(`^\\s*(?:de\\s+)?${e.phrase.replace(/\s+/g, '\\s+')}(?![a-z0-9])`);
        const mb = before.match(reB); const ma = after.match(reA);
        if (mb) { col = e.column; colSpan = { start: span.start - mb[0].length + (mb[0].length - mb[0].trimStart().length), end: span.start }; break; }
        if (ma) { col = e.column; colSpan = { start: span.end, end: span.end + ma[0].length }; break; }
      }
      if (!col) {
        const ent = [...vocab.countEntities].find((w) => new RegExp(`^\\s*${w}(?![a-z0-9])`).test(after));
        if (ent) continue; // "más de 5 pedidos" sin columna: se ignora
        // "con descuento superior al 10%": buscar columna más cercana antes
        continue;
      }
      const full = { start: Math.min(span.start, colSpan.start), end: Math.max(span.end, colSpan.end) };
      const isPct = /%/.test(m[1]);
      cands.push({ ...full, type: 'numfilter', column: col, op, value, isPct, priority: 11 });
    }
    // "entre N y M <columna>" / "<columna> entre N y M"
  }
  for (const m of n.matchAll(RE(`entre\\s+${NUMBER}\\s+y\\s+${NUMBER}`))) {
    const a = parseNumber(m[1]); const b = parseNumber(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a >= 1900 && a <= 2100 && b >= 1900 && b <= 2100)) continue;
    const span = { start: m.index, end: m.index + m[0].length };
    const before = n.slice(Math.max(0, span.start - 40), span.start);
    const after = n.slice(span.end, span.end + 40);
    for (const e of numericEntries) {
      const reB = new RegExp(`${e.phrase.replace(/\s+/g, '\\s+')}\\s*(?:de\\s+)?$`);
      const reA = new RegExp(`^\\s*(?:de\\s+)?${e.phrase.replace(/\s+/g, '\\s+')}(?![a-z0-9])`);
      const mb = before.match(reB); const ma = after.match(reA);
      if (mb || ma) {
        const full = mb ? { start: span.start - mb[0].length, end: span.end } : { start: span.start, end: span.end + ma[0].length };
        cands.push({ ...full, type: 'numfilter', column: e.column, op: 'BETWEEN', value: Math.min(a, b), value2: Math.max(a, b), priority: 11 });
        break;
      }
    }
  }

  const matches = resolve(cands);

  // -------------------------------------------------------------------------
  // Interpretación
  // -------------------------------------------------------------------------
  const has = (re) => RE(re).test(n);
  const col = (name) => schema.columns.find((c) => c.name === name);
  const spans = [];
  const span = (m, kind, label) => spans.push({ start: m.start, end: m.end, kind, label });

  const intent = {
    kind: 'aggregate', metric: null, dims: [], filters: [], time: null, compare: null,
    extras: {}, order: null, limit: null, focusTop: false, dateColumn: dateCol, spans, notes, confidence: 1,
  };

  // Palabras clave de agregación
  const wAvg = has('promedio|promedios|media|en\\s+promedio|average|tipicamente|ticket\\s+promedio');
  const wMedian = has('mediana');
  const wCount = has('cuant[oa]s|numero\\s+de|n\\s+de|conteo|contar|cuenta\\s+de|cantidad\\s+de\\s+(?:' + [...vocab.countEntities].join('|') + ')|how\\s+many|frecuencia');
  const wDistinct = has('distint[oa]s|diferentes|unic[oa]s');
  const wMax = has('maximo|maxima|el\\s+mas\\s+alto|valor\\s+mas\\s+alto|max');
  const wMin = has('minimo|minima|el\\s+mas\\s+bajo|valor\\s+mas\\s+bajo|min');
  const wAsc = has('menos|menor|menores|peor|peores|mas\\s+bajo|mas\\s+bajos|mas\\s+bajas|bottom|ultimos\\s+lugares|el\\s+que\\s+menos|la\\s+que\\s+menos');
  const wShare = has('participacion|porcentaje\\s+del\\s+total|%\\s*del\\s+total|share|peso\\s+(?:de|en)|contribucion|proporcion\\s+del\\s+total|que\\s+porcentaje\\s+representa');
  const wRate = has('tasa|porcentaje|proporcion|%|ratio|que\\s+parte');
  const wGrowth = has('crec[a-z]*|variacion|cambio|increment[a-z]*|aument[a-z]*|disminu[a-z]*|caida|cay[a-z]*');
  const wCumul = has('acumulad[oa]s?|acumulativ[oa]|running');
  const wMargin = has('margen|margenes|rentabilidad');
  const wList = has('lista|listar|listado|muestrame\\s+(?:los|las)|detalle|registros|filas|ver\\s+(?:los|las)');
  const wDistribution = has('distribucion|histograma|rangos\\s+de|por\\s+rangos');
  const wAvgPeriod = (() => { const m = n.match(RE1('promedio\\s+(mensual|diario|semanal|anual|trimestral|por\\s+mes|por\\s+dia|por\\s+semana|al\\s+mes|al\\s+dia)|(mensual|diario|semanal|anual)\\s+promedio')); if (!m) return null; const w = m[1] || m[2]; return /mes|mensual/.test(w) ? 'month' : /dia|diario/.test(w) ? 'day' : /semana/.test(w) ? 'week' : /trimestr/.test(w) ? 'quarter' : 'year'; })();

  // Exclusión: "excepto Bogotá", "sin E-commerce", "que no sea…"
  const isNegated = (m) => {
    const before = n.slice(Math.max(0, m.start - 30), m.start);
    return /(?:excepto|salvo|sin|sin\s+contar|excluyendo|exceptuando|distint[oa]\s+(?:de|a)|diferente\s+(?:de|a)|que\s+no\s+(?:sea|sean|es|son)|no\s+(?:sea|sean))\s+(?:(?:el|la|los|las|de|en|del|canal|ciudad|categoria|region)\s+)*$/.test(before)
      || /(?:todos?|todas?)\s+(?:menos|excepto)\s+(?:(?:el|la|los|las)\s+)*$/.test(before)
      || /(?<![a-z])menos\s+(?:(?:el|la|los|las)\s+)?$/.test(before) && !/(?:que|el|la)\s+menos\s*$/.test(before);
  };

  // Tiempo
  const times = matches.filter((m) => m.type === 'time');
  const cmp = times.find((t) => t.kind === 'compare');
  if (cmp) {
    intent.compare = { years: cmp.years };
    intent.time = { column: dateCol, from: cmp.range.from, to: cmp.range.to, label: cmp.label };
    span(cmp, 'time', `compara ${cmp.label}`);
  } else if (times.length) {
    let from = null; let to = null; const labels = [];
    // si hay varios años sueltos ("2024 y 2025"), se toma el rango completo
    for (const t of times) {
      if (t.range.from && (!from || t.range.from < from)) from = t.range.from;
      if (t.range.to && (!to || t.range.to > to)) to = t.range.to;
      labels.push(t.label);
      span(t, 'time', t.label);
    }
    // "desde marzo" sin fin: hasta la última fecha
    intent.time = { column: dateCol, from, to, label: labels.join(' + ') };
  }
  if (intent.time && refDate) {
    if (intent.time.to && intent.time.to > refDate && (!intent.time.from || intent.time.from <= refDate)) intent.time.to = String(refDate).slice(0, 10);
    if (intent.time.from && minDate && intent.time.from < minDate && (!intent.time.to || intent.time.to >= minDate)) intent.time.from = String(minDate).slice(0, 10);
    if ((intent.time.from && intent.time.from > refDate) || (intent.time.to && minDate && intent.time.to < minDate)) notes.push(`Los datos van de ${minDate} a ${refDate}; el periodo pedido queda fuera.`);
  }

  // Granularidad temporal
  const grains = matches.filter((m) => m.type === 'grain');
  for (const g of grains) {
    let grain = g.grain;
    if (grain === 'trend') {
      if (intent.dims.some((d) => d.grain)) continue;
      const span0 = intent.time ? daysBetween(intent.time.from || minDate, intent.time.to || refDate) : daysBetween(minDate, refDate);
      grain = span0 <= 62 ? 'day' : span0 <= 3 * 366 ? 'month' : 'year';
    }
    if (intent.dims.some((d) => d.grain === grain)) continue;
    if (wAvgPeriod && !intent.dims.length) continue; // "promedio mensual" no agrupa
    intent.dims.push({ column: dateCol, grain });
    span(g, 'dimension', `por ${GRAIN_LABEL[grain]}`);
  }

  // Métricas, dimensiones y filtros desde columnas/valores
  const columnHits = matches.filter((m) => m.type === 'column');
  const valueHits = matches.filter((m) => m.type === 'value');
  const numFilters = matches.filter((m) => m.type === 'numfilter');
  const entityHits = matches.filter((m) => m.type === 'entity');

  for (const f of numFilters) {
    let v = f.value; const c = col(f.column);
    // "descuento mayor al 10%" en columna con valores 0-1 → 0.10
    if (f.isPct && c && c.max != null && c.max <= 1) v = v / 100;
    intent.filters.push({ column: f.column, op: f.op, value: v, value2: f.value2 });
    span(f, 'filter', `${f.column} ${f.op} ${f.value}${f.value2 != null ? ' y ' + f.value2 : ''}`);
  }

  // Tasas: "tasa de devolución", "% de pedidos devueltos", "porcentaje de ventas por E-commerce"
  let shareValue = null;
  if (wRate && !wShare) {
    for (const v of valueHits) {
      const before = n.slice(Math.max(0, v.start - 45), v.start);
      if (/(?:tasa|porcentaje|proporcion|%|ratio|que\s+parte)\s+(?:de\s+|del\s+)?(?:[a-z]+\s+){0,3}$/.test(before) || (v.derived && /tasa|porcentaje|%/.test(n))) { shareValue = v; break; }
    }
  }

  // Valores → filtros (agrupados por columna)
  const byCol = {};
  for (const v of valueHits) {
    if (v === shareValue) continue;
    // valores parciales ambiguos ("tienda") solo si no hay coincidencia completa en la misma columna
    const neg = isNegated(v);
    const key = `${v.column}|${neg}`;
    (byCol[key] ||= { column: v.column, neg, values: new Set(), hits: [] }).values.add(v.value);
    byCol[key].hits.push(v);
  }
  for (const g of Object.values(byCol)) {
    const vals = [...g.values];
    intent.filters.push({ column: g.column, op: g.neg ? (vals.length > 1 ? 'NOT IN' : '!=') : (vals.length > 1 ? 'IN' : '='), value: vals.length > 1 ? vals : vals[0] });
    for (const h of g.hits) span(h, 'filter', `${g.column} ${g.neg ? '≠' : '='} ${h.value}`);
  }

  // Columnas mencionadas: numéricas → métrica; texto → dimensión
  const filterCols = new Set(intent.filters.map((f) => f.column));
  const metricHits = []; const dimHits = [];
  for (const h of columnHits) {
    const c = col(h.column);
    if (!c) continue;
    // "en la ciudad de Medellín": columna seguida de su propio valor → contexto del filtro
    const next = valueHits.find((v) => v.column === h.column && v.start >= h.end && v.start - h.end <= 6);
    if (next) { span(h, 'filter', `${h.column}`); continue; }
    if (numFilters.some((f) => f.column === h.column && overlaps(f, h))) continue;
    const before = n.slice(Math.max(0, h.start - 14), h.start);
    const byWord = /(?:por|segun|de\s+cada|por\s+cada|cada|entre\s+(?:los|las))\s+(?:(?:el|la|los|las)\s+)?$/.test(before);
    if (c.type === 'number') {
      if (byWord && (c.integer && c.max - c.min <= 31)) dimHits.push({ h, c, numericDim: true });
      else if (byWord && wDistribution) dimHits.push({ h, c, bucket: true });
      else metricHits.push({ h, c });
    } else if (c.type === 'text') {
      dimHits.push({ h, c, byWord });
    } else if (c.type === 'date' && byWord) {
      if (!intent.dims.some((d) => d.grain)) { intent.dims.push({ column: c.name, grain: 'day' }); span(h, 'dimension', 'por día'); }
    }
  }

  // Distribución de una columna numérica: "distribución del ingreso"
  if (wDistribution && metricHits.length && !dimHits.length) {
    const mh = metricHits.shift();
    intent.kind = 'distribution';
    intent.metric = { type: 'agg', agg: 'COUNT', column: null, label: 'registros' };
    intent.dims.push({ column: mh.c.name, bucket: true });
    span(mh.h, 'dimension', `rangos de ${mh.c.name}`);
  }

  // Métrica principal
  const countEntityHit = entityHits[0];
  const countCol = (() => {
    // "cuántos clientes distintos", "cuántos productos" → COUNT DISTINCT de la dimensión
    if (!wCount) return null;
    const m = n.match(RE1('(?:cuant[oa]s|numero\\s+de|cantidad\\s+de)\\s+([a-z]+(?:\\s+[a-z]+)?)'));
    if (!m) return null;
    const after = m.index + m[0].length - m[1].length;
    return dimHits.find((d) => d.h.start === after) || null;
  })();

  const wTicket = has('ticket\\s+promedio|ticket\\s+medio|valor\\s+promedio\\s+(?:por|de\\s+cada|del?)\\s+(?:pedido|compra|venta|orden|factura)');
  if (wTicket && vocab.conceptCol.revenue) {
    const rev = vocab.conceptCol.revenue;
    intent.metric = { type: 'agg', agg: 'AVG', column: rev, label: 'ticket_promedio', title: `ticket promedio (${rev} por registro)` };
    const tm = n.match(RE1('ticket\\s+promedio|ticket\\s+medio|valor\\s+promedio'));
    if (tm) spans.push({ start: tm.index, end: tm.index + tm[0].length, kind: 'metric', label: `promedio de ${rev}` });
    for (const m of [...metricHits]) if (m.c.name === rev) metricHits.splice(metricHits.indexOf(m), 1);
  }
  if (!intent.metric) {
    if (wMargin && vocab.conceptCol.profit && vocab.conceptCol.revenue) {
      intent.metric = { type: 'ratio', num: vocab.conceptCol.profit, den: vocab.conceptCol.revenue, label: 'margen_pct', title: 'margen (%)' };
      const mh = n.match(RE1('margen(?:es)?|rentabilidad'));
      if (mh) spans.push({ start: mh.index, end: mh.index + mh[0].length, kind: 'metric', label: `margen = ${vocab.conceptCol.profit} / ${vocab.conceptCol.revenue}` });
      // las columnas de utilidad/ingreso mencionadas no se agregan por separado
      for (const m of [...metricHits]) if ([vocab.conceptCol.profit, vocab.conceptCol.revenue].includes(m.c.name)) metricHits.splice(metricHits.indexOf(m), 1);
    } else if (shareValue) {
      const weight = metricHits.find((m) => MONEY_COL.test(m.c.name.toLowerCase()) || m.c.name === vocab.conceptCol.qty);
      intent.metric = { type: 'share', column: shareValue.column, value: shareValue.value, weight: weight?.c.name || null, label: `pct_${phrase(shareValue.value).replace(/\s+/g, '_')}`, title: `% ${shareValue.value}` };
      if (weight) metricHits.splice(metricHits.indexOf(weight), 1);
      const rm = n.match(RE1('tasa|porcentaje|proporcion|ratio|%'));
      if (rm) spans.push({ start: rm.index, end: rm.index + rm[0].length, kind: 'metric', label: 'tasa' });
      span(shareValue, 'metric', `% donde ${shareValue.column} = ${shareValue.value}`);
    } else if (countCol && !metricHits.some((m) => m.c.name === vocab.conceptCol.qty)) {
      intent.metric = { type: 'agg', agg: 'COUNT_DISTINCT', column: countCol.c.name, label: `${countCol.c.name}_distintos`, title: `${countCol.c.name} distintos` };
      dimHits.splice(dimHits.indexOf(countCol), 1);
      span(countCol.h, 'metric', `contar ${countCol.c.name} distintos`);
    } else if (metricHits.length) {
      const mh = metricHits[0];
      let agg = wMedian ? 'MEDIAN' : wAvg ? 'AVG' : AVG_COL.test(mh.c.name.toLowerCase()) ? 'AVG' : 'SUM';
      const hasDims = dimHits.length || intent.dims.length;
      if (!hasDims && wMax) agg = 'MAX';
      if (!hasDims && wMin && !wAvg) agg = 'MIN';
      if (wAvgPeriod && !hasDims) agg = 'SUM';
      intent.metric = { type: 'agg', agg, column: mh.c.name, label: aggLabel(agg, mh.c.name), title: aggTitle(agg, mh.c.name) };
      span(mh.h, 'metric', `${aggTitle(agg, mh.c.name)}`);
      if (metricHits.length > 1) {
        intent.extraMetrics = metricHits.slice(1, 3).map((m) => {
          const a = wAvg || AVG_COL.test(m.c.name.toLowerCase()) ? 'AVG' : 'SUM';
          span(m.h, 'metric', aggTitle(a, m.c.name));
          return { type: 'agg', agg: a, column: m.c.name, label: aggLabel(a, m.c.name), title: aggTitle(a, m.c.name) };
        });
      }
    } else if (countEntityHit || wCount) {
      const id = vocab.idCols[0];
      intent.metric = id ? { type: 'agg', agg: 'COUNT_DISTINCT', column: id, label: 'registros', title: 'número de registros' } : { type: 'agg', agg: 'COUNT', column: null, label: 'registros', title: 'número de registros' };
      if (countEntityHit) span(countEntityHit, 'metric', 'contar registros');
    }
  }
  if (wAvgPeriod && intent.metric?.type === 'agg' && !intent.dims.length && !dimHits.length) {
    intent.extras.avgOfPeriod = wAvgPeriod;
    const mm = n.match(RE1('promedio\\s+(mensual|diario|semanal|anual|trimestral|por\\s+mes|por\\s+dia|por\\s+semana|al\\s+mes|al\\s+dia)|(mensual|diario|semanal|anual)\\s+promedio'));
    if (mm) spans.push({ start: mm.index, end: mm.index + mm[0].length, kind: 'modifier', label: `promedio por ${GRAIN_LABEL[wAvgPeriod]}` });
  }

  // Dimensiones de texto (máximo 2 en total)
  for (const d of dimHits) {
    if (intent.dims.length >= 2) break;
    if (filterCols.has(d.c.name) && !d.byWord) { span(d.h, 'filter', d.c.name); continue; }
    if (intent.dims.some((x) => x.column === d.c.name)) continue;
    if (d.bucket) intent.dims.push({ column: d.c.name, bucket: true });
    else intent.dims.push({ column: d.c.name });
    span(d.h, 'dimension', `por ${d.c.name}`);
  }

  // Detalle de registros: "muéstrame los pedidos devueltos de mayo", "últimos 10 pedidos"
  const latest = matches.find((m) => m.type === 'latest');
  if (latest || (wList && !intent.dims.length && !wCount && !(intent.metric && intent.metric.type !== 'agg') && !metricHits.length)) {
    intent.kind = 'detail';
    intent.metric = null;
    intent.limit = latest ? latest.limit : 100;
    if (latest) span(latest, 'modifier', `últimos ${latest.limit}`);
  }

  // Métrica por defecto
  if (intent.kind !== 'detail' && !intent.metric) {
    const rev = vocab.conceptCol.revenue;
    if (rev && !has('cuant')) {
      const agg = wAvg ? 'AVG' : 'SUM';
      intent.metric = { type: 'agg', agg, column: rev, label: aggLabel(agg, rev), title: aggTitle(agg, rev), implicit: true };
      notes.push(`No se mencionó una métrica: se usa ${aggTitle(agg, rev)}.`);
    } else {
      intent.metric = { type: 'agg', agg: 'COUNT', column: null, label: 'registros', title: 'número de registros', implicit: true };
      if (!wCount) notes.push('No se mencionó una métrica: se cuentan registros.');
    }
    if (!matches.length) intent.confidence = 0.2;
  }

  // Extras
  if (intent.kind === 'aggregate') {
    if (wShare && intent.dims.length && intent.metric.type === 'agg' && !intent.dims.some((d) => d.grain)) {
      intent.extras.pctTotal = true;
      const m = n.match(RE1('participacion|porcentaje\\s+del\\s+total|%\\s*del\\s+total|share|contribucion|proporcion\\s+del\\s+total|peso'));
      if (m) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'modifier', label: '% del total' });
    }
    const timeDim = intent.dims.find((d) => d.grain && !['dow', 'moy'].includes(d.grain));
    if (wGrowth && timeDim && intent.metric.type === 'agg' && !intent.compare) {
      intent.extras.growth = true;
      const m = n.match(RE1('crec[a-z]*|variacion|cambio|increment[a-z]*|aument[a-z]*|disminu[a-z]*|caida|cay[a-z]*'));
      if (m) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'modifier', label: 'variación vs periodo anterior' });
    }
    if (wCumul && timeDim) {
      intent.extras.cumulative = true;
      const m = n.match(RE1('acumulad[oa]s?|acumulativ[oa]|running'));
      if (m) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'modifier', label: 'acumulado' });
    }
    // Comparación de años sin dimensión → por mes del año
    if (intent.compare && !intent.dims.length) intent.dims.push({ column: dateCol, grain: 'moy' });
    // Crecimiento sin grano temporal ("¿cuánto crecieron las ventas en 2025?") → año contra año
    if (wGrowth && !intent.dims.length && !intent.compare && intent.metric.type === 'agg' && dateCol) {
      const y = intent.time?.from ? Number(intent.time.from.slice(0, 4)) : Number(String(refDate).slice(0, 4));
      const prevSameRange = intent.time?.from && intent.time?.to && intent.time.from.slice(0, 4) === intent.time.to.slice(0, 4);
      intent.compare = { years: [y - 1, y] };
      intent.time = { column: dateCol, from: `${y - 1}-01-01`, to: prevSameRange ? `${y}-12-31` : String(refDate), label: `${y - 1} vs ${y}` };
      intent.dims.push({ column: dateCol, grain: 'moy' });
      notes.push(`Para medir el crecimiento se compara ${y} contra ${y - 1}.`);
    }
  }

  // Orden y límite
  const limitHit = matches.find((m) => m.type === 'limit');
  if (limitHit && intent.kind !== 'detail') { intent.limit = limitHit.limit; span(limitHit, 'modifier', `top ${limitHit.limit}`); }
  if (intent.kind === 'aggregate' && intent.dims.length) {
    const time = intent.dims.find((d) => d.grain || d.bucket || d.numericDim);
    if (time) intent.order = 'time';
    else intent.order = wAsc ? 'asc' : 'desc';
    const superl = n.match(RE1('(?:mas|mayor|menos|menor|mejor|peor|lider|lidera)'));
    if (superl && !time) {
      spans.push({ start: superl.index, end: superl.index + superl[0].length, kind: 'modifier', label: wAsc ? 'orden ascendente' : 'orden descendente' });
      if (has('(?:cual|que|quien)\\s+(?:es\\s+)?(?:el|la)?\\s*[a-z]+\\s+(?:que\\s+)?(?:mas|menos|con\\s+(?:mas|menos|mayor|menor))|(?:cual|que|quien)\\s+[a-z]+\\s+(?:vende|genera|tiene|deja|aporta|produce)')) intent.focusTop = true;
    }
    if (!intent.limit && !time) {
      const dc = col(intent.dims[0].column);
      if (dc?.distinct > 25 && intent.dims.length === 1) { intent.limit = 20; notes.push(`Se muestran las 20 categorías principales de ${dc.name} (hay ${dc.distinct}).`); }
    }
  }
  if (intent.kind === 'detail') intent.order = 'recent';

  // Comparar contra el periodo anterior cuando la respuesta es un solo número con periodo
  if (intent.kind === 'aggregate' && !intent.dims.length && intent.time?.from && intent.time?.to && !intent.compare && !intent.extras.avgOfPeriod) {
    intent.extras.previousPeriod = previousRange(intent.time.from, intent.time.to);
  }

  // Confianza
  const understood = spans.reduce((s, x) => s + (x.end - x.start), 0);
  const meaningful = n.replace(/\s+/g, ' ').split(' ').filter((w) => w && !STOPWORDS.has(w) && !/^(que|cual|cuales|como|me|dime|muestra|muestrame|dame|quiero|ver|saber|por|favor|fue|fueron|tiene|tienen|hay|mas|menos|mayor|menor)$/.test(w)).join(' ').length;
  if (meaningful > 0) intent.confidence = Math.min(1, Math.max(intent.confidence === 0.2 ? 0.2 : 0.35, understood / Math.max(1, meaningful)));
  intent.spans = mergeSpans(spans);
  return intent;
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const s of sorted) if (!out.some((o) => overlaps(o, s))) out.push(s);
  return out;
}

function daysBetween(a, b) {
  if (!a || !b) return 9999;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function previousRange(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const last = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p2 = (x) => String(x).padStart(2, '0');
  // meses completos (mes, trimestre, semestre, año) → mismo número de meses antes
  if (fd === 1 && td === last(ty, tm)) {
    const months = (ty * 12 + tm) - (fy * 12 + fm) + 1;
    // periodos largos (más de un trimestre) se comparan con el mismo periodo del año anterior
    if (months > 3 && months < 12 && fy === ty) {
      return { from: `${fy - 1}-${p2(fm)}-01`, to: `${ty - 1}-${p2(tm)}-${p2(last(ty - 1, tm))}`, label: `el mismo periodo de ${fy - 1}` };
    }
    const s = fy * 12 + (fm - 1) - months; const e = fy * 12 + (fm - 1) - 1;
    const sy = Math.floor(s / 12); const sm = (s % 12) + 1; const ey = Math.floor(e / 12); const em = (e % 12) + 1;
    const pf = `${sy}-${p2(sm)}-01`; const pt = `${ey}-${p2(em)}-${p2(last(ey, em))}`;
    const label = months === 12 && sm === 1 ? `${sy}` : `${pf} a ${pt}`;
    return { from: pf, to: pt, label };
  }
  const a = Date.parse(from); const b = Date.parse(to);
  const len = b - a + 86400000;
  const pf = new Date(a - len).toISOString().slice(0, 10);
  const pt = new Date(a - 86400000).toISOString().slice(0, 10);
  return { from: pf, to: pt, label: `${pf} a ${pt}` };
}

export function aggLabel(agg, column) {
  const p = { SUM: 'total', AVG: 'promedio', COUNT: 'conteo', COUNT_DISTINCT: 'distintos', MAX: 'maximo', MIN: 'minimo', MEDIAN: 'mediana' }[agg];
  return column ? `${p}_${column}` : 'registros';
}
export function aggTitle(agg, column) {
  const p = { SUM: 'total de', AVG: 'promedio de', COUNT: 'número de', COUNT_DISTINCT: 'número de', MAX: 'máximo de', MIN: 'mínimo de', MEDIAN: 'mediana de' }[agg];
  return column ? `${p} ${column}` : 'número de registros';
}

// ---------------------------------------------------------------------------
// Construcción de SQL (DuckDB)
// ---------------------------------------------------------------------------
export const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const lit = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function metricSQL(m) {
  if (!m) return 'COUNT(*)';
  if (m.type === 'ratio') return `ROUND(100.0 * SUM(${q(m.num)}) / NULLIF(SUM(${q(m.den)}), 0), 2)`;
  if (m.type === 'share') {
    return m.weight
      ? `ROUND(100.0 * SUM(CASE WHEN ${q(m.column)} = ${lit(m.value)} THEN ${q(m.weight)} ELSE 0 END) / NULLIF(SUM(${q(m.weight)}), 0), 2)`
      : `ROUND(100.0 * AVG(CASE WHEN ${q(m.column)} = ${lit(m.value)} THEN 1 ELSE 0 END), 2)`;
  }
  const c = m.column ? q(m.column) : '*';
  switch (m.agg) {
    case 'SUM': return `SUM(${c})`;
    case 'AVG': return `ROUND(AVG(${c}), 2)`;
    case 'MEDIAN': return `MEDIAN(${c})`;
    case 'MAX': return `MAX(${c})`;
    case 'MIN': return `MIN(${c})`;
    case 'COUNT_DISTINCT': return `COUNT(DISTINCT ${c})`;
    default: return 'COUNT(*)';
  }
}

const DOW = "['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']";
const MOY = "['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']";

function dimSQL(d, schema, ctx) {
  const dc = `CAST(${q(d.column)} AS DATE)`;
  switch (d.grain) {
    case 'day': return { expr: dc, alias: 'dia', sort: 'dia' };
    case 'week': return { expr: `date_trunc('week', ${dc})`, alias: 'semana', sort: 'semana' };
    case 'month': return { expr: `strftime(date_trunc('month', ${dc}), '%Y-%m')`, alias: 'mes', sort: 'mes' };
    case 'quarter': return { expr: `CAST(year(${dc}) AS VARCHAR) || '-T' || CAST(quarter(${dc}) AS VARCHAR)`, alias: 'trimestre', sort: 'trimestre' };
    case 'year': return { expr: `year(${dc})`, alias: 'anio', sort: 'anio' };
    case 'dow': return { expr: `${DOW}[isodow(${dc})]`, alias: 'dia_semana', sort: `MIN(isodow(${dc}))`, sortIsExpr: true };
    case 'moy': return { expr: `${MOY}[month(${dc})]`, alias: 'mes', sort: `MIN(month(${dc}))`, sortIsExpr: true };
    default: break;
  }
  if (d.bucket) {
    const c = schema.columns.find((x) => x.name === d.column);
    const step = niceStep(((c?.max ?? 100) - (c?.min ?? 0)) / 12);
    ctx.bucketStep = step;
    return { expr: `FLOOR(${q(d.column)} / ${step}) * ${step}`, alias: `rango_${d.column}`, sort: `rango_${d.column}` };
  }
  return { expr: q(d.column), alias: d.column, sort: d.column, plain: true };
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function whereSQL(intent, { skipTime = false } = {}) {
  const parts = [];
  if (intent.time && !skipTime) {
    const c = `CAST(${q(intent.time.column)} AS DATE)`;
    if (intent.time.from && intent.time.to) parts.push(`${c} BETWEEN DATE ${lit(intent.time.from)} AND DATE ${lit(intent.time.to)}`);
    else if (intent.time.from) parts.push(`${c} >= DATE ${lit(intent.time.from)}`);
    else if (intent.time.to) parts.push(`${c} <= DATE ${lit(intent.time.to)}`);
  }
  for (const f of intent.filters) {
    const c = q(f.column);
    if (f.op === 'IN' || f.op === 'NOT IN') parts.push(`${c} ${f.op} (${f.value.map(lit).join(', ')})`);
    else if (f.op === 'BETWEEN') parts.push(`${c} BETWEEN ${lit(f.value)} AND ${lit(f.value2)}`);
    else parts.push(`${c} ${f.op} ${lit(f.value)}`);
  }
  return parts;
}

/** Construye el SQL de una intención. */
export function buildSQL(intent, schema) {
  const T = q(schema.table);
  const where = whereSQL(intent);
  const W = where.length ? `\nWHERE ${where.join('\n  AND ')}` : '';

  if (intent.kind === 'detail') {
    const order = intent.dateColumn ? `\nORDER BY ${q(intent.dateColumn)} DESC` : '';
    return `SELECT *\nFROM ${T}${W}${order}\nLIMIT ${intent.limit || 100}`;
  }

  const m = metricSQL(intent.metric);
  const mAlias = intent.metric?.label || 'valor';
  const extra = (intent.extraMetrics || []).map((x) => `,\n  ${metricSQL(x)} AS ${q(x.label)}`).join('');

  // Promedio de totales por periodo: "promedio mensual de ventas"
  if (intent.extras.avgOfPeriod) {
    const d = dimSQL({ column: intent.dateColumn, grain: intent.extras.avgOfPeriod }, schema, {});
    return `WITH por_periodo AS (\n  SELECT ${d.expr} AS periodo, ${m} AS valor\n  FROM ${T}${W.replace(/\n/g, '\n  ')}\n  GROUP BY 1\n)\nSELECT ROUND(AVG(valor), 2) AS ${q(`${mAlias}_promedio_${GRAIN_LABEL[intent.extras.avgOfPeriod].replace(/\s+/g, '_')}`)},\n  COUNT(*) AS periodos\nFROM por_periodo`;
  }

  // KPI sin dimensiones
  if (!intent.dims.length) {
    if (intent.extras.previousPeriod) {
      const prev = { ...intent, time: { ...intent.time, ...intent.extras.previousPeriod } };
      const pw = whereSQL(prev);
      return `SELECT\n  ${m} AS ${q(mAlias)}${extra},\n  (SELECT ${m} FROM ${T} WHERE ${pw.join(' AND ')}) AS periodo_anterior\nFROM ${T}${W}`;
    }
    return `SELECT ${m} AS ${q(mAlias)}${extra}\nFROM ${T}${W}`;
  }

  const ctx = {};
  const dims = intent.dims.map((d) => dimSQL(d, schema, ctx));

  // Comparación de años en columnas: "2024 vs 2025 por categoría"
  if (intent.compare) {
    const [y1, y2] = intent.compare.years;
    const dc = `CAST(${q(intent.dateColumn)} AS DATE)`;
    const base = intent.metric;
    const cond = (y) => `year(${dc}) = ${y}`;
    const caseMetric = (y) => {
      if (base.type === 'ratio') return `ROUND(100.0 * SUM(CASE WHEN ${cond(y)} THEN ${q(base.num)} END) / NULLIF(SUM(CASE WHEN ${cond(y)} THEN ${q(base.den)} END), 0), 2)`;
      if (base.type === 'share') return `ROUND(100.0 * AVG(CASE WHEN ${cond(y)} THEN (CASE WHEN ${q(base.column)} = ${lit(base.value)} THEN 1 ELSE 0 END) END), 2)`;
      const c = base.column ? q(base.column) : '1';
      if (base.agg === 'AVG') return `ROUND(AVG(CASE WHEN ${cond(y)} THEN ${c} END), 2)`;
      if (base.agg === 'COUNT_DISTINCT') return `COUNT(DISTINCT CASE WHEN ${cond(y)} THEN ${c} END)`;
      if (base.agg === 'COUNT') return `COUNT(CASE WHEN ${cond(y)} THEN 1 END)`;
      if (base.agg === 'MAX') return `MAX(CASE WHEN ${cond(y)} THEN ${c} END)`;
      if (base.agg === 'MIN') return `MIN(CASE WHEN ${cond(y)} THEN ${c} END)`;
      return `SUM(CASE WHEN ${cond(y)} THEN ${c} ELSE 0 END)`;
    };
    const d = dims[0];
    const orderBy = d.sortIsExpr ? d.sort : (intent.order === 'time' ? q(d.alias) : `${q(String(y2))} ${intent.order === 'asc' ? 'ASC' : 'DESC'}`);
    const lim = intent.limit ? `\nLIMIT ${intent.limit}` : '';
    return `SELECT\n  ${d.expr} AS ${q(d.alias)},\n  ${caseMetric(y1)} AS ${q(String(y1))},\n  ${caseMetric(y2)} AS ${q(String(y2))},\n  ROUND(100.0 * (${caseMetric(y2)} - ${caseMetric(y1)}) / NULLIF(${caseMetric(y1)}, 0), 1) AS variacion_pct\nFROM ${T}${W}\nGROUP BY 1\nORDER BY ${orderBy}${lim}`;
  }

  const select = dims.map((d) => `${d.expr} AS ${q(d.alias)}`).join(',\n  ');
  let where2 = where.slice();
  // dos dimensiones con una de alta cardinalidad: limitar a las 8 principales
  if (dims.length === 2) {
    const series = intent.dims.find((d) => !d.grain && !d.bucket);
    const other = intent.dims.find((d) => d !== series);
    const sc = series && schema.columns.find((c) => c.name === series.column);
    if (series && other && sc?.distinct > 8) {
      where2.push(`${q(series.column)} IN (\n    SELECT ${q(series.column)} FROM ${T}${where.length ? ' WHERE ' + where.join(' AND ') : ''}\n    GROUP BY 1 ORDER BY ${m} DESC LIMIT 8\n  )`);
    }
  }
  const W2 = where2.length ? `\nWHERE ${where2.join('\n  AND ')}` : '';
  const groupBy = dims.map((_, i) => i + 1).join(', ');

  let orderBy;
  const timeIdx = intent.dims.findIndex((d) => d.grain || d.bucket || d.numericDim);
  if (timeIdx >= 0) {
    const td = dims[timeIdx];
    orderBy = td.sortIsExpr ? td.sort : q(td.alias);
    if (dims.length === 2) orderBy += `, ${q(mAlias)} DESC`;
  } else orderBy = `${q(mAlias)} ${intent.order === 'asc' ? 'ASC' : 'DESC'}`;

  const lim = intent.limit ? `\nLIMIT ${intent.limit}` : '';
  let sql = `SELECT\n  ${select},\n  ${m} AS ${q(mAlias)}${extra}\nFROM ${T}${W2}\nGROUP BY ${groupBy}\nORDER BY ${orderBy}${lim}`;

  const windows = [];
  if (intent.extras.pctTotal) windows.push(`ROUND(100.0 * ${q(mAlias)} / SUM(${q(mAlias)}) OVER (), 2) AS pct_del_total`);
  if (intent.extras.growth && dims.length === 1) windows.push(`ROUND(100.0 * (${q(mAlias)} - LAG(${q(mAlias)}) OVER (ORDER BY ${q(dims[0].alias)})) / NULLIF(LAG(${q(mAlias)}) OVER (ORDER BY ${q(dims[0].alias)}), 0), 1) AS variacion_pct`);
  if (intent.extras.cumulative && dims.length === 1) windows.push(`SUM(${q(mAlias)}) OVER (ORDER BY ${q(dims[0].alias)}) AS acumulado`);
  if (windows.length) {
    // las ventanas se calculan sobre todos los grupos (antes del LIMIT)
    const inner = sql.replace(/\nLIMIT \d+$/, '');
    sql = `WITH base AS (\n${indent(inner)}\n)\nSELECT *,\n  ${windows.join(',\n  ')}\nFROM base\nORDER BY ${orderBy.replace(/MIN\(.*\)/, '1')}${lim}`;
  }
  return sql;
}

function indent(s) { return s.split('\n').map((l) => '  ' + l).join('\n'); }

// ---------------------------------------------------------------------------
// Explicación en lenguaje natural
// ---------------------------------------------------------------------------
const OP_TXT = { '=': 'es', '!=': 'no es', IN: 'es uno de', 'NOT IN': 'no es ninguno de', '>': 'mayor que', '<': 'menor que', '>=': 'al menos', '<=': 'como máximo', BETWEEN: 'entre' };

export function describeFilter(f) {
  const v = Array.isArray(f.value) ? f.value.join(', ') : f.value;
  if (f.op === 'BETWEEN') return `${f.column} entre ${f.value} y ${f.value2}`;
  return `${f.column} ${OP_TXT[f.op] || f.op} ${v}`;
}

export function metricTitle(m) {
  if (!m) return 'registros';
  if (m.type === 'ratio') return `margen (${m.num} ÷ ${m.den})`;
  if (m.type === 'share') return m.weight ? `participación de «${m.value}» en ${m.weight}` : `porcentaje de registros con ${m.column} «${m.value}»`;
  return m.title || aggTitle(m.agg, m.column);
}

export function dimTitle(d) {
  if (d.grain) return GRAIN_LABEL[d.grain];
  if (d.bucket) return `rangos de ${d.column}`;
  return d.column;
}

export function explain(intent) {
  if (intent.kind === 'detail') {
    const f = intent.filters.map(describeFilter);
    return `Muestro los ${intent.limit} registros más recientes${f.length ? ' donde ' + f.join(' y ') : ''}${intent.time ? ` en ${intent.time.label}` : ''}.`;
  }
  const parts = [];
  if (intent.extras.avgOfPeriod) parts.push(`Calculo el ${metricTitle(intent.metric)} de cada ${GRAIN_LABEL[intent.extras.avgOfPeriod]} y luego su promedio`);
  else parts.push(`Calculo ${metricTitle(intent.metric)}`);
  if (intent.dims.length) parts.push(`por ${intent.dims.map(dimTitle).join(' y ')}`);
  if (intent.compare) parts.push(`comparando ${intent.compare.years.join(' contra ')}`);
  else if (intent.time) parts.push(`en ${intent.time.label}`);
  if (intent.filters.length) parts.push(`solo donde ${intent.filters.map(describeFilter).join(' y ')}`);
  if (intent.extras.pctTotal) parts.push('con su participación en el total');
  if (intent.extras.growth) parts.push('con la variación frente al periodo anterior');
  if (intent.extras.cumulative) parts.push('con el acumulado');
  if (intent.extras.previousPeriod) parts.push(`y lo comparo con ${intent.extras.previousPeriod.label}`);
  if (intent.limit) parts.push(`mostrando ${intent.order === 'asc' ? 'los' : 'los'} ${intent.limit} ${intent.order === 'asc' ? 'más bajos' : 'principales'}`);
  return parts.join(', ') + '.';
}

/** Lista de columnas útiles para preguntas sugeridas y edición de la intención. */
export function schemaRoles(schema) {
  const vocab = buildVocabulary(schema);
  const cols = schema.columns.filter((c) => !vocab.idCols.includes(c.name));
  const metrics = cols.filter((c) => c.type === 'number');
  const dims = cols.filter((c) => c.type === 'text' && c.distinct && c.distinct <= 200 && c.distinct > 1);
  const date = vocab.dateCols[0] || null;
  return { metrics, dims, date, conceptCol: vocab.conceptCol, idCols: vocab.idCols };
}

export { MONTH_NAMES, GRAIN_LABEL, MONEY_COL };
