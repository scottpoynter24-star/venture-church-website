// Offline test: feeds today's real Church Center readings through the merge logic.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { buildEvents, buildGroups, parseRegistrationText, parseTimes, formatWhen, dayFor, applyTitleOverrides, parseGroupPage, placeIndex } from './lib.mjs';
const F = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url)));
const read = p => structuredClone({ 'events.json': F.oldEvents, 'groups.json': F.oldGroups, 'rooms.json': F.rooms }[p]);
const rooms = read('rooms.json');
const now = DateTime.fromISO(F.now, { zone: 'America/Indiana/Indianapolis' });

// times and DST
assert.deepEqual(parseTimes('2026-11-08', '10:59am–12:15pm'), { allDay: false, starts: '2026-11-08T15:59:00Z', ends: '2026-11-08T17:15:00Z' });
assert.deepEqual(parseTimes('2026-10-25', '8–9am'), { allDay: false, starts: '2026-10-25T12:00:00Z', ends: '2026-10-25T13:00:00Z' });
assert.equal(parseTimes('2026-11-03', 'All day').ends, '2026-11-04T04:59:00Z');
assert.equal(parseTimes('2026-11-14', '11–1pm').starts, '2026-11-14T16:00:00Z');
assert.equal(applyTitleOverrides("Men's Prayer Breakfast"), "Men's Breakfast");
assert.equal(formatWhen('Meets weekly on Thursdays from 6:30-8pm'), 'Thursdays 6:30–8 PM');
assert.equal(dayFor('second Saturday of every month'), 'Saturday');
assert.equal(dayFor('once a month'), 'Monthly');

const reg = parseRegistrationText(F.regText);
assert.deepEqual(reg.dates, [{ date: '2026-11-14', time: '10am–4:30pm' }]);

const regItems = F.registrations.map(r => ({ id: r.id, title: r.title, dates: r.dates || parseRegistrationText(r.text).dates, categories: r.categories || [], location: '', text: '' }));
const events = buildEvents({ calendarItems: F.calendar, regItems, old: read('events.json'), rooms, now });
const old = read('events.json').events;
const strip = e => JSON.stringify(e);
const oldIds = new Set(old.map(e => e.id));
const added = events.filter(e => !oldIds.has(e.id));
const removed = old.filter(e => !events.some(x => x.id === e.id));
const changed = events.filter(e => oldIds.has(e.id) && strip(e) !== strip(old.find(o => o.id === e.id)));
console.log('events', events.length, 'added', added.map(e => e.id + ' ' + e.title + ' ' + e.starts + ' ' + e.category + ' ' + e.roomId + ' ' + e.featured));
console.log('removed', removed.map(e => e.id), 'changed', changed.map(e => e.id));
assert.equal(changed.length, 0);
assert.ok(!events.some(e => /prayer breakfast/i.test(e.title)));

const groups = buildGroups({ cards: F.groups, old: read('groups.json'), rooms, pages: {} });
const og = read('groups.json').groups;
console.log('groups', groups.length, 'changed', groups.filter(g => { const o = og.find(x => x.url === g.url); return !o || o.name !== g.name || o.when !== g.when; }).map(g => g.name));

// a brand-new group, using a real group page's text (leader names and address must not appear)
const places = placeIndex(rooms);
const p1 = parseGroupPage(F.groupPage2717, places);
assert.equal(p1.where, 'In a home · Pittsboro');
const p2 = parseGroupPage(F.groupPageBasin, places);
assert.equal(p2.where, 'At Venture');
const g2 = buildGroups({ cards: [{ slug: 'grace-at-the-basin', name: 'Grace at the Basin', schedule: 'Meets weekly on Tuesdays from 6-7:30pm' }], old: { groups: [] }, rooms, pages: { 'grace-at-the-basin': F.groupPageBasin } })[0];
console.log('new group sample', g2);
assert.equal(g2.where, 'At Venture · Coffee Bar');
assert.ok(!/Joe|John|Chardell|IN 46167/.test(JSON.stringify(buildGroups({ cards: [{ slug: 'x', name: '27:17 Men', schedule: 'Mostly Tuesdays 6-7:30' }], old: { groups: [] }, rooms, pages: { x: F.groupPage2717 } }))));
console.log('ALL TESTS PASSED');
