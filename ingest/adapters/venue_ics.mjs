import { createHash } from 'node:crypto';
import { expandIcs, prop, unescapeText, laTodayIso, addDays } from '../lib/ics.mjs';

/* Venues that publish a plain iCalendar feed (Google Calendar or the Modern
   Events Calendar WordPress plugin). Feeds carry years of history and weekly
   repeat rules, so lib/ics.mjs expands them into dated occurrences within a
   window, and each venue's `exclude` drops its non-music nights. Venue names
   match the volunteer list's so shows dedupe against it. */
const VENUES = [
  {
    venue_id: 'local31',
    name: 'Local 31 Pub',
    city: 'Ashland',
    region: 'Ashland',
    venue_type: 'Bar',
    venue_url: 'https://local31pub.ai/',
    address: '31 Water St, Ashland OR',
    ics_url: 'https://local31pub.ai/?mec-ical-feed=1',
    exclude: /\b(karaoke|trivia|bingo|quiz|comedy|the musical)\b/i,
    // MEC sometimes stamps an event with its save time instead of a show time
    // (e.g. 04:14:44, zero length). Bands there start at 9pm.
    default_start: '2100',
  },
  {
    venue_id: 'wonderbur',
    name: 'The Wonder Bur Cafe',
    city: 'Grants Pass',
    region: 'GrantsPass',
    venue_type: 'Bar',
    venue_url: 'https://wonderbur.net/',
    address: '',
    ics_url: 'https://calendar.google.com/calendar/ical/wonderbur116%40gmail.com/public/basic.ics',
    exclude: /\b(karaoke|trivia|bingo|pool|8-ball|9-ball|scotch doubles|tournament|service industry|tapwalk|tree lighting|party)\b/i,
    default_start: '2100',
  },
  {
    venue_id: 'wildgoose',
    name: 'Wild Goose Cafe',
    city: 'Ashland',
    region: 'Ashland',
    venue_type: 'Bar',
    venue_url: 'http://www.wildgoosecafe.com/events.html',
    address: '2365 Ashland St, Ashland OR',
    ics_url: 'https://calendar.google.com/calendar/ical/wildgooseashland%40gmail.com/public/basic.ics',
    exclude: /\b(karaoke|trivia|bingo|quiz|comedy)\b/i,
    default_start: '1800',
  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'text/calendar,*/*;q=0.8',
};

const WINDOW_PAST_DAYS = 7;     // recent past still reaches the archive
const WINDOW_FUTURE_DAYS = 120; // how far ahead repeat rules are expanded

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function eventId(venue_id, dateISO, startRaw, title) {
  const key = `venue_ics|${venue_id}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function ingestVenue(v, fromIso, toIso) {
  const res = await fetch(v.ics_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${v.venue_id} HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VEVENT')) throw new Error(`${v.venue_id} no VEVENT in response`);

  const events = [];
  for (const occ of expandIcs(text, fromIso, toIso)) {
    const title = unescapeText(prop(occ.ev, 'SUMMARY')).replace(/\s+/g, ' ').trim();
    if (!title || v.exclude.test(title)) continue;
    if (!occ.start) continue; // all-day entries are notices, not shows

    // A start before 10am, or a zero-length slot, is a bad timestamp.
    let start = occ.start;
    let end = occ.end;
    let estimated = false;
    if (start < '1000' || end === start) { start = v.default_start; end = null; }
    if (!end) { end = addHours(start, 2); estimated = true; }
    // The site's time math assumes same-day ends; clamp 9pm-1am to midnight.
    if (end < start) end = '2359';

    const url = prop(occ.ev, 'URL') || v.venue_url;
    const description = unescapeText(prop(occ.ev, 'DESCRIPTION')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    events.push({
      id: eventId(v.venue_id, occ.date, start, title),
      date: occ.date,
      start_raw: start,
      end_raw: end,
      end_estimated: estimated,
      musician: title,
      genre: '',
      link: url,
      link_name: '',
      venue: v.name,
      notes: description.slice(0, 200),
      event_type: /open mic|jam\b/i.test(title) ? 'Open Mic' : 'Band',
      source: `venue_ics:${v.venue_id}`,
      source_url: url,
    });
  }
  const venues = {
    [v.name]: {
      url: v.venue_url,
      city: v.city,
      notes: '',
      address: v.address,
      region: v.region,
      type: v.venue_type,
    },
  };
  return { events, venues };
}

export async function ingest({ offline = false } = {}) {
  const started = new Date().toISOString();
  if (offline) {
    return {
      ok: true, count: 0, events: [], venues: {}, source_timestamp: null,
      error: null, strategy: 'offline-skipped', fetched_at: started,
    };
  }
  const today = laTodayIso();
  const fromIso = addDays(today, -WINDOW_PAST_DAYS);
  const toIso = addDays(today, WINDOW_FUTURE_DAYS);
  const results = await Promise.allSettled(VENUES.map(v => ingestVenue(v, fromIso, toIso)));
  const events = [];
  let venues = {};
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      events.push(...r.value.events);
      venues = { ...venues, ...r.value.venues };
    } else {
      errors.push(`${VENUES[i].venue_id}: ${r.reason?.message || r.reason}`);
    }
  });
  const allFailed = errors.length === VENUES.length;
  return {
    ok: !allFailed,
    count: events.length,
    events,
    venues,
    source_timestamp: null,
    error: errors.length ? errors.join('; ') : null,
    strategy: allFailed ? null : 'live',
    fetched_at: started,
  };
}
