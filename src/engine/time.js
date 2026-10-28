// Detección de expresiones de tiempo en español. Las fechas relativas
// ("este año", "últimos 3 meses") se calculan contra la fecha más reciente
// de los datos, no contra el reloj: así la demo siempre tiene respuesta.

import { MONTHS, MONTH_NAMES, NUM_WORD_RE, parseNumber } from './text.js';

const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseISO(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function addMonths({ y, m }, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
const monthRange = (y, m) => ({ from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) });
const yearRange = (y) => ({ from: iso(y, 1, 1), to: iso(y, 12, 31) });
const quarterRange = (y, q) => ({ from: iso(y, q * 3 - 2, 1), to: iso(y, q * 3, lastDay(y, q * 3)) });

const MONTH_FULL = MONTHS.map((n) => [n[0], ...n.slice(3)]).flat().join('|'); // nombres completos
const MONTH_ANY = MONTHS.flat().join('|');
const ORD = { primer: 1, primero: 1, '1er': 1, '1': 1, segundo: 2, '2do': 2, '2': 2, tercer: 3, tercero: 3, '3er': 3, '3': 3, cuarto: 4, '4to': 4, '4': 4 };
const YEAR = '((?:19|20)\\d{2})';

function monthNum(word) {
  return MONTHS.findIndex((n) => n.includes(word)) + 1;
}

/** Año más reciente de los datos que contiene un mes dado. */
function latestYearFor(month, ref, minDate) {
  let y = ref.y;
  if (month > ref.m) y -= 1;
  if (minDate && iso(y, month, 1) < iso(minDate.y, minDate.m, 1)) y += 1;
  return y;
}

/**
 * Busca expresiones de tiempo. Devuelve coincidencias {start,end,range,label,kind}.
 * kind: 'range' | 'compare' (años contrastados).
 */
export function findTimeExpressions(n, refISO, minISO) {
  const ref = parseISO(refISO);
  const min = minISO ? parseISO(minISO) : null;
  const out = [];
  const push = (m, range, label, extra = {}) => out.push({ start: m.index, end: m.index + m[0].length, range, label, ...extra });
  const each = (re, fn) => { for (const m of n.matchAll(re)) fn(m); };
  const b = (s) => new RegExp(`(?<![a-z0-9])(?:${s})(?![a-z0-9])`, 'g');

  // Comparación de años: "2024 vs 2025", "2025 frente a 2024", "comparar 2024 con 2025"
  each(b(`${YEAR}\\s+(?:vs|versus|contra|frente\\s+a|comparado\\s+con|y|con)\\s+${YEAR}`), (m) => {
    const ctx = n.slice(Math.max(0, m.index - 40), m.index);
    const explicit = /vs|versus|contra|frente|comparado/.test(m[0]) || /compar/.test(ctx);
    if (!explicit || /entre\s*$/.test(ctx)) return;
    const years = [Number(m[1]), Number(m[2])].sort();
    push(m, { from: iso(years[0], 1, 1), to: iso(years[1], 12, 31) }, `${years[0]} vs ${years[1]}`, { kind: 'compare', years });
  });
  // "este año vs el año pasado" / "año pasado vs este año"
  each(b('(?:este\\s+ano|ano\\s+actual)\\s+(?:vs|versus|contra|frente\\s+a|comparado\\s+con)\\s+(?:el\\s+)?(?:ano\\s+pasado|ano\\s+anterior)|(?:el\\s+)?(?:ano\\s+pasado|ano\\s+anterior)\\s+(?:vs|versus|contra|frente\\s+a)\\s+(?:este\\s+ano|ano\\s+actual)'), (m) => {
    const years = [ref.y - 1, ref.y];
    push(m, { from: iso(years[0], 1, 1), to: refISO }, `${years[0]} vs ${years[1]}`, { kind: 'compare', years });
  });

  // Rango "entre <mes>? <año>? y <mes>? <año>"
  each(b(`entre\\s+(?:(${MONTH_FULL})\\s+(?:de(?:l)?\\s+)?)?${YEAR}?\\s*(?:y|a|hasta)\\s+(?:(${MONTH_FULL})\\s+(?:de(?:l)?\\s+)?)?${YEAR}`), (m) => {
    const [, m1, y1, m2, y2] = m;
    if (!m1 && !y1) return;
    const ya = y1 ? Number(y1) : Number(y2);
    const yb = Number(y2);
    const from = m1 ? iso(ya, monthNum(m1), 1) : iso(ya, 1, 1);
    const to = m2 ? monthRange(yb, monthNum(m2)).to : iso(yb, 12, 31);
    push(m, { from, to }, `${from} a ${to}`);
  });
  // "entre enero y marzo (de 2025)"
  each(b(`entre\\s+(${MONTH_FULL})\\s+y\\s+(${MONTH_FULL})(?:\\s+(?:de(?:l)?\\s+)?${YEAR})?`), (m) => {
    const a = monthNum(m[1]); const z = monthNum(m[2]);
    const y = m[3] ? Number(m[3]) : latestYearFor(z, ref, min);
    push(m, { from: iso(y, a, 1), to: monthRange(y, z).to }, `${MONTH_NAMES[a - 1]} a ${MONTH_NAMES[z - 1]} de ${y}`);
  });

  // "desde/a partir de <mes>? <año>" y "hasta/antes de <mes>? <año>"
  each(b(`(desde|a\\s+partir\\s+de(?:l)?|hasta|antes\\s+de(?:l)?)\\s+(?:(?:el\\s+)?(?:mes\\s+de\\s+)?(${MONTH_ANY})\\s*(?:de(?:l)?\\s+)?)?${YEAR}?`), (m) => {
    const [, word, mon, yr] = m;
    if (!mon && !yr) return;
    const mi = mon ? monthNum(mon) : 0;
    const y = yr ? Number(yr) : latestYearFor(mi, ref, min);
    const start = /desde|partir/.test(word);
    let range;
    if (start) range = { from: mi ? iso(y, mi, 1) : iso(y, 1, 1), to: null };
    else if (/antes/.test(word)) range = { from: null, to: mi ? iso(...Object.values(addDays({ y, m: mi, d: 1 }, -1))) : iso(y - 1, 12, 31) };
    else range = { from: null, to: mi ? monthRange(y, mi).to : iso(y, 12, 31) };
    push(m, range, `${word.replace(/\s+/g, ' ')} ${mon ? MONTH_NAMES[mi - 1] + ' ' : ''}${y}`, { open: true });
  });

  // Trimestres: "primer trimestre de 2025", "Q3 2025", "T2", "último trimestre"
  each(b(`(primer|primero|1er|segundo|2do|tercer|tercero|3er|cuarto|4to|[1-4])\\s*trimestre(?:\\s+(?:de(?:l)?\\s+)?${YEAR})?`), (m) => {
    const q = ORD[m[1]];
    const y = m[2] ? Number(m[2]) : (q * 3 - 2 > ref.m ? ref.y - 1 : ref.y);
    push(m, quarterRange(y, q), `T${q} ${y}`);
  });
  each(b(`(?:q|t)([1-4])(?:\\s+(?:de(?:l)?\\s+)?${YEAR})?`), (m) => {
    const q = Number(m[1]);
    const y = m[2] ? Number(m[2]) : (q * 3 - 2 > ref.m ? ref.y - 1 : ref.y);
    push(m, quarterRange(y, q), `T${q} ${y}`);
  });
  // Semestres
  each(b(`(primer|segundo|1er|2do)\\s+semestre(?:\\s+(?:de(?:l)?\\s+)?${YEAR})?`), (m) => {
    const s = /primer|1er/.test(m[1]) ? 1 : 2;
    const y = m[2] ? Number(m[2]) : (s === 2 && ref.m < 7 ? ref.y - 1 : ref.y);
    push(m, s === 1 ? { from: iso(y, 1, 1), to: iso(y, 6, 30) } : { from: iso(y, 7, 1), to: iso(y, 12, 31) }, `S${s} ${y}`);
  });

  // Mes + año: "marzo de 2026", "mar 2026", "marzo del 2025"
  each(b(`(${MONTH_ANY})\\s*(?:de(?:l)?\\s+|-|\\s)?${YEAR}`), (m) => {
    const mi = monthNum(m[1]); const y = Number(m[2]);
    push(m, monthRange(y, mi), `${MONTH_NAMES[mi - 1]} ${y}`);
  });
  // Mes suelto (solo nombres completos): "en marzo"
  each(b(`(?:en\\s+|de\\s+|durante\\s+)?(?:el\\s+mes\\s+de\\s+)?(${MONTH_FULL})`), (m) => {
    const mi = monthNum(m[1]); const y = latestYearFor(mi, ref, min);
    push(m, monthRange(y, mi), `${MONTH_NAMES[mi - 1]} ${y}`);
  });

  // Años: "en 2025", "del año 2024", "2025"
  each(b(`(?:(?:en|de(?:l)?|durante)\\s+(?:el\\s+)?)?(?:ano\\s+)?${YEAR}`), (m) => {
    const y = Number(m[1]);
    push(m, yearRange(y), String(y));
  });

  // Relativos: "últimos 3 meses", "últimas 2 semanas", "últimos 90 días"
  each(b(`(?:en\\s+)?(?:los|las)?\\s*ultim[oa]s\\s+(\\d+|${NUM_WORD_RE})\\s+(dias|semanas|meses|anos|trimestres)`), (m) => {
    const k = parseNumber(m[1]); const unit = m[2];
    let from;
    if (unit === 'dias') from = addDays(ref, -(k - 1));
    else if (unit === 'semanas') from = addDays(ref, -(7 * k - 1));
    else {
      const months = unit === 'meses' ? k : unit === 'trimestres' ? 3 * k : 12 * k;
      const s = addMonths(ref, -(months - 1)); from = { ...s, d: 1 };
    }
    push(m, { from: iso(from.y, from.m, from.d), to: refISO }, `últimos ${k} ${unit.replace('anos', 'años').replace('dias', 'días')}`);
  });
  const rel = [
    ['(?:en\\s+)?(?:este|el)\\s+ano(?:\\s+actual)?|ano\\s+actual|en\\s+lo\\s+que\\s+va\\s+del\\s+ano|ytd|year\\s+to\\s+date', () => ({ from: iso(ref.y, 1, 1), to: refISO }), `${ref.y} (hasta ${refISO})`],
    ['(?:el\\s+)?ano\\s+(?:pasado|anterior)', () => yearRange(ref.y - 1), String(ref.y - 1)],
    ['(?:el\\s+)?ultimo\\s+ano|ultimos\\s+12\\s+meses', () => { const s = addMonths(ref, -11); return { from: iso(s.y, s.m, 1), to: refISO }; }, 'últimos 12 meses'],
    ['(?:en\\s+)?(?:este|el)\\s+mes(?:\\s+actual)?|mes\\s+actual|(?:el\\s+)?ultimo\\s+mes', () => monthRange(ref.y, ref.m), `${MONTH_NAMES[ref.m - 1]} ${ref.y}`],
    ['(?:el\\s+)?mes\\s+(?:pasado|anterior)', () => { const p = addMonths(ref, -1); return monthRange(p.y, p.m); }, (() => { const p = addMonths(ref, -1); return `${MONTH_NAMES[p.m - 1]} ${p.y}`; })()],
    ['(?:en\\s+)?(?:este|el)\\s+trimestre(?:\\s+actual)?|(?:el\\s+)?ultimo\\s+trimestre', () => quarterRange(ref.y, Math.ceil(ref.m / 3)), `T${Math.ceil(ref.m / 3)} ${ref.y}`],
    ['(?:el\\s+)?trimestre\\s+(?:pasado|anterior)', () => { const p = addMonths(ref, -3); return quarterRange(p.y, Math.ceil(p.m / 3)); }, (() => { const p = addMonths(ref, -3); return `T${Math.ceil(p.m / 3)} ${p.y}`; })()],
    ['(?:la\\s+)?ultima\\s+semana|(?:esta|la)\\s+semana', () => ({ from: iso(...Object.values(addDays(ref, -6))), to: refISO }), 'últimos 7 días'],
  ];
  for (const [re, fn, label] of rel) each(b(re), (m) => push(m, fn(), label));

  return out;
}

/** Granularidad temporal: "por mes", "mensual", "tendencia", "por día de la semana". */
export function findGrains(n) {
  const out = [];
  const defs = [
    ['dow', '(?:por|segun|cada)\\s+(?:el\\s+)?dias?\\s+de\\s+(?:la\\s+)?semana|dia\\s+de\\s+la\\s+semana'],
    ['moy', '(?:por|segun)\\s+mes\\s+del\\s+ano|estacionalidad|estacional'],
    ['day', '(?:por|cada)\\s+dias?|diari[oa]s?|diariamente|dia\\s+a\\s+dia|por\\s+fecha'],
    ['week', '(?:por|cada)\\s+semanas?|semanal(?:es|mente)?|semana\\s+a\\s+semana'],
    ['month', '(?:por|cada)\\s+mes(?:es)?|mensual(?:es|mente)?|mes\\s+a\\s+mes'],
    ['quarter', '(?:por|cada)\\s+trimestres?|trimestral(?:es|mente)?|trimestre\\s+a\\s+trimestre'],
    ['year', '(?:por|cada)\\s+anos?|anual(?:es|mente)?|ano\\s+a\\s+ano|interanual'],
    ['trend', 'tendencia|evolucion|historico|historia|a\\s+lo\\s+largo\\s+del\\s+tiempo|en\\s+el\\s+tiempo|comportamiento|serie\\s+de\\s+tiempo|como\\s+ha\\s+(?:evolucionado|cambiado|crecido)'],
  ];
  for (const [grain, re] of defs) {
    for (const m of n.matchAll(new RegExp(`(?<![a-z0-9])(?:${re})(?![a-z0-9])`, 'g'))) {
      out.push({ start: m.index, end: m.index + m[0].length, grain });
    }
  }
  return out;
}
