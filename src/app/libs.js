// Origen de las librerías. Por defecto se cargan desde jsDelivr; con
// ?local=1 se usan copias en /vendor (útil sin internet o en pruebas).
const DUCKDB_VERSION = '1.33.1-dev57.0';
const ECHARTS_VERSION = '5.6.0';
const XLSX_VERSION = '0.18.5';

const local = new URLSearchParams(location.search).has('local');
const base = new URL('../../', import.meta.url).href; // raíz del sitio

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}. Revisa la conexión a internet.`));
    document.head.appendChild(s);
  });
}

export const LIBS = {
  duckdbModule: local
    ? `${base}vendor/duckdb/duckdb-browser.mjs`
    : `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`,
  duckdbBundles(duckdb) {
    if (!local) return duckdb.getJsDelivrBundles();
    const d = `${base}vendor/duckdb/`;
    return {
      mvp: { mainModule: `${d}duckdb-mvp.wasm`, mainWorker: `${d}duckdb-browser-mvp.worker.js` },
      eh: { mainModule: `${d}duckdb-eh.wasm`, mainWorker: `${d}duckdb-browser-eh.worker.js` },
    };
  },
  loadECharts: () => loadScript(local ? `${base}vendor/echarts.min.js` : `https://cdn.jsdelivr.net/npm/echarts@${ECHARTS_VERSION}/dist/echarts.min.js`, 'echarts'),
  loadXLSX: () => loadScript(local ? `${base}vendor/xlsx.full.min.js` : `https://cdn.jsdelivr.net/npm/xlsx@${XLSX_VERSION}/dist/xlsx.full.min.js`, 'XLSX'),
  versions: { duckdb: DUCKDB_VERSION, echarts: ECHARTS_VERSION, xlsx: XLSX_VERSION },
};
