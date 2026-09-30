import { createHash } from 'node:crypto';

/* Holly Theatre (Medford) is a Wix site; its events live in a Wix Data
   collection (named "Courses", a template leftover) read with an anonymous
   instance token from the site's own access-tokens endpoint.

   Date handling: date.$date is entered inconsistently (sometimes midnight
   Pacific, sometimes the real show time in UTC, once noon Pacific), but its
   Pacific calendar date is always the show date. The show time comes from the
   separate `time` field (local wall clock). Don't scrape the /events HTML:
   it renders every time 8 hours early. */
const SITE = 'https://www.hollytheatre.org';
const TOKENS_URL = `${SITE}/_api/v1/access-tokens`;
const QUERY_URL = `${SITE}/_api/cloud-data/v2/items/query`;
const WIX_DATA_APP_ID = '675bbcef-18d8-41f5-800e-131ec9e08762';
const COLLECTION = 'Courses';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
  'Accept': 'application/json,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Name matches the volunteer list's existing venue so the two dedupe. */
const VENUE = {
  name: 'Holly Theater',
  city: 'Medford',
  region: 'Medford',
  venue_type: 'Other',
  venue_url: 'https://www.hollytheatre.org/',
  address: '226 W 6th St, Medford OR',
};

/* Ballet, film, comedy and storytelling bookings. The description check only
   looks at how a show describes itself up top: some music listings carry
   template filler ("an evening of bold comedy"), so a loose "comedy" match
   would drop real concerts. */
const EXCLUDE_TITLE = /\b(nutcracker|ballet|swan lake|screening|film)\b/i;
const EXCLUDE_DESC = /\b(comedy icons?|comedian|ballet|screening|documentary|storytelling event)\b/i;
const DESC_WINDOW = 300;

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function laParts(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, raw: time.replace(':', '') };
}

/* "19:30:00.000" -> "1930" */
function wallRaw(t) {
  const m = String(t || '').match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}` : null;
}

function addHours(raw, hours) {
  const h = parseInt(raw.slice(0, 2), 10);
  const m = parseInt(raw.slice(2), 10);
  let total = h * 60 + m + hours * 60;
  if (total >= 1440) total = 1439;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}

function fmt12(raw) {
  let h = parseInt(raw.slice(0, 2), 10);
  const m = raw.slice(2);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function eventId(itemId, dateISO, title) {
  const key = `holly|${itemId}|${dateISO}|${title}`.toLowerCase();
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
    const tokRes = await fetch(TOKENS_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!tokRes.ok) throw new Error(`access-tokens HTTP ${tokRes.status}`);
    const instance = (await tokRes.json())?.apps?.[WIX_DATA_APP_ID]?.instance;
    if (!instance) throw new Error('no Wix Data instance token');

    const res = await fetch(QUERY_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Authorization: instance },
      body: JSON.stringify({ dataCollectionId: COLLECTION, query: { paging: { limit: 100 } } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`items/query HTTP ${res.status}`);
    const items = (await res.json())?.dataItems;
    if (!Array.isArray(items)) throw new Error('dataItems missing');

    // Keep past events (the merge step archives them); only drop ancient ones.
    const pastFloor = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
    const events = [];
    for (const it of items) {
      const x = it.data || {};
      if (x._publishStatus && x._publishStatus !== 'PUBLISHED') continue;
      const title = clean(x.title);
      const stamp = x.date?.$date;
      if (!title || !stamp) continue;
      if (EXCLUDE_TITLE.test(title)) continue;
      if (EXCLUDE_DESC.test(clean(x.aboutTheInstructor).slice(0, DESC_WINDOW))) continue;

      const at = laParts(stamp);
      const dateISO = at.date;
      if (dateISO < pastFloor) continue;

      // Start: the `time` field; else the stamp's own time if it carries one
      // (not midnight/noon placeholders); else an hour after doors.
      const doors = wallRaw(x.doorsOpen);
      let start = wallRaw(x.time);
      if (!start && at.raw !== '0000' && at.raw !== '1200') start = at.raw;
      if (!start && doors) start = addHours(doors, 1);
      if (!start) start = '1930';
      const end = addHours(start, 2);

      const link = x.url || `${SITE}${x['link-courses-title'] || '/events'}`;
      events.push({
        id: eventId(it.id || x._id || link, dateISO, title),
        date: dateISO,
        start_raw: start,
        end_raw: end,
        end_estimated: true,
        musician: title,
        genre: '',
        link,
        link_name: '',
        venue: VENUE.name,
        notes: doors ? `Doors ${fmt12(doors)}` : '',
        event_type: 'Band',
        source: 'holly',
        source_url: link,
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
