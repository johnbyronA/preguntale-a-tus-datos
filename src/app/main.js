// Interfaz de "Pregúntale a tus datos".
import { parse, buildSQL, explain, buildVocabulary, schemaRoles, describeFilter, metricTitle, dimTitle, aggLabel, aggTitle, GRAIN_LABEL } from '../engine/nl2sql.js';
import { normalize, phrase, pluralize } from '../engine/text.js';
import { headline, fmt, fmtCell, pct, cap } from '../engine/format.js';
import { findInsights } from '../engine/insights.js';
import { EVALSET, checkIntent } from '../engine/evalset.js';
import { initDB, loadURL, loadFile, profile, query, assertReadOnly } from './db.js';
import { LIBS } from './libs.js';
import { inferShape, chartChoices, buildOption, sparkline, CHART_NAMES } from './charts.js';
import { askClaude, spansFromClaude, CLAUDE_MODELS } from './claude.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento no disponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

const DEMO = { url: 'data/ventas_demo.csv', table: 'ventas', name: 'Ventas de Comercial Andina (demo)' };
const DEMO_QUESTIONS = [
  '¿Qué ciudad vende más en 2025?',
  'Evolución mensual de las ventas',
  'Tasa de devolución por mes en E-commerce',
  'Compara las ventas de 2024 vs 2025 por categoría',
  'Margen por categoría',
  'Top 5 productos por utilidad en Medellín',
  'Participación de cada canal en las ventas',
  'Calificación promedio por días de entrega',
  'Ventas por mes y canal en 2026',
  '¿Cuánto vendimos este año?',
];

const state = {
  schema: null, isDemo: true, datasetName: DEMO.name,
  engine: 'local', apiKey: '', model: CLAUDE_MODELS[0].id,
  cur: null, drill: [], drillDim: null,
  history: [], chart: null, echarts: null, sort: null,
};

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function start() {
  applyTheme();
  $('#libs').textContent = `DuckDB-WASM ${LIBS.versions.duckdb}, ECharts ${LIBS.versions.echarts} y SheetJS ${LIBS.versions.xlsx}.`;
  state.apiKey = sessionGet('patd-key') || store.get('patd-key', '');
  state.model = store.get('patd-model', CLAUDE_MODELS[0].id);
  state.history = store.get('patd-history', []);
  bindUI();
  renderHistory();
  try {
    LIBS.loadECharts().then((e) => { state.echarts = e; if (state.cur) renderChart(); renderBoard(); });
    await initDB();
    await useDemo();
  } catch (err) {
    showError('No se pudo iniciar la base de datos en el navegador.', err.message);
    $('#dataset-name').textContent = 'Sin datos';
  }
}

function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* nada */ } }

async function useDemo() {
  $('#dataset-name').textContent = 'Cargando datos de demostración…';
  await loadURL(DEMO.url, DEMO.table);
  await setDataset(DEMO.table, DEMO.name, true);
  const hash = new URLSearchParams(location.hash.slice(1));
  const q = hash.get('q');
  if (q) { $('#pregunta').value = q; ask(q); } else { $('#pregunta').value = ''; liveGloss(''); }
}

async function setDataset(table, name, isDemo) {
  state.schema = await profile(table);
  state.isDemo = isDemo; state.datasetName = name; state.cur = null; state.drill = [];
  const date = state.schema.columns.find((c) => c.type === 'date');
  $('#dataset-name').textContent = name;
  $('#dataset-meta').textContent = `${state.schema.rows.toLocaleString('es-CO')} filas, ${state.schema.columns.length} columnas${date ? `, ${fmtDate(date.min)} a ${fmtDate(date.max)}` : ''}`;
  $('#btn-demo').hidden = isDemo;
  $('#btn-lab').disabled = !isDemo;
  $('#btn-lab').title = isDemo ? '' : 'El banco de pruebas usa los datos de demostración';
  renderSchema();
  renderSuggestions();
  resetResult();
  renderBoard();
  $('#pregunta').placeholder = isDemo ? '¿Qué ciudad vende más en 2025?' : suggestionsFor(state.schema)[1] || 'Escribe tu pregunta';
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m] = String(s).split('-');
  return `${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function bindUI() {
  const input = $('#pregunta');
  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); closeAutocomplete(); ask(input.value); });
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => liveGloss(input.value), 90); updateAutocomplete(); });
  input.addEventListener('keydown', onAutocompleteKey);
  input.addEventListener('blur', () => setTimeout(closeAutocomplete, 150));

  document.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => setEngine(b.dataset.engine)));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-cancel').addEventListener('click', () => $('#settings').close());
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#btn-theme').addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); rerenderCharts(); });

  $('#file-input').addEventListener('change', onFile);
  $('#btn-demo').addEventListener('click', async () => { await useDemo(); toast('De vuelta a los datos de demostración.'); });

  for (const id of ['chart', 'table', 'sql']) $(`#tab-${id}`).addEventListener('click', () => showTab(id));
  $('#btn-run-sql').addEventListener('click', runEditedSQL);
  $('#btn-copy-sql').addEventListener('click', () => copy($('#sql-editor').value, 'SQL copiado.'));
  $('#btn-csv').addEventListener('click', downloadCSV);
  $('#btn-png').addEventListener('click', downloadPNG);
  $('#btn-share').addEventListener('click', shareLink);
  $('#btn-pin').addEventListener('click', pinCurrent);
  $('#btn-clear-board').addEventListener('click', () => { store.del(boardKey()); renderBoard(); toast('Tablero vacío.'); });
  $('#btn-lab').addEventListener('click', runLab);

  // arrastrar y soltar archivos sobre la página
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); });

  new ResizeObserver(() => state.chart?.resize()).observe($('#chart'));
  window.addEventListener('hashchange', () => { const q = new URLSearchParams(location.hash.slice(1)).get('q'); if (q && q !== state.cur?.question) { $('#pregunta').value = q; ask(q); } });
}

