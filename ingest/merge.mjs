import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ingest as ingestMusiclistTxt } from './adapters/musiclist_txt.mjs';
import { ingest as ingestTribeIcs } from './adapters/tribe_ics.mjs';
import { ingest as ingestTalentClub } from './adapters/talent_club.mjs';
import { venueKey, artistKey, artistTokens, jaccard, minutesFromRaw } from './lib/text.mjs';
import { canonicalizeGenres, hasOtherSignal } from './lib/genres.mjs';
import { Spotify, isGenericArtistName } from './lib/spotify.mjs';
import { GenreCache } from './lib/genre_cache.mjs';

const DATA_DIR = new URL('../data/', import.meta.url);
const EVENTS_OUT = new URL('events.json', DATA_DIR);
const META_OUT = new URL('meta.json', DATA_DIR);
const SNAPSHOT_OUT = new URL('musiclist.txt', DATA_DIR);

const OFFLINE = process.argv.includes('--offline');

const ADAPTERS = [
  { name: 'musiclist_txt', trust: 100, run: () => ingestMusiclistTxt({ offline: OFFLINE }) },
  { name: 'tribe_ics',     trust: 80,  run: () => ingestTribeIcs({ offline: OFFLINE }) },
  { name: 'talent_club',   trust: 80,  run: () => ingestTalentClub({ offline: OFFLINE }) },
];

const TIME_WINDOW_MIN = 90;
const ARTIST_JACCARD_THRESHOLD = 0.6;

function mergeVenues(results) {
  const sorted = [...results].sort((a, b) => b.trust - a.trust);
  const out = {};
  for (const r of sorted) {
    if (!r.ok) continue;
    for (const [name, v] of Object.entries(r.venues || {})) {
      if (!out[name]) out[name] = { ...v, _sources: [r.name] };
      else {
        for (const [k, val] of Object.entries(v)) {
          if (!out[name][k] && val) out[name][k] = val;
        }
        if (!out[name]._sources.includes(r.name)) out[name]._sources.push(r.name);
      }
    }
  }
  return out;
}

