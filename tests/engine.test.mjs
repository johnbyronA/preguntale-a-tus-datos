// Pruebas del motor: interpretación de cada pregunta del banco y ejecución
// real del SQL generado contra los datos de demostración (DuckDB nativo).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { parse, buildSQL } from '../src/engine/nl2sql.js';
import { EVALSET, checkIntent } from '../src/engine/evalset.js';
import { findTimeExpressions } from '../src/engine/time.js';
import { normalize, parseNumber } from '../src/engine/text.js';

const schema = JSON.parse(readFileSync(new URL('./fixtures/schema_ventas.json', import.meta.url), 'utf8'));
let con;
before(async () => {
  const db = await DuckDBInstance.create(':memory:');
  con = await db.connect();
  await con.run(`CREATE TABLE ventas AS SELECT * FROM read_csv_auto('${new URL('../data/ventas_demo.csv', import.meta.url).pathname}')`);
});

for (const c of EVALSET) {
  test(c.q, async () => {
    const intent = parse(c.q, schema);
    assert.deepEqual(checkIntent(intent, c.expect), []);
    const sql = buildSQL(intent, schema);
    const res = await con.runAndReadAll(sql);
    assert.ok(res.getRows().length > 0, 'la consulta no devolvió filas');
  });
}

test('normalize conserva la longitud (las marcas se alinean con el texto)', () => {
  const s = '¿Cuánto vendió Medellín en el último año?';
  assert.equal(normalize(s).length, s.length);
});

test('números en español', () => {
  assert.equal(parseNumber('1.500.000'), 1500000);
  assert.equal(parseNumber('2,5 millones'), 2500000);
  assert.equal(parseNumber('500 mil'), 500000);
  assert.equal(parseNumber('diez'), 10);
});

test('fechas relativas se calculan contra la última fecha de los datos', () => {
  const t = findTimeExpressions(normalize('ventas del mes pasado'), '2026-09-30');
  assert.deepEqual(t[0].range, { from: '2026-08-01', to: '2026-08-31' });
});

test('una pregunta sin nada reconocible tiene confianza baja', () => {
  const i = parse('hola, ¿cómo estás?', schema);
  assert.ok(i.confidence <= 0.2);
});

// Los ejemplos de la guía se generan para cualquier tabla: todos deben
// entenderse y ejecutarse, tanto en la demo como en una tabla distinta.
import { buildGuide } from '../src/engine/guide.js';
import { profileNode } from './profile-node.mjs';

for (const [table, file] of [['ventas', '../data/ventas_demo.csv'], ['gastos', './fixtures/gastos.csv']]) {
  test(`guía: todos los ejemplos funcionan con la tabla ${table}`, async () => {
    if (table !== 'ventas') await con.run(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${new URL(file, import.meta.url).pathname}')`);
    const sch = await profileNode(con, table);
    const items = buildGuide(sch).flatMap((g) => g.items);
    assert.ok(items.length >= 18, `solo ${items.length} ejemplos`);
    for (const it of items) {
      const intent = parse(it.example, sch);
      assert.ok(intent.confidence > 0.3, `poca confianza en «${it.example}»`);
      const res = await con.runAndReadAll(buildSQL(intent, sch));
      assert.ok(res.getRows().length > 0, `sin filas: «${it.example}»`);
    }
  });
}