function setEngine(engine) {
  state.engine = engine;
  document.querySelectorAll('[data-engine]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.engine === engine)));
  if (engine === 'claude' && !state.apiKey) openSettings();
  toast(engine === 'claude' ? 'Modo Claude: las preguntas se envían a la API de Anthropic con tu clave.' : 'Motor local: sin IA y sin internet.');
}

function openSettings() {
  const sel = $('#api-model'); sel.innerHTML = '';
  for (const m of CLAUDE_MODELS) sel.append(el('option', { value: m.id, selected: m.id === state.model }, m.name));
  $('#api-key').value = state.apiKey;
  $('#api-remember').checked = !!store.get('patd-key', '');
  $('#settings').showModal();
}
function saveSettings(e) {
  e.preventDefault();
  state.apiKey = $('#api-key').value.trim();
  state.model = $('#api-model').value;
  store.set('patd-model', state.model);
  if ($('#api-remember').checked) store.set('patd-key', state.apiKey); else store.del('patd-key');
  sessionSet('patd-key', state.apiKey);
  $('#settings').close();
  if (state.apiKey) setEngine('claude');
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------
function resolvedTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() { document.documentElement.dataset.resolvedTheme = resolvedTheme(); }
function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('patd-theme', next); } catch { /* nada */ }
  applyTheme(); rerenderCharts();
}
function rerenderCharts() { if (state.cur) renderChart(); renderBoard(); }

// ---------------------------------------------------------------------------
// Archivos propios
// ---------------------------------------------------------------------------
function onFile(e) { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }
async function openFile(file) {
  if (file.size > 300 * 1024 * 1024) { toast('El archivo supera 300 MB; prueba con una muestra.'); return; }
  $('#dataset-name').textContent = `Cargando ${file.name}…`; $('#dataset-meta').textContent = '';
  try {
    const t0 = performance.now();
    const table = await loadFile(file);
    await setDataset(table, file.name, false);
    toast(`${file.name} cargado en ${Math.round(performance.now() - t0)} ms. Ya puedes preguntar.`);
    $('#pregunta').value = ''; liveGloss('');
    $('#pregunta').focus();
  } catch (err) {
    showError(`No se pudo leer ${file.name}.`, `${err.message}. Formatos admitidos: CSV, TSV, Excel (primera hoja), JSON y Parquet.`);
    if (state.schema) $('#dataset-name').textContent = state.datasetName;
  }
}

// ---------------------------------------------------------------------------
// Esquema y sugerencias
// ---------------------------------------------------------------------------
function renderSchema() {
  const list = $('#schema-list'); list.innerHTML = '';
  const ids = buildVocabulary(state.schema).idCols;
  for (const c of state.schema.columns) {
    const tag = c.type === 'number' ? '#' : c.type === 'date' ? 'F' : 'Aa';
    let sub = '';
    let prof = '';
    if (c.type === 'number') { sub = `${fmt(c.min, c.name, { short: true })} a ${fmt(c.max, c.name, { short: true })}`; prof = sparkline(c.hist || [], { width: 54, height: 18, bars: true, color: 'var(--k-metric)' }); }
    else if (c.type === 'date') { sub = `${c.min} a ${c.max}`; prof = sparkline(c.hist || [], { width: 54, height: 18, color: 'var(--k-time)' }); }
    else sub = ids.includes(c.name) ? `${c.distinct.toLocaleString('es-CO')} valores únicos (identificador)` : `${c.distinct.toLocaleString('es-CO')} valores: ${(c.top || []).slice(0, 3).map((t) => t.v).join(', ')}`;
    const nulls = c.nulls ? el('span', { class: 'nulls' }, ` ${c.nulls.toLocaleString('es-CO')} vacíos`) : null;
    list.append(el('li', {},
      el('button', { type: 'button', title: `Usar «${phrase(c.name)}» en la pregunta`, onclick: () => insertWord(phrase(c.name)) },
        el('span', { class: 't', 'aria-label': c.type === 'number' ? 'número' : c.type === 'date' ? 'fecha' : 'texto' }, tag),
        el('span', { class: 'n' }, c.name),
        el('span', { class: 'p', html: prof }),
        el('span', { class: 'sub' }, sub, nulls))));
  }
}

function insertWord(w) {
  const input = $('#pregunta');
  const v = input.value.trimEnd();
  input.value = v ? `${v} ${w}` : cap(w);
  input.focus(); liveGloss(input.value);
}

function suggestionsFor(schema) {
  const r = schemaRoles(schema);
  const money = r.metrics.find((m) => m.name === r.conceptCol.revenue) || r.metrics.find((m) => /ingreso|venta|monto|valor|total|precio|costo/.test(m.name)) || r.metrics[0];
  const other = r.metrics.find((m) => m !== money);
  const dims = [...r.dims].sort((a, b) => a.distinct - b.distinct);
  const d1 = dims[0]; const d2 = dims.find((d) => d !== d1 && d.distinct > 4) || dims[1];
  const m = money ? phrase(money.name) : null;
  const out = [];
  if (m) out.push(`¿Cuál es el total de ${m}?`);
  if (m && d1) out.push(`${cap(m)} por ${phrase(d1.name)}`);
  if (m && r.date) out.push(`Evolución mensual de ${m}`);
  if (m && d2) out.push(`Top 5 ${pluralize(phrase(d2.name))} por ${m}`);
  if (other && d1) out.push(`Promedio de ${phrase(other.name)} por ${phrase(d1.name)}`);
  if (m && d1 && r.date) out.push(`${cap(m)} por mes y ${phrase(d1.name)}`);
  if (m && d2 && d2.values?.[0]) out.push(`${cap(m)} de ${d2.values[0]} por ${r.date ? 'mes' : phrase(d1.name)}`);
  if (m && d1) out.push(`Participación de cada ${phrase(d1.name)} en ${m}`);
  if (!m && d1) out.push(`¿Cuántos registros hay por ${phrase(d1.name)}?`);
  return out.slice(0, 8);
}

function renderSuggestions() {
  const box = $('#suggestions'); box.innerHTML = '';
  const qs = state.isDemo ? DEMO_QUESTIONS : suggestionsFor(state.schema);
  for (const q of qs) box.append(el('button', { type: 'button', onclick: () => { $('#pregunta').value = q; ask(q); } }, q));
}

// ---------------------------------------------------------------------------
// Glosa (pregunta anotada)
// ---------------------------------------------------------------------------
const KIND_NAME = { metric: 'métrica', dimension: 'agrupar', filter: 'filtro', time: 'periodo', modifier: 'cálculo' };

