// Copia las librerías a /vendor para usar la demo sin CDN (?local=1).
// Uso: npm install && npm run vendor
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const nm = 'node_modules';
mkdirSync('vendor/duckdb', { recursive: true });
await build({
  entryPoints: [`${nm}/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs`],
  bundle: true, format: 'esm', outfile: 'vendor/duckdb/duckdb-browser.mjs', minify: true, logLevel: 'warning',
});
for (const f of ['duckdb-mvp.wasm', 'duckdb-eh.wasm', 'duckdb-browser-mvp.worker.js', 'duckdb-browser-eh.worker.js']) {
  cpSync(`${nm}/@duckdb/duckdb-wasm/dist/${f}`, `vendor/duckdb/${f}`);
}
cpSync(`${nm}/echarts/dist/echarts.min.js`, 'vendor/echarts.min.js');
cpSync(`${nm}/xlsx/dist/xlsx.full.min.js`, 'vendor/xlsx.full.min.js');
console.log('vendor/ listo');
