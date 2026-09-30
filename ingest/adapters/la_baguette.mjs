import { createHash } from 'node:crypto';

/* La Baguette Music Cafe (Ashland) runs a Squarespace events collection whose
   upcoming[] list is always empty; the calendar view only answers per month
   (?format=json&month=october-2026 -> items[] with epoch-ms start/end). So
   this reads last month through two months ahead. Morning sets, 10:30-12:30. */
const SITE = 'https://www.labaguettemusiccafe.com';
const COLLECTION = `${SITE}/upcoming-events`;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Name matches the volunteer list's existing venue so the two dedupe. */
const VENUE = {
  name: 'La Baguette',
  city: 'Ashland',
  region: 'Ashland',
  venue_type: 'Other',
  venue_url: 'https://www.labaguettemusiccafe.com/',
};

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function laParts(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, raw: time.replace(':', '') };
}

function monthKeys() {
  const now = new Date();
  const y = +now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 4);
  const m = +now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(5, 7) - 1;
  return [-1, 0, 1, 2].map(off => {
    const mi = (m + off + 12) % 12;
    const yy = y + Math.floor((m + off) / 12);
    return `${MONTHS[mi]}-${yy}`;
  });
}

function eventId(itemId, dateISO, title) {
  const key = `la_baguette|${itemId}|${dateISO}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
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
    const items = new Map();
    for (const key of monthKeys()) {
      const res = await fetch(`${COLLECTION}?format=json&month=${key}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
      const data = await res.json();
      for (const it of data.items || []) items.set(it.id, it);
    }

    const events = [];
    for (const it of items.values()) {
      const title = decodeEntities(it.title || '').trim();
      if (!title || !it.startDate) continue;
      const s = laParts(it.startDate);
      const e = it.endDate ? laParts(it.endDate) : null;
      const end = e && e.date === s.date && e.raw > s.raw ? e.raw : '';
      const page = it.fullUrl ? `${SITE}${it.fullUrl}` : VENUE.venue_url;
      events.push({
        id: eventId(it.id, s.date, title),
        date: s.date,
        start_raw: s.raw,
        end_raw: end,
        end_estimated: !end,
        musician: title,
        genre: '',
        link: page,
        link_name: '',
        venue: VENUE.name,
        notes: '',
        event_type: 'Band',
        source: 'la_baguette',
        source_url: page,
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