function renderGloss(question, spans) {
  const g = $('#gloss'); g.innerHTML = '';
  if (!question.trim()) {
    g.classList.add('is-empty');
    g.textContent = 'Mientras escribes, aquí verás cómo se entiende cada parte de tu pregunta.';
    return;
  }
  g.classList.remove('is-empty');
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) g.append(el('span', { class: 'plain' }, question.slice(pos, s.start)));
    g.append(el('span', { class: `g ${s.kind}`, title: `${KIND_NAME[s.kind]}: ${s.label}` },
      el('span', {}, question.slice(s.start, s.end)),
      el('small', {}, s.label || KIND_NAME[s.kind])));
    pos = s.end;
  }
  if (pos < question.length) g.append(el('span', { class: 'plain' }, question.slice(pos)));
}

function liveGloss(q) {
  if (!state.schema) return;
  if (!q.trim()) { renderGloss('', []); return; }
  try { renderGloss(q, parse(q, state.schema).spans); } catch { renderGloss(q, []); }
}

// ---------------------------------------------------------------------------
// Autocompletado de columnas y valores
// ---------------------------------------------------------------------------
let acItems = []; let acIndex = -1;
function updateAutocomplete() {
  const input = $('#pregunta'); const list = $('#autocomplete');
  if (!state.schema) return;
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/([\p{L}\d-]{2,})$/u);
  if (!m) return closeAutocomplete();
  const frag = normalize(m[1]).trim();
  const vocab = buildVocabulary(state.schema);
  const seen = new Set();
  acItems = [];
  for (const e of vocab.entries) {
    if (e.partial || e.derived || e.concept) continue;
    const label = e.kind === 'value' ? e.value : phrase(e.column);
    if (seen.has(label)) continue;
    if (e.phrase.startsWith(frag) && e.phrase !== frag) { seen.add(label); acItems.push({ label, kind: e.kind === 'value' ? `valor de ${e.column}` : 'columna', frag: m[1] }); }
    if (acItems.length >= 8) break;
  }
  if (!acItems.length) return closeAutocomplete();
  acIndex = -1;
  list.innerHTML = '';
  acItems.forEach((it, i) => list.append(el('li', { role: 'option', id: `ac-${i}`, 'aria-selected': 'false', onmousedown: (ev) => { ev.preventDefault(); pickAutocomplete(i); } }, el('span', {}, it.label), el('small', {}, it.kind))));
  list.hidden = false; input.setAttribute('aria-expanded', 'true');
}
function closeAutocomplete() { $('#autocomplete').hidden = true; $('#pregunta').setAttribute('aria-expanded', 'false'); acItems = []; acIndex = -1; }
function onAutocompleteKey(e) {
  if (!acItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    acIndex = (acIndex + (e.key === 'ArrowDown' ? 1 : -1) + acItems.length) % acItems.length;
    document.querySelectorAll('#autocomplete li').forEach((li, i) => li.setAttribute('aria-selected', String(i === acIndex)));
    $('#pregunta').setAttribute('aria-activedescendant', `ac-${acIndex}`);
  } else if ((e.key === 'Enter' || e.key === 'Tab') && acIndex >= 0) { e.preventDefault(); pickAutocomplete(acIndex); }
  else if (e.key === 'Escape') closeAutocomplete();
}
function pickAutocomplete(i) {
  const it = acItems[i]; const input = $('#pregunta');
  const pos = input.selectionStart; const v = input.value;
  const start = pos - it.frag.length;
  input.value = `${v.slice(0, start)}${it.label} ${v.slice(pos)}`;
  const caret = start + it.label.length + 1;
  input.setSelectionRange(caret, caret);
  closeAutocomplete(); liveGloss(input.value); input.focus();
}

// ---------------------------------------------------------------------------
// Preguntar
// ---------------------------------------------------------------------------
async function ask(question) {
  question = String(question || '').trim();
  if (!question || !state.schema) return;
  setBusy(true);
  state.drill = [];
  try {
    if (state.engine === 'claude') await askWithClaude(question);
    else await askLocal(question);
    pushHistory(question);
    if (state.isDemo) history.replaceState(null, '', `#q=${encodeURIComponent(question)}`);
  } catch (err) {
    showError('No se pudo responder la pregunta.', err.message);
  } finally { setBusy(false); }
}

async function askLocal(question) {
  const t0 = performance.now();
  const intent = parse(question, state.schema);
  const tParse = performance.now() - t0;
  renderGloss(question, intent.spans);
  if (intent.confidence <= 0.2 && !intent.spans.length) {
    showError('No reconocí columnas, valores ni fechas en la pregunta.', 'Prueba mencionando una columna (por ejemplo, las de la izquierda) o elige una sugerencia.', true);
    return;
  }
  const t1 = performance.now();
  const sql = buildSQL(intent, state.schema);
  const tBuild = performance.now() - t1;
  await execute({ question, intent, sql, source: 'local', spans: intent.spans, explanation: explain(intent), timings: { 'interpretación': tParse, 'SQL': tBuild } });
}

async function askWithClaude(question) {
  if (!state.apiKey) { openSettings(); throw new Error('Falta la clave de API de Claude. Escríbela en Ajustes o vuelve al motor local.'); }
  renderGloss(question, []);
  $('#gloss').classList.add('is-empty');
  $('#gloss').textContent = 'Claude está leyendo tu pregunta…';
  const t0 = performance.now();
  let ans = await askClaude({ apiKey: state.apiKey, model: state.model, question, schema: state.schema });
  let tries = 1;
  let result; let lastErr;
  for (;;) {
    try { assertReadOnly(ans.sql); result = await timed(() => query(ans.sql)); break; } catch (err) {
      lastErr = err;
      if (tries >= 2) break;
      tries++;
      ans = await askClaude({ apiKey: state.apiKey, model: state.model, question, schema: state.schema, previousError: err.message, previousSQL: ans.sql });
    }
  }
  const tAll = performance.now() - t0;
  const spans = spansFromClaude(question, ans.interpretacion);
  renderGloss(question, spans);
  if (!result) throw new Error(`El SQL de Claude no se pudo ejecutar: ${lastErr?.message}`);
  const usage = ans.usage ? `, ${ans.usage.input_tokens + ans.usage.output_tokens} tokens` : '';
  state.cur = { question, intent: null, sql: ans.sql, source: 'claude', spans, explanation: ans.explicacion || '', result: result.value, chartType: null, chartHint: ans.grafico, timings: { [`Claude (${ans.model || state.model}${tries > 1 ? ', con 1 corrección' : ''}${usage})`]: tAll - result.ms, DuckDB: result.ms } };
  await renderResult();
}

