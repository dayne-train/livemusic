import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ingest as ingestMusiclistTxt } from './adapters/musiclist_txt.mjs';
import { ingest as ingestTribeIcs } from './adapters/tribe_ics.mjs';
import { ingest as ingestTalentClub } from './adapters/talent_club.mjs';
import { ingest as ingestBlackSheep } from './adapters/black_sheep.mjs';
import { ingest as ingestSouLocalist } from './adapters/sou_localist.mjs';
import { ingest as ingestAshlandCity } from './adapters/ashland_city.mjs';
import { venueKey, artistKey, artistTokens, jaccard, minutesFromRaw } from './lib/text.mjs';
import { canonicalizeGenres, hasOtherSignal } from './lib/genres.mjs';

const DATA_DIR = new URL('../data/', import.meta.url);
const EVENTS_OUT = new URL('events.json', DATA_DIR);
const META_OUT = new URL('meta.json', DATA_DIR);
const SNAPSHOT_OUT = new URL('musiclist.txt', DATA_DIR);

const OFFLINE = process.argv.includes('--offline');

/* events.json keeps this many days of recent past; anything older lives in the
   per-year archive files (data/archive-YYYY.json), which are append-only: once
   a show lands there it never leaves, even after every source feed drops it. */
const KEEP_PAST_DAYS = 30;

function laTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function isoAddDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Upsert past-dated events into the per-year archive files. Newer versions of
   the same event id replace older ones; nothing is ever removed. Returns a
   summary of files written. Exported for reuse by backfill-archive.mjs. */
export async function upsertArchive(candidates, venueDict) {
  const byYear = new Map();
  for (const e of candidates.values()) {
    const y = e.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(e);
  }
  const written = [];
  for (const [year, evts] of byYear) {
    const outUrl = new URL(`archive-${year}.json`, DATA_DIR);
    let existing = null;
    try { existing = JSON.parse(await readFile(outUrl, 'utf8')); } catch {}
    const merged = new Map((existing?.events || []).map(e => [e.id, e]));
    for (const e of evts) merged.set(e.id, e);
    const mergedEvents = [...merged.values()].sort((a, b) =>
      (a.date + (a.start_raw || '0000') + a.id).localeCompare(b.date + (b.start_raw || '0000') + b.id));
    const archVenues = { ...(existing?.venues || {}) };
    for (const e of mergedEvents) {
      const v = venueDict[e.venue];
      if (v) archVenues[e.venue] = v;
    }
    const sortedVenues = Object.fromEntries(Object.keys(archVenues).sort().map(k => [k, archVenues[k]]));
    const payload = { year: +year, event_count: mergedEvents.length, venues: sortedVenues, events: mergedEvents };
    const str = JSON.stringify(payload, null, 2) + '\n';
    let prevStr = null;
    try { prevStr = await readFile(outUrl, 'utf8'); } catch {}
    if (str !== prevStr) {
      await writeFile(outUrl, str);
      written.push({ year, count: mergedEvents.length });
    }
  }
  return written;
}

const ADAPTERS = [
  { name: 'musiclist_txt', trust: 100, run: () => ingestMusiclistTxt({ offline: OFFLINE }) },
  { name: 'tribe_ics',     trust: 80,  run: () => ingestTribeIcs({ offline: OFFLINE }) },
  { name: 'talent_club',   trust: 80,  run: () => ingestTalentClub({ offline: OFFLINE }) },
  { name: 'black_sheep',   trust: 80,  run: () => ingestBlackSheep({ offline: OFFLINE }) },
  { name: 'sou_localist',  trust: 80,  run: () => ingestSouLocalist({ offline: OFFLINE }) },
  { name: 'ashland_city',  trust: 80,  run: () => ingestAshlandCity({ offline: OFFLINE }) },
];

const TIME_WINDOW_MIN = 90;
const ARTIST_JACCARD_THRESHOLD = 0.6;
/* When two events share the EXACT same start minute at the same venue + date,
   a coincidence on the minute is extremely unlikely if they were separate shows.
   The artist-overlap bar drops accordingly. */
