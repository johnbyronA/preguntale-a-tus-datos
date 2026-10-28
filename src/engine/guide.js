// Guía de preguntas: cada patrón que entiende el motor, con sus palabras
// clave y un ejemplo armado con las columnas y valores de la tabla cargada.
import { schemaRoles, buildVocabulary } from './nl2sql.js';
import { phrase, pluralize } from './text.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Elige las columnas "protagonistas" de la tabla para armar ejemplos. */
export function pickRoles(schema) {
  const r = schemaRoles(schema);
  const vocab = buildVocabulary(schema);
  const money = r.metrics.find((m) => m.name === r.conceptCol.revenue)
    || r.metrics.find((m) => /ingreso|venta|monto|valor|total|importe|costo|gasto|precio/.test(m.name.toLowerCase()))
    || r.metrics[0] || null;
  const avgLike = r.metrics.find((m) => m !== money && /calific|rating|dias|precio|descuento|edad|tiempo|score|pct/.test(m.name.toLowerCase()))
    || r.metrics.find((m) => m !== money) || null;
  const dims = [...r.dims].sort((a, b) => a.distinct - b.distinct);
  // d1: pocas categorías (ideal para comparar); d2: más categorías (ideal para rankings)
  const isStatus = (d) => /estado|status|situacion|condicion/.test(d.name.toLowerCase());
  const d1 = dims.find((d) => d.distinct >= 4 && d.distinct <= 12 && !isStatus(d)) || dims.find((d) => d.distinct >= 3 && !isStatus(d)) || dims[0] || null;
  const d2 = [...dims].reverse().find((d) => d !== d1 && d.distinct >= 4 && !isStatus(d)) || dims.find((d) => d !== d1) || null;
  // columna para tasas: la de estados si existe; si no, la de pocas categorías
  const ds = dims.find((d) => isStatus(d) && d.distinct >= 2) || d1;
  const valueOf = (d, i = 0) => (d?.values?.length ? d.values[Math.min(i, d.values.length - 1)] : null);
  const date = r.date;
  const years = date ? range(Number(String(date.min).slice(0, 4)), Number(String(date.max).slice(0, 4))) : [];
  return { r, vocab, money, avgLike, d1, d2, ds, vs: valueOf(ds, 1), v1: valueOf(d1, 0), v1b: valueOf(d1, 1), v2: valueOf(d2, 0), date, years };
}

function range(a, b) { const o = []; for (let y = a; y <= b; y++) o.push(y); return o; }

function niceThreshold(col) {
  const mid = (Number(col.min) + Number(col.max)) / 4;
  if (!(mid > 0)) return null;
  const p = 10 ** Math.floor(Math.log10(mid));
  return Math.max(1, Math.round(mid / p) * p);
}

/**
 * Devuelve grupos de patrones: [{ group, items: [{ title, words, example, explain }] }].
 * Los ejemplos que no aplican a la tabla (por ejemplo, sin fechas) se omiten.
 */