async function timed(fn) { const t = performance.now(); const value = await fn(); return { value, ms: performance.now() - t }; }

async function execute(cur) {
  assertReadOnly(cur.sql);
  const r = await timed(() => query(cur.sql));
  cur.result = r.value;
  cur.timings = { ...(cur.timings || {}), DuckDB: r.ms };
  cur.chartType = null;
  state.cur = cur;
  await renderResult();
}

async function runEditedSQL() {
  const sql = $('#sql-editor').value;
  setBusy(true);
  try {
    const cur = { ...state.cur, sql, intent: null, source: 'manual', explanation: 'Consulta escrita o editada a mano.', timings: {} };
    await execute(cur);
    showTab('chart');
  } catch (err) { showError('La consulta no se pudo ejecutar.', err.message); } finally { setBusy(false); }
}

/** Re-ejecuta la intención editada con los controles. */
async function rerunIntent(intent, { keepDrill = false } = {}) {
  if (!keepDrill) state.drill = [];
  setBusy(true);
  try {
    const sql = buildSQL(intent, state.schema);
    await execute({ ...state.cur, intent, sql, source: 'local', explanation: explain(intent), timings: {} });
  } catch (err) { showError('No se pudo ejecutar el ajuste.', err.message); } finally { setBusy(false); }
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
function resetResult() {
  $('#result-empty').hidden = false; $('#result-body').hidden = true; $('#result-error').hidden = true;
  state.chart?.clear();
}

function setBusy(b) { $('#result').setAttribute('aria-busy', String(b)); $('#btn-ask').disabled = b; $('#btn-ask').textContent = b ? 'Pensando…' : 'Preguntar'; }

function showError(title, detail, withSuggestions = false) {
  const box = $('#result-error'); box.innerHTML = '';
  box.append(el('b', {}, title), el('span', {}, detail));
  if (withSuggestions) {
    const s = el('div', { class: 'suggestions' });
    for (const q of (state.isDemo ? DEMO_QUESTIONS : suggestionsFor(state.schema)).slice(0, 4)) s.append(el('button', { type: 'button', onclick: () => { $('#pregunta').value = q; ask(q); } }, q));
    box.append(s);
  }
  box.hidden = false;
  $('#result-empty').hidden = true;
  $('#result-body').hidden = !state.cur;
}

async function renderResult() {
  const cur = state.cur;
  $('#result-empty').hidden = true; $('#result-error').hidden = true; $('#result-body').hidden = false;
  cur.shape = inferShape(cur.result, cur.intent);
  const choices = chartChoices(cur.shape, cur.result.rows);
  if (!cur.chartType || !choices.includes(cur.chartType)) {
    cur.chartType = cur.chartHint === 'line' && choices.includes('line') ? 'line' : choices[0] || null;
  }

  // respuesta principal
  const h = cur.intent ? headline(cur.intent, cur.result) : genericHeadline(cur.result, cur.shape);
  $('#answer').textContent = h.text;
  const delta = $('#answer-delta');
  if (h.delta && Number.isFinite(h.delta.value)) {
    delta.hidden = false;
    delta.className = `answer-delta ${h.delta.value >= 0 ? 'up' : 'down'}`;
    delta.textContent = `${h.delta.value >= 0 ? '▲' : '▼'} ${pct(h.delta.value)} frente a ${h.delta.against}${h.delta.prev ? ` (${h.delta.prev})` : ''}`;
  } else delta.hidden = true;
  $('#explanation').textContent = cur.explanation || '';
  const notes = [...(cur.intent?.notes || [])];
  if (cur.result.truncated) notes.push('Se muestran las primeras 5.000 filas.');
  $('#notes').hidden = !notes.length; $('#notes').textContent = notes.join(' ');

  renderChips();
  renderChartTypes(choices);
  $('#sql-editor').value = cur.sql;
  renderTable();

  // hallazgos
  cur.insights = cur.shape.x ? findInsights(cur.result, cur.shape) : [];
  const ul = $('#insights'); ul.innerHTML = '';
  if (!cur.insights.length) ul.append(el('li', {}, cur.shape.kind === 'kpi' ? 'Agrupa por una columna o por tiempo para ver tendencias, concentración y valores atípicos.' : 'No hay suficientes datos para encontrar patrones.'));
  for (const i of cur.insights) {
    ul.append(el('li', { class: i.kind }, i.text, i.focus != null && cur.chartType && cur.chartType !== 'treemap' && cur.chartType !== 'heatmap' ? el('button', { type: 'button', onclick: () => { cur.focus = [i.focus]; renderChart(); showTab('chart'); } }, 'Resaltar') : null));
  }
  cur.focus = cur.insights.filter((i) => i.kind === 'anomaly').map((i) => i.focus);

  const tr = Object.entries(cur.timings || {}).map(([k, v]) => `${k} ${v < 10 ? v.toFixed(1) : Math.round(v)} ms`).join(', ');
  $('#trace').textContent = `${cur.source === 'claude' ? 'Interpretado por Claude' : cur.source === 'manual' ? 'SQL manual' : 'Motor local'}. Tiempos: ${tr}. ${cur.result.rows.length.toLocaleString('es-CO')} ${cur.result.rows.length === 1 ? 'fila' : 'filas'}.`;

  renderDrill();
  showTab(cur.shape.kind === 'table' ? 'table' : 'chart');
  await renderChart();
}

function genericHeadline(result, shape) {
  const { rows } = result;
  if (!rows.length) return { text: 'No hay registros que cumplan esas condiciones.' };
  if (shape.kind === 'kpi') return { text: `${cap(String(shape.y).replace(/_/g, ' '))}: ${fmt(rows[0][shape.y], shape.y)}.` };
  if (shape.kind === 'category' && !shape.series) {
    const top = [...rows].sort((a, b) => b[shape.y] - a[shape.y])[0];
    return { text: `${top[shape.x]} tiene el valor más alto de ${String(shape.y).replace(/_/g, ' ')}: ${fmt(top[shape.y], shape.y)}.` };
  }
  if (shape.kind === 'time' && !shape.series) {
    const a = rows[0]; const b = rows[rows.length - 1];
    return { text: `${cap(String(shape.y).replace(/_/g, ' '))} pasó de ${fmt(a[shape.y], shape.y)} (${a[shape.x]}) a ${fmt(b[shape.y], shape.y)} (${b[shape.x]}).` };
  }
  return { text: `${rows.length.toLocaleString('es-CO')} filas de resultado.` };
}

let currentTab = 'chart';
function showTab(id) {
  currentTab = id;
  for (const t of ['chart', 'table', 'sql']) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === id));
    $(`#view-${t}`).hidden = t !== id;
  }
  $('#chart-types').hidden = id !== 'chart';
  if (id === 'chart') requestAnimationFrame(() => state.chart?.resize());
}

