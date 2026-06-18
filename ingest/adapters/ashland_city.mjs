import { createHash } from 'node:crypto';

/* City of Ashland calendar RSS (CivicEngage). Filters to a small whitelist of
   recurring music programming -- the feed itself is mostly council meetings.
   For known series that also appear in the Travel Ashland feed, the musician
   name is normalized to match the Travel Ashland title exactly so the
   cross-venue dedup pass in merge.mjs catches them. */

const FEED_URL = 'https://ashlandoregon.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; rvlivemusic-ingest/0.1; +https://rvlivemusic.com)',
  'Accept': 'application/rss+xml, application/xml, text/xml',
};

const MUSIC_RULES = [
  {
    pattern: /ashland city band/i,
    venue: 'Butler Bandshell',
    event_type: 'Band',
  },
  {
    pattern: /folk collective/i,
    venue: 'Lithia Park Bandshell',
    event_type: 'Band',
  },
  {
    pattern: /summer sounds/i,
    venue: 'Lithia Park Bandshell',
    // Align with Travel Ashland's title so the cross-venue dedup pass merges them.
    musician_override: 'Epic Ashland Summer Sounds Concert Series',
    event_type: 'Band',
  },
  {
    pattern: /silent disco/i,
    venue: 'Lithia Park',
    event_type: 'Other',
  },
];

const VENUE_META = {
  'Butler Bandshell': {
    url: 'https://ashlandparksandrec.org',
    city: 'Ashland',
    notes: 'Outdoor concert bandshell in Lithia Park',
    address: 'Winburn Way, Ashland OR',
    region: 'Ashland',
    type: 'Other',
  },
  'Lithia Park Bandshell': {
    url: 'https://ashlandparksandrec.org',
    city: 'Ashland',
    notes: 'Outdoor concert bandshell in Lithia Park',
    address: 'Winburn Way, Ashland OR',
    region: 'Ashland',
    type: 'Other',
  },
  'Lithia Park': {
    url: 'https://ashlandparksandrec.org',
    city: 'Ashland',
    notes: '',
    address: 'Winburn Way, Ashland OR',
    region: 'Ashland',
    type: 'Other',
  },
};

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function tag(block, name) {
  const escaped = name.replace(':', '\\:');
  const re = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`);
  const m = block.match(re);
  return m ? decodeEntities(m[1].trim()) : '';
}

function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    items.push({
      title: tag(block, 'title'),
      link: tag(block, 'link'),
      eventDates: tag(block, 'calendarEvent:EventDates'),
      eventTimes: tag(block, 'calendarEvent:EventTimes'),
      location: tag(block, 'calendarEvent:Location'),
    });
  }
  return items;
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseDate(s) {
  if (!s) return null;
  const m = s.trim().match(/(\w+)\s+(\d+),\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  const d = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toRaw(h, min, ampm) {
  let hh = parseInt(h, 10);
  const mm = parseInt(min, 10);
  const ap = ampm.toUpperCase();
  if (ap === 'PM' && hh !== 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  return `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
}

function parseTimeRange(s) {
  if (!s) return { start: '', end: '' };
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return { start: '', end: '' };
  return { start: toRaw(m[1], m[2], m[3]), end: toRaw(m[4], m[5], m[6]) };
}

function eventId(dateISO, startRaw, title) {
  const key = `ashland_city|${dateISO}|${startRaw}|${title}`.toLowerCase();
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
    const res = await fetch(FEED_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!xml.includes('<item>')) throw new Error('no <item> blocks in feed');
    const items = parseItems(xml);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const events = [];
    const usedVenues = new Set();
    for (const it of items) {
      const title = it.title.trim();
      if (!title) continue;
      if (/CANCEL+ED/i.test(title)) continue;
      const rule = MUSIC_RULES.find(r => r.pattern.test(title));
      if (!rule) continue;
      const dateISO = parseDate(it.eventDates);
      if (!dateISO) continue;
      const eventDate = new Date(dateISO + 'T00:00:00');
      if (eventDate < today) continue;
      const { start, end } = parseTimeRange(it.eventTimes);
      const musician = rule.musician_override || title;
      events.push({
        id: eventId(dateISO, start, musician),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        musician,
        genre: '',
        link: it.link,
        link_name: '',
        venue: rule.venue,
        notes: '',
        event_type: rule.event_type,
        source: 'ashland_city',
        source_url: it.link,
      });
      usedVenues.add(rule.venue);
    }
    const venues = {};
    for (const name of usedVenues) venues[name] = VENUE_META[name];
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
