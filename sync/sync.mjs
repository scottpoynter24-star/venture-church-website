// Daily Church Center sync for the Your Venture Church website.
// Opens the public Church Center pages in a headless browser, reads what they show,
// and rewrites data/events.json and data/groups.json. Exits non-zero (so GitHub emails
// the repo owner) when a sanity check fails; in that case nothing is written.
import { chromium } from 'playwright';
import { DateTime } from 'luxon';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, TZ, WEEKS_AHEAD, buildEvents, buildGroups, parseRegistrationText, sameData } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = p => path.join(ROOT, 'data', p);
const readJSON = async p => JSON.parse(await fs.readFile(DATA(p), 'utf8'));
const log = (...a) => console.log('[sync]', ...a);

async function withRetries(label, fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw new Error(`${label} failed after ${tries} tries: ${e.message}`); log(`${label}: try ${i} failed (${e.message}), retrying`); await new Promise(r => setTimeout(r, 5000 * i)); }
  }
}

async function scrapeCalendar(page, now) {
  const horizon = now.setZone(TZ).plus({ weeks: WEEKS_AHEAD }).toISODate();
  await page.goto(`${BASE}/calendar?view=list`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('li[data-eventid]', { timeout: 60000 });
  let prev = -1, still = 0;
  for (let i = 0; i < 80; i++) {
    const { n, last } = await page.evaluate(() => { const l = [...document.querySelectorAll('li[data-eventid]')]; return { n: l.length, last: l.at(-1)?.dataset.date || '' }; });
    if (last >= horizon) break;
    if (n === prev) {
      still++;
      const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => /^(load|show) more/i.test(b.innerText.trim())); if (b) { b.click(); return true; } return false; });
      if (!clicked && still >= 5) break;
    } else still = 0;
    prev = n;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1500);
  }
  const items = await page.evaluate(() => [...document.querySelectorAll('li[data-eventid]')].map(li => {
    const a = li.querySelector('a[href*="/calendar/event/"]');
    return {
      id: (a?.getAttribute('href') || '').split('/').pop() || li.dataset.eventid,
      date: li.dataset.date,
      title: (li.querySelector('h1')?.textContent || a?.textContent || '').trim(),
      time: (li.querySelector('a + div')?.textContent || '').trim(),
    };
  }));
  log(`calendar: ${items.length} list entries, last date ${items.at(-1)?.date}`);
  return items.filter(x => x.id && x.date && x.title);
}

async function scrapeRegistrations(page) {
  await page.goto(`${BASE}/registrations/events`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(1000); }
  const list = await page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/registrations/events/"]')].map(a => {
      const id = (a.getAttribute('href').match(/\/registrations\/events\/(\d+)/) || [])[1];
      const lines = a.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      return { id, title: lines[0] || (a.querySelector('img')?.alt || '').replace(/ logo$/, '') };
    }).filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
  });
  log(`registrations: ${list.length} listed`);
  const out = [];
  for (const r of list) {
    const text = await withRetries(`registration ${r.id}`, async () => {
      await page.goto(`${BASE}/registrations/events/${r.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => /UPCOMING DATES|PAST DATES|Registration (is )?(open|closed)/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
      return page.evaluate(() => document.body.innerText);
    });
    const p = parseRegistrationText(text);
    out.push({ id: r.id, title: r.title, dates: p.dates, categories: p.categories, location: p.location, text: p.details });
    log(`  ${r.title}: ${p.dates.map(d => d.date).join(', ') || 'no upcoming dates'}`);
  }
  return out;
}

async function scrapeGroups(page, oldGroups) {
  await page.goto(`${BASE}/groups/small-groups`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('a[href*="/groups/small-groups/"] h3', { timeout: 60000 });
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('a[href*="/groups/small-groups/"]').length);
    if (n === prev && i > 2) break;
    prev = n;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
  const cards = await page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/groups/small-groups/"]')].map(a => ({
      slug: (a.getAttribute('href').split('/groups/small-groups/')[1] || '').split(/[?#/]/)[0],
      name: (a.querySelector('h3')?.textContent || '').trim(),
      schedule: (a.querySelector('h3 + p')?.textContent || '').trim(),
    })).filter(c => c.slug && c.name && !seen.has(c.slug) && seen.add(c.slug));
  });
  log(`groups: ${cards.length} open groups`);
  const known = new Set((oldGroups || []).map(g => g.url.split('/').pop()));
  const pages = {};
  for (const c of cards.filter(c => !known.has(c.slug))) {
    pages[c.slug] = await withRetries(`group ${c.slug}`, async () => {
      await page.goto(`${BASE}/groups/small-groups/${c.slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => /SCHEDULE|LOCATION|About /.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
      return page.evaluate(() => document.body.innerText);
    });
    log(`  new group: ${c.name}`);
  }
  return { cards, pages };
}

async function main() {
  const now = DateTime.now().setZone(TZ);
  const [oldEvents, oldGroups, rooms] = await Promise.all([readJSON('events.json'), readJSON('groups.json'), readJSON('rooms.json')]);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'en-US', timezoneId: TZ, viewport: { width: 1280, height: 1600 } })).newPage();
  let calendarItems, regItems, groupData;
  try {
    calendarItems = await withRetries('calendar', () => scrapeCalendar(page, now));
    regItems = await withRetries('registrations', () => scrapeRegistrations(page));
    groupData = await withRetries('groups', () => scrapeGroups(page, oldGroups.groups));
  } finally { await browser.close(); }

  const events = buildEvents({ calendarItems, regItems, old: oldEvents, rooms, now });
  const groups = buildGroups({ cards: groupData.cards, old: oldGroups, rooms, pages: groupData.pages });

  // ---- sanity checks: write nothing if Church Center looks broken ----
  const problems = [];
  if (!calendarItems.length) problems.push('the Church Center calendar list came back empty');
  if (!events.length) problems.push('no events would be published');
  const before = (oldGroups.groups || []).length;
  if (before && groups.length < Math.ceil(before / 2)) problems.push(`groups would drop from ${before} to ${groups.length}`);
  if (problems.length) { console.error('[sync] NOT publishing: ' + problems.join('; ')); process.exit(1); }

  const stamp = now.set({ millisecond: 0 }).toISO({ suppressMilliseconds: true });
  const evOut = { updated: stamp, source: `${BASE}/calendar`, events };
  const grOut = { updated: stamp, source: `${BASE}/groups/small-groups`, groups };
  const changed = [];
  if (!sameData(evOut, oldEvents)) { await fs.writeFile(DATA('events.json'), JSON.stringify(evOut, null, 1) + '\n'); changed.push('events'); }
  if (!sameData(grOut, oldGroups)) { await fs.writeFile(DATA('groups.json'), JSON.stringify(grOut, null, 1) + '\n'); changed.push('groups'); }
  const added = events.filter(e => !(oldEvents.events || []).some(o => o.series === e.series)).map(e => e.title);
  log(`${events.length} events, ${groups.length} groups. ${changed.length ? 'Changed: ' + changed.join(', ') : 'No changes.'}`);
  if (added.length) log('New events: ' + [...new Set(added)].join('; '));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### Church Center sync\n${events.length} events, ${groups.length} groups. ${changed.length ? 'Updated: ' + changed.join(', ') : 'No changes.'}\n` +
      (added.length ? `\nNew events (no summary yet): ${[...new Set(added)].join(', ')}\n` : ''));
  }
}

main().catch(e => { console.error('[sync] FAILED:', e); process.exit(1); });
