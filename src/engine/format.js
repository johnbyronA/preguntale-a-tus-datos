// Formato de números (es-CO) y redacción de la respuesta principal.
import { MONEY_COL, metricTitle, dimTitle } from './nl2sql.js';

const nf = (max = 0, min = 0) => { const f = new Intl.NumberFormat('es-CO', { maximumFractionDigits: max, minimumFractionDigits: min }); return (v) => f.format(v); };

export function isMoneyName(name) {
  const s = String(name || '').toLowerCase();
  if (/pct|porcentaje|tasa|margen|variacion/.test(s)) return false;
  return MONEY_COL.test(s) || /ticket/.test(s);
}
export function isPctName(name) { return /pct|porcentaje|tasa|margen|variacion|participacion/.test(String(name || '').toLowerCase()); }

/** Formato largo para textos: "$12.778 millones", "4,2 %", "1.234". */
export function fmt(v, name, { short = false } = {}) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);
  if (isPctName(name)) return `${nf(1)(v)} %`;
  const money = isMoneyName(name);
  const a = Math.abs(v);
  if (money) {
    if (a >= 1e12) return `$${nf(2)(v / 1e12)} ${short ? 'B' : 'billones'}`;
    if (a >= 1e6) return `$${nf(a >= 1e8 ? 0 : 1)(v / 1e6)} ${short ? 'M' : 'millones'}`;
    if (short && a >= 1e3) return `$${nf(0)(v / 1e3)} mil`;
    return `$${nf(0)(v)}`;
  }
  if (short) {
    if (a >= 1e9) return `${nf(1)(v / 1e9)} mil M`;
    if (a >= 1e6) return `${nf(1)(v / 1e6)} M`;
    if (a >= 1e4) return `${nf(0)(v / 1e3)} mil`;
  }
  return Number.isInteger(v) ? nf(0)(v) : nf(2)(v);
}

/** Formato exacto para tablas. */
export function fmtCell(v, name) {
  if (v == null) return '—';
  if (typeof v !== 'number') return String(v);
  if (isPctName(name)) return `${nf(2)(v)} %`;
  if (isMoneyName(name)) return `$${nf(0)(v)}`;
  return Number.isInteger(v) ? nf(0)(v) : nf(2)(v);
}

export const pct = (v) => `${v > 0 ? '+' : ''}${nf(1)(v)} %`;

const ART = (word) => (/(?:a|ion|dad|ud)$/.test(word) ? 'la' : 'el');

/**
 * Redacta la respuesta principal a partir de la intención y las filas.
 * Devuelve { text, delta? } donde text es una frase corta.
 */
