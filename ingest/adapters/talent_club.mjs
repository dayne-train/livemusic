import { createHash } from 'node:crypto';

const URL = 'https://talentclublive.com/live-music/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'The Talent Club',
  city: 'Talent',
  region: 'Ashland',
  venue_type: 'Bar',
  venue_url: 'https://talentclublive.com',
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function parseDate(s) {
  const m = s.match(/(\w+),\s+(\w+)\s+(\d+),\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const d = parseInt(m[3], 10);
  const y = parseInt(m[4], 10);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseTime(s) {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${min}`;
}

const DEFAULT_DURATION_HOURS = 2;

function addHours(raw, hours) {
  if (!raw) return '';
  const t = raw.padStart(4, '0');
  const h = parseInt(t.slice(0, 2), 10);
  const m = parseInt(t.slice(2), 10);
  if (isNaN(h) || isNaN(m)) return '';
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}${String(nm).padStart(2, '0')}`;
}

function eventId(slug, dateISO, startRaw, title) {
  const key = `talent_club|${slug}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function extractEvents(html) {
  const events = [];
  const articleRe = /<article[^>]+post-(\d+)[^>]+event_category-([a-z0-9-]+)[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  while ((m = articleRe.exec(html)) !== null) {
    const postId = m[1];
    const category = m[2];
    const block = m[3];

    if (category !== 'live-music') continue;

    const slugMatch = block.match(/href="https:\/\/talentclublive\.com\/event\/([^"\/]+)/);
    const slug = slugMatch ? slugMatch[1] : `post-${postId}`;

    const dateMatch = block.match(/<span[^>]*elementor-post-info__item--type-custom[^>]*>\s*(\w+,\s+\w+\s+\d+,\s+\d{4})/);
    if (!dateMatch) continue;
    const dateISO = parseDate(dateMatch[1]);
    if (!dateISO) continue;

    const eventDate = new Date(dateISO + 'T00:00:00');
    if (eventDate < today) continue;

    const timeMatch = block.match(/<span[^>]*elementor-post-info__item--type-custom[^>]*>\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
    const startRaw = timeMatch ? parseTime(timeMatch[1]) : '';

    const titleMatch = block.match(/<h\d[^>]+elementor-heading-title[^>]*>([^<]+)<\/h\d>/);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Live Music';

    const detailUrl = `https://talentclublive.com/event/${slug}/`;

    const endRaw = startRaw ? addHours(startRaw, DEFAULT_DURATION_HOURS) : '';
    events.push({
      id: eventId(slug, dateISO, startRaw, title),
      date: dateISO,
      start_raw: startRaw,
      end_raw: endRaw,
      end_estimated: !!endRaw,
      musician: title,
      genre: '',
      link: detailUrl,
      link_name: '',
      venue: VENUE.name,
      notes: '',
      event_type: 'Band',
      source: 'talent_club',
      source_url: detailUrl,
    });
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
    if (!html.includes('event_category-live-music')) throw new Error('page missing event blocks');
    const events = extractEvents(html);
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
