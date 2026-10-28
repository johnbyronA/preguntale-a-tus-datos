// Gráficos con ECharts: elige la forma según el resultado y aplica la paleta
// categórica validada (orden fijo, nunca cíclico) para modo claro y oscuro.
import { fmt, fmtCell, isPctName } from '../engine/format.js';

const PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

const TIME_RE = /^(\d{4}(-\d{2}(-\d{2})?)?|\d{4}-T[1-4])$/;
const ORDERED_X = /^(mes|dia_semana|anio|trimestre|semana|dia|rango_|year|month|fecha)/;
const SECONDARY = /^(variacion_pct|pct_del_total|acumulado|periodo_anterior|periodos)$/;

/** Deduce qué columna es eje X, cuál es la serie y cuáles son métricas. */
export function inferShape(result, intent) {
  const { columns, types, rows } = result;
  if (!rows.length) return { kind: 'empty' };
  if (intent?.kind === 'detail') return { kind: 'table' };
  const numeric = columns.filter((c) => types[c] === 'number');
  const textual = columns.filter((c) => types[c] !== 'number');
  const shape = { additive: false, extras: [] };

  // claves de agrupación
  let keys = textual.slice(0, 2);
  if (intent?.dims?.length) keys = columns.slice(0, intent.dims.length);
  else if (!textual.length && numeric.length >= 2 && /^(anio|year|rango_|dias|calific|mes|semana|trimestre)/.test(columns[0])) keys = [columns[0]];

  const metrics = numeric.filter((c) => !keys.includes(c));
  if (!keys.length) {
    if (rows.length === 1) return { kind: 'kpi', y: metrics[0], ys: metrics };
    return { kind: 'table' };
  }
  if (!metrics.length) return { kind: 'table' };

  shape.x = keys[0];
  if (keys.length > 1) shape.series = keys[1];
  const main = metrics.filter((c) => !SECONDARY.test(c));
  shape.ys = main.length ? main : metrics;
  shape.y = intent?.metric?.label && metrics.includes(intent.metric.label) ? intent.metric.label : shape.ys[0];
  shape.extras = metrics.filter((c) => SECONDARY.test(c));
  shape.label = intent?.metric ? (intent.metric.type === 'agg' ? (intent.metric.column || shape.y) : intent.metric.label) : shape.y;
  if (intent?.compare) shape.y = shape.ys[shape.ys.length - 1];
  const xs = rows.map((r) => String(r[shape.x]));
  shape.kind = (intent?.dims?.[0]?.grain && !['dow', 'moy'].includes(intent.dims[0].grain)) || xs.every((v) => TIME_RE.test(v)) ? 'time' : 'category';
  shape.ordered = shape.kind === 'time' || ORDERED_X.test(shape.x) || !!intent?.dims?.[0]?.bucket || !!intent?.dims?.[0]?.numericDim;
  shape.compare = !!intent?.compare;
  if (intent?.metric?.type === 'agg') shape.additive = ['SUM', 'COUNT', 'COUNT_DISTINCT'].includes(intent.metric.agg) && !intent.limit && !intent.compare;
  else if (!intent) shape.additive = /^(total|suma|conteo|registros|cantidad|ingreso|venta)/.test(shape.y);
  return shape;
}

/** Tipos de gráfico que tienen sentido para una forma. El primero es el recomendado. */
export function chartChoices(shape, rows) {
  if (['kpi', 'table', 'empty'].includes(shape.kind)) return [];
  if (shape.series) {
    return shape.kind === 'time' ? ['line', 'area', 'bar', 'heatmap'] : ['heatmap', 'bar'];
  }
  if (shape.compare) return shape.ordered ? ['line', 'bar'] : ['bar', 'line'];
  if (shape.kind === 'time') return rows.length <= 8 ? ['bar', 'line', 'area'] : ['line', 'area', 'bar'];
  const c = ['bar'];
  if (!shape.ordered && shape.additive && rows.length >= 3) c.push('treemap');
  if (shape.ordered) c.push('line');
  return c;
}

export const CHART_NAMES = { bar: 'Barras', line: 'Líneas', area: 'Área', treemap: 'Mosaico', heatmap: 'Mapa de calor' };

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.resolvedTheme === 'dark';
  return {
    dark, palette: dark ? PALETTE.dark : PALETTE.light,
    ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), line: v('--line'), surface: v('--surface'), focus: v('--focus-mark'),
    font: v('--font-body') || 'sans-serif',
  };
}

function baseOption(t) {
  return {
    animationDuration: 450,
    textStyle: { fontFamily: t.font, color: t.ink2 },
    grid: { left: 8, right: 24, top: 36, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', confine: true,
      backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, padding: [8, 12],
      textStyle: { color: t.ink, fontFamily: t.font, fontSize: 13 },
      extraCssText: 'box-shadow: 0 6px 24px rgba(10,20,40,.14); border-radius: 8px;',
    },
  };
}

const axisCommon = (t) => ({
  axisLine: { lineStyle: { color: t.line } },
  axisTick: { show: false },
  axisLabel: { color: t.ink3, fontSize: 12 },
  splitLine: { lineStyle: { color: t.line, opacity: 0.6 } },
});

