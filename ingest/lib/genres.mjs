/* Map messy raw genre text to a small canonical set so the Genre filter
   is usable. Multiple canonical buckets per event are allowed.
   Returns an array of canonical genre names. */

const BUCKETS = [
  ['Bluegrass',       ['bluegrass', 'blue grass', 'newgrass']],
  ['Rockabilly',      ['rockabilly', 'psychobilly']],
  ['Country',         ['country', 'honky tonk', 'honkytonk', 'americana', 'outlaw country']],
  ['Blues',           ['blues', 'delta']],
  ['Jazz',            ['jazz', 'bebop', 'gypsy jazz']],
  ['Swing',           ['swing', 'big band']],
  ['Folk',            ['folk', 'singer songwriter', 'singer-songwriter', 'acoustic']],
  ['Celtic',          ['celtic', 'irish', 'scottish']],
  ['Latin',           ['latin', 'salsa', 'cumbia', 'mariachi', 'flamenco', 'bachata']],
  ['Reggae',          ['reggae', 'ska', 'dub', 'dancehall']],
  ['Funk / Soul',     ['funk', 'soul', 'r&b', 'rnb', 'motown', 'gospel']],
  ['Hip Hop',         ['hip hop', 'hip-hop', 'hiphop', 'rap']],
  ['Electronic / DJ', ['electronic', 'edm', 'house music', 'techno', 'trance', 'dj', 'drum and bass', 'dnb']],
  ['Punk / Metal',    ['punk', 'metal', 'hardcore', 'grunge']],
  ['Rock',            ['rock', 'alternative', 'alt rock', 'indie', 'indie rock', 'psychedelic', 'garage']],
  ['Pop',             ['pop', 'indie pop']],
  ['Classical',       ['classical', 'orchestral', 'chamber', 'opera']],
  ['World',           ['world music', 'world', 'african', 'middle eastern', 'polka', 'klezmer']],
];

/* Catch-all triggers: when raw text says "variety" / "originals" / "covers" /
   "tribute" but doesn't fit a specific bucket, treat as Other. Only fires if
   no specific bucket matched. */
const OTHER_TOKENS = ['variety', 'original', 'originals', 'cover', 'covers', 'tribute', 'all genres', 'eclectic'];

/* Build a case-insensitive word-bounded regex from a list of phrases. Spaces
   match any whitespace; & matches optional whitespace on both sides. */
function buildRe(phrases) {
  const escaped = phrases.map(p =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
     .replace(/\s+/g, '\\s+')
     .replace(/&/g, '\\s*&\\s*')
  );
  return new RegExp('\\b(?:' + escaped.join('|') + ')\\b', 'i');
}

const BUCKET_RES = BUCKETS.map(([name, phrases]) => [name, buildRe(phrases)]);
const OTHER_RE = buildRe(OTHER_TOKENS);

export function canonicalizeGenres(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const found = [];
  for (const [name, re] of BUCKET_RES) {
    if (re.test(raw)) found.push(name);
  }
  return found;
}

/* Returns true if the raw text hints at cover/variety/originals music. Use
   from the merge step to add Other only when no specific genre matched. */
export function hasOtherSignal(raw) {
  return !!raw && typeof raw === 'string' && OTHER_RE.test(raw);
}

export function allCanonicalGenres() {
  return BUCKETS.map(([name]) => name).concat(['Other']);
}
