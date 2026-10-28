// Base de datos en el navegador con DuckDB-WASM. Los archivos nunca salen
// del equipo: se cargan en memoria y se consultan con SQL.
import { LIBS } from './libs.js';

let db = null;
let conn = null;

export async function initDB() {
  if (conn) return conn;
  const duckdb = await import(LIBS.duckdbModule);
  const bundle = await duckdb.selectBundle(LIBS.duckdbBundles(duckdb));
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  return conn;
}

export function tableName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[a-z]/.test(base) ? base : `t_${base}`) || 'datos';
}

/** Carga un archivo (CSV, TSV, JSON, Parquet o Excel) como tabla. */
export async function loadFile(file, name) {
  await initDB();
  const ext = file.name.split('.').pop().toLowerCase();
  const table = name || tableName(file.name);
  let reader;
  if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) {
    const XLSX = await LIBS.loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const csv = XLSX.utils.sheet_to_csv(sheet, { dateNF: 'yyyy-mm-dd' });
    await db.registerFileText(`${table}.csv`, csv);
    reader = `read_csv_auto('${table}.csv', header = true, sample_size = -1)`;
  } else {
    const fname = `${table}.${ext}`;
    await db.registerFileBuffer(fname, new Uint8Array(await file.arrayBuffer()));
    if (ext === 'parquet') reader = `read_parquet('${fname}')`;
    else if (ext === 'json' || ext === 'ndjson') reader = `read_json_auto('${fname}')`;
    else reader = `read_csv_auto('${fname}', header = true, sample_size = -1)`;
  }
  await conn.query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM ${reader}`);
  return table;
}

export async function loadURL(url, table) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url} (${res.status})`);
  const blob = await res.blob();
  return loadFile(new File([blob], url.split('/').pop()), table);
}

const NUM = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/;
const INT = /INT/;

