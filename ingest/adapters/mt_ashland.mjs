import { createHash } from 'node:crypto';

/* Mt. Ashland Ski Area event directory (WordPress + EventON). EventON exposes
   no ICS feed or JSON-LD, but every card carries a mailto share link with a
   machine-parseable "Event Date: July 25, 2026 12:00 PM - July 26, 2026 8:00 PM"
   line, so we parse those. The directory mixes in non-music events (movie
   nights, trail runs), so each event's detail page is fetched once and kept
   only if it reads as live music. Ticket pricing is pulled from the detail
   page's Ticketing section; when a "prices rise to ..." clause has already
   kicked in, the risen price is prepended so the UI's $-badge (first $NN in
   notes) shows what a ticket costs today, not the expired advance price. */

const DIRECTORY_URL = 'https://www.mtashland.com/event-directory/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; rvlivemusic-ingest/0.1; +https://rvlivemusic.com)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const VENUE = {
  name: 'Mt Ashland Lodge',
  meta: {
    url: 'https://www.mtashland.com',
    city: 'Ashland',
    notes: 'Outdoor stages at the Mt. Ashland Ski Area, elevation 6,500 ft',
    address: '11 Mt. Ashland Ski Road, Ashland, OR 97520',
    region: 'Ashland',
    type: 'Other',
  },
};

const MUSIC_SIGNAL = /live music|music festival|concert|band lineup/i;
const MAX_SPLIT_DAYS = 4;
const NOTES_CAP = 300;

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseDate(s) {
  const m = s.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

function parseTime(s) {
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}${m[2]}`;
}

function isoAddDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function pageText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ');
  // Drop everything from the prev/next-post nav on: a neighboring post titled
  // "...Music Festival" would otherwise trip the music filter for every event.
  const nav = text.search(/previous post:|next post:/i);
  return nav >= 0 ? text.slice(0, nav) : text;
}

/* Pull the Ticketing section blob. When a "prices rise to ..." clause has
   already taken effect, the superseded advance prices are stripped and the
   current price leads, so the UI's $-badge (first $NN in notes) quotes what a
   ticket costs today rather than an expired one. */
function extractCost(text, eventDateISO, todayISO) {
  let blob = '';
  const anchor = text.search(/Ticketing Information/i);
  if (anchor >= 0) {
    const seg = text.slice(anchor + 'Ticketing Information'.length);
    const stop = seg.search(/Event Information|Add To Calendar|Share this/i);
    blob = seg.slice(0, stop > 0 ? stop : 400).trim();
  }
  if (!blob || !/\$\d/.test(blob)) {
    const m = text.match(/[^.!?]*\btickets?\b[^.!?]*\$\d[^.!?]*[.!?]/i);
    blob = m ? m[0].trim() : '';
  }
  if (!blob) return '';

  let notes = blob;
  const riseRe = /\s*Starting\s+(\w+\s+\d{1,2})(?:st|nd|rd|th)?,?\s+ticket prices?\s+rise to\s+([^.!?]*)[.!?]?/i;
  const rise = blob.match(riseRe);
  if (rise) {
    const riseISO = parseDate(`${rise[1]}, ${eventDateISO.slice(0, 4)}`);
    if (riseISO && riseISO <= todayISO) {
      // In effect: drop both the rise clause and the advance prices it replaced.
      const rest = blob
        .replace(riseRe, ' ')
        .replace(/\s*(?:Single day|Full weekend|Day|Weekend)\s+tickets?:?\s*\$\d[\d,]*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      notes = `Tickets ${rise[2].trim()}. ${rest}`.trim();
    }
  }
  notes = notes.replace(/\s{2,}/g, ' ').trim();
  if (notes.length > NOTES_CAP) notes = notes.slice(0, NOTES_CAP).replace(/\s+\S*$/, '') + '…';
  return notes;
}

function eventId(slug, dateISO, startRaw, title) {
  const key = `mt_ashland|${slug}|${dateISO}|${startRaw}|${title}`.toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function parseDirectory(html) {
  const out = [];
  const mailtoRe = /href="mailto:\?subject=[^"]*&body=([^"]*)"/g;
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    const body = decodeURIComponent(m[1].replace(/&#0?38;/g, '&'));
    const name = body.match(/Event Name:\s*(.+)/);
    const date = body.match(/Event Date:\s*(.+)/);
    const link = body.match(/Link:\s*(\S+)/);
    if (!name || !date || !link) continue;
    out.push({ title: name[1].trim(), dateRange: date[1].trim(), link: link[1].trim() });
  }
  return out;
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
    const res = await fetch(DIRECTORY_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('mailto:?subject=')) throw new Error('page missing event share blocks');
    const cards = parseDirectory(html);

    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pastFloor = isoAddDays(todayISO, -366);

    // One detail-page fetch per event, shared across recurrence variants
    // (/events/foo/var/ri-2.l-L1 and /events/foo/ are the same page).
    const detailCache = new Map();
    async function detailText(link) {
      const base = link.replace(/\/var\/[^/]+\/?$/, '/');
      if (!detailCache.has(base)) {
        try {
          const r = await fetch(base, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
          detailCache.set(base, r.ok ? pageText(await r.text()) : '');
        } catch {
          detailCache.set(base, '');
        }
      }
      return detailCache.get(base);
    }

    const events = [];
    const seen = new Set();
    for (const card of cards) {
      const range = card.dateRange.match(
        /(\w+\s+\d{1,2},\s+\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(?:(\w+\s+\d{1,2},\s+\d{4})\s+)?(\d{1,2}:\d{2}\s*[AP]M)/i
      );
      if (!range) continue;
      const startISO = parseDate(range[1]);
      if (!startISO || startISO < pastFloor) continue;
      const endISO = range[3] ? parseDate(range[3]) : startISO;
      const startRaw = parseTime(range[2]);
      const endRaw = parseTime(range[4]);

      const text = await detailText(card.link);
      if (!MUSIC_SIGNAL.test(`${card.title} ${text}`)) continue;

      const notes = extractCost(text, startISO, todayISO);
      const eventType = /festival/i.test(card.title) ? 'Festival' : 'Band';

      // Multi-day events become one entry per day: each day reuses the range's
      // start time (festivals keep a consistent daily start) and only the final
      // day gets the published end time. The title stays identical across days
      // so a day another feed also lists (e.g. Travel Ashland) dedups against it.
      const days = [];
      for (let iso = startISO; iso <= endISO && days.length < MAX_SPLIT_DAYS; iso = isoAddDays(iso, 1)) {
        days.push(iso);
      }
      days.forEach((iso, i) => {
        const title = card.title;
        const id = eventId(card.link, iso, startRaw, title);
        if (seen.has(id)) return;
        seen.add(id);
        events.push({
          id,
          date: iso,
          start_raw: startRaw,
          end_raw: i === days.length - 1 ? endRaw : '',
          musician: title,
          genre: '',
          link: card.link,
          link_name: '',
          venue: VENUE.name,
          notes,
          event_type: eventType,
          source: 'mt_ashland',
          source_url: card.link,
        });
      });
    }

    const venues = events.length ? { [VENUE.name]: VENUE.meta } : {};
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