export function buildGuide(schema) {
  const { r, money, avgLike, d1, d2, ds, vs, v1, v1b, v2, date, years } = pickRoles(schema);
  const m = money ? phrase(money.name) : null;
  const M = cap(m);
  const a = avgLike ? phrase(avgLike.name) : null;
  const D1 = d1 ? phrase(d1.name) : null;
  const D2 = d2 ? phrase(d2.name) : null;
  const lastYear = years[years.length - 1];
  const fullYear = years.length > 1 ? years[years.length - 2] : lastYear;
  const g = [];
  const add = (group, title, words, example, explain) => {
    if (!example) return;
    let grp = g.find((x) => x.group === group);
    if (!grp) { grp = { group, items: [] }; g.push(grp); }
    grp.items.push({ title, words, example, explain });
  };

  // Qué medir
  add('Qué medir', 'Total', ['total', 'suma', 'cuánto'], m && `¿Cuál es el total de ${m}?`, 'Suma una columna numérica.');
  add('Qué medir', 'Promedio, mediana, máximo, mínimo', ['promedio', 'mediana', 'máximo', 'mínimo'], (a || m) && (D1 ? `Promedio de ${a || m} por ${D1}` : `Promedio de ${a || m}`), 'Cambia la forma de resumir la columna.');
  add('Qué medir', 'Contar registros', ['cuántos', 'número de', 'registros'], D1 ? `¿Cuántos registros hay por ${D1}?` : '¿Cuántos registros hay?', 'Cuenta filas.');
  add('Qué medir', 'Contar valores distintos', ['cuántos … distintos', 'cuántos … hay'], d2 && D1 ? `¿Cuántos ${pluralize(D2)} distintos hay por ${D1}?` : null, 'Cuenta valores únicos de una columna de texto.');
  add('Qué medir', 'Promedio por periodo', ['promedio mensual', 'promedio diario', 'promedio por semana'], m && date && `Promedio mensual de ${m}`, 'Suma cada periodo y promedia esos totales.');
  if (r.conceptCol.profit && r.conceptCol.revenue) add('Qué medir', 'Margen', ['margen', 'rentabilidad'], D1 && `Margen por ${D1}`, `Calcula ${r.conceptCol.profit} ÷ ${r.conceptCol.revenue} en porcentaje.`);
  add('Qué medir', 'Tasa de un valor', ['tasa de', 'porcentaje de', '% de'], vs && D1 && `Porcentaje de ${vs} por ${ds === d1 ? D2 || D1 : D1}`, `Qué porcentaje de los registros tiene ese valor en ${ds?.name}.`);

  // Cómo agrupar
  add('Cómo agrupar', 'Por una columna', ['por', 'por cada', 'de cada', 'según'], m && D1 && `${M} por ${D1}`, 'Agrupa y ordena de mayor a menor.');
  add('Cómo agrupar', 'Por dos columnas', ['por … y …'], m && D1 && (date ? `${M} por mes y ${D1}` : D2 && `${M} por ${D1} y ${D2}`), 'Cruza dos agrupaciones: líneas por serie o mapa de calor.');
  add('Cómo agrupar', 'Top y orden', ['top 5', 'los 3', 'más', 'menos', 'mayor', 'menor'], m && D2 && `Top 5 ${pluralize(D2)} por ${m}`, 'Limita y ordena el ranking. «menos» o «menor» invierte el orden.');
  add('Cómo agrupar', 'Participación en el total', ['participación', '% del total', 'contribución'], m && D1 && `Participación de cada ${D1} en ${m}`, 'Agrega el porcentaje que aporta cada grupo.');
  add('Cómo agrupar', 'Distribución', ['distribución de', 'histograma'], (a || m) && `Distribución de ${a || m}`, 'Agrupa una columna numérica en rangos.');

  // Qué filtrar
  add('Qué filtrar', 'Por un valor', ['escribe el valor tal como aparece'], m && v2 && D1 && `${M} de ${v2} por ${D1}`, 'Cualquier valor real de una columna de texto funciona como filtro.');
  add('Qué filtrar', 'Varios valores', ['… y …'], m && v1 && v1b && v1 !== v1b && `${M} de ${v1} y ${v1b}${date ? ' por mes' : ''}`, 'Dos o más valores de la misma columna.');
  add('Qué filtrar', 'Excluir', ['excepto', 'sin', 'menos', 'que no sea'], m && D1 && v1 && `${M} por ${D1} excepto ${v1}`, 'Quita uno o varios valores.');
  const numCol = avgLike || money;
  const thr = numCol ? niceThreshold(numCol) : null;
  if (numCol && thr && D1) add('Qué filtrar', 'Condición numérica', ['mayor a', 'más de', 'menor a', 'al menos', 'entre … y …'], `¿Cuántos registros hay por ${D1} con ${phrase(numCol.name)} mayor a ${thr.toLocaleString('es-CO')}?`, 'Compara una columna numérica con un número.');

  // Cuándo
  if (date) {
    add('Cuándo', 'Año, mes, trimestre o semestre', ['en 2025', 'en marzo de 2026', 'T3 2025', 'primer semestre'], m && `${M} del primer semestre de ${fullYear}`, `Usa la columna ${date.name}.`);
    add('Cuándo', 'Rangos', ['entre enero y marzo', 'desde marzo de 2025', 'hasta junio'], m && `${M} entre enero y marzo de ${lastYear}`, 'Fechas de inicio y fin.');
    add('Cuándo', 'Fechas relativas', ['este año', 'el año pasado', 'último mes', 'últimos 3 meses', 'últimos 30 días'], m && D1 && `${M} de los últimos 3 meses por ${D1}`, `Se calculan contra la última fecha de los datos (${date.max}).`);
    add('Cuándo', 'Tendencia en el tiempo', ['por mes', 'mensual', 'por semana', 'por año', 'evolución', 'tendencia'], m && `Evolución mensual de ${m}`, 'Serie de tiempo con tendencia y valores atípicos.');
    add('Cuándo', 'Día de la semana', ['por día de la semana'], m && `${M} por día de la semana`, 'Agrupa de lunes a domingo.');
    if (years.length > 1) add('Cuándo', 'Comparar años', [`${fullYear - 1 >= years[0] ? fullYear - 1 : years[0]} vs ${fullYear}`, 'este año vs el año pasado', 'cuánto creció'], m && D1 && `Compara ${m} de ${years[years.length - 2]} vs ${lastYear} por ${D1}`, 'Pone los dos años lado a lado con la variación.');
    add('Cuándo', 'Variación y acumulado', ['crecimiento', 'variación', 'acumulado'], m && `${M} acumulado por mes en ${lastYear}`, 'Agrega la variación contra el periodo anterior o el acumulado.');
  }

  // Ver registros
  add('Ver registros', 'Últimos registros', ['muéstrame los últimos 10 registros'], v1 ? `Muéstrame los últimos 10 registros de ${v1}` : 'Muéstrame los últimos 10 registros', 'Lista filas completas, de la más reciente a la más antigua.');
  return g;
}

/** Lo que el motor local todavía no entiende (se muestra al final de la guía). */
export const NOT_SUPPORTED = [
  'Preguntas de causa, como «¿por qué bajó…?». Agrupa por mes y desglosa con un clic para investigar.',
  'Varias condiciones encadenadas sobre distintos registros, como «quienes compraron A pero no B».',
  'Cruzar dos tablas: el motor trabaja sobre una tabla a la vez.',
  'Pronósticos o «qué pasaría si».',
  'Cálculos entre columnas cualesquiera (salvo el margen). Para eso, edita el SQL o usa el modo Claude.',
];