function toJS(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

/**
 * Ejecuta SQL y devuelve {columns, types, rows}. Convierte enteros grandes y
 * decimales a número de JavaScript y las fechas a texto ISO.
 */
export async function query(sql, { maxRows = 5000 } = {}) {
  await initDB();
  const clean = sql.trim().replace(/;+\s*$/, '');
  const desc = await conn.query(`DESCRIBE SELECT * FROM (${clean}) AS _d`);
  const cols = desc.toArray().map((r) => ({ name: r.column_name, type: String(r.column_type) }));
  const sel = cols.map((c) => {
    const id = `"${c.name.replace(/"/g, '""')}"`;
    if (/^(HUGEINT|UHUGEINT|BIGINT|UBIGINT|DECIMAL)/.test(c.type)) return `CAST(${id} AS DOUBLE) AS ${id}`;
    if (/^(DATE|TIMESTAMP|TIME|INTERVAL)/.test(c.type)) return `CAST(${id} AS VARCHAR) AS ${id}`;
    if (/\[\]$|^(STRUCT|MAP|LIST|UNION|BLOB)/.test(c.type)) return `CAST(${id} AS VARCHAR) AS ${id}`;
    return id;
  }).join(', ');
  const res = await conn.query(`SELECT ${sel} FROM (${clean}) AS _r LIMIT ${maxRows + 1}`);
  const rows = res.toArray().map((r) => {
    const o = {};
    for (const c of cols) o[c.name] = toJS(r[c.name]);
    return o;
  });
  const truncated = rows.length > maxRows;
  if (truncated) rows.pop();
  return {
    columns: cols.map((c) => c.name),
    types: Object.fromEntries(cols.map((c) => [c.name, NUM.test(c.type) ? 'number' : /^(DATE|TIMESTAMP)/.test(c.type) ? 'date' : 'text'])),
    rows, truncated,
  };
}

/**
 * Perfil de la tabla: tipos, rangos, nulos, valores frecuentes e histograma.
 * Es el "esquema" que usa el motor para entender las preguntas.
 */
export async function profile(table) {
  await initDB();
  const desc = (await conn.query(`DESCRIBE "${table}"`)).toArray();
  const total = Number((await conn.query(`SELECT COUNT(*) AS n FROM "${table}"`)).toArray()[0].n);
  const columns = [];
  for (const r of desc) {
    const name = r.column_name; const t = String(r.column_type); const id = `"${name.replace(/"/g, '""')}"`;
    const base = { name, sqlType: t };
    if (NUM.test(t)) {
      const s = (await conn.query(`SELECT CAST(MIN(${id}) AS DOUBLE) mn, CAST(MAX(${id}) AS DOUBLE) mx, CAST(AVG(${id}) AS DOUBLE) av, COUNT(*) - COUNT(${id}) nn, COUNT(DISTINCT ${id}) d FROM "${table}"`)).toArray()[0];
      const mn = Number(s.mn); const mx = Number(s.mx);
      let hist = [];
      if (Number.isFinite(mn) && mx > mn) {
        const h = (await conn.query(`SELECT LEAST(CAST(FLOOR((${id} - ${mn}) / ${(mx - mn) / 16}) AS INT), 15) b, COUNT(*) c FROM "${table}" WHERE ${id} IS NOT NULL GROUP BY 1 ORDER BY 1`)).toArray();
        hist = Array(16).fill(0); for (const x of h) hist[Number(x.b)] = Number(x.c);
      }
      columns.push({ ...base, type: 'number', integer: INT.test(t), min: mn, max: mx, avg: Number(s.av), nulls: Number(s.nn), distinct: Number(s.d), hist });
    } else if (/^(DATE|TIMESTAMP)/.test(t)) {
      const s = (await conn.query(`SELECT CAST(MIN(CAST(${id} AS DATE)) AS VARCHAR) mn, CAST(MAX(CAST(${id} AS DATE)) AS VARCHAR) mx, COUNT(*) - COUNT(${id}) nn FROM "${table}"`)).toArray()[0];
      const h = (await conn.query(`SELECT strftime(date_trunc('month', CAST(${id} AS DATE)), '%Y-%m') m, COUNT(*) c FROM "${table}" WHERE ${id} IS NOT NULL GROUP BY 1 ORDER BY 1`)).toArray();
      columns.push({ ...base, type: 'date', min: s.mn, max: s.mx, nulls: Number(s.nn), hist: h.map((x) => Number(x.c)) });
    } else {
      const s = (await conn.query(`SELECT COUNT(DISTINCT ${id}) d, COUNT(*) - COUNT(${id}) nn FROM "${table}"`)).toArray()[0];
      const d = Number(s.d);
      const top = (await conn.query(`SELECT CAST(${id} AS VARCHAR) v, COUNT(*) c FROM "${table}" WHERE ${id} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${d <= 200 ? 200 : 5}`)).toArray();
      columns.push({ ...base, type: 'text', distinct: d, nulls: Number(s.nn), values: d <= 200 ? top.map((x) => x.v) : [], top: top.slice(0, 5).map((x) => ({ v: x.v, c: Number(x.c) })) });
    }
  }
  return { table, rows: total, columns };
}

/** Rechaza SQL que no sea de solo lectura. */
export function assertReadOnly(sql) {
  const s = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = s.trim().replace(/;+\s*$/, '');
  if (body.includes(';')) throw new Error('Solo se permite una instrucción SQL a la vez.');
  if (!/^(select|with|from|describe|summarize|values|pivot|unpivot)\b/i.test(body)) throw new Error('Solo se permiten consultas de lectura (SELECT o WITH).');
  const bad = body.match(/\b(copy|attach|detach|install|load|pragma|export|import|create|drop|insert|update|delete|alter|set|call|checkpoint|vacuum|truncate)\b/i);
  if (bad) throw new Error(`La instrucción «${bad[1].toUpperCase()}» no está permitida: la demo es de solo lectura.`);
}