const ARTIST_JACCARD_EXACT_TIME = 0.4;

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
        if (j === 0) return false;
        const sA = existing._start_min, sB = enriched._start_min;
        const timeExact = sA != null && sB != null && sA === sB;
        const timeOk = sA == null || sB == null || Math.abs(sA - sB) <= TIME_WINDOW_MIN;
        return (timeExact && j >= ARTIST_JACCARD_EXACT_TIME) || (timeOk && j >= ARTIST_JACCARD_THRESHOLD);
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
    for (const e of bucket) out.push(e);
  }

  // Second-pass dedup: same artist + same date across DIFFERENT venues.
  // An artist almost never plays two Rogue Valley venues on the same day, so
  // we treat these as the aggregator listing the same show under venue
  // spelling variants. Higher-trust source wins. Skip if the artist key is
  // too short to be a stable identifier, OR if it's a generic placeholder
  // ("Live Music", "Open Mic", "Karaoke") that legitimately appears at
  // multiple venues independently on the same night.
  const GENERIC_TOKENS = new Set(['live', 'music', 'open', 'mic', 'night', 'karaoke', 'jam', 'tba', 'tbd', 'show', 'tonight', 'dj']);
  const isGenericPlaceholder = (tokens) => {
    if (!tokens || tokens.size === 0) return true;
    for (const t of tokens) if (!GENERIC_TOKENS.has(t)) return false;
    return true;
  };
  const byArtistDate = new Map();
  const second = [];
  for (const e of out) {
    const key = e._artist_key && e._artist_key.length >= 5 && !isGenericPlaceholder(e._artist_tokens)
      ? `${e._artist_key}|${e.date}`
      : null;
    if (!key) { second.push(e); continue; }
    const prior = byArtistDate.get(key);
    if (!prior) {
      byArtistDate.set(key, e);
      second.push(e);
    } else {
      // Merge into the higher-trust one already in second[].
      const keep = prior._trust >= e._trust ? prior : e;
      const drop = keep === prior ? e : prior;
      for (const [k, v] of Object.entries(drop)) {
        if (k.startsWith('_')) continue;
        if (!keep[k] && v) keep[k] = v;
      }
      keep._merged_from = keep._merged_from || [];
      keep._merged_from.push({ source: drop._source_name, id: drop.id });
      dropped.push({ kept: keep.id, dropped_source: drop._source_name, dropped_id: drop.id, venue: drop.venue, date: drop.date, musician: drop.musician });
      // Remove the dropped event from the output and put keep in if it isn't already.
      const dropIdx = second.indexOf(drop);
      if (dropIdx >= 0) second.splice(dropIdx, 1);
      if (!second.includes(keep)) second.push(keep);
      byArtistDate.set(key, keep);
    }
  }

  // Strip internal fields and attach merge metadata for inspection.
  const cleaned = second.map(e => {
    const { _venue_key, _artist_key, _artist_tokens, _start_min, _trust, _source_name, _merged_from, ...rest } = e;
    if (_merged_from && _merged_from.length) rest.merged_from = _merged_from;
    return rest;
  });
  cleaned.sort((a, b) => (a.date + (a.start_raw || '0000')).localeCompare(b.date + (b.start_raw || '0000')));
  return { events: cleaned, dropped };
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


  /* ── Archive past shows before they vanish from the feeds ── */
  const todayISO = laTodayISO();
  const keepFloor = isoAddDays(todayISO, -KEEP_PAST_DAYS);

  let prevJson = null;
  try { prevJson = JSON.parse(await readFile(EVENTS_OUT, 'utf8')); } catch {}

  // Candidates: every past-dated event we currently know about — the fresh
  // fetch plus whatever the previous events.json still carried (a show a feed
  // just dropped would otherwise disappear forever). Fresh fetch wins on id.
  const candidates = new Map();
  for (const e of (prevJson?.events || [])) {
    if (e.id && e.date && e.date < todayISO) candidates.set(e.id, { ...e, merged_from: undefined });
  }
  for (const e of events) {
    if (e.id && e.date && e.date < todayISO) candidates.set(e.id, { ...e, merged_from: undefined });
  }
  const venueDict = { ...(prevJson?.venues || {}), ...venues };
  const archiveWritten = await upsertArchive(candidates, venueDict);
  for (const w of archiveWritten) console.log(`archive-${w.year}.json updated (${w.count} events)`);

  // events.json keeps only a rolling window of recent past; older is archive-only.
  const liveEvents = events.filter(e => !e.date || e.date >= keepFloor);

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
      events: liveEvents.map(e => ({ ...e, merged_from: undefined })),
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
    events: liveEvents,
  };

  await writeFile(EVENTS_OUT, JSON.stringify(eventsJson, null, 2) + '\n');

  const rawTxt = results.find(r => r.name === 'musiclist_txt' && r.ok && r.raw)?.raw;
  if (rawTxt) await writeFile(SNAPSHOT_OUT, rawTxt);

  const meta = {
    fetched_at: generated_at,
    source_timestamp: sourceTimestamp || 'unknown',
    bytes: rawTxt ? Buffer.byteLength(rawTxt, 'utf8') : (existingMeta?.bytes ?? 0),
    sources,
    event_count: liveEvents.length,
    venue_count: Object.keys(venues).length,
    deduped: dropped.length,
    archived: candidates.size,
    content_hash: contentHash,
  };
  await writeFile(META_OUT, JSON.stringify(meta, null, 2) + '\n');

  console.log(`\nwrote ${liveEvents.length} events, ${Object.keys(venues).length} venues, deduped ${dropped.length}, ${candidates.size} past events upserted to archive`);
  if (dropped.length) {
    console.log('\nDedup samples (first 5):');
    for (const d of dropped.slice(0, 5)) {
      console.log(`  ${d.venue} ${d.date} ${d.musician} (kept primary, dropped ${d.dropped_source})`);
    }
  }
  console.log(`source_timestamp: ${sourceTimestamp || 'unknown'}`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('merge failed:', err);
    process.exit(1);
  });
}
