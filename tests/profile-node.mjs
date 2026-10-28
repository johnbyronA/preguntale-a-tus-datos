// Perfil de una tabla con DuckDB nativo, con la misma forma que src/app/db.js.
export async function profileNode(con, table) {
  const NUM = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|U)/;
  const rows = async (sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
  const desc = await rows(`DESCRIBE "${table}"`);
  const total = Number((await rows(`SELECT COUNT(*) n FROM "${table}"`))[0].n);
  const columns = [];
  for (const d of desc) {
    const name = d.column_name; const t = String(d.column_type); const id = `"${name}"`;
    if (NUM.test(t)) {
      const s = (await rows(`SELECT CAST(MIN(${id}) AS DOUBLE) mn, CAST(MAX(${id}) AS DOUBLE) mx, COUNT(DISTINCT ${id}) d FROM "${table}"`))[0];
      columns.push({ name, type: 'number', integer: /INT/.test(t), min: Number(s.mn), max: Number(s.mx), distinct: Number(s.d) });
    } else if (/^(DATE|TIMESTAMP)/.test(t)) {
      const s = (await rows(`SELECT CAST(MIN(CAST(${id} AS DATE)) AS VARCHAR) mn, CAST(MAX(CAST(${id} AS DATE)) AS VARCHAR) mx FROM "${table}"`))[0];
      columns.push({ name, type: 'date', min: s.mn, max: s.mx });
    } else {
      const d = Number((await rows(`SELECT COUNT(DISTINCT ${id}) d FROM "${table}"`))[0].d);
      const top = await rows(`SELECT CAST(${id} AS VARCHAR) v FROM "${table}" GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 200`);
      columns.push({ name, type: 'text', distinct: d, values: d <= 200 ? top.map((x) => x.v) : [] });
    }
  }
  return { table, rows: total, columns };
}
