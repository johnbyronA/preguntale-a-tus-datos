// Banco de pruebas del motor local. Se usa en dos lugares:
//  - tests/engine.test.mjs (Node, en CI)
//  - la sección "Laboratorio" de la demo (se ejecuta en vivo en el navegador)
//
// Cada caso verifica la interpretación (métrica, dimensiones, filtros,
// periodo) y, en el laboratorio, que el SQL se ejecute sin errores en DuckDB.

export const EVALSET = [
  // KPI simples
  { q: '¿Cuánto vendimos en 2025?', expect: { metric: 'SUM:ingreso', dims: [], time: ['2025-01-01', '2025-12-31'] } },
  { q: '¿Cuál fue la utilidad total del año pasado?', expect: { metric: 'SUM:utilidad', time: ['2025-01-01', '2025-12-31'] } },
  { q: '¿Cuántos pedidos tuvimos en marzo de 2026?', expect: { metric: 'COUNT_DISTINCT:id_pedido', time: ['2026-03-01', '2026-03-31'] } },
  { q: 'Calificación promedio de los clientes en E-commerce', expect: { metric: 'AVG:calificacion', filters: ['canal=E-commerce'] } },
  { q: 'Ticket promedio en Medellín', expect: { metric: 'AVG:ingreso', filters: ['ciudad=Medellín'] } },
  { q: '¿Cuál es el descuento máximo que se ha dado?', expect: { metric: 'MAX:descuento_pct' } },
  { q: 'Promedio mensual de ventas en 2025', expect: { metric: 'SUM:ingreso', extras: ['avgOfPeriod'], time: ['2025-01-01', '2025-12-31'] } },
  // Rankings
  { q: '¿Qué ciudad vende más?', expect: { metric: 'SUM:ingreso', dims: ['ciudad'], order: 'desc' } },
  { q: 'Top 5 productos por utilidad', expect: { metric: 'SUM:utilidad', dims: ['producto'], limit: 5 } },
  { q: 'Los 3 vendedores con menos ventas en 2025', expect: { dims: ['vendedor'], limit: 3, order: 'asc', time: ['2025-01-01', '2025-12-31'] } },
  { q: 'Unidades vendidas por categoría', expect: { metric: 'SUM:cantidad', dims: ['categoria'] } },
  { q: '¿Cuántos productos distintos vende cada canal?', expect: { metric: 'COUNT_DISTINCT:producto', dims: ['canal'] } },
  // Tiempo
  { q: 'Evolución mensual de las ventas', expect: { metric: 'SUM:ingreso', dims: ['month'] } },
  { q: 'Ventas por trimestre en Bogotá', expect: { dims: ['quarter'], filters: ['ciudad=Bogotá'] } },
  { q: 'Ventas por día de la semana', expect: { dims: ['dow'] } },
  { q: 'Ingresos de los últimos 3 meses por canal', expect: { dims: ['canal'], time: ['2026-07-01', '2026-09-30'] } },
  { q: 'Ventas acumuladas por mes en 2026', expect: { dims: ['month'], extras: ['cumulative'], time: ['2026-01-01', '2026-09-30'] } },
  { q: 'Crecimiento de la utilidad por año', expect: { metric: 'SUM:utilidad', dims: ['year'], extras: ['growth'] } },
  { q: 'Ventas del primer semestre de 2025 por región', expect: { dims: ['region'], time: ['2025-01-01', '2025-06-30'] } },
  { q: 'Ventas entre enero y marzo de 2026', expect: { time: ['2026-01-01', '2026-03-31'] } },
  // Comparaciones
  { q: 'Compara las ventas de 2024 vs 2025 por categoría', expect: { compare: [2024, 2025], dims: ['categoria'] } },
  { q: '¿Cuánto crecieron las ventas en 2025?', expect: { compare: [2024, 2025] } },
  // Filtros
  { q: 'Ventas por ciudad excepto Bogotá', expect: { dims: ['ciudad'], filters: ['ciudad!=Bogotá'] } },
  { q: 'Ingresos de Tecnología y Muebles por canal', expect: { dims: ['canal'], filters: ['categoria IN Tecnología,Muebles'] } },
  { q: 'Ventas de la vendedora Laura Gómez por mes', expect: { dims: ['month'], filters: ['vendedor=Laura Gómez'] } },
  { q: 'Pedidos con descuento mayor al 15% por canal', expect: { dims: ['canal'], filters: ['descuento_pct>15'] } },
  { q: 'Ventas con más de 10 unidades por ciudad', expect: { dims: ['ciudad'], filters: ['cantidad>10'] } },
  // Tasas, márgenes y participación
  { q: 'Tasa de devolución por canal', expect: { metric: 'SHARE:estado=Devuelto', dims: ['canal'] } },
  { q: 'Porcentaje de pedidos devueltos por mes en 2026', expect: { metric: 'SHARE:estado=Devuelto', dims: ['month'] } },
  { q: 'Margen por categoría', expect: { metric: 'RATIO:utilidad/ingreso', dims: ['categoria'] } },
  { q: 'Participación de cada región en las ventas', expect: { dims: ['region'], extras: ['pctTotal'] } },
  // Dos dimensiones y distribución
  { q: 'Ventas por mes y canal', expect: { dims: ['month', 'canal'] } },
  { q: 'Calificación promedio por días de entrega', expect: { metric: 'AVG:calificacion', dims: ['dias_entrega'] } },
  { q: 'Distribución de la calificación', expect: { kind: 'distribution' } },
  // Detalle
  { q: 'Muéstrame los últimos 10 pedidos devueltos', expect: { kind: 'detail', limit: 10, filters: ['estado=Devuelto'] } },
];

