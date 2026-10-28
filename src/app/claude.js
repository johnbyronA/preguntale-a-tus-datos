// Modo opcional con Claude (API de Anthropic). La llamada se hace directo
// desde el navegador con la clave que el usuario escribe; la clave no pasa
// por ningún servidor intermedio. Solo se envía el esquema (columnas, tipos y
// algunos valores de ejemplo) y la pregunta, nunca las filas de datos.

export const CLAUDE_MODELS = [
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (rápido)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (equilibrado)' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (más capaz)' },
];

function schemaForPrompt(schema) {
  return schema.columns.map((c) => {
    if (c.type === 'number') return `- "${c.name}" (${c.sqlType || 'número'}; rango ${c.min} a ${c.max})`;
    if (c.type === 'date') return `- "${c.name}" (fecha; de ${c.min} a ${c.max})`;
    const sample = (c.values?.length ? c.values : (c.top || []).map((t) => t.v)).slice(0, 25).map((v) => `"${v}"`).join(', ');
    return `- "${c.name}" (texto; ${c.distinct} valores distintos${sample ? `; ejemplos: ${sample}` : ''})`;
  }).join('\n');
}

const SYSTEM = `Eres un analista de datos que traduce preguntas de negocio en español a SQL para DuckDB.
Reglas:
- Responde SOLO con un objeto JSON válido, sin texto adicional ni bloques de código.
- El SQL debe ser una sola consulta de lectura (SELECT o WITH), compatible con DuckDB.
- Usa comillas dobles en los identificadores y los valores exactos que aparecen en el esquema.
- Las fechas relativas ("este año", "último mes") se calculan respecto a la fecha máxima de los datos, no a hoy.
- Pon primero las columnas de agrupación y después las métricas. Usa alias claros en español y snake_case.
- Si agrupas por tiempo usa strftime(date_trunc('month', CAST(col AS DATE)), '%Y-%m') y ordena cronológicamente.
- Redondea promedios y porcentajes a 2 decimales. Limita a 50 filas salvo que se pida más.
Formato de respuesta:
{"sql": "...", "explicacion": "una frase en español que diga qué calcula la consulta",
 "interpretacion": [{"fragmento": "texto literal de la pregunta", "tipo": "metric|dimension|filter|time|modifier", "etiqueta": "qué significa"}],
 "grafico": "bar|line|kpi|table"}`;

export async function askClaude({ apiKey, model, question, schema, previousError, previousSQL }) {
  const user = [
    `Tabla: "${schema.table}" (${schema.rows} filas)`,
    `Columnas:\n${schemaForPrompt(schema)}`,
    `Pregunta: ${question}`,
  ];
  if (previousError) user.push(`Tu consulta anterior falló en DuckDB.\nSQL: ${previousSQL}\nError: ${previousError}\nCorrígela.`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: user.join('\n\n') }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('La clave de API no es válida. Revísala en Ajustes de Claude.');
    throw new Error(`La API de Claude respondió con un error: ${msg}`);
  }
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('Claude no devolvió un JSON reconocible.');
  const out = JSON.parse(json[0]);
  if (!out.sql) throw new Error('La respuesta de Claude no incluye SQL.');
  return { ...out, usage: body.usage, model: body.model };
}

/** Convierte la interpretación de Claude en marcas sobre la pregunta. */
export function spansFromClaude(question, items = []) {
  const lower = question.toLowerCase();
  const spans = [];
  for (const it of items) {
    const frag = String(it.fragmento || '').toLowerCase();
    if (!frag) continue;
    const i = lower.indexOf(frag);
    if (i < 0) continue;
    const s = { start: i, end: i + frag.length, kind: ['metric', 'dimension', 'filter', 'time', 'modifier'].includes(it.tipo) ? it.tipo : 'modifier', label: it.etiqueta || '' };
    if (!spans.some((o) => o.start < s.end && s.start < o.end)) spans.push(s);
  }
  return spans.sort((a, b) => a.start - b.start);
}
