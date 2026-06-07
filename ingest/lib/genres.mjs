/* Map messy raw genre text to a small canonical set so the Genre filter
   is usable. Multiple canonical buckets per event are allowed.
   Returns an array of canonical genre names. */

const BUCKETS = [
  ['Bluegrass', /\bblue\s*grass|bluegrass|newgrass\b/i],
  ['Rockabilly', /\brockabilly|psychobilly\b/i],
  ['Country', /\bcountry|honky\s*tonk|americana|outlaw\b/i],
  ['Blues', /\bblues|delta\b/i],
  ['Jazz', /\bjazz|bebop|gypsy\s*jazz\b/i],
  ['Swing', /\bswing|big\s*band\b/i],
  ['Folk', /\bfolk|singer.?songwriter|acoustic\b/i],
  ['Celtic', /\bceltic|irish|scottish\b/i],
  ['Latin', /\blatin|salsa|cumbia|mariachi|flamenco|bachata\b/i],
  ['Reggae', /\breggae|ska|dub|dancehall\b/i],
  ['Funk / Soul', /\bfunk|soul|r&b|rnb|motown|gospel\b/i],
  ['Hip Hop', /\bhip.?hop|rap\b/i],
  ['Electronic / DJ', /\belectronic|edm|house|techno|trance|\bdj\b|drum\s*&?\s*bass|dnb\b/i],
  ['Punk / Metal', /\bpunk|metal|hardcore|grunge\b/i],
  ['Rock', /\brock\b|alt(ernative)?|indie|psychedelic|garage\b/i],
  ['Pop', /\bpop\b/i],
  ['Classical', /\bclassical|orchestral|chamber|opera\b/i],
  ['World', /\bworld|african|asian|middle.?eastern|polka|klezmer\b/i],
];

const ORIGINAL_RE = /\boriginal(s)?\b/i;
const VARIETY_RE = /\bvariety|cover(s|ed)?|tribute|all.?genres?\b/i;

export function canonicalizeGenres(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const found = new Set();
  for (const [name, re] of BUCKETS) {
    if (re.test(raw)) found.add(name);
  }
  if (found.size === 0) {
    if (ORIGINAL_RE.test(raw) || VARIETY_RE.test(raw)) found.add('Other');
  }
  return [...found];
}

export function allCanonicalGenres() {
  return BUCKETS.map(([name]) => name).concat(['Other']);
}