/**
 * Construye la opción de ECharts.
 * @param {object} result {columns, rows}
 * @param {object} shape  de inferShape
 * @param {string} type   bar|line|area|treemap|heatmap
 * @param {{focus?:string[]}} opts  valores de X a resaltar (hallazgos)
 */
export function buildOption(result, shape, type, opts = {}) {
  const t = tokens();
  const { rows } = result;
  const opt = baseOption(t);
  const fy = (v) => fmt(v, shape.label || shape.y, { short: true });
  const valueAxis = { type: 'value', ...axisCommon(t), axisLabel: { ...axisCommon(t).axisLabel, formatter: (v) => fy(v) } };
  const tipFmt = (name) => (v) => fmtCell(typeof v === 'object' ? v?.value : v, name);
  const focus = new Set((opts.focus || []).map(String));

  // ---- Dos dimensiones
  if (shape.series) {
    const xs = unique(rows.map((r) => r[shape.x]));
    const ss = unique(rows.map((r) => r[shape.series]));
    const get = new Map(rows.map((r) => [`${r[shape.x]}|${r[shape.series]}`, r[shape.y]]));
    if (type === 'heatmap') {
      const data = []; let mx = -Infinity; let mn = Infinity;
      xs.forEach((x, i) => ss.forEach((s, j) => { const v = get.get(`${x}|${s}`); if (v != null) { data.push([i, j, v]); mx = Math.max(mx, v); mn = Math.min(mn, v); } }));
      return {
        ...opt,
        tooltip: { ...opt.tooltip, trigger: 'item', formatter: (p) => `<b>${xs[p.value[0]]} · ${ss[p.value[1]]}</b><br>${fmtCell(p.value[2], shape.label)}` },
        grid: { ...opt.grid, bottom: 56 },
        xAxis: { type: 'category', data: xs, ...axisCommon(t), splitLine: { show: false } },
        yAxis: { type: 'category', data: ss, ...axisCommon(t), splitLine: { show: false } },
        visualMap: { min: mn, max: mx, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, text: [fy(mx), fy(mn)], textStyle: { color: t.ink3 }, inRange: { color: t.dark ? [...SEQ].reverse() : SEQ } },
        series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } } }],
      };
    }
    const shown = ss.slice(0, 8);
    return {
      ...opt,
      color: t.palette,
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4, textStyle: { color: t.ink2 } },
      xAxis: { type: 'category', data: xs, boundaryGap: type === 'bar', ...axisCommon(t), splitLine: { show: false } },
      yAxis: valueAxis,
      dataZoom: xs.length > 24 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 0, borderColor: t.line }] : [],
      grid: { ...opt.grid, top: 40, bottom: xs.length > 24 ? 36 : 8 },
      tooltip: { ...opt.tooltip, order: 'valueDesc', valueFormatter: tipFmt(shape.label) },
      series: shown.map((s) => ({
        name: s, type: type === 'area' ? 'line' : type,
        stack: type === 'area' || type === 'bar' ? 'total' : undefined,
        areaStyle: type === 'area' ? { opacity: 0.85 } : undefined,
        smooth: false, symbol: 'circle', symbolSize: 6, showSymbol: xs.length <= 24,
        lineStyle: { width: 2 }, barMaxWidth: 28,
        itemStyle: type === 'bar' ? { borderColor: t.surface, borderWidth: 1 } : undefined,
        emphasis: { focus: 'series' },
        data: xs.map((x) => get.get(`${x}|${s}`) ?? null),
      })),
    };
  }

  const xs = rows.map((r) => r[shape.x]);

  // ---- Mosaico (treemap)
  if (type === 'treemap') {
    const total = rows.reduce((s, r) => s + (r[shape.y] || 0), 0);
    return {
      ...opt,
      tooltip: { ...opt.tooltip, trigger: 'item', formatter: (p) => `<b>${p.name}</b><br>${fmtCell(p.value, shape.label)}<br>${(100 * p.value / total).toFixed(1).replace('.', ',')} % del total` },
      series: [{
        type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
        itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        label: { color: '#fff', fontSize: 13, fontWeight: 600, formatter: (p) => `${p.name}\n${fy(p.value)}` },
        data: rows.map((r, i) => ({ name: String(r[shape.x]), value: r[shape.y], itemStyle: { color: t.palette[Math.min(i, 7)] } })),
      }],
    };
  }

  // ---- Comparación de años (dos métricas)
  if (shape.compare && shape.ys.length >= 2) {
    const horizontal = !shape.ordered && type === 'bar';
    const cat = { type: 'category', data: horizontal ? [...xs].reverse() : xs, ...axisCommon(t), splitLine: { show: false } };
    return {
      ...opt, color: t.palette,
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4, textStyle: { color: t.ink2 } },
      grid: { ...opt.grid, top: 40 },
      tooltip: { ...opt.tooltip, valueFormatter: tipFmt(shape.label) },
      xAxis: horizontal ? valueAxis : cat, yAxis: horizontal ? cat : valueAxis,
      series: shape.ys.slice(0, 2).map((y) => ({
        name: y, type, barMaxWidth: 22, barGap: '15%', symbol: 'circle', symbolSize: 7, lineStyle: { width: 2 },
        itemStyle: { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
        data: (horizontal ? [...rows].reverse() : rows).map((r) => r[y]),
      })),
    };
  }

  // ---- Una dimensión: barras / líneas / área
  const horizontal = type === 'bar' && !shape.ordered;
  const data = (horizontal ? [...rows].reverse() : rows).map((r) => ({
    value: r[shape.y],
    itemStyle: focus.has(String(r[shape.x])) ? { color: t.focus } : undefined,
  }));
  const cats = horizontal ? [...xs].reverse() : xs;
  const series = [{
    name: shape.y, type: type === 'area' ? 'line' : type, data,
    barMaxWidth: horizontal ? 22 : 36,
    itemStyle: { color: t.palette[0], borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
    lineStyle: { width: 2, color: t.palette[0] },
    areaStyle: type === 'area' ? { color: t.palette[0], opacity: 0.18 } : undefined,
    symbol: 'circle', symbolSize: 8, showSymbol: rows.length <= 36,
    label: horizontal && rows.length <= 16 ? { show: true, position: 'right', color: t.ink2, fontSize: 12, formatter: (p) => fy(p.value) } : undefined,
    emphasis: { itemStyle: { color: t.palette[0], opacity: 0.85 } },
  }];
  if (type !== 'bar' && focus.size) {
    series[0].markPoint = {
      symbol: 'circle', symbolSize: 14, itemStyle: { color: t.focus, borderColor: t.surface, borderWidth: 2 }, label: { show: false },
      data: rows.map((r, i) => (focus.has(String(r[shape.x])) ? { coord: [i, r[shape.y]], name: String(r[shape.x]) } : null)).filter(Boolean),
    };
  }
  if (shape.extras.includes('acumulado')) {
    series.push({ name: 'acumulado', type: 'line', data: rows.map((r) => r.acumulado), lineStyle: { width: 2, type: 'dashed', color: t.palette[1] }, itemStyle: { color: t.palette[1] }, symbol: 'none' });
  }
  const tooltipFormatter = (params) => {
    const p = Array.isArray(params) ? params[0] : params;
    const r = rows[horizontal ? rows.length - 1 - p.dataIndex : p.dataIndex];
    let html = `<b>${r[shape.x]}</b><br>${shape.y}: <b>${fmtCell(r[shape.y], shape.label)}</b>`;
    for (const e of shape.extras) if (r[e] != null) html += `<br>${e.replace(/_/g, ' ')}: ${isPctName(e) ? fmtCell(r[e], e) : fmtCell(r[e], shape.label)}`;
    for (const y of shape.ys.slice(1)) html += `<br>${y}: ${fmtCell(r[y], y)}`;
    return html;
  };
  return {
    ...opt,
    legend: shape.extras.includes('acumulado') ? { top: 0, left: 0, textStyle: { color: t.ink2 } } : undefined,
    tooltip: { ...opt.tooltip, trigger: horizontal ? 'item' : 'axis', formatter: tooltipFormatter, axisPointer: { type: type === 'bar' ? 'shadow' : 'line', lineStyle: { color: t.ink3 }, shadowStyle: { color: t.dark ? 'rgba(255,255,255,.04)' : 'rgba(20,40,80,.05)' } } },
    grid: { ...opt.grid, top: shape.extras.includes('acumulado') ? 40 : 16, right: horizontal ? 64 : 24, bottom: rows.length > 30 && !horizontal ? 36 : 8 },
    xAxis: horizontal ? valueAxis : { type: 'category', data: cats, boundaryGap: type === 'bar', ...axisCommon(t), splitLine: { show: false } },
    yAxis: horizontal ? { type: 'category', data: cats, ...axisCommon(t), splitLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, color: t.ink2, width: 160, overflow: 'truncate' } } : valueAxis,
    dataZoom: rows.length > 30 && !horizontal ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 0, borderColor: t.line }] : [],
    series,
  };
}

/** Mini serie para la tarjeta de KPI y el perfil de columnas (SVG puro). */
export function sparkline(values, { width = 160, height = 36, color = 'currentColor', bars = false, stretch = false } = {}) {
  const v = values.map(Number).filter(Number.isFinite);
  if (v.length < 2) return '';
  const mx = Math.max(...v); const mn = bars ? 0 : Math.min(...v);
  const sx = width / (v.length - (bars ? 0 : 1)); const sy = (height - 4) / (mx - mn || 1);
  if (bars) {
    const w = Math.max(1, sx - 2);
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${v.map((x, i) => `<rect x="${(i * sx + 1).toFixed(1)}" y="${(height - (x - mn) * sy).toFixed(1)}" width="${w.toFixed(1)}" height="${((x - mn) * sy).toFixed(1)}" rx="1" fill="${color}"/>`).join('')}</svg>`;
  }
  const pts = v.map((x, i) => `${(i * sx).toFixed(1)},${(height - 2 - (x - mn) * sy).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${stretch ? ' preserveAspectRatio="none"' : ''} aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function unique(a) { return [...new Set(a)]; }