function renderChartTypes(choices) {
  const box = $('#chart-types'); box.innerHTML = '';
  if (choices.length < 2) return;
  for (const c of choices) box.append(el('button', { type: 'button', 'aria-pressed': String(c === state.cur.chartType), onclick: () => { state.cur.chartType = c; renderChartTypes(choices); renderChart(); } }, CHART_NAMES[c]));
}

async function renderChart() {
  const cur = state.cur; if (!cur) return;
  const chartEl = $('#chart'); const kpi = $('#kpi');
  if (cur.shape.kind === 'kpi') {
    chartEl.hidden = true; kpi.hidden = false; $('#drill-hint').hidden = true;
    const y = cur.shape.y; const v = cur.result.rows[0][y];
    kpi.innerHTML = '';
    kpi.append(el('div', { class: 'big' }, fmt(v, cur.intent?.metric?.column || y)), el('div', { class: 'sub' }, cap(cur.intent ? metricTitle(cur.intent.metric) : y.replace(/_/g, ' ')) + (cur.intent?.time ? ` en ${cur.intent.time.label}` : '')));
    // mini tendencia mensual con los mismos filtros
    if (cur.intent && cur.intent.dateColumn && cur.intent.metric && !cur.intent.extras.avgOfPeriod) {
      const trend = { ...cur.intent, dims: [{ column: cur.intent.dateColumn, grain: 'month' }], extras: {}, limit: null, order: 'time' };
      try {
        const r = await query(buildSQL(trend, state.schema));
        if (r.rows.length > 2) {
          const ys = r.rows.map((row) => row[cur.intent.metric.label]);
          kpi.append(el('div', { class: 'spark', html: sparkline(ys, { width: 600, height: 80, color: 'var(--k-metric)', stretch: true }) }), el('div', { class: 'sub' }, `Mensual, de ${r.rows[0].mes} a ${r.rows[r.rows.length - 1].mes}`));
        }
      } catch { /* la tendencia es opcional */ }
    }
    return;
  }
  kpi.hidden = true;
  if (!cur.chartType || !state.echarts) { chartEl.hidden = true; $('#drill-hint').hidden = true; if (!state.echarts && cur.chartType) { chartEl.hidden = false; chartEl.textContent = 'Cargando gráficos…'; } return; }
  chartEl.hidden = false;
  if (!state.chart || state.chart.isDisposed()) { chartEl.textContent = ''; state.chart = state.echarts.init(chartEl, null, { renderer: 'canvas' }); }
  state.chart.clear();
  state.chart.setOption(buildOption(cur.result, cur.shape, cur.chartType, { focus: cur.focus }), true);
  state.chart.off('click');
  const canDrill = cur.intent && cur.intent.kind === 'aggregate' && !cur.intent.compare && cur.intent.dims.length === 1 && cur.chartType !== 'heatmap';
  const hint = $('#drill-hint');
  if (canDrill) {
    const dimsAvail = drillOptions(cur.intent);
    if (!dimsAvail.length) { hint.hidden = true; return; }
    if (!state.drillDim || !dimsAvail.some((d) => d.value === state.drillDim)) state.drillDim = dimsAvail[0].value;
    hint.hidden = false; hint.innerHTML = '';
    const sel = el('select', { 'aria-label': 'Desglosar por', onchange: (e) => { state.drillDim = e.target.value; } }, dimsAvail.map((d) => el('option', { value: d.value, selected: d.value === state.drillDim }, d.label)));
    hint.append('Haz clic en un elemento del gráfico para desglosarlo por ', sel, '.');
    state.chart.on('click', (p) => drillInto(p));
  } else hint.hidden = true;
}

function drillOptions(intent) {
  const r = schemaRoles(state.schema);
  const used = new Set([...intent.dims.map((d) => d.column), ...intent.filters.filter((f) => f.op === '=').map((f) => f.column)]);
  const opts = r.dims.filter((d) => !used.has(d.name)).map((d) => ({ value: d.name, label: d.name }));
  if (r.date && !intent.dims.some((d) => d.grain)) opts.push({ value: '__month', label: 'mes' });
  return opts;
}

function drillInto(p) {
  const cur = state.cur; const intent = cur.intent; const d = intent.dims[0];
  const name = p.name ?? (cur.shape.x && cur.result.rows[p.dataIndex]?.[cur.shape.x]);
  if (name == null) return;
  const next = structuredClone(intent);
  next.extras = { ...next.extras, pctTotal: false, growth: false, cumulative: false, previousPeriod: undefined };
  let label;
  if (d.grain) {
    const range = periodRange(d.grain, String(name));
    if (!range) return;
    next.time = { column: intent.dateColumn, ...range, label: String(name) };
    label = `${GRAIN_LABEL[d.grain]} ${name}`;
  } else if (d.bucket || d.numericDim) {
    return;
  } else {
    next.filters = next.filters.filter((f) => f.column !== d.column);
    next.filters.push({ column: d.column, op: '=', value: name });
    label = `${d.column} = ${name}`;
  }
  next.dims = state.drillDim === '__month' ? [{ column: intent.dateColumn, grain: 'month' }] : [{ column: state.drillDim }];
  next.order = state.drillDim === '__month' ? 'time' : 'desc';
  next.limit = null; next.focusTop = false;
  state.drill.push({ intent, label, question: cur.question });
  rerunIntent(next, { keepDrill: true });
}

