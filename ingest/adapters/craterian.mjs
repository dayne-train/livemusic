import { createHash } from 'node:crypto';

/* Craterian Theater (Medford) runs WordPress + The Events Calendar, so the
   Tribe REST API gives clean local start/end times. It has no music category
   (everything is "Craterian Performances"), so non-music bookings are dropped
   by title/description keywords. Prices aren't in the API; they're read from
   each event page's ticket block ("Section A $62.00 ...") into notes. */
const API_URL = 'https://craterian.org/wp-json/tribe/events/v1/events';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'Craterian Theater',
  city: 'Medford',
  region: 'Medford',
  venue_type: 'Other',
  venue_url: 'https://craterian.org/',
  address: '23 S Central Ave, Medford OR',
};

/* Theater, dance, circus, film and comedy bookings. Title is checked in full;
   the description only in its opening, where the show describes itself. */
const EXCLUDE_TITLE = /\b(circus|cirque|ballet|nutcracker|improv|musical|annie|newsies|lion king|cat in the hat|picture show|screening|film|comedy|recital)\b/i;
const EXCLUDE_DESC = /\b(comedian|stand-?up comedy|dance studio|variety show|ballet|broadway musical|film screening)\b/i;
const DESC_WINDOW = 300;

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-').replace(/&#8212;/g, '-')
    .replace(/&#8216;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function plainText(htmlStr) {
  return decodeEntities(String(htmlStr || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function eventId(url, dateISO, startRaw, title) {
  const key = `craterian|${url}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/* Ticket prices sit just above the "Ticket prices include a $N processing fee"
   line. Returns "$33-$76 incl. fees" (or a single "$45"), or '' if absent. */
function extractPrice(pageHtml) {
  const lines = decodeEntities(pageHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '\n'))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const feeIdx = lines.findIndex(l => /processing fee/i.test(l));
  if (feeIdx < 0) return '';
  const amounts = [];
  for (let i = Math.max(0, feeIdx - 12); i < feeIdx; i++) {
    if (lines[i].length > 80) continue;
    for (const m of lines[i].matchAll(/\$(\d+(?:\.\d{2})?)/g)) amounts.push(parseFloat(m[1]));
  }
  if (!amounts.length) return '';
  const fmt = n => `$${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.00$/, '')}`;
  const lo = Math.min(...amounts), hi = Math.max(...amounts);
  return `${lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`} incl. fees`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
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
      const title = decodeEntities(e.title || '').trim();
      if (!title || EXCLUDE_TITLE.test(title)) continue;
      const desc = plainText(e.description);
      if (EXCLUDE_DESC.test(desc.slice(0, DESC_WINDOW))) continue;
      const m = String(e.start_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      if (!m) continue;
      const dateISO = m[1];
      const start = `${m[2]}${m[3]}`;
      const endM = String(e.end_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      let end = endM && endM[1] === dateISO ? `${endM[2]}${endM[3]}` : '';
      let estimated = false;
      if (!end || end <= start) { end = addHours(start, 2); estimated = true; }

      let price = '';
      try { price = extractPrice(await fetchText(e.url)); } catch { /* no price; still list the show */ }

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
        notes: price,
        event_type: 'Band',
        source: 'craterian',
        source_url: e.url,
      });
    }

    const venues = {
      [VENUE.name]: {
        url: VENUE.venue_url,
        city: VENUE.city,
        notes: '',
        address: VENUE.address,
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
