import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const LIVE_URL = 'https://roguevalleylivemusicnightlife.com/musiclist.txt';
const SNAPSHOT_PATH = new URL('../../data/musiclist.txt', import.meta.url);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Accept': 'text/plain,text/html;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchLive() {
  const res = await fetch(LIVE_URL, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const txt = await res.text();
  if (!looksValid(txt)) throw new Error('Live response missing expected markers');
  return txt;
}

async function readSnapshot() {
  const txt = await readFile(SNAPSHOT_PATH, 'utf8');
  if (!looksValid(txt)) throw new Error('Snapshot missing expected markers');
  return txt;
}

function looksValid(txt) {
  return !!txt && txt.length > 200 && txt.includes('--events') && txt.includes('--musicians');
}

function parseEntryDateISO(d) {
  if (!d) return null;
  const p = d.trim().split('/');
  if (p.length !== 3) return null;
  const yr = parseInt(p[2], 10);
  const year = yr < 100 ? 2000 + yr : yr;
  const month = parseInt(p[0], 10);
  const day = parseInt(p[1], 10);
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function eventId(venue, dateISO, startRaw, musician) {
  const key = `musiclist_txt|${venue}|${dateISO}|${startRaw}|${musician}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function parseTxt(txt) {
  const lines = txt.split('\n');
  const venues = {};
  const events = [];
  const musicianGenres = {};
  let section = '';
  let sourceTimestamp = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '--timestamp') { section = 'timestamp'; continue; }
    if (line === '--venues') { section = 'venues'; continue; }
    if (line === '--events') { section = 'events'; continue; }
    if (line === '--musicians') { section = 'musicians'; continue; }
    if (line === '--news') { section = 'skip'; continue; }
    if (section === 'timestamp') { sourceTimestamp = line; section = ''; continue; }
    if (line.startsWith('--') || line.startsWith('*')) continue;

    if (section === 'musicians') {
      const p = line.split('|');
      const name = p[0]?.trim();
      if (!name) continue;
      const genre = p[1]?.trim() || '';
      if (genre) musicianGenres[name] = genre;
      continue;
    }

    if (section === 'venues') {
      const p = line.split('|');
      if (p.length < 6) continue;
      const name = p[0]?.trim();
      if (!name) continue;
      const notes = p[4]?.trim() || '';
      const addressLooking = notes && /\d+\s+\w/.test(notes) ? notes : '';
      venues[name] = {
        url: p[1]?.trim() || '',
        city: p[2]?.trim() || '',
        notes,
        address: addressLooking,
        region: p[5]?.trim() || '',
        type: p[6]?.trim() || '',
      };
    } else if (section === 'events') {
      const p = line.split('|');
      if (p.length < 11) continue;
      const dateISO = parseEntryDateISO(p[6]?.trim());
      if (!dateISO) continue;
      const venue = p[4]?.trim() || '';
      const musician = p[0]?.trim() || 'Unknown';
      const startRaw = p[7]?.trim() || '';
      const eventGenre = p[1]?.trim() || '';
      events.push({
        id: eventId(venue, dateISO, startRaw, musician),
        date: dateISO,
        start_raw: startRaw,
        end_raw: p[8]?.trim() || '',
        musician,
        genre: eventGenre,
        _musician_key: musician,
        link: p[2]?.trim() || '',
        link_name: p[3]?.trim() || '',
        venue,
        notes: p[9]?.trim() || '',
        event_type: p[10]?.trim() || 'Band',
        source: 'musiclist_txt',
        source_url: null,
      });
    }
  }

  for (const e of events) {
    if (!e.genre && e._musician_key && musicianGenres[e._musician_key]) {
      e.genre = musicianGenres[e._musician_key];
    }
    delete e._musician_key;
  }

  return { events, venues, source_timestamp: sourceTimestamp, musician_genres: musicianGenres };
}

export async function ingest({ offline = false } = {}) {
  const started = new Date().toISOString();
  let txt;
  let strategy;
  try {
    if (offline) {
      txt = await readSnapshot();
      strategy = 'snapshot';
    } else {
      try {
        txt = await fetchLive();
        strategy = 'live';
      } catch (liveErr) {
        txt = await readSnapshot();
        strategy = 'snapshot-fallback';
      }
    }
  } catch (err) {
    return {
      ok: false,
      count: 0,
      events: [],
      venues: {},
      source_timestamp: null,
      error: err.message,
      strategy: null,
      fetched_at: started,
    };
  }

  const { events, venues, source_timestamp, musician_genres } = parseTxt(txt);

  return {
    ok: true,
    count: events.length,
    events,
    venues,
    source_timestamp,
    error: null,
    strategy,
    fetched_at: started,
    raw: txt,
    musician_genres,
  };
}