function dedupeEvents(results) {
  const sorted = [...results].sort((a, b) => b.trust - a.trust);
  const trustByName = new Map(sorted.map(r => [r.name, r.trust]));
  const buckets = new Map();
  const dropped = [];

  for (const r of sorted) {
    if (!r.ok) continue;
    for (const e of r.events) {
      const enriched = {
        ...e,
        _venue_key: venueKey(e.venue),
        _artist_key: artistKey(e.musician),
        _artist_tokens: artistTokens(e.musician),
        _start_min: minutesFromRaw(e.start_raw),
        _trust: trustByName.get(r.name) || 0,
        _source_name: r.name,
      };
      const bucketKey = `${enriched._venue_key}|${e.date}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      const bucket = buckets.get(bucketKey);

      const match = bucket.find(existing => {
        if (existing._artist_key && enriched._artist_key && existing._artist_key === enriched._artist_key) return true;
        const j = jaccard(existing._artist_tokens, enriched._artist_tokens);
        const timeOk =
          existing._start_min == null ||
          enriched._start_min == null ||
          Math.abs(existing._start_min - enriched._start_min) <= TIME_WINDOW_MIN;
        return j >= ARTIST_JACCARD_THRESHOLD && timeOk;
      });

      if (!match) {
        bucket.push(enriched);
      } else {
        for (const [k, v] of Object.entries(enriched)) {
          if (k.startsWith('_')) continue;
          if (!match[k] && v) match[k] = v;
        }
        match._merged_from = match._merged_from || [];
        match._merged_from.push({ source: enriched._source_name, id: enriched.id });
        dropped.push({ kept: match.id, dropped_source: enriched._source_name, dropped_id: enriched.id, venue: e.venue, date: e.date, musician: e.musician });
      }
    }
  }

  const out = [];
  for (const bucket of buckets.values()) {
    for (const e of bucket) {
      const { _venue_key, _artist_key, _artist_tokens, _start_min, _trust, _source_name, _merged_from, ...clean } = e;
      if (_merged_from && _merged_from.length) clean.merged_from = _merged_from;
      out.push(clean);
    }
  }
  out.sort((a, b) => (a.date + (a.start_raw || '0000')).localeCompare(b.date + (b.start_raw || '0000')));
  return { events: out, dropped };
}

async function readExistingMeta() {
  try { return JSON.parse(await readFile(META_OUT, 'utf8')); } catch { return null; }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const results = [];
  for (const adapter of ADAPTERS) {
    process.stdout.write(`[${adapter.name}] running...`);
    try {
      const res = await adapter.run();
      results.push({ ...res, name: adapter.name, trust: adapter.trust });
      if (res.ok) process.stdout.write(` ok (${res.count} events, strategy=${res.strategy})\n`);
      else process.stdout.write(` FAILED (${res.error})\n`);
    } catch (err) {
      results.push({ ok: false, count: 0, events: [], venues: {}, source_timestamp: null, error: err.message, strategy: null, fetched_at: new Date().toISOString(), name: adapter.name, trust: adapter.trust });
      process.stdout.write(` THREW (${err.message})\n`);
    }
  }

  const venues = mergeVenues(results);
  const { events, dropped } = dedupeEvents(results);

  const musicianGenres = results.find(r => r.name === 'musiclist_txt' && r.ok)?.musician_genres || {};
  const GENRE_CAP = 3;
  for (const e of events) {
    // Sources in descending confidence. Specific BUCKETS are ordered most to least
    // specific, so canonicalizeGenres returns specific-first; the cap keeps top 3.
    const dictGenre = musicianGenres[e.musician] || null;
    const probeStrings = [e.genre, dictGenre, e.musician, e.notes].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const s of probeStrings) {
      for (const g of canonicalizeGenres(s)) {
        if (seen.has(g)) continue;
        seen.add(g);
        out.push(g);
        if (out.length >= GENRE_CAP) break;
      }
      if (out.length >= GENRE_CAP) break;
    }
    // Add Other only if nothing specific matched and any source mentions cover/variety.
    if (out.length === 0 && probeStrings.some(hasOtherSignal)) out.push('Other');
    e.genres = out;
    // Backfill the raw display genre from the dictionary if blank.
    if (!e.genre && dictGenre) e.genre = dictGenre;
  }

  // Spotify enrichment: for events still untagged, look up the artist in the
  // genre cache (querying Spotify on first encounter). Skips entirely if no
  // credentials are configured.
  const spotify = Spotify.fromEnv();
  const cache = new GenreCache();
  await cache.load();
  let spotifyQueried = 0, spotifyHits = 0, spotifyMisses = 0, spotifyErrors = 0;

  const untaggedArtists = new Set();
  for (const e of events) {
    if (e.genres.length === 0 && !isGenericArtistName(e.musician)) {
      untaggedArtists.add(e.musician);
    }
  }

  if (spotify) {
    const toQuery = [...untaggedArtists].filter(name => !cache.has(name));
    if (toQuery.length) console.log(`[spotify] querying ${toQuery.length} new artist${toQuery.length === 1 ? '' : 's'}...`);
    for (const name of toQuery) {
      try {
        const result = await spotify.lookupArtist(name);
        const fetched_at = new Date().toISOString();
        if (!result) {
          cache.set(name, { spotify_id: null, spotify_genres: [], canonical: [], no_match: true, fetched_at });
          spotifyMisses++;
        } else {
          const canonical = [...new Set(result.genres.flatMap(g => canonicalizeGenres(g)))];
          cache.set(name, {
            spotify_id: result.spotify_id,
            spotify_name: result.name,
            spotify_genres: result.genres,
            canonical,
            fetched_at,
          });
          spotifyHits++;
        }
        spotifyQueried++;
      } catch (err) {
        console.warn(`[spotify] ${name}: ${err.message}`);
        spotifyErrors++;
        if (spotifyErrors >= 5) {
          console.warn('[spotify] too many errors, aborting Spotify pass');
          break;
        }
      }
    }
    if (cache.dirty) await cache.save();
  } else {
    console.log('[spotify] no credentials in env, skipping enrichment');
  }

  // Apply cache to untagged events (covers both newly-queried and previously-cached).
  let enrichedCount = 0;
  for (const e of events) {
    if (e.genres.length > 0) continue;
    if (isGenericArtistName(e.musician)) continue;
    const cached = cache.get(e.musician);
    if (cached && Array.isArray(cached.canonical) && cached.canonical.length > 0) {
      e.genres = cached.canonical.slice(0, GENRE_CAP);
      enrichedCount++;
    }
  }
  if (spotify) {
    console.log(`[spotify] queried=${spotifyQueried} hits=${spotifyHits} misses=${spotifyMisses} errors=${spotifyErrors} cache_size=${cache.size()} events_enriched=${enrichedCount}`);
  }

  const sourceTimestamp =
    results.find(r => r.ok && r.source_timestamp)?.source_timestamp || null;

  const sources = {};
  const existingMeta = await readExistingMeta();
  const prevSources = (existingMeta && existingMeta.sources) || {};
  for (const r of results) {
    const prev = prevSources[r.name] || {};
    sources[r.name] = {
      ok: r.ok,
      count: r.count,
      strategy: r.strategy || null,
      last_ok: r.ok ? r.fetched_at : prev.last_ok || null,
      last_attempt: r.fetched_at,
      error: r.error || null,
    };
  }

  const generated_at = new Date().toISOString();

  const contentHash = createHash('sha256')
    .update(JSON.stringify({
      events: events.map(e => ({ ...e, merged_from: undefined })),
      venues,
      source_timestamp: sourceTimestamp,
    }))
    .digest('hex')
    .slice(0, 16);

  const eventsJson = {
    generated_at,
    source_timestamp: sourceTimestamp,
    content_hash: contentHash,
    sources,
    venues,
    events,
  };

  await writeFile(EVENTS_OUT, JSON.stringify(eventsJson, null, 2) + '\n');

  const rawTxt = results.find(r => r.name === 'musiclist_txt' && r.ok && r.raw)?.raw;
  if (rawTxt) await writeFile(SNAPSHOT_OUT, rawTxt);

  const meta = {
    fetched_at: generated_at,
    source_timestamp: sourceTimestamp || 'unknown',
    bytes: rawTxt ? Buffer.byteLength(rawTxt, 'utf8') : (existingMeta?.bytes ?? 0),
    sources,
    event_count: events.length,
    venue_count: Object.keys(venues).length,
    deduped: dropped.length,
    content_hash: contentHash,
  };
  await writeFile(META_OUT, JSON.stringify(meta, null, 2) + '\n');

  console.log(`\nwrote ${events.length} events, ${Object.keys(venues).length} venues, deduped ${dropped.length}`);
  if (dropped.length) {
    console.log('\nDedup samples (first 5):');
    for (const d of dropped.slice(0, 5)) {
      console.log(`  ${d.venue} ${d.date} ${d.musician} (kept primary, dropped ${d.dropped_source})`);
    }
  }
  console.log(`source_timestamp: ${sourceTimestamp || 'unknown'}`);
}

main().catch(err => {
  console.error('merge failed:', err);
  process.exit(1);
});
