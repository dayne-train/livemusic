import { createHash } from 'node:crypto';

/* Tap & Vine at 559 (Village at Medford Center) publishes events on a
   SpotHopper page, server-rendered: each "row event-content" block holds an
   <h2> title, an event-day line ("Wednesday September 30th", no year) and an
   event-time line ("05:00 PM - 07:00 PM"). Only the "Music on the Patio /
   Promenade ft. <Artist>" series is music; the rest are food days. The artist
   becomes the listing name so it dedupes against the volunteer list. */
const URL = 'https://tapandvine559.com/medford-the-village-tap-and-vine-at-559-events';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Name matches the volunteer list's existing venue so the two dedupe. */
const VENUE = {
  name: 'Tap & Vine',
  city: 'Medford',
  region: 'Medford',
  venue_type: 'Bar',
  venue_url: 'https://tapandvine559.com/',
};

const MUSIC_TITLE = /^Music on the (Patio|Promenade)\s+(?:ft\.?|feat\.?|featuring)\s+(.+)$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function text(htmlStr) {
  return decodeEntities(String(htmlStr || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* "05:00 PM" -> "1700" */
function toRaw(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${m[2]}`;
}

/* "Wednesday September 30th" has no year: take the year that puts the date
   nearest today (so December listings viewed in January roll forward). */
function resolveDate(dayText, todayIso) {
  const m = String(dayText || '').match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/g);
  if (!m) return null;
  for (const part of m) {
    const mm = part.match(/([A-Za-z]+)\s+(\d{1,2})/);
    const mi = MONTHS.indexOf(mm[1].toLowerCase());
    if (mi < 0) continue;
    const y0 = +todayIso.slice(0, 4);
    const cands = [y0 - 1, y0, y0 + 1].map(y => `${y}-${String(mi + 1).padStart(2, '0')}-${String(+mm[2]).padStart(2, '0')}`);
    const t = Date.parse(todayIso);
    return cands.reduce((a, b) => Math.abs(Date.parse(a) - t) <= Math.abs(Date.parse(b) - t) ? a : b);
  }
  return null;
}

function eventId(dateISO, startRaw, artist) {
  const key = `tap_and_vine|${dateISO}|${startRaw}|${artist}`.toLowerCase();
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
    const res = await fetch(URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blocks = html.split('class="row event-content"').slice(1);
    if (!blocks.length) throw new Error('no event blocks found');
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

    const events = [];
    for (const b of blocks) {
      const title = text((b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
      const mt = title.match(MUSIC_TITLE);
      if (!mt) continue;
      const artist = mt[2].trim();
      const dateISO = resolveDate(text((b.match(/event-day"[^>]*>([\s\S]*?)<\/div>/) || [])[1]), todayIso);
      if (!dateISO) continue;
      const times = text((b.match(/event-time"[^>]*>([\s\S]*?)<\/div>/) || [])[1]).split(/\s*-\s*/);
      const start = toRaw(times[0]) || '1700';
      const end = toRaw(times[1]);
      const where = /promenade/i.test(mt[1]) ? 'Outdoor stage on The Village Promenade' : 'On the patio';

      events.push({
        id: eventId(dateISO, start, artist),
        date: dateISO,
        start_raw: start,
        end_raw: end || '',
        end_estimated: !end,
        musician: artist,
        genre: '',
        link: URL,
        link_name: '',
        venue: VENUE.name,
        notes: where,
        event_type: 'Band',
        source: 'tap_and_vine',
        source_url: URL,
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