function periodRange(grain, v) {
  const last = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  if (grain === 'month' && /^\d{4}-\d{2}$/.test(v)) { const [y, m] = v.split('-').map(Number); return { from: `${v}-01`, to: `${y}-${p(m)}-${p(last(y, m))}` }; }
  if (grain === 'year' && /^\d{4}$/.test(v)) return { from: `${v}-01-01`, to: `${v}-12-31` };
  if (grain === 'quarter' && /^\d{4}-T[1-4]$/.test(v)) { const y = Number(v.slice(0, 4)); const q = Number(v.slice(-1)); return { from: `${y}-${p(q * 3 - 2)}-01`, to: `${y}-${p(q * 3)}-${p(last(y, q * 3))}` }; }
  if (grain === 'day' && /^\d{4}-\d{2}-\d{2}/.test(v)) return { from: v.slice(0, 10), to: v.slice(0, 10) };
  if (grain === 'week' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const a = new Date(v.slice(0, 10)); const b = new Date(a.getTime() + 6 * 864e5); return { from: v.slice(0, 10), to: b.toISOString().slice(0, 10) }; }
  return null;
}

function renderDrill() {
  const box = $('#drill');
  if (!state.drill.length) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '';
  box.append(el('button', { type: 'button', onclick: () => backTo(0) }, 'Inicio'));
  state.drill.forEach((d, i) => {
    box.append(' › ');
    if (i < state.drill.length - 1) box.append(el('button', { type: 'button', onclick: () => backTo(i + 1) }, d.label));
    else box.append(el('span', {}, d.label));
  });
}
function backTo(i) {
  const target = state.drill[i].intent;
  state.drill = state.drill.slice(0, i);
  rerunIntent(target, { keepDrill: true });
}

// ---------------------------------------------------------------------------
// Controles de la intención (chips)
// ---------------------------------------------------------------------------
function renderChips() {
  const box = $('#chips'); box.innerHTML = '';
  const intent = state.cur.intent;
  if (!intent) { box.hidden = true; return; }
  box.hidden = false;
  const r = schemaRoles(state.schema);
  const edit = (fn) => { const next = structuredClone(intent); fn(next); rerunIntent(next); };

  if (intent.kind !== 'detail') {
    // métrica
    const options = [{ v: 'COUNT|', t: 'número de registros' }];
    for (const m of r.metrics) for (const a of ['SUM', 'AVG', 'MEDIAN', 'MAX', 'MIN']) options.push({ v: `${a}|${m.name}`, t: aggTitle(a, m.name) });
    for (const d of r.dims) options.push({ v: `COUNT_DISTINCT|${d.name}`, t: `número de ${d.name} distintos` });
    if (r.conceptCol.profit && r.conceptCol.revenue) options.push({ v: 'RATIO|', t: `margen (${r.conceptCol.profit} ÷ ${r.conceptCol.revenue})` });
    const curV = intent.metric.type === 'ratio' ? 'RATIO|' : intent.metric.type === 'share' ? 'SHARE|' : `${intent.metric.agg}|${intent.metric.column || ''}`;
    if (intent.metric.type === 'share') options.unshift({ v: 'SHARE|', t: metricTitle(intent.metric) });
    if (!options.some((o) => o.v === curV)) options.unshift({ v: curV, t: metricTitle(intent.metric) });
    box.append(chip('metric', 'Métrica', el('select', { 'aria-label': 'Métrica', onchange: (e) => edit((n) => {
      const [agg, col] = e.target.value.split('|');
      if (agg === 'RATIO') n.metric = { type: 'ratio', num: r.conceptCol.profit, den: r.conceptCol.revenue, label: 'margen_pct', title: 'margen (%)' };
      else if (agg === 'SHARE') n.metric = intent.metric;
      else n.metric = { type: 'agg', agg, column: col || null, label: col ? aggLabel(agg, col) : 'registros', title: col ? aggTitle(agg, col) : 'número de registros' };
    }) }, options.map((o) => el('option', { value: o.v, selected: o.v === curV }, o.t)))));

    // agrupación
    const dimOpts = [{ v: '', t: 'sin agrupar' }];
    if (r.date) for (const g of ['day', 'week', 'month', 'quarter', 'year', 'dow', 'moy']) dimOpts.push({ v: `@${g}`, t: GRAIN_LABEL[g] });
    for (const d of r.dims) dimOpts.push({ v: d.name, t: d.name });
    for (const m of r.metrics.filter((x) => x.integer && x.max - x.min <= 31)) dimOpts.push({ v: `#${m.name}`, t: m.name });
    const dimVal = (d) => (d ? (d.grain ? `@${d.grain}` : d.numericDim ? `#${d.column}` : d.column) : '');
    const toDim = (v) => (v.startsWith('@') ? { column: r.date.name, grain: v.slice(1) } : v.startsWith('#') ? { column: v.slice(1), numericDim: true } : { column: v });
    for (let i = 0; i < Math.min(2, intent.dims.length + 1); i++) {
      if (intent.compare && i > 0) break;
      const d = intent.dims[i];
      if (!d && i === 1 && !intent.dims.length) break;
      if (d?.bucket) { box.append(chip('dimension', 'Agrupar', el('span', {}, dimTitle(d)))); continue; }
      const opts = i === 0 ? dimOpts : [{ v: '', t: 'añadir otra' }, ...dimOpts.slice(1)];
      box.append(chip('dimension', i === 0 ? 'Agrupar por' : 'y por', el('select', { 'aria-label': i === 0 ? 'Agrupar por' : 'Segunda agrupación', onchange: (e) => edit((n) => {
        const v = e.target.value;
        if (!v) n.dims.splice(i, 1); else n.dims[i] = toDim(v);
        n.dims = n.dims.filter(Boolean);
        n.order = n.dims.some((x) => x.grain || x.numericDim) ? 'time' : (n.order === 'asc' ? 'asc' : 'desc');
        if (n.compare && n.dims.length === 0) n.dims = [{ column: r.date.name, grain: 'moy' }];
        n.extras.previousPeriod = undefined;
      }) }, opts.map((o) => el('option', { value: o.v, selected: o.v === dimVal(d) }, o.t)))));
    }
  }

  // filtros
  intent.filters.forEach((f, i) => {
    box.append(chip('filter', 'Filtro', el('span', {}, describeFilter(f)), el('button', { type: 'button', 'aria-label': `Quitar filtro ${describeFilter(f)}`, onclick: () => edit((n) => { n.filters.splice(i, 1); }) }, '×')));
  });
  box.append(addFilterChip(intent, r, edit));

  // periodo
  if (r.date) {
    const t = intent.time || {};
    const from = el('input', { type: 'date', value: t.from || '', min: r.date.min, max: r.date.max, 'aria-label': 'Desde' });
    const to = el('input', { type: 'date', value: t.to || '', min: r.date.min, max: r.date.max, 'aria-label': 'Hasta' });
    const apply = () => edit((n) => {
      if (!from.value && !to.value) { n.time = null; n.compare = null; return; }
      n.time = { column: r.date.name, from: from.value || null, to: to.value || null, label: `${from.value || 'inicio'} a ${to.value || 'fin'}` };
      n.compare = null;
      n.extras.previousPeriod = undefined;
    });
    from.addEventListener('change', apply); to.addEventListener('change', apply);
    box.append(chip('time', 'Periodo', from, el('span', {}, 'a'), to, intent.time ? el('button', { type: 'button', 'aria-label': 'Quitar periodo', onclick: () => edit((n) => { n.time = null; n.compare = null; n.extras.previousPeriod = undefined; }) }, '×') : null));
  }

  // orden y límite
  if (intent.kind !== 'detail' && intent.dims.length && !intent.dims.some((d) => d.grain || d.bucket || d.numericDim)) {
    const ord = el('select', { 'aria-label': 'Orden', onchange: (e) => edit((n) => { n.order = e.target.value; }) },
      el('option', { value: 'desc', selected: intent.order !== 'asc' }, 'mayor a menor'), el('option', { value: 'asc', selected: intent.order === 'asc' }, 'menor a mayor'));
    const lim = el('input', { type: 'number', min: 1, max: 500, value: intent.limit || '', placeholder: 'todos', 'aria-label': 'Límite de filas', onchange: (e) => edit((n) => { n.limit = Number(e.target.value) || null; }) });
    box.append(chip('modifier', 'Orden', ord, el('span', {}, 'top'), lim));
  }
}

