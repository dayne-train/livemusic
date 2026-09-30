import { createHash } from 'node:crypto';

/* Historic Ashland Armory ("Live at the Armory") is a Squarespace events
   collection; ?format=json returns upcoming[] and past[] with epoch-ms
   start/end. startDate is sometimes doors and sometimes show time, so the
   listed start is kept and the body's "Doors ..." and price lines go in notes.
   The ticket link (Tixr / TicketWeb / Eventbrite) lives inside the body. */
const SITE = 'https://www.liveatthearmory.com';
const LIST_URL = `${SITE}/calendar-of-events?format=json`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Name matches the volunteer list's existing venue so the two dedupe. */
const VENUE = {
  name: 'Ashland Armory',
  city: 'Ashland',
  region: 'Ashland',
  venue_type: 'Other',
  venue_url: 'https://www.liveatthearmory.com/',
  address: '208 Oak St, Ashland OR',
};

const EXCLUDE_TITLE = /\b(comedy|comedian|stand-?up|film|screening|market|expo|fair)\b/i;
const TICKET_HOST = /tixr\.com|ticketweb\.com|eventbrite\.com|ticketmaster\.com|seetickets|dice\.fm|etix\.com|venuepilot/i;
const NOTES_CAP = 200;

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

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function eventId(itemId, dateISO, title) {
  const key = `armory|${itemId}|${dateISO}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function bodyNotes(body) {
  const lines = decodeEntities(String(body || '').replace(/<[^>]+>/g, '\n'))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const price = lines.find(l => /\$\d/.test(l) && l.length < 80);
  const doors = lines.find(l => /^doors\b/i.test(l) && l.length < 40);
  const ages = lines.find(l => /^all ages\b|^21\+/i.test(l) && l.length < 40);
  return [price, doors, ages].filter(Boolean).join('. ').slice(0, NOTES_CAP);
}

function ticketLink(body) {
  const hrefs = [...String(body || '').matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => decodeEntities(m[1]));
  const t = hrefs.find(h => TICKET_HOST.test(h));
  return t ? t.replace(/[?&]fbclid=[^&]*/, '').replace(/\?$/, '') : null;
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
    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.upcoming)) throw new Error('upcoming[] missing');

    // Include the last week of past[] so recent shows still reach the archive.
    const weekAgo = Date.now() - 7 * 86400000;
    const items = [...data.upcoming, ...(data.past || []).filter(e => e.startDate >= weekAgo)];

    const events = [];
    for (const e of items) {
      const title = decodeEntities(e.title || '').trim();
      if (!title || !e.startDate || EXCLUDE_TITLE.test(title)) continue;
      const s = laParts(e.startDate);
      const en = e.endDate ? laParts(e.endDate) : null;
      let end = en && en.date === s.date && en.raw > s.raw ? en.raw : '';
      let estimated = false;
      if (!end) { end = addHours(s.raw, 3); estimated = true; }
      const page = e.fullUrl ? `${SITE}${e.fullUrl}` : VENUE.venue_url;
      const link = ticketLink(e.body) || page;

      events.push({
        id: eventId(e.id || page, s.date, title),
        date: s.date,
        start_raw: s.raw,
        end_raw: end,
        end_estimated: estimated,
        musician: title,
        genre: '',
        link,
        link_name: '',
        venue: VENUE.name,
        notes: bodyNotes(e.body),
        event_type: 'Band',
        source: 'armory',
        source_url: page,
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