export function headline(intent, result) {
  const { rows, columns } = result;
  if (!rows.length) return { text: 'No hay registros que cumplan esas condiciones.' };
  if (!intent) return { text: `${rows.length.toLocaleString('es-CO')} ${rows.length === 1 ? 'fila' : 'filas'} de resultado.` };
  if (intent.kind === 'detail') return { text: `${rows.length.toLocaleString('es-CO')} registros, del más reciente al más antiguo.` };

  const mName = columns.find((c) => c === intent.metric?.label) || columns[columns.length - 1];
  const mTitle = metricTitle(intent.metric);
  const period = intent.time && !intent.compare ? ` en ${intent.time.label}` : '';

  if (intent.extras.avgOfPeriod) {
    const v = rows[0][columns[0]]; const k = rows[0].periodos;
    return { text: `En promedio, ${fmt(v, intent.metric.column)} por ${dimTitle({ grain: intent.extras.avgOfPeriod })}${period} (${k} periodos).` };
  }

  if (!intent.dims.length) {
    const v = rows[0][mName];
    const out = { text: `${cap(mTitle)}${period}: ${fmt(v, mName)}.` };
    if (rows[0].periodo_anterior != null && intent.extras.previousPeriod) {
      const p = rows[0].periodo_anterior;
      if (p) out.delta = { value: 100 * (v - p) / Math.abs(p), against: intent.extras.previousPeriod.label, prev: fmt(p, mName) };
    }
    return out;
  }

  if (intent.compare) {
    const [y1, y2] = intent.compare.years.map(String);
    const isAdditive = intent.metric.type === 'agg' && ['SUM', 'COUNT', 'COUNT_DISTINCT'].includes(intent.metric.agg);
    const dim = columns[0];
    const best = [...rows].filter((r) => r.variacion_pct != null).sort((a, b) => b.variacion_pct - a.variacion_pct)[0];
    if (isAdditive) {
      const t1 = rows.reduce((s, r) => s + (r[y1] || 0), 0); const t2 = rows.reduce((s, r) => s + (r[y2] || 0), 0);
      const d = t1 ? 100 * (t2 - t1) / t1 : null;
      const more = d == null ? '' : d >= 0 ? `crece ${pct(d)}` : `cae ${pct(d)}`;
      const tail = best && !['mes', 'dia_semana'].includes(dim) ? ` ${best[dim]} es ${ART(dim)} que más cambia (${pct(best.variacion_pct)}).` : '';
      return { text: `${cap(mTitle)} ${more} de ${y1} a ${y2}: ${fmt(t1, intent.metric.column || mName)} → ${fmt(t2, intent.metric.column || mName)}.${tail}`, delta: d != null ? { value: d, against: y1 } : null };
    }
    return { text: `Comparación de ${mTitle} entre ${y1} y ${y2}.${best ? ` Mayor cambio: ${best[dim]} (${pct(best.variacion_pct)}).` : ''}` };
  }

  const d0 = intent.dims[0];
  const xName = columns[0];
  if (intent.dims.length === 1 && (d0.grain || d0.bucket || d0.numericDim)) {
    if (['dow', 'moy'].includes(d0.grain) || d0.bucket || d0.numericDim) {
      const top = [...rows].sort((a, b) => b[mName] - a[mName])[0];
      return { text: `El valor más alto de ${mTitle} está en ${labelX(top[xName], d0)}: ${fmt(top[mName], mName)}.` };
    }
    const first = rows[0]; const last = rows[rows.length - 1];
    const peak = [...rows].sort((a, b) => b[mName] - a[mName])[0];
    let ch = '';
    if (isPctName(mName)) ch = `, ${last[mName] - first[mName] >= 0 ? '+' : ''}${nf(1)(last[mName] - first[mName])} puntos`;
    else if (first[mName]) ch = `, ${pct(100 * (last[mName] - first[mName]) / Math.abs(first[mName]))}`;
    return { text: `${cap(mTitle)} pasó de ${fmt(first[mName], mName)} (${first[xName]}) a ${fmt(last[mName], mName)} (${last[xName]})${ch}. El pico fue ${peak[xName]}.` };
  }

  if (intent.dims.length === 1) {
    const sorted = rows;
    const top = sorted[0];
    const total = rows.reduce((s, r) => s + (r[mName] || 0), 0);
    const additive = intent.metric.type === 'agg' && ['SUM', 'COUNT', 'COUNT_DISTINCT'].includes(intent.metric.agg) && !intent.limit;
    const share = additive && total ? ` (${nf(1)(100 * top[mName] / total)} % del total)` : '';
    if (intent.order === 'asc') return { text: `${top[xName]} tiene ${ART(xName)} ${mTitle} más bajo: ${fmt(top[mName], mName)}.` };
    const lead = sorted.length > 1 ? `, seguido de ${sorted[1][xName]} con ${fmt(sorted[1][mName], mName)}` : '';
    return { text: `${top[xName]} lidera en ${mTitle} con ${fmt(top[mName], mName)}${share}${lead}.` };
  }

  // dos dimensiones
  const series = columns[1];
  const agg = {};
  for (const r of rows) agg[r[series]] = (agg[r[series]] || 0) + (r[mName] || 0);
  const lead = Object.entries(agg).sort((a, b) => b[1] - a[1])[0];
  return { text: `${cap(mTitle)} por ${dimTitle(intent.dims[0])} y ${dimTitle(intent.dims[1])}. ${lead ? `${lead[0]} aporta más en el periodo.` : ''}` };
}

function labelX(v, d) {
  if (d.bucket) return `el rango ${fmt(v, d.column)}+`;
  if (d.numericDim) return `${d.column} = ${v}`;
  return v;
}

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