function chip(kind, label, ...content) { return el('span', { class: `chip ${kind}` }, el('span', {}, label), ...content); }

function addFilterChip(intent, r, edit) {
  const wrap = el('span', { class: 'chip chip-add filter' });
  const start = el('button', { type: 'button', style: 'width:auto;padding:0 2px', onclick: () => {
    wrap.innerHTML = '';
    const colSel = el('select', { 'aria-label': 'Columna del filtro' }, el('option', { value: '' }, 'columna…'), r.dims.map((d) => el('option', { value: d.name }, d.name)));
    const valSel = el('select', { 'aria-label': 'Valor del filtro', disabled: true }, el('option', {}, 'valor…'));
    colSel.addEventListener('change', () => {
      const c = state.schema.columns.find((x) => x.name === colSel.value);
      valSel.innerHTML = ''; valSel.disabled = !c;
      valSel.append(el('option', { value: '' }, 'valor…'), ...(c?.values || []).map((v) => el('option', { value: v }, v)));
    });
    valSel.addEventListener('change', () => { if (valSel.value) edit((n) => { n.filters.push({ column: colSel.value, op: '=', value: valSel.value }); }); });
    wrap.append(el('span', {}, 'Filtro'), colSel, valSel);
    colSel.focus();
  } }, '+ filtro');
  wrap.append(start);
  return wrap;
}

// ---------------------------------------------------------------------------
// Tabla
// ---------------------------------------------------------------------------
function renderTable() {
  const { result } = state.cur;
  const tbl = $('#table'); tbl.innerHTML = '';
  let rows = result.rows;
  if (state.sort) {
    const { col, dir } = state.sort;
    if (result.columns.includes(col)) rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * dir);
  }
  const numCols = result.columns.filter((c) => result.types[c] === 'number');
  const max = Object.fromEntries(numCols.map((c) => [c, Math.max(...result.rows.map((r) => Math.abs(r[c] || 0)))]));
  const mainY = state.cur.shape?.y;
  const thead = el('thead', {}, el('tr', {}, result.columns.map((c) => el('th', {
    scope: 'col', tabindex: 0, 'aria-sort': state.sort?.col === c ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null,
    onclick: () => sortBy(c), onkeydown: (e) => { if (e.key === 'Enter') sortBy(c); },
  }, c))));
  const shown = rows.slice(0, 1000);
  const tbody = el('tbody', {}, shown.map((r) => el('tr', {}, result.columns.map((c) => {
    const v = r[c]; const isNum = result.types[c] === 'number';
    const label = state.cur.intent?.metric?.column && c === mainY ? state.cur.intent.metric.column : c;
    const td = el('td', { class: isNum ? 'num' : null }, isNum ? fmtCell(v, /^\d{4}$/.test(c) ? (state.cur.intent?.metric?.column || c) : label) : (v ?? '—'));
    if (isNum && c === mainY && max[c] > 0 && v != null) td.append(el('span', { class: 'bar', style: `width:${Math.round(48 * Math.abs(v) / max[c])}px` }));
    return td;
  }))));
  tbl.append(thead, tbody);
  $('#table-foot').textContent = `${result.rows.length.toLocaleString('es-CO')} filas${result.rows.length > 1000 ? ' (la tabla muestra 1.000; el CSV las incluye todas)' : ''}. Haz clic en un encabezado para ordenar.`;
}
function sortBy(col) {
  state.sort = state.sort?.col === col ? { col, dir: -state.sort.dir } : { col, dir: -1 };
  renderTable();
}

// ---------------------------------------------------------------------------
// Exportar y compartir
// ---------------------------------------------------------------------------
function downloadCSV() {
  const { result } = state.cur || {};
  if (!result) return;
  const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [result.columns.join(','), ...result.rows.map((r) => result.columns.map((c) => esc(r[c])).join(','))].join('\n');
  downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${slug(state.cur.question || 'resultado')}.csv`);
}
function downloadPNG() {
  if (!state.chart || $('#chart').hidden) { toast('Esta respuesta no tiene gráfico para descargar.'); return; }
  const url = state.chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() });
  const a = el('a', { href: url, download: `${slug(state.cur.question || 'grafico')}.png` }); a.click();
}
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = el('a', { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const slug = (s) => normalize(s).trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'resultado';

function shareLink() {
  if (!state.cur?.question) return;
  if (!state.isDemo) { toast('Los enlaces funcionan con los datos de demostración; tu archivo solo existe en este navegador.'); return; }
  const url = `${location.origin}${location.pathname}#q=${encodeURIComponent(state.cur.question)}`;
  copy(url, 'Enlace copiado: abre la demo con esta pregunta.');
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('No se pudo copiar al portapapeles.'); }
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
function pushHistory(q) {
  state.history = [q, ...state.history.filter((x) => x !== q)].slice(0, 12);
  store.set('patd-history', state.history);
  renderHistory();
}
function renderHistory() {
  const ol = $('#history'); ol.innerHTML = '';
  if (!state.history.length) { ol.append(el('li', { class: 'empty' }, 'Tus preguntas aparecerán aquí.')); return; }
  for (const q of state.history) ol.append(el('li', {}, el('button', { type: 'button', onclick: () => { $('#pregunta').value = q; ask(q); } }, q)));
}