/** Compara la intención con lo esperado. Devuelve la lista de diferencias. */
export function checkIntent(intent, expect) {
  const errs = [];
  const metricKey = (m) => {
    if (!m) return null;
    if (m.type === 'ratio') return `RATIO:${m.num}/${m.den}`;
    if (m.type === 'share') return `SHARE:${m.column}=${m.value}`;
    return `${m.agg}:${m.column}`;
  };
  if (expect.kind && intent.kind !== expect.kind) errs.push(`tipo ${intent.kind} ≠ ${expect.kind}`);
  if (expect.metric && metricKey(intent.metric) !== expect.metric) errs.push(`métrica ${metricKey(intent.metric)} ≠ ${expect.metric}`);
  if (expect.dims) {
    const got = intent.dims.map((d) => d.grain || d.column);
    if (got.join(',') !== expect.dims.join(',')) errs.push(`dimensiones [${got}] ≠ [${expect.dims}]`);
  }
  if (expect.filters) {
    const got = intent.filters.map((f) => (Array.isArray(f.value) ? `${f.column} ${f.op} ${f.value.join(',')}` : `${f.column}${f.op}${f.value}`));
    for (const e of expect.filters) if (!got.includes(e)) errs.push(`falta filtro ${e} (hay: ${got.join('; ') || 'ninguno'})`);
  }
  if (expect.time) {
    const t = intent.time || {};
    if (t.from !== expect.time[0] || t.to !== expect.time[1]) errs.push(`periodo ${t.from}…${t.to} ≠ ${expect.time.join('…')}`);
  }
  if (expect.compare && (intent.compare?.years || []).join(',') !== expect.compare.join(',')) errs.push(`comparación ${intent.compare?.years} ≠ ${expect.compare}`);
  if (expect.limit && intent.limit !== expect.limit) errs.push(`límite ${intent.limit} ≠ ${expect.limit}`);
  if (expect.order && intent.order !== expect.order) errs.push(`orden ${intent.order} ≠ ${expect.order}`);
  if (expect.extras) for (const x of expect.extras) if (!intent.extras[x]) errs.push(`falta ${x}`);
  return errs;
}
