import { createHash } from 'node:crypto';

const URL = 'https://theblacksheep.com/events/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'The Black Sheep',
  city: 'Ashland',
  region: 'Ashland',
  venue_type: 'Bar',
  venue_url: 'https://theblacksheep.com',
};

/* Skip non-music recurring events (Black Sheep also publishes trivia, bingo,
   and board-game nights). Music-event detection is by exclusion to remain
   forward-compatible with new music programming. */
const EXCLUDE_NAME = /\b(trivia|quiz|game\s*(knight|night)|bingo)\b/i;

/* Best-effort start/end-time extraction from the JSON-LD description text.
   The Black Sheep's MEC plugin writes the date in startDate but leaves the
   time inside the description like "Tuesdays - 8pm", "Every Sunday from 2-5pm".
   We try a range pattern first, then a single-time pattern, then default to
   8pm with a 2-hour estimated window. */
function extractTimes(desc) {
  if (!desc) return defaultEvening();
  const text = desc.replace(/&#?\w+;/g, ' ');

  // Range like "2-5pm", "2:00 - 5:00 pm", "7.30pm to 9pm"
  const range = text.match(/(\d{1,2})(?:[.:](\d{2}))?\s*(?:(am|pm))?\s*(?:-|–|—|to)\s*(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)/i);
  if (range) {
    const sH = parseInt(range[1], 10);
    const sM = parseInt(range[2] || '0', 10);
    const sAmPm = (range[3] || range[6]).toLowerCase();
    const eH = parseInt(range[4], 10);
    const eM = parseInt(range[5] || '0', 10);
    const eAmPm = range[6].toLowerCase();
    return {
      start: toRaw(sH, sM, sAmPm),
      end: toRaw(eH, eM, eAmPm),
      estimated: false,
    };
  }

  // Single time like "8pm", "8:00pm", "7.30pm"
  const single = text.match(/(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)/i);
  if (single) {
    const h = parseInt(single[1], 10);
    const m = parseInt(single[2] || '0', 10);
    const ampm = single[3].toLowerCase();
    const start = toRaw(h, m, ampm);
    return { start, end: addHours(start, 2), estimated: true };
  }

  return defaultEvening();
}

function defaultEvening() {
  return { start: '2000', end: '2200', estimated: true };
}

function toRaw(h, m, ampm) {
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

function addHours(raw, hours) {
  if (!raw) return '';
  const t = raw.padStart(4, '0');
  const h = parseInt(t.slice(0, 2), 10);
  const m = parseInt(t.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-').replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function eventId(slug, dateISO, startRaw, title) {
  const key = `black_sheep|${slug}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      blocks.push(parsed);
    } catch {
      // skip malformed blocks
    }
  }
  return blocks;
}

function buildEvents(blocks) {
  // Keep past events (the merge step archives them); only drop ancient ones.
  const pastFloor = new Date();
  pastFloor.setHours(0, 0, 0, 0);
  pastFloor.setDate(pastFloor.getDate() - 366);
  const events = [];
  for (const block of blocks) {
    // Each block may be an Event object, or wrap one. Black Sheep emits one per script tag.
    const items = Array.isArray(block) ? block : [block];
    for (const item of items) {
      if (!item || item['@type'] !== 'Event') continue;
      const name = decodeEntities(item.name || '').trim();
      if (!name) continue;
      if (EXCLUDE_NAME.test(name)) continue;
      const startDate = item.startDate;
      if (!startDate || !/^\d{4}-\d{2}-\d{2}/.test(startDate)) continue;
      const dateISO = startDate.slice(0, 10);
      if (new Date(dateISO + 'T00:00:00') < pastFloor) continue;
      const url = item.url || (item.offers && item.offers.url) || '';
      const description = decodeEntities(item.description || '');
      const slug = (url.match(/\/event\/([^\/?#]+)/) || [])[1] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const { start, end, estimated } = extractTimes(description);
      const eventType = /open mic|jam session|celtic session/i.test(name) ? 'Open Mic'
        : /karaoke/i.test(name) ? 'Open Mic'
        : 'Band';
      events.push({
        id: eventId(slug, dateISO, start, name),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        end_estimated: estimated,
        musician: name,
        genre: '',
        link: url,
        link_name: '',
        venue: VENUE.name,
        notes: description.slice(0, 200),
        event_type: eventType,
        source: 'black_sheep',
        source_url: url,
      });
    }
  }
  return events;
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
    const res = await fetch(URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blocks = extractJsonLdBlocks(html);
    if (blocks.length === 0) throw new Error('no JSON-LD blocks found');
    const events = buildEvents(blocks);
    const venues = {
      [VENUE.name]: {
        url: VENUE.venue_url,
        city: VENUE.city,
        notes: '',
        address: '51 N Main St, Ashland OR',
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