// ---------------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------------
const boardKey = () => `patd-board-${state.isDemo ? 'demo' : state.schema?.table}`;
function pinCurrent() {
  const cur = state.cur; if (!cur) return;
  const board = store.get(boardKey(), []);
  if (board.length >= 12) { toast('El tablero admite hasta 12 respuestas.'); return; }
  board.push({ id: Date.now(), question: cur.question, sql: cur.sql, intent: cur.intent, chartType: cur.chartType, title: $('#answer').textContent });
  store.set(boardKey(), board);
  renderBoard();
  toast('Fijado en tu tablero.');
}
const tileCharts = [];
async function renderBoard() {
  const box = $('#board');
  if (!state.schema) return;
  const board = store.get(boardKey(), []);
  tileCharts.splice(0).forEach((c) => c.dispose());
  box.innerHTML = '';
  $('#board-empty').hidden = board.length > 0;
  $('#btn-clear-board').hidden = !board.length;
  for (const item of board) {
    const chartBox = el('div', { class: 'tile-chart' });
    const tile = el('article', { class: 'tile' },
      el('header', {}, el('h3', {}, item.question),
        el('span', { class: 'tile-actions' },
          el('button', { type: 'button', onclick: () => { $('#pregunta').value = item.question; if (item.intent) { state.cur = { question: item.question, intent: item.intent, spans: item.intent.spans || [], timings: {} }; renderGloss(item.question, item.intent.spans || []); rerunIntent(item.intent); } else ask(item.question); window.scrollTo({ top: $('#result').offsetTop - 20, behavior: 'smooth' }); } }, 'Abrir'),
          el('button', { type: 'button', 'aria-label': `Quitar «${item.question}» del tablero`, onclick: () => { store.set(boardKey(), store.get(boardKey(), []).filter((b) => b.id !== item.id)); renderBoard(); } }, 'Quitar'))),
      chartBox);
    box.append(tile);
    try {
      const result = await query(item.sql);
      const shape = inferShape(result, item.intent);
      if (shape.kind === 'kpi') {
        chartBox.replaceWith(el('div', { class: 'tile-kpi' }, fmt(result.rows[0][shape.y], item.intent?.metric?.column || shape.y)), el('p', {}, item.title));
      } else if (state.echarts && shape.x) {
        const type = chartChoices(shape, result.rows).includes(item.chartType) ? item.chartType : chartChoices(shape, result.rows)[0];
        const c = state.echarts.init(chartBox, null, { renderer: 'canvas' });
        const opt = buildOption(result, shape, type);
        opt.dataZoom = []; opt.legend = shape.series ? { ...opt.legend, type: 'scroll' } : opt.legend;
        c.setOption(opt);
        tileCharts.push(c);
        new ResizeObserver(() => c.resize()).observe(chartBox);
      } else chartBox.replaceWith(el('p', {}, item.title));
    } catch (err) { chartBox.replaceWith(el('p', {}, `No se pudo actualizar: ${err.message}`)); }
  }
}

// ---------------------------------------------------------------------------
// Laboratorio: banco de pruebas en vivo
// ---------------------------------------------------------------------------
async function runLab() {
  if (!state.isDemo) { toast('El banco de pruebas usa los datos de demostración. Vuelve a la demo para ejecutarlo.'); return; }
  const btn = $('#btn-lab'); btn.disabled = true; btn.textContent = 'Ejecutando…';
  const table = $('#lab-table'); table.innerHTML = '';
  $('#lab-table-wrap').hidden = false;
  const tbody = el('tbody');
  table.append(el('thead', {}, el('tr', {}, ['Pregunta', 'Interpretación', 'SQL', 'Tiempo'].map((h) => el('th', { scope: 'col' }, h)))), tbody);
  let okI = 0; let okS = 0; let tParse = 0; let tSQL = 0;
  for (const c of EVALSET) {
    const t0 = performance.now();
    const intent = parse(c.q, state.schema);
    const sql = buildSQL(intent, state.schema);
    const tp = performance.now() - t0; tParse += tp;
    const errs = checkIntent(intent, c.expect);
    let sqlErr = null; let ts = 0; let rows = 0;
    try { const r = await timed(() => query(sql)); ts = r.ms; rows = r.value.rows.length; } catch (e) { sqlErr = e.message; }
    tSQL += ts;
    if (!errs.length) okI++;
    if (!sqlErr) okS++;
    tbody.append(el('tr', {},
      el('td', {}, el('button', { type: 'button', onclick: () => { $('#pregunta').value = c.q; ask(c.q); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, c.q)),
      el('td', {}, errs.length ? el('span', { class: 'fail' }, `✗ ${errs.join('; ')}`) : el('span', { class: 'ok' }, '✓ '), errs.length ? null : el('code', {}, explain(intent))),
      el('td', {}, sqlErr ? el('span', { class: 'fail' }, `✗ ${sqlErr}`) : el('span', { class: 'ok' }, `✓ ${rows} ${rows === 1 ? 'fila' : 'filas'}`)),
      el('td', { class: 'num' }, `${tp.toFixed(1)} + ${Math.round(ts)} ms`)));
  }
  const n = EVALSET.length;
  const sum = $('#lab-summary'); sum.hidden = false; sum.innerHTML = '';
  const stat = (b, s) => el('div', {}, el('b', {}, b), el('span', {}, s));
  sum.append(stat(`${okI}/${n}`, 'interpretaciones correctas'), stat(`${okS}/${n}`, 'consultas ejecutadas sin error'), stat(`${(tParse / n).toFixed(1)} ms`, 'interpretación promedio'), stat(`${Math.round(tSQL / n)} ms`, 'consulta promedio en DuckDB'));
  btn.disabled = false; btn.textContent = 'Ejecutar de nuevo';
}

start();
