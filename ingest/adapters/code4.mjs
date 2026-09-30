import { createHash } from 'node:crypto';

/* Code 4 Taphouse (Grants Pass) runs WordPress + The Events Calendar. Only
   the "live-music" category is kept: the broader "music" category also holds
   DJ brunches, karaoke and club nights. Titles are "Live Music w/ <Artist>". */
const API_URL = 'https://code4taphouse.com/wp-json/tribe/events/v1/events';
const MUSIC_CATEGORY = 'live-music';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Name matches the volunteer list's existing venue so the two dedupe. */
const VENUE = {
  name: 'Code 4 Taphouse',
  city: 'Grants Pass',
  region: 'GrantsPass',
  venue_type: 'BrewPub',
  venue_url: 'https://code4taphouse.com/',
};

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-').replace(/&#8212;/g, '-')
    .replace(/&#8216;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function eventId(url, dateISO, startRaw, title) {
  const key = `code4|${url}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function ingest({ offline = false } = {}) {
  const started = new Date().toISOString();
  if (offline) {
    return {
      ok: true, count: 0, events: [], venues: {}, source_timestamp: null,
      error: null, strategy: 'offline-skipped', fetched_at: started,
    };
  }
  try {
    // A week back so shows from the last few days still reach the archive.
    const from = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const raw = [];
    for (let page = 1, pages = 1; page <= pages && page <= 5; page++) {
      const data = await fetchJson(`${API_URL}?per_page=50&page=${page}&start_date=${from}`);
      if (!Array.isArray(data.events)) throw new Error('events array missing');
      raw.push(...data.events);
      pages = data.total_pages || 1;
    }

    const events = [];
    for (const e of raw) {
      if (!(e.categories || []).some(c => c.slug === MUSIC_CATEGORY)) continue;
      const title = decodeEntities(e.title || '').replace(/^Live Music\s*(w\/|with)\s*/i, '').trim();
      if (!title) continue;
      const m = String(e.start_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      if (!m) continue;
      const dateISO = m[1];
      const start = `${m[2]}${m[3]}`;
      const endM = String(e.end_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      let end = endM && endM[1] === dateISO ? `${endM[2]}${endM[3]}` : '';
      let estimated = false;
      if (!end || end <= start) { end = addHours(start, 3); estimated = true; }
      const cost = decodeEntities(e.cost || '').trim();

      events.push({
        id: eventId(e.url, dateISO, start, title),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        end_estimated: estimated,
        musician: title,
        genre: '',
        link: e.url,
        link_name: '',
        venue: VENUE.name,
        notes: /^free/i.test(cost) ? 'Free' : cost,
        event_type: /open mic|jam\b/i.test(title) ? 'Open Mic' : 'Band',
        source: 'code4',
        source_url: e.url,
      });
    }

    const venues = {
      [VENUE.name]: {
        url: VENUE.venue_url,
        city: VENUE.city,
        notes: '',
        address: '',
        region: VENUE.region,
        type: VENUE.venue_type,
      },
    };
    return {
      ok: true, count: events.length, events, venues,
      source_timestamp: null, error: null, strategy: 'live', fetched_at: started,
    };
  } catch (err) {
    return {
      ok: false, count: 0, events: [], venues: {}, source_timestamp: null,
      error: err.message, strategy: null, fetched_at: started,
    };
  }
}
