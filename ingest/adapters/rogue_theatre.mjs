import { createHash } from 'node:crypto';

/* Rogue Theatre (Grants Pass) lists shows as cards on its WordPress (Brizy)
   homepage: a rich-text block of <h4> lines ending in a date line like
   "Fri, Oct 2, 2026", followed by a TicketSpice button. The homepage has no
   times; each TicketSpice page says "8:00PM SHOW- DOORS AT 7:00PM", and its
   <title> names the act better than the card ("The Stinkfoot Orchestra- Zappa
   Tribute" vs "FRANK ZAPPA / TRIBUTE"). Stand-up comedy bookings are dropped. */
const HOME = 'https://www.roguetheatre.org/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'Rogue Theatre',
  city: 'Grants Pass',
  region: 'GrantsPass',
  venue_type: 'Other',
  venue_url: 'https://www.roguetheatre.org/',
};

const DATE_LINE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Z][a-z]{2}) (\d{1,2}), (20\d\d)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EXCLUDE = /\b(comedy|comedian|stand[- ]?up|film|screening|lecture)\b/i;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;|&rsquo;|&#8217;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function text(htmlStr) {
  return decodeEntities(String(htmlStr || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* Cards are set in all caps; "FAN HALEN" -> "Fan Halen". */
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().split(' ').map((w, i) =>
    i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/^[a-z]/, c => c.toUpperCase())).join(' ');
}

function toRaw(h, m, ampm) {
  h = parseInt(h, 10);
  ampm = ampm.toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${m}`;
}

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

/* "8:00PM SHOW- DOORS AT 7:00PM" (split across lines on the page). */
function parseTicketPage(pageHtml) {
  const t = text(pageHtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''));
  const show = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*SHOW/i);
  const doors = t.match(/DOORS\s*(?:AT|OPEN)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const title = decodeEntities((pageHtml.match(/<title>([^<]*)/i) || [])[1] || '')
    .replace(/\s*-\s+/, ': ').replace(/\s+/g, ' ').trim();
  return {
    title: title || null,
    start: show ? toRaw(show[1], show[2], show[3]) : null,
    doors: doors ? `${+doors[1]}:${doors[2]} ${doors[3].toUpperCase()}` : null,
  };
}

function eventId(dateISO, title) {
  const key = `rogue_theatre|${dateISO}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
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
    const html = await fetchText(HOME);
    // Walk the page in order: each card's rich-text block, then the first
    // TicketSpice link before the next card is that card's ticket link.
    const tokens = [...html.matchAll(/<div class="brz-rich-text[^>]*>([\s\S]*?)<\/div><\/div>|href="(https:\/\/[a-z0-9-]+\.ticketspice\.com\/[^"]+)"/g)];
    const cards = [];
    for (const tok of tokens) {
      if (tok[2]) {
        const last = cards[cards.length - 1];
        if (last && !last.ticket) last.ticket = tok[2];
        continue;
      }
      const lines = [...tok[1].matchAll(/<h\d[^>]*>([\s\S]*?)<\/h\d>/g)].map(m => text(m[1])).filter(Boolean);
      const dateIdx = lines.findIndex(l => DATE_LINE.test(l));
      if (dateIdx < 1) continue;
      const dm = lines[dateIdx].match(DATE_LINE);
      const mi = MONTHS.indexOf(dm[1]);
      if (mi < 0) continue;
      cards.push({
        parts: lines.slice(0, dateIdx),
        date: `${dm[3]}-${String(mi + 1).padStart(2, '0')}-${String(+dm[2]).padStart(2, '0')}`,
        ticket: null,
      });
    }
    if (!cards.length) throw new Error('no show cards found');

    const events = [];
    for (const c of cards) {
      const raw = c.parts.join(' ');
      if (EXCLUDE.test(raw)) continue;
      let detail = {};
      if (c.ticket) {
        try { detail = parseTicketPage(await fetchText(c.ticket)); } catch { /* list without a time */ }
      }
      const [head, ...rest] = c.parts.map(titleCase);
      const title = detail.title || (rest.length ? `${head}: ${rest.join(' ')}` : head);
      // Most shows here are 8pm; used when the ticket page gives no time.
      const start = detail.start || '2000';
      const link = c.ticket || VENUE.venue_url;
      events.push({
        id: eventId(c.date, title),
        date: c.date,
        start_raw: start,
        end_raw: addHours(start, 2),
        end_estimated: true,
        musician: title,
        genre: '',
        link,
        link_name: '',
        venue: VENUE.name,
        notes: detail.doors ? `Doors ${detail.doors}` : '',
        event_type: 'Band',
        source: 'rogue_theatre',
        source_url: link,
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
