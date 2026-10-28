// Utilidades de texto en español: normalización 1:1 (conserva posiciones),
// plurales, números escritos y meses.

/** Minúsculas, sin tildes, signos → espacio. Conserva la longitud para mapear posiciones. */
export function normalize(str) {
  let out = '';
  for (const ch of String(str)) {
    let c = ch.toLowerCase();
    const folded = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (folded.length === 1) c = folded;
    if (c.length !== 1) c = ' ';
    // se conservan letras, dígitos y símbolos útiles para números y comparadores
    if (!/[a-z0-9.,%$<>=]/.test(c)) c = ' ';
    // un punto/coma que no está entre dígitos es puntuación
    out += c;
  }
  // limpia puntos y comas que no forman parte de un número
  return out.replace(/[.,](?!\d)/g, ' ').replace(/(?<!\d)[.,]/g, ' ');
}

/** Normaliza un nombre de columna o valor a frase buscable ("precio_unitario" → "precio unitario"). */
export function phrase(str) {
  const spaced = String(str)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-/]+/g, ' ');
  return normalize(spaced).replace(/[.,%$<>=]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function pluralize(word) {
  if (!word || /\d$/.test(word)) return word;
  if (/[aeiou]$/.test(word)) return word + 's';
  if (/z$/.test(word)) return word.slice(0, -1) + 'ces';
  if (/s$/.test(word)) return word;
  return word + 'es';
}

export function singularize(word) {
  if (/ces$/.test(word)) return word.slice(0, -3) + 'z';
  if (/(ion|dad|or|al|ar|el|il|ol|ul|en|on|an)es$/.test(word)) return word.slice(0, -2);
  if (/[aeiou]s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex de frase completa con límites de palabra. */
export function wordRegex(p, flags = 'g') {
  const body = escapeRegex(p).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, flags);
}

const NUM_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30,
};
export const NUM_WORD_RE = Object.keys(NUM_WORDS).join('|');

/** Convierte "1.500.000", "2,5", "3 millones", "500 mil", "diez", "1.5m" en número. */
export function parseNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim().replace(/\$/g, '').replace(/\s+/g, ' ');
  if (NUM_WORDS[s] != null) return NUM_WORDS[s];
  let mult = 1;
  const m = s.match(/^(.*?)\s*(millones|millon|mil|k|m|mm|billones|billon)$/);
  if (m) {
    s = m[1];
    mult = { millones: 1e6, millon: 1e6, mm: 1e6, m: 1e6, mil: 1e3, k: 1e3, billones: 1e12, billon: 1e12 }[m[2]];
  }
  s = s.replace(/%$/, '').trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.500.000,5
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); // 1,500,000.5
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : NaN;
}

export const MONTHS = [
  ['enero', 'ene'], ['febrero', 'feb'], ['marzo', 'mar'], ['abril', 'abr'], ['mayo', 'may'],
  ['junio', 'jun'], ['julio', 'jul'], ['agosto', 'ago'], ['septiembre', 'sep', 'sept', 'setiembre'],
  ['octubre', 'oct'], ['noviembre', 'nov'], ['diciembre', 'dic'],
];
export const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function monthIndex(word) {
  const w = word.toLowerCase();
  return MONTHS.findIndex((names) => names.includes(w)) + 1; // 1..12, 0 si no
}

export const STOPWORDS = new Set(('de del la las el los un una unos unas y o en por para con sin que cual cuales ' +
  'como cuanto cuanta cuantos cuantas es son fue fueron ha han hay al a se su sus mi mis me lo le les ' +
  'mas menos muy total totales cada todo todos toda todas este esta estos estas ese esa entre desde hasta ' +
  'segun sobre ver dame muestra muestrame mostrar quiero necesito').split(' '));
