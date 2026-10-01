import { createHash } from 'node:crypto';

/* ashland.news community calendar (WordPress + The Events Calendar). The REST
   API filters to the "music" category server-side. It's an aggregator: the
   per-event venue becomes the listing's venue, renamed where the volunteer
   list or a venue adapter already uses a different spelling so they dedupe.
   The Music tag is loose, so folk-dance sessions, services, meetings and
   open houses are dropped by title. */
const API_URL = 'https://ashland.news/wp-json/tribe/events/v1/events';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const EXCLUDE_TITLE = /\b(dancing at|meeting|open house|evensong|communion|mass|worship|party|class|workshop|lessons?|festival)\b/i;

/* ashland.news venue name -> name already used on the site. */
const VENUE_RENAMES = [
  [/^Ashland Bellview Grange$/i, 'Bellview Grange'],
  [/^Cedarwood Farm Barn/i, 'Cedarwood Barn'],
  [/^450 S Mountain Ave|Southern Oregon University Music/i, 'SOU Music Recital Hall'],
];

/* Venues with their own adapter: their listings are better (and titled
   differently, e.g. "Camp Django Presents: Gypsy Jazz Legend" vs "...Paulus
   Schafer, Jimmy Grant", so dedupe misses them). Skip ours-covered venues. */
const DIRECT_VENUES = new Set([
  'Grizzly Peak Winery', 'Belle Fiore', 'Roxy Ann Winery', 'The Talent Club', 'Holly Theater',
  'Craterian Theater', 'Rockafairy', 'Local 31 Pub', 'Wild Goose Cafe', 'Ashland Armory',
  'La Baguette', 'Tap & Vine', 'Rogue Theatre', 'Code 4 Taphouse', 'The Wonder Bur Cafe',
]);

const REGION_BY_CITY = {
  ashland: 'Ashland', talent: 'Ashland',
  medford: 'Medford', phoenix: 'Medford', jacksonville: 'Medford', 'central point': 'Medford', 'eagle point': 'Medford',
  'grants pass': 'GrantsPass', 'cave junction': 'GrantsPass', merlin: 'GrantsPass',
  'rogue river': 'RogueRiver', 'gold hill': 'RogueRiver',
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
  const key = `ashland_news|${url}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function laDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function venueOf(e) {
  const v = e.venue && typeof e.venue === 'object' && !Array.isArray(e.venue) ? e.venue : {};
  let name = decodeEntities(v.venue || '').trim() || 'Ashland (venue TBA)';
  for (const [re, to] of VENUE_RENAMES) if (re.test(name)) { name = to; break; }
  const city = decodeEntities(v.city || '').replace(/,\s*OR\b.*$/i, '').trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Ashland';
  const address = v.address ? `${decodeEntities(v.address)}, ${city} OR` : '';
  return {
    name,
    city,
    region: REGION_BY_CITY[city.toLowerCase()] || 'Ashland',
    address: /private home/i.test(name) ? '' : address,
    url: v.website || '',
  };
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
    const raw = [];
    for (let page = 1, pages = 1; page <= pages && page <= 10; page++) {
      const data = await fetchJson(`${API_URL}?per_page=50&page=${page}&categories=music&start_date=${laDate(-7)}&end_date=${laDate(120)}`);
      if (!Array.isArray(data.events)) throw new Error('events array missing');
      raw.push(...data.events);
      pages = data.total_pages || 1;
    }

    const events = [];
    const venues = {};
    for (const e of raw) {
      if (e.all_day) continue;
      const title = decodeEntities(e.title || '').replace(/\s+/g, ' ').trim();
      if (!title || EXCLUDE_TITLE.test(title)) continue;
      const m = String(e.start_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      if (!m) continue;
      const dateISO = m[1];
      const start = `${m[2]}${m[3]}`;
      const endM = String(e.end_date || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
      let end = endM && endM[1] === dateISO ? `${endM[2]}${endM[3]}` : '';
      let estimated = false;
      if (!end || end <= start) { end = addHours(start, 2); estimated = true; }

      const v = venueOf(e);
      if (DIRECT_VENUES.has(v.name)) continue;
      // House concerts give no address (RSVP only), so Directions can't work.
      if (/private home/i.test(v.name) || /house concert/i.test(title)) continue;
      if (!venues[v.name]) {
        venues[v.name] = { url: v.url, city: v.city, notes: '', address: v.address, region: v.region, type: 'Other' };
      }
      const cost = decodeEntities(e.cost || '').trim();
      const link = e.website || e.url;
      events.push({
        id: eventId(e.url, dateISO, start, title),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        end_estimated: estimated,
        musician: title,
        genre: '',
        link,
        link_name: '',
        venue: v.name,
        notes: /^free$/i.test(cost) ? 'Free' : cost,
        event_type: /open mic|jam\b/i.test(title) ? 'Open Mic' : 'Band',
        source: 'ashland_news',
        source_url: e.url,
      });
    }

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
