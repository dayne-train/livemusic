/* Shared text normalization helpers for dedup + venue matching. */

const VENUE_NOISE = /\b(the|a|winery|wineries|vineyard|vineyards|cellars|brewing|brewery|brewhouse|tap|taproom|tasting|room|company|co|llc|inc|club|pub|bar|grill|restaurant|cafe|kitchen|lounge|hall|theater|theatre|house|estate|wines|farm|farms|ranch)\b/gi;

/* Aliases collapse venue spelling/specificity variants used by different sources
   (e.g. the city RSS says "Butler Bandshell" or "Lithia Park Bandshell" while
   Travel Ashland writes "Lithia Park Ashland Oregon" for the same physical venue).
   Applied after the noise-strip + space-strip, so the keys here are post-normalized. */
const VENUE_ALIASES = [
  { match: /^(butlerbandshell|lithiaparkbandshell|lithiaparkashlandoregon|lithiapark)$/, canonical: 'lithiaparkbandshell' },
];

export function venueKey(name) {
  if (!name) return '';
  const key = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(VENUE_NOISE, ' ')
    .replace(/\s+/g, '')
    .trim();
  for (const a of VENUE_ALIASES) {
    if (a.match.test(key)) return a.canonical;
  }
  return key;
}

const ARTIST_NOISE = /^(the\s+)|\s*(feat\.?|featuring|ft\.?|w\/|with|presents|presented by)\s+.*$|\([^)]*\)|\[[^\]]*\]/gi;

export function artistKey(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(ARTIST_NOISE, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/* For token-set matching we keep secondary-artist names so joint-billing
   variants ("Jen Ambrose w/ Jon Galfano" vs "Jen & Jon") still overlap.
   The artistKey above strips them; tokens do not. Joiner words themselves
   are filtered so they don't pad the set artificially. */
const ARTIST_TOKEN_NOISE = /\([^)]*\)|\[[^\]]*\]/g;
const ARTIST_TOKEN_STOP = new Set(['the', 'feat', 'featuring', 'with', 'presents', 'presented']);

export function artistTokens(name) {
  if (!name) return new Set();
  return new Set(
    name.toLowerCase()
      .replace(ARTIST_TOKEN_NOISE, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !ARTIST_TOKEN_STOP.has(t))
  );
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

export function minutesFromRaw(s) {
  if (!s) return null;
  const t = s.trim().padStart(4, '0');
  const h = parseInt(t.slice(0, t.length - 2), 10);
  const m = parseInt(t.slice(-2), 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
