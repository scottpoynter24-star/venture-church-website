// Pure logic for the Church Center sync: parsing what the pages show and merging it
// into data/events.json and data/groups.json. No network access in this file.
import { DateTime } from 'luxon';

export const TZ = 'America/Indiana/Indianapolis';
export const BASE = process.env.CC_BASE || 'https://yvc.churchcenter.com';
export const WEEKS_AHEAD = 9;

// ---------- small helpers ----------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function normTitle(t) {
  return clean(t).toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/(\s*-)?\s+\d{1,2}(:\d\d)?\s*(am|pm)$/i, '')   // " 11 AM", " - 11 AM", " 7pm"
    .replace(/\b20\d\d\b/g, '')                            // years
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const ordered = t => ({ starts: t.starts, ends: t.ends, allDay: t.allDay });
const toUTC = dt => dt.toUTC().toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");

// ---------- title overrides (Scott's request) ----------
export function applyTitleOverrides(title) {
  let t = clean(title);
  if (/^men'?s prayer breakfast$/i.test(t.replace(/’/g, "'"))) return "Men's Breakfast";
  t = t.replace(/Men(['’])s Prayer Breakfast/gi, "Men$1s Breakfast");
  return t;
}

// ---------- times ----------
function hm(h, m, ap) {
  h = +h; m = +(m || 0);
  if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h !== 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  return [h, m];
}
// Parses "6:30–8pm", "10:59am–12:15pm", "8–9am", "7pm", "All day" for a local date (yyyy-mm-dd).
export function parseTimes(dateISO, timeText) {
  const day = DateTime.fromISO(dateISO, { zone: TZ });
  const t = clean(timeText).replace(/ /g, ' ');
  const allDay = () => ({ allDay: true, starts: toUTC(day.startOf('day')), ends: toUTC(day.set({ hour: 23, minute: 59 })) });
  if (!t || /all day/i.test(t)) return allDay();
  let m = t.match(/^(\d{1,2})(?::(\d\d))?\s*(am|pm)?\s*[–—-]\s*(\d{1,2})(?::(\d\d))?\s*(am|pm)$/i);
  if (m) {
    const [eh, em] = hm(m[4], m[5], m[6]);
    let [sh, sm] = hm(m[1], m[2], m[3] || m[6]);
    if (!m[3] && (sh * 60 + sm) > (eh * 60 + em)) [sh, sm] = hm(m[1], m[2], 'am'); // "11–1pm"
    const s = day.set({ hour: sh, minute: sm }), e = day.set({ hour: eh, minute: em });
    return { allDay: false, starts: toUTC(s), ends: toUTC(e < s ? e.plus({ days: 1 }) : e) };
  }
  m = t.match(/^(\d{1,2})(?::(\d\d))?\s*(am|pm)$/i);
  if (m) { const [h, mi] = hm(m[1], m[2], m[3]); const s = day.set({ hour: h, minute: mi }); return { allDay: false, starts: toUTC(s), ends: toUTC(s.plus({ hours: 1 })) }; }
  return allDay();
}
export function cleanRecur(r) {
  r = clean(r).replace(/^the\s+/i, '');
  return r ? r[0].toUpperCase() + r.slice(1) : '';
}

// ---------- rooms ----------
export function placeIndex(rooms) {
  const out = [];
  (rooms.rooms || []).forEach(r => r.label !== false && r.kind !== 'hall' && out.push({ id: r.id, name: r.name }));
  (rooms.landmarks || []).forEach(l => out.push({ id: l.id, name: l.name }));
  (rooms.zones || []).forEach(z => out.push({ id: z.id, name: z.name }));
  return out.filter(p => p.name.length >= 5 && !/^(restrooms|patio|room [a-z]?\d|office)/i.test(p.name));
}
// Known assignments always win (by title), then any room name the text mentions.
export function roomFor(title, text, places) {
  const t = clean(title);
  const known = [
    [/sunday.*service|express service|christmas eve|easter|first wednesday|jingle jam/i, 'auditorium'],
    [/growth track/i, 'growth-track-room'],
    [/middle school ministry|high school ministry|high school room|teen room/i, 'nw-classroom'],
    [/\brestore\b|grief ?share/i, 'west-hall'],
    [/men'?s (prayer )?breakfast/i, 'lobby'],
    [/trunk or treat/i, 'back-yard'],
  ];
  for (const [re, id] of known) if (re.test(t)) return id;
  const hay = `${t} ${clean(text)}`;
  if (/high school room|teen room/i.test(hay)) return 'nw-classroom';
  if (/coffee bar/i.test(hay)) return 'coffee-bar';
  if (/kids check-?in/i.test(hay)) return 'kids-checkin';
  if (/multipurpose room/i.test(hay)) return 'west-hall';
  if (/main lobby/i.test(hay)) return 'lobby';
  if (/back ?yard/i.test(hay)) return 'back-yard';
  const p = places.find(p => new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay));
  return p ? p.id : null;
}

// ---------- event categories ----------
export function categoryFor(title, extra = '') {
  const t = `${title} ${extra}`;
  if (/sunday.*service|express service|\b(9:30|11) ?am service/i.test(t)) return 'Sunday services';
  if (/christmas|easter|thanksgiving|new year|good friday|holiday/i.test(t)) return 'Holiday';
  if (/growth track/i.test(t)) return 'Growth Track';
  if (/middle school|high school|student|youth|teen/i.test(t)) return 'Students';
  if (/women|ladies/i.test(t)) return 'Women';
  if (/\bmen\b|\bmen'?s\b/i.test(t)) return 'Men';
  if (/kids|family|families|trunk or treat|jingle|vbs|children/i.test(t)) return 'Family';
  if (/food drive|outreach|serve day|drive\b|donat/i.test(t)) return 'Outreach';
  if (/prayer|first wednesday/i.test(t)) return 'Prayer';
  if (/group|restore|grief ?share|class/i.test(t)) return 'Groups';
  return 'Church life';
}
function featuredFor(title, recur, category) {
  if (['Sunday services', 'Growth Track'].includes(category)) return false;
  if (/first wednesday/i.test(title)) return true;           // monthly church-wide night
  return !recur;                                              // one-offs and special events
}

// ---------- events ----------
// calendarItems: [{ id, date (yyyy-mm-dd), title, time }]   ("time" is the full time line, e.g. "7–9pm | Every Wednesday")
// regItems:      [{ id, title, dates: [{ date, time }], categories, location, text }]
export function buildEvents({ calendarItems, regItems, old, rooms, now }) {
  const today = now.setZone(TZ).startOf('day');
  const horizon = today.plus({ weeks: WEEKS_AHEAD }).endOf('day');
  const places = placeIndex(rooms);
  const oldEvents = old.events || [];
  const byOcc = new Map(oldEvents.map(e => [String(e.url || '').split('/').pop(), e]));
  const seriesMeta = new Map();
  oldEvents.forEach(e => { if (!seriesMeta.has(e.series)) seriesMeta.set(e.series, e); });
  const titleToSeries = new Map();
  oldEvents.forEach(e => { const k = normTitle(e.title); if (!titleToSeries.has(k)) titleToSeries.set(k, e.series); });
  // also match titles as Church Center writes them (before the override)
  oldEvents.forEach(e => { if (e.title === "Men's Breakfast") titleToSeries.set(normTitle("Men's Prayer Breakfast"), titleToSeries.get(normTitle(e.title))); });
  const newSeries = new Map();
  const out = [];

  for (const it of calendarItems) {
    const [timePart, ...rest] = String(it.time || '').split('|');
    const recurRaw = cleanRecur(rest.join('|'));
    const title = applyTitleOverrides(it.title);
    const day = DateTime.fromISO(it.date, { zone: TZ });
    if (!day.isValid || day < today || day > horizon) continue;
    const occ = byOcc.get(String(it.id));
    let series = occ?.series || titleToSeries.get(normTitle(it.title)) || titleToSeries.get(normTitle(title)) || newSeries.get(normTitle(title));
    if (!series) { series = String(it.id); newSeries.set(normTitle(title), series); titleToSeries.set(normTitle(title), series); }
    const meta = seriesMeta.get(series);
    let recur = recurRaw;
    if (occ && occ.recur && (!recur || occ.recur.startsWith(recur))) recur = occ.recur;   // keep hand-written extras like "through Nov 18"
    const category = meta?.category ?? categoryFor(title);
    out.push({
      id: `${series}-${it.date}`, series, title, ...ordered(parseTimes(it.date, timePart)),
      recur, category,
      roomId: meta ? meta.roomId : roomFor(title, '', places),
      location: 'Lizton Campus',
      summary: meta?.summary ?? '',
      url: `${BASE}/calendar/event/${it.id}`,
      featured: meta?.featured ?? featuredFor(title, recur, category),
    });
  }

  // registrations: add any dated registration event that the calendar doesn't already show
  const sameEvent = (a, b) => { const x = normTitle(a), y = normTitle(b); return x === y || (x.length > 5 && y.includes(x)) || (y.length > 5 && x.includes(y)); };
  for (const r of regItems) {
    const title = applyTitleOverrides(r.title);
    const series = `reg-${r.id}`;
    const meta = seriesMeta.get(series);
    for (const d of r.dates) {
      const day = DateTime.fromISO(d.date, { zone: TZ });
      if (!day.isValid || day < today) continue;
      const dup = out.some(e => !e.series.startsWith('reg-') && sameEvent(e.title, title) &&
        DateTime.fromISO(e.starts).setZone(TZ).toISODate() === d.date);
      if (dup) continue;
      const category = meta?.category ?? categoryFor(title, (r.categories || []).join(' '));
      out.push({
        id: `${series}-${d.date}`, series, title, ...ordered(parseTimes(d.date, d.time)),
        recur: '', category,
        roomId: meta ? meta.roomId : roomFor(title, r.text, places),
        location: 'Lizton Campus',
        summary: meta?.summary ?? '',
        url: `${BASE}/registrations/events/${r.id}`,
        featured: meta?.featured ?? (category !== 'Sunday services' && category !== 'Growth Track'),
      });
    }
  }
  out.sort((a, b) => a.starts.localeCompare(b.starts) || a.title.localeCompare(b.title));
  // ids must be unique (two services with the same title on one day get a time suffix)
  const seen = new Map();
  out.forEach(e => { const n = (seen.get(e.id) || 0) + 1; seen.set(e.id, n); if (n > 1) e.id = `${e.id}-${n}`; });
  return out;
}

// ---------- registration detail page text ----------
const HEADINGS = /^(CATEGORIES|DETAILS|UPCOMING DATES|LOCATION|SELECTIONS|CONTACT|REGISTRATION|PAST DATES|SPOTS|PRICE|DATES)$/i;
export function parseRegistrationText(text) {
  const lines = String(text).split('\n').map(clean).filter(Boolean);
  const section = name => { const i = lines.findIndex(l => l.toUpperCase() === name); if (i < 0) return []; const o = []; for (let j = i + 1; j < lines.length && !HEADINGS.test(lines[j]); j++) o.push(lines[j]); return o; };
  const dates = [];
  const up = section('UPCOMING DATES');
  for (let i = 0; i < up.length; i++) {
    const d = DateTime.fromFormat(up[i], 'LLL d, yyyy', { zone: TZ });
    if (!d.isValid) continue;
    const next = up[i + 1] || '';
    const isTime = /^(all day|\d{1,2}(:\d\d)?\s*(am|pm)?\s*([–—-]\s*\d{1,2}(:\d\d)?\s*(am|pm))?)$/i.test(next);
    dates.push({ date: d.toISODate(), time: isTime ? next : 'All day' });
    if (isTime) i++;
  }
  return { dates, categories: section('CATEGORIES'), location: section('LOCATION')[0] || '', details: section('DETAILS').join(' ') };
}

// ---------- groups ----------
export function formatWhen(raw) {
  let s = clean(raw);
  if (!s) return 'Schedule varies';
  s = s.replace(/^meets weekly on\s+/i, '').replace(/\s+from\s+/i, ' ')
    .replace(/(\d)\s*-\s*(\d)/g, '$1–$2')
    .replace(/(\d)\s*(am|pm)\b/gi, (m, d, ap) => `${d} ${ap.toUpperCase()}`);
  return s[0].toUpperCase() + s.slice(1);
}
export function dayFor(raw) {
  const m = clean(raw).match(/\b(Sun|Mon|Tues?|Wed(nes)?|Thu(rs)?|Fri|Sat(ur)?)[a-z]*day/i);
  if (m) { const k = m[0].slice(0, 3).toLowerCase(); return WEEKDAYS.find(d => d.slice(0, 3).toLowerCase() === k); }
  if (/month/i.test(raw)) return 'Monthly';
  return 'Varies';
}
export function whoFor(name, cats = '') {
  const t = `${name} ${cats}`;
  const women = /women|ladies/i.test(t), men = /\bmen\b|\bmen'?s\b/i.test(t);
  if (/55\+|seniors?\b/i.test(t)) return '55+';
  if (/young adult|18[–-]30|college/i.test(t)) return 'Young adults';
  if (/grief|recovery|addiction|divorce|support/i.test(t)) return 'Support';
  if (/serve|maintenance|team\b/i.test(t)) return 'Serve teams';
  if (women && men) return 'Everyone';
  if (women) return 'Women';
  if (men) return 'Men';
  if (/famil|kids|parents|moms|dads/i.test(t)) return 'Families';
  return 'Everyone';
}
// Group page text -> where/roomId. PRIVACY: never publishes leader names or street addresses.
export function parseGroupPage(text, places) {
  const lines = String(text).split('\n').map(clean).filter(Boolean);
  const after = name => { const i = lines.findIndex(l => l.toUpperCase() === name); return i < 0 ? [] : lines.slice(i + 1, i + 6); };
  const catLines = after('CATEGORIES');
  let town = '';
  const ni = lines.findIndex(l => /^neighborhood$/i.test(l));
  if (ni >= 0) town = clean((lines[ni + 1] || '').replace(/^:\s*/, ''));
  const loc = after('LOCATION')[0] || '';
  const aboutI = lines.findIndex(l => /^about /i.test(l));
  const about = aboutI >= 0 ? lines.slice(aboutI + 1, aboutI + 12).join(' ') : '';
  let where, roomId = null;
  if (!loc) where = /online|zoom|virtual/i.test(about) ? 'Online' : 'Varies';
  else if (/venture church|7865 n/i.test(loc)) {
    where = 'At Venture';
  } else if (/online|zoom|virtual/i.test(loc)) where = 'Online';
  else if (/house|home|residence|['’]s\b/i.test(loc)) where = 'In a home' + (town ? ` · ${town}` : '');
  else where = 'Off-site' + (town ? ` · ${town}` : '');
  return { where, town, about, categories: catLines.join(' ') };
}

export function buildGroups({ cards, old, rooms, pages }) {
  const places = placeIndex(rooms);
  const byUrl = new Map((old.groups || []).map(g => [g.url, g]));
  const out = [];
  for (const c of cards) {
    const url = `${BASE}/groups/small-groups/${c.slug}`;
    const prev = byUrl.get(url);
    if (prev) {
      const g = { ...prev };
      if (g.ccName !== undefined && clean(c.name) !== g.ccName) { g.name = clean(c.name); g.ccName = clean(c.name); }
      if (g.ccSchedule !== undefined && clean(c.schedule) !== g.ccSchedule) { g.when = formatWhen(c.schedule); g.day = dayFor(c.schedule); g.ccSchedule = clean(c.schedule); }
      if (g.ccName === undefined) g.ccName = clean(c.name);
      if (g.ccSchedule === undefined) g.ccSchedule = clean(c.schedule);
      out.push(g);
      continue;
    }
    const p = parseGroupPage(pages[c.slug] || '', places);
    let roomId = null;
    if (p.where === 'At Venture') {
      roomId = roomFor(c.name, p.about, places);
      const nm = roomId && (places.find(x => x.id === roomId)?.name || (roomId === 'back-yard' ? 'Back Yard' : null));
      if (nm) p.where = `At Venture · ${nm}`;
    }
    out.push({
      name: clean(c.name), when: formatWhen(c.schedule), day: dayFor(c.schedule),
      who: whoFor(c.name, p.categories), where: p.where, roomId, summary: '', url,
      ccName: clean(c.name), ccSchedule: clean(c.schedule),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Compare two data files ignoring "updated".
export const sameData = (a, b) => JSON.stringify({ ...a, updated: 0 }) === JSON.stringify({ ...b, updated: 0 });
