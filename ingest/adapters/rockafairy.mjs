import { createHash } from 'node:crypto';

/* Rockafairy (Medford) publishes its calendar as a small JSON list at
   rockafairy.org/events (name, date, BetterWorld ticket URL). The list has no
   times, so each event's BetterWorld page is fetched for the rest:
   data-start/data-end unix timestamps on the calendar widget, the
   "Doors 7:00PM, Music 8:00PM" line (music time wins as the start), and the
   "$15 Advance / $20 Day Of Show" price line (goes in notes for the $-badge). */
const LIST_URL = 'https://www.rockafairy.org/events';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  // The list URL is Apache content-negotiated (events.php); a specific Accept
  // like application/json gets 406, so ask for anything.
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'Rockafairy',
  city: 'Medford',
  region: 'Medford',
  venue_type: 'Other',
  venue_url: 'https://www.rockafairy.org/',
  address: 'Rogue Valley Mall, 1600 N Riverside Ave #1130, Medford OR',
};

/* Rockafairy also hosts chess quads, workshops, and comedy. Music detection is
   by exclusion so new music programming comes through without changes. */
const EXCLUDE_NAME = /\b(chess|quads?|tournament|workshop|class|comedy|stand-?up|market|meeting)\b/i;

const NOTES_CAP = 200;

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function laParts(unixSec) {
  const d = new Date(unixSec * 1000);
  const date = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, raw: time.replace(':', '') };
}

function toRaw(h, m, ampm) {
  ampm = ampm.toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function eventId(url, dateISO, title) {
  const key = `rockafairy|${url}|${dateISO}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/* Visible text of the detail page, one line per text node. */
function pageLines(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '\n'))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parseDetail(html) {
  const out = {};
  const start = html.match(/data-start="(\d{9,})"/);
  const end = html.match(/data-end="(\d{9,})"/);
  if (start) out.start = laParts(+start[1]);
  if (end) out.end = laParts(+end[1]);

  const lines = pageLines(html);
  const music = lines.map(l => l.match(/\b(?:music|show|bands?)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)).find(Boolean);
  if (music) out.musicRaw = toRaw(+music[1], +(music[2] || 0), music[3]);
  const doors = lines.find(l => /\bdoors\b/i.test(l) && /\d\s*(am|pm)/i.test(l));
  const price = lines.find(l => /^\$\d/.test(l) && /(advance|door|day of|at the door|free|\/)/i.test(l))
    || lines.find(l => /^(free|all ages|donation)/i.test(l) && l.length < 60);
  const noteParts = [];
  if (price) noteParts.push(price);
  if (doors) noteParts.push(doors);
  if (lines.some(l => /^all ages/i.test(l))) noteParts.push('All ages');
  out.notes = noteParts.join('. ').slice(0, NOTES_CAP);
  return out;
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
    const list = JSON.parse(await fetchText(LIST_URL));
    if (!Array.isArray(list.events)) throw new Error('events list missing');
    const items = list.events.filter(e => e && e.name && e.url && !EXCLUDE_NAME.test(e.name));

    const events = [];
    for (const item of items) {
      const title = decodeEntities(item.name).trim();
      let detail = {};
      try { detail = parseDetail(await fetchText(item.url)); } catch { /* list-only fallback below */ }

      // Date: detail page's LA-local start, else the list's timestamp.
      const dateISO = detail.start?.date || (item.ts ? laParts(item.ts).date : null);
      if (!dateISO) continue;
      let start = detail.musicRaw || detail.start?.raw || '2000';
      let end = detail.end?.date === dateISO ? detail.end.raw : '';
      let estimated = false;
      if (!detail.start && !detail.musicRaw) estimated = true;
      if (!end || end <= start) { end = addHours(start, 3); estimated = true; }

      events.push({
        id: eventId(item.url, dateISO, title),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        end_estimated: estimated,
        musician: title,
        genre: '',
        link: item.url,
        link_name: '',
        venue: VENUE.name,
        notes: detail.notes || '',
        event_type: /karaoke|open mic/i.test(title) ? 'Open Mic' : 'Band',
        source: 'rockafairy',
        source_url: item.url,
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
    const updated = list.updated ? new Date(list.updated * 1000).toISOString() : null;
    return {
      ok: true, count: events.length, events, venues,
      source_timestamp: updated, error: null, strategy: 'live', fetched_at: started,
    };
  } catch (err) {
    return {
      ok: false, count: 0, events: [], venues: {}, source_timestamp: null,
      error: err.message, strategy: null, fetched_at: started,
    };
  }
}
