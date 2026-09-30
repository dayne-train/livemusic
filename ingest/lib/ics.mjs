/* Minimal iCalendar reader with RRULE expansion, for venue feeds (Google
   Calendar, Modern Events Calendar). No dependencies. Everything is resolved
   to America/Los_Angeles wall-clock dates and "HHMM" times.

   Supported: DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY
   (plain or ordinal like 2TH / -1FR), BYMONTH, BYMONTHDAY; EXDATE; per-
   occurrence overrides via RECURRENCE-ID; STATUS:CANCELLED. Anything fancier
   falls back to the DTSTART occurrence only. */

const TZ = 'America/Los_Angeles';
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function unfold(text) {
  return text.replace(/\r\n[ \t]|\n[ \t]/g, '');
}

export function unescapeText(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/* Returns [{ props: { KEY: [{ value, params }] } }] for each VEVENT. */
export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push({ props: cur }); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [key, ...paramParts] = line.slice(0, colon).split(';');
    const params = Object.fromEntries(paramParts.map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
    (cur[key] ||= []).push({ value: line.slice(colon + 1), params });
  }
  return events;
}

export function prop(ev, key) {
  return ev.props[key]?.[0]?.value ?? '';
}

function laFromUtc(y, mo, d, h, mi) {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = dt.toLocaleDateString('en-CA', { timeZone: TZ });
  const time = dt.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '');
  return { date, time };
}

/* A DTSTART/DTEND/EXDATE/RECURRENCE-ID value -> { date: 'YYYY-MM-DD', time: 'HHMM' | null }.
   UTC ("Z") values are converted to LA; TZID and floating values are taken
   as LA wall clock. */
export function toLocal(p) {
  if (!p) return null;
  const v = p.value || p;
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?/);
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  if (m[6]) return laFromUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}${m[5]}` };
}

/* Date helpers on plain YYYY-MM-DD strings (UTC-noon math, no TZ drift). */
const toD = iso => new Date(iso + 'T12:00:00Z');
const fromD = d => d.toISOString().slice(0, 10);
export function addDays(iso, n) { const d = toD(iso); d.setUTCDate(d.getUTCDate() + n); return fromD(d); }
const dayDiff = (a, b) => Math.round((toD(b) - toD(a)) / 86400000);

function parseRule(s) {
  const r = Object.fromEntries(s.split(';').map(kv => kv.split('=')));
  return {
    freq: r.FREQ,
    interval: parseInt(r.INTERVAL || '1', 10) || 1,
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? toLocal(r.UNTIL)?.date : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? { n: m[1] ? parseInt(m[1], 10) : null, wd: DAY_CODES.indexOf(m[2]) } : null; }).filter(Boolean) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    wkst: DAY_CODES.indexOf(r.WKST || 'MO'),
  };
}

function nthOfMonth(d) {
  const day = d.getUTCDate();
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { pos: Math.ceil(day / 7), neg: -Math.ceil((dim - day + 1) / 7) };
}

function matchesByday(d, byday) {
  const wd = d.getUTCDay();
  const { pos, neg } = nthOfMonth(d);
  return byday.some(b => b.wd === wd && (b.n == null || b.n === pos || b.n === neg));
}

function occursOn(rule, startIso, iso) {
  const s = toD(startIso), d = toD(iso);
  switch (rule.freq) {
    case 'DAILY':
      return dayDiff(startIso, iso) % rule.interval === 0;
    case 'WEEKLY': {
      const wds = rule.byday ? rule.byday.map(b => b.wd) : [s.getUTCDay()];
      if (!wds.includes(d.getUTCDay())) return false;
      const weekStart = x => { const off = (x.getUTCDay() - rule.wkst + 7) % 7; return addDays(fromD(x), -off); };
      return (dayDiff(weekStart(s), weekStart(d)) / 7) % rule.interval === 0;
    }
    case 'MONTHLY': {
      const months = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + d.getUTCMonth() - s.getUTCMonth();
      if (months % rule.interval !== 0) return false;
      if (rule.byday) return matchesByday(d, rule.byday);
      if (rule.bymonthday) return rule.bymonthday.includes(d.getUTCDate());
      return d.getUTCDate() === s.getUTCDate();
    }
    case 'YEARLY': {
      if ((d.getUTCFullYear() - s.getUTCFullYear()) % rule.interval !== 0) return false;
      const months = rule.bymonth || [s.getUTCMonth() + 1];
      if (!months.includes(d.getUTCMonth() + 1)) return false;
      if (rule.byday) return matchesByday(d, rule.byday);
      if (rule.bymonthday) return rule.bymonthday.includes(d.getUTCDate());
      return d.getUTCDate() === s.getUTCDate();
    }
    default:
      return false;
  }
}

/* Expand a feed into concrete occurrences within [fromIso, toIso]:
   [{ ev, date, start, end }] where start/end are "HHMM" or null (all-day).
   `ev` is the VEVENT that describes that occurrence (an override if any). */
export function expandIcs(text, fromIso, toIso) {
  const events = parseIcs(text).filter(ev => prop(ev, 'STATUS').toUpperCase() !== 'CANCELLED');
  // Occurrences replaced by RECURRENCE-ID overrides, keyed by UID + date.
  const overridden = new Set();
  for (const ev of events) {
    const rid = toLocal(ev.props['RECURRENCE-ID']?.[0]);
    if (rid) overridden.add(`${prop(ev, 'UID')}|${rid.date}`);
  }
  // Cancelled overrides also remove their occurrence.
  for (const ev of parseIcs(text)) {
    if (prop(ev, 'STATUS').toUpperCase() !== 'CANCELLED') continue;
    const rid = toLocal(ev.props['RECURRENCE-ID']?.[0]);
    if (rid) overridden.add(`${prop(ev, 'UID')}|${rid.date}`);
  }

  const out = [];
  for (const ev of events) {
    const start = toLocal(ev.props.DTSTART?.[0]);
    if (!start) continue;
    const end = toLocal(ev.props.DTEND?.[0]);
    // Same-day end, or a past-midnight end on the next day (e.g. 21:00-01:00).
    const endTime = !end || !end.time ? null
      : end.date === start.date ? end.time
      : end.date === addDays(start.date, 1) && end.time < (start.time || '') ? end.time : null;
    const rruleStr = prop(ev, 'RRULE');
    if (!rruleStr || ev.props['RECURRENCE-ID']) {
      if (start.date >= fromIso && start.date <= toIso) out.push({ ev, date: start.date, start: start.time, end: endTime });
      continue;
    }
    const rule = parseRule(rruleStr);
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) {
      if (start.date >= fromIso && start.date <= toIso) out.push({ ev, date: start.date, start: start.time, end: endTime });
      continue;
    }
    const exdates = new Set((ev.props.EXDATE || []).flatMap(p => p.value.split(',').map(v => toLocal({ value: v, params: p.params })?.date)).filter(Boolean));
    const uid = prop(ev, 'UID');
    const last = rule.until && rule.until < toIso ? rule.until : toIso;
    let n = 0;
    for (let iso = start.date; iso <= last; iso = addDays(iso, 1)) {
      if (!occursOn(rule, start.date, iso)) continue;
      n++;
      if (rule.count != null && n > rule.count) break;
      if (iso < fromIso || exdates.has(iso) || overridden.has(`${uid}|${iso}`)) continue;
      out.push({ ev, date: iso, start: start.time, end: endTime });
    }
  }
  return out;
}

export function laTodayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}
