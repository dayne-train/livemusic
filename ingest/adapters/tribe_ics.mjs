import { createHash } from 'node:crypto';

const VENUES = [
  {
    venue_id: 'belle_fiore',
    name: 'Belle Fiore',
    city: 'Ashland',
    region: 'Ashland',
    venue_type: 'Winery',
    venue_url: 'https://bellefiorewine.com',
    ics_url: 'https://bellefiorewine.com/events/category/live-music/?ical=1',
    title_strip: /^Live Music:\s*/i,
    event_type: 'Band',
  },
  {
    venue_id: 'grizzly_peak',
    name: 'Grizzly Peak Winery',
    city: 'Ashland',
    region: 'Ashland',
    venue_type: 'Winery',
    venue_url: 'https://grizzlypeakwinery.com',
    ics_url: 'https://grizzlypeakwinery.com/?post_type=tribe_events&ical=1',
    exclude_summary: /Savor Southern Oregon|Hops\s*&\s*Pops|Wine Club|Tasting|Rogue Theater Presents/i,
    title_strip: /^(Siskiyou Music Project|Guitar Society of Southern Oregon)\s*Presents:\s*/i,
    event_type: 'Band',
  },
  {
    venue_id: 'roxyann',
    name: 'Roxy Ann Winery',
    city: 'Medford',
    region: 'Medford',
    venue_type: 'Winery',
    venue_url: 'https://roxyann.com',
    ics_url: 'https://roxyann.com/?post_type=tribe_events&ical=1',
    include_summary: /MUSIC \+ WINE|Open Mic|Bluegrass|Brews,?\s*Bluegrass|Comedy:/i,
    title_strip: /^MUSIC \+ WINE SERIES FEATURING\s*/i,
    event_type: 'Band',
  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; rvlivemusic-ingest/0.1; +https://rvlivemusic.com)',
  'Accept': 'text/calendar,*/*;q=0.8',
};

function unfold(text) {
  return text.replace(/\r\n[ \t]|\n[ \t]/g, '');
}

function unescape(s) {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcs(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const keyPart = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [key, ...params] = keyPart.split(';');
    cur[key] = { value, params: Object.fromEntries(params.map(p => p.split('=')).map(([k, v]) => [k, v || ''])) };
  }
  return events;
}

function parseDtstart(field) {
  if (!field) return null;
  const { value, params } = field;
  if (params.VALUE === 'DATE') {
    if (!/^\d{8}$/.test(value)) return null;
    return { date: `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`, time: null, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${m[4]}${m[5]}`,
    allDay: false,
  };
}

function eventId(venue_id, dateISO, startRaw, title) {
  const key = `tribe_ics|${venue_id}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

async function ingestVenue(v, signal) {
  const res = await fetch(v.ics_url, { headers: HEADERS, signal });
  if (!res.ok) throw new Error(`${v.venue_id} HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VEVENT')) throw new Error(`${v.venue_id} no VEVENT in response`);
  const raw = parseIcs(text);
  const events = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const r of raw) {
    const dt = parseDtstart(r.DTSTART);
    if (!dt || dt.allDay) continue;
    const summary = r.SUMMARY ? unescape(r.SUMMARY.value).trim() : '';
    if (!summary) continue;
    if (v.include_summary && !v.include_summary.test(summary)) continue;
    if (v.exclude_summary && v.exclude_summary.test(summary)) continue;
    if (/^No Live Music/i.test(summary)) continue;
    const eventDate = new Date(dt.date + 'T00:00:00');
    if (eventDate < today) continue;
    const title = v.title_strip ? summary.replace(v.title_strip, '').trim() : summary;
    const dtEnd = parseDtstart(r.DTEND);
    const url = r.URL ? r.URL.value : null;
    const description = r.DESCRIPTION ? unescape(r.DESCRIPTION.value).trim() : '';
    events.push({
      id: eventId(v.venue_id, dt.date, dt.time, title),
      date: dt.date,
      start_raw: dt.time || '',
      end_raw: dtEnd && !dtEnd.allDay ? dtEnd.time : '',
      musician: title || 'Live Music',
      genre: '',
      link: url || '',
      link_name: '',
      venue: v.name,
      notes: description.slice(0, 200),
      event_type: v.event_type,
      source: `tribe_ics:${v.venue_id}`,
      source_url: url,
    });
  }
  const venues = {
    [v.name]: {
      url: v.venue_url,
      city: v.city,
      notes: '',
      address: '',
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
      ok: true,
      count: 0,
      events: [],
      venues: {},
      source_timestamp: null,
      error: null,
      strategy: 'offline-skipped',
      fetched_at: started,
    };
  }
  const signal = AbortSignal.timeout(25000);
  const results = await Promise.allSettled(VENUES.map(v => ingestVenue(v, signal)));
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
  const allFailed = events.length === 0 && errors.length === VENUES.length;
  return {
    ok: !allFailed,
    count: events.length,
    events,
    venues,
    source_timestamp: null,
    error: errors.length ? errors.join('; ') : null,
    strategy: 'live',
    fetched_at: started,
  };
}
