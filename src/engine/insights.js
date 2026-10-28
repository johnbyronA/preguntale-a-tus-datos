// Hallazgos automáticos sobre el resultado de una consulta: concentración
// (Pareto), brechas, tendencia lineal, estacionalidad y valores atípicos.
// Trabaja sobre la forma del resultado, así que sirve también para el SQL
// generado por Claude o escrito a mano.

import { fmt, pct } from './format.js';

const nf1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

function linreg(ys) {
  const n = ys.length; const xs = ys.map((_, i) => i);
  const mx = (n - 1) / 2; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const fit = xs.map((x) => my + slope * (x - mx));
  const ssRes = ys.reduce((s, y, i) => s + (y - fit[i]) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  return { slope, mean: my, fit, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

/**
 * @param {{columns:string[], rows:object[]}} result
 * @param {{x?:string, series?:string, y?:string, kind?:'time'|'category', additive?:boolean, label?:string}} shape
 */
export function findInsights(result, shape) {
  const out = [];
  const { rows } = result;
  if (!shape?.x || !shape?.y || rows.length < 2) return out;
  const { x, y, series } = shape;
  const name = shape.label || y;

  if (series) {
    // dos dimensiones: qué serie crece más entre el primer y el último periodo
    if (shape.kind === 'time') {
      const bySeries = {};
      for (const r of rows) (bySeries[r[series]] ||= []).push(r);
      const ch = Object.entries(bySeries).map(([k, rs]) => {
        const a = rs[0][y]; const b = rs[rs.length - 1][y];
        return { k, d: a ? 100 * (b - a) / Math.abs(a) : null, n: rs.length };
      }).filter((c) => c.d != null && c.n > 2).sort((a, b) => b.d - a.d);
      if (ch.length > 1) {
        out.push({ kind: 'trend', text: `${ch[0].k} es la serie que más crece entre el primer y el último periodo (${pct(ch[0].d)}); ${ch[ch.length - 1].k} la que menos (${pct(ch[ch.length - 1].d)}).` });
      }
    } else {
      const top = [...rows].sort((a, b) => b[y] - a[y])[0];
      out.push({ kind: 'peak', text: `La combinación más alta es ${top[x]} · ${top[series]} con ${fmt(top[y], name)}.`, focus: top[x] });
    }
    return out;
  }

  const vals = rows.map((r) => Number(r[y])).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return out;

  if (shape.kind === 'time' && rows.length >= 4) {
    const reg = linreg(vals);
    const perPeriod = reg.mean ? (100 * reg.slope) / Math.abs(reg.mean) : 0;
    if (reg.r2 > 0.25 && Math.abs(perPeriod) > 0.3) {
      out.push({ kind: 'trend', text: `Tendencia ${perPeriod > 0 ? 'al alza' : 'a la baja'}: en promedio ${perPeriod > 0 ? '+' : ''}${nf1.format(perPeriod)} % por periodo (ajuste lineal, R² ${nf1.format(reg.r2)}).` });
    } else {
      out.push({ kind: 'trend', text: `Sin tendencia clara: los valores oscilan alrededor de ${fmt(reg.mean, name)} (R² ${nf1.format(reg.r2)}).` });
    }
    // atípicos sobre los residuos del ajuste
    const res = vals.map((v, i) => v - reg.fit[i]);
    const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / Math.max(1, res.length - 1));
    if (sd > 0) {
      const anomalies = res.map((r, i) => ({ i, z: r / sd })).filter((a) => Math.abs(a.z) >= 2.2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 2);
      for (const a of anomalies) {
        const r = rows[a.i];
        out.push({ kind: 'anomaly', text: `${r[x]} se sale del patrón: ${fmt(vals[a.i], name)} frente a ~${fmt(reg.fit[a.i], name)} esperado (${a.z > 0 ? '+' : ''}${nf1.format(a.z)} desviaciones).`, focus: r[x] });
      }
    }
    // estacionalidad: mes del año con mayor promedio cuando hay ≥ 18 meses
    if (/^\d{4}-\d{2}$/.test(String(rows[0][x])) && rows.length >= 18) {
      const byM = {};
      rows.forEach((r, i) => { const m = String(r[x]).slice(5, 7); (byM[m] ||= []).push(vals[i] / reg.fit[i]); });
      const med = (a) => { const s = [...a].sort((p, q) => p - q); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
      const avg = Object.entries(byM).map(([m, a]) => [m, med(a)]).sort((a, b) => b[1] - a[1]);
      const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      if (avg[0][1] > 1.12) out.push({ kind: 'season', text: `Estacionalidad: ${names[Number(avg[0][0]) - 1]} suele estar ${nf1.format(100 * (avg[0][1] - 1))} % por encima de la tendencia; ${names[Number(avg[avg.length - 1][0]) - 1]} es el mes más flojo.` });
    }
    const best = rows[vals.indexOf(Math.max(...vals))]; const worst = rows[vals.indexOf(Math.min(...vals))];
    out.push({ kind: 'range', text: `Máximo en ${best[x]} (${fmt(Math.max(...vals), name)}) y mínimo en ${worst[x]} (${fmt(Math.min(...vals), name)}).` });
    return out;
  }

  // categorías
  const total = vals.reduce((a, b) => a + b, 0);
  const sorted = rows.map((r, i) => ({ k: r[x], v: vals[i] })).sort((a, b) => b.v - a.v);
  if (shape.additive && total > 0 && sorted.length >= 3) {
    let acc = 0; let k80 = 0;
    for (const s of sorted) { acc += s.v; k80++; if (acc / total >= 0.8) break; }
    const top3 = sorted.slice(0, 3).reduce((s, v) => s + v.v, 0) / total;
    out.push({ kind: 'concentration', text: `${k80} de ${sorted.length} (${nf1.format(100 * k80 / sorted.length)} %) concentran el 80 % del total; los tres primeros suman el ${nf1.format(100 * top3)} %.` });
  }
  if (sorted.length >= 2 && sorted[1].v) {
    const gap = 100 * (sorted[0].v - sorted[1].v) / Math.abs(sorted[1].v);
    out.push({ kind: 'gap', text: `${sorted[0].k} supera a ${sorted[1].k} por ${nf1.format(gap)} %.`, focus: sorted[0].k });
  }
  if (sorted.length >= 3) {
    const mean = total / sorted.length;
    const sd = Math.sqrt(sorted.reduce((s, v) => s + (v.v - mean) ** 2, 0) / (sorted.length - 1));
    const out2 = sorted.filter((s) => sd && Math.abs(s.v - mean) / sd >= 2);
    for (const o of out2.slice(0, 1)) out.push({ kind: 'anomaly', text: `${o.k} es atípico: ${fmt(o.v, name)} frente a un promedio de ${fmt(mean, name)}.`, focus: o.k });
    const last = sorted[sorted.length - 1];
    out.push({ kind: 'range', text: `El más bajo es ${last.k} con ${fmt(last.v, name)}; el promedio es ${fmt(mean, name)}.` });
  }
  return out;
}
