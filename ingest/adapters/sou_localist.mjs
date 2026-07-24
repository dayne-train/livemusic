import { createHash } from 'node:crypto';

const API_URL = 'https://events.sou.edu/api/2/events?pp=100&days=120';
const SOU_BASE = 'https://events.sou.edu';

const HEADERS = {
  'User-Agent': 'rvlivemusic-ingest/0.1 (https://rvlivemusic.com)',
  'Accept': 'application/json',
};

const MUSIC_TITLE_RE = /\b(music|musical|recital|showcase|symphony|concert|chamber music|orchestra|jazz|opera|choir|chorus|sing[- ]?along|songwriter|jam|open mic|band|ensemble)\b/i;

function isMusicEvent(e) {
  const title = e.title || '';
  if (MUSIC_TITLE_RE.test(title)) return true;
  const types = (e.filters?.event_types || []).map(t => t.name);
  if (types.includes('Music')) return true;
  const depts = (e.filters?.departments || []).map(d => d.name);
  if (depts.some(d => /music|performing arts/i.test(d))) return true;
  return false;
}

function parseStart(start) {
  if (!start) return { date: null, time: '' };
  const m = start.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { date: null, time: '' };
  return { date: m[1], time: `${m[2]}${m[3]}` };
}

function parseEnd(end) {
  if (!end) return '';
  const m = end.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}` : '';
}

function eventId(id, dateISO, startRaw, title) {
  const key = `sou_localist|${id}|${dateISO}|${startRaw}|${title}`.toLowerCase();
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
    const res = await fetch(API_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data?.events) ? data.events : [];
    if (items.length === 0) {
      return {
        ok: true, count: 0, events: [], venues: {}, source_timestamp: null,
        error: null, strategy: 'live', fetched_at: started,
      };
    }
    const events = [];
    const venueSet = new Map();
    // Keep past events (the merge step archives them); only drop ancient ones.
    const pastFloor = new Date();
    pastFloor.setHours(0, 0, 0, 0);
    pastFloor.setDate(pastFloor.getDate() - 366);

    for (const wrap of items) {
      const e = wrap.event;
      if (!e) continue;
      if (!isMusicEvent(e)) continue;
      const instance = e.event_instances?.[0]?.event_instance;
      const { date: dateISO, time: startRaw } = parseStart(instance?.start);
      if (!dateISO) continue;
      if (new Date(dateISO + 'T00:00:00') < pastFloor) continue;
      const endRaw = parseEnd(instance?.end);
      const venueName = (e.location_name || '').trim() || 'SOU';
      const title = (e.title || 'Music event').trim();
      const url = e.url_path ? `${SOU_BASE}${e.url_path}` : null;
      const description = (e.description_text || '').trim();
      events.push({
        id: eventId(e.id, dateISO, startRaw, title),
        date: dateISO,
        start_raw: startRaw,
        end_raw: endRaw,
        end_estimated: !endRaw,
        musician: title,
        genre: '',
        link: url || '',
        link_name: '',
        venue: venueName,
        notes: description.slice(0, 200),
        event_type: 'Band',
        source: 'sou_localist',
        source_url: url,
      });
      if (!venueSet.has(venueName)) {
        venueSet.set(venueName, {
          url: SOU_BASE,
          city: 'Ashland',
          notes: '',
          address: '',
          region: 'Ashland',
          type: 'Other',
        });
      }
    }
    return {
      ok: true,
      count: events.length,
      events,
      venues: Object.fromEntries(venueSet),
      source_timestamp: null,
      error: null,
      strategy: 'live',
      fetched_at: started,
    };
  } catch (err) {
    return {
      ok: false, count: 0, events: [], venues: {}, source_timestamp: null,
      error: err.message, strategy: null, fetched_at: started,
    };
  }
}
