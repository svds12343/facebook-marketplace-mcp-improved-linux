import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseMoney, priceSignals, observeListing } from '../dist/analysis/prices.js';
import { filterListings } from '../dist/analysis/filters.js';
import { fingerprintImage, comparePhotos, assessEvidence } from '../dist/analysis/photos.js';
import { readState, updateState, withLock, BusyError } from '../dist/storage/state.js';
import { addMonitor } from '../dist/storage/monitors.js';
import { runChecks, recordPriceAlerts } from '../dist/monitoring/runner.js';
import { automationStatus, configureAutomation, suspendAutomation, reserveAutomatedRequest } from '../dist/monitoring/control.js';
import { reserveRequestSlot } from '../dist/utils/rate-limit.js';
import { readAlerts, acknowledgeAlerts, createWatchHandler } from '../dist/tools/tracking.js';
import { createSearchHandler } from '../dist/tools/search.js';

const now = '2026-11-14T12:00:00.000Z';
const listing = (id = '1', price = 'CHF 500') => ({ id, title: 'Laptop', price, location: 'Morges', imageUrl: '', sellerName: 'Seller', sellerId: '42', postedDate: now,
  url: `https://www.facebook.com/marketplace/item/${id}/`, isPending: false });
const detail = (id = '1', price = 'CHF 500') => ({ ...listing(id, price), description: 'Laptop in good condition', images: [], condition: 'Used', seller: { name: 'Seller', profileUrl: 'https://www.facebook.com/42' } });
const searchParams = { query: 'laptop', latitude: 46.5, longitude: 6.5, radiusKm: 20, limit: 24 };
const state = () => ({ version: 1, monitors: [], listings: {}, watches: [], alerts: [], monitorRotation: 0 });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-tracking-'));
  const old = process.env.FB_DATA_DIR;
  process.env.FB_DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.FB_DATA_DIR; else process.env.FB_DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('Swiss and European money formats retain currency and reject ambiguous amounts', () => {
  for (const text of ["CHF 1'234.50", '1’234,50 CHF', 'Fr. 1234.50', 'CHF 1 234.50']) assert.deepEqual(parseMoney(text), { amount: 1234.5, currency: 'CHF' });
  assert.deepEqual(parseMoney('CHF 450.–'), { amount: 450, currency: 'CHF' });
  assert.deepEqual(parseMoney('€1.234,50'), { amount: 1234.5, currency: 'EUR' });
  assert.equal(parseMoney('$500'), null);
  assert.equal(parseMoney('500'), null);
  assert.equal(parseMoney('CHF 30-50'), null);
  assert.equal(parseMoney('CHF 1.2345'), null);
});
test('price review separates asking prices from original cost and shipping', () => {
  assert.equal(priceSignals(listing('1', 'CHF 1'))[0].code, 'possible_placeholder');
  assert.equal(priceSignals(listing(), 'Acheté CHF 1000. Livraison CHF 20.').length, 0);
  assert.ok(priceSignals(listing(), 'Prix de vente: CHF 700.').some(s => s.code === 'description_price_difference'));
  assert.equal(priceSignals(listing(), 'Prix: EUR 700.').length, 0);
});
test('keyword, seen and age filters expose unknown dates without inventing posting age', () => {
  const s = state();
  s.listings['3'] = { listing: listing('3'), firstSeen: now, lastSeen: now, seenAt: now, history: [] };
  const items = [{ ...listing('1'), title: 'POUR PIÈCES laptop' }, { ...listing('2'), title: 'unbroken laptop' }, listing('3'),
    { ...listing('4'), postedDate: '' }, { ...listing('5'), postedDate: '2020-01-01' }];
  const r = filterListings(items, { exclude_keywords: ['pour pieces', 'broken'], hide_seen: true, max_age_days: 2 }, s, Date.parse(now));
  assert.deepEqual(r.listings.map(l => l.id), ['2']);
  assert.deepEqual(r.excluded, { keyword: 1, id: 0, seen: 1, age: 1, unknown_age: 1 });
  assert.equal(filterListings([items[3]], { max_age_days: 2, include_unknown_age: true }, s).listings.length, 1);
});
test('history records changes, does not backfill, and clears stale numeric price fields', () => {
  const s = state();
  observeListing(s, { ...listing(), priceAmount: 500, currency: 'CHF' }, now);
  observeListing(s, listing('1', 'CHF 400'), now);
  observeListing(s, listing('1', 'CHF 400'), now);
  assert.deepEqual(s.listings['1'].history.map(p => p.amount), [500, 400]);
  assert.equal(s.listings['1'].listing.priceAmount, undefined);
});
test('monitor scans multiple pages, handles empty pages, and deduplicates alerts across runs', async t => {
  setup(t);
  await addMonitor('laptops', searchParams, { maxPages: 3, inspectLimit: 0 });
  const calls = [];
  const client = { searchListings: async p => {
    calls.push(p.cursor);
    if (!p.cursor) return { listings: [listing('1')], hasNextPage: true, endCursor: 'a' };
    if (p.cursor === 'a') return { listings: [], hasNextPage: true, endCursor: 'b' };
    return { listings: [listing('1'), listing('2')], hasNextPage: false, endCursor: null };
  } };
  const first = await runChecks(client, { requestBudget: 3 });
  assert.deepEqual(calls, [undefined, 'a', 'b']);
  assert.equal(first.monitors[0].newListings, 2);
  assert.equal(first.monitors[0].coverage, 'complete');
  await runChecks(client, { requestBudget: 3 });
  assert.equal(readState().alerts.filter(a => a.kind === 'new_listing').length, 2);
});
test('cyclic cursors terminate and failed later pages preserve earlier observations', async t => {
  setup(t);
  await addMonitor('test', searchParams, { maxPages: 10, inspectLimit: 0 });
  let calls = 0;
  const r = await runChecks({ searchListings: async () => ({ listings: [listing()], hasNextPage: true, endCursor: ++calls % 2 ? 'a' : 'b' }) }, { requestBudget: 10 });
  assert.equal(calls, 3);
  assert.equal(r.monitors[0].coverage, 'stalled');
  calls = 0;
  const failed = await runChecks({ searchListings: async () => {
    if (++calls > 1) throw new Error('Fixture network failure');
    return { listings: [listing('8')], hasNextPage: true, endCursor: 'next' };
  } }, { requestBudget: 5 });
  assert.equal(failed.monitors[0].coverage, 'error');
  assert.ok(readState().listings['8']);
  assert.ok(readState().alerts.some(a => a.kind === 'check_error'));
});
test('bounded monitor runs disclose deferred searches and rotate fairly', async t => {
  setup(t);
  for (const name of ['first', 'second', 'third']) await addMonitor(name, searchParams, { maxPages: 1, inspectLimit: 0 });
  const client = { searchListings: async () => ({ listings: [], hasNextPage: false, endCursor: null }) };
  const first = await runChecks(client, { requestBudget: 1 });
  const second = await runChecks(client, { requestBudget: 1 });
  assert.equal(first.monitorsDeferred, 2);
  assert.equal(first.monitors[0].name, 'first');
  assert.equal(second.monitors[0].name, 'second');
});
test('price drops are checked on already-seen offers and target crossings notify once', async t => {
  setup(t);
  await addMonitor('prices', searchParams, { maxPages: 1, inspectLimit: 0, targetPrice: 400, targetCurrency: 'CHF' });
  let price = 'CHF 500';
  const client = { searchListings: async () => ({ listings: [listing('1', price)], hasNextPage: false, endCursor: null }) };
  for (const value of ['CHF 500', 'CHF 400', 'CHF 400', 'CHF 350']) { price = value; await runChecks(client); }
  const saved = readState();
  assert.equal(saved.alerts.filter(a => a.kind === 'price_drop').length, 2);
  assert.equal(saved.alerts.filter(a => a.kind === 'target_reached').length, 1);
  assert.deepEqual(saved.listings['1'].history.map(p => p.amount), [500, 400, 350]);
});
test('placeholders and currency changes do not trigger false price-drop alerts', () => {
  const s = state();
  const old = { amount: 500, currency: 'CHF' };
  assert.deepEqual(recordPriceAlerts(s, 'x', listing('1', 'CHF 1'), old, { amount: 300, currency: 'CHF' }, now), old);
  recordPriceAlerts(s, 'x', listing('1', 'EUR 100'), old, { amount: 300, currency: 'CHF' }, now);
  assert.equal(s.alerts.length, 0);
});
test('individual watch finds a price drop even when search no longer returns the offer', async t => {
  setup(t);
  let price = 'CHF 500';
  const client = { getListingDetail: async id => detail(id, price), searchListings: async () => ({ listings: [], hasNextPage: false, endCursor: null }) };
  const result = await createWatchHandler(client)({ listing_id: '99', target_price: 400, currency: 'CHF' });
  assert.equal(result.isError, undefined);
  price = 'CHF 350';
  const report = await runChecks(client, { requestBudget: 1 });
  assert.equal(report.watched[0].listingId, '99');
  assert.ok(readState().alerts.some(a => a.kind === 'target_reached' && a.listingId === '99'));
});
test('hidden seen results remain paginated and persist across independent handler calls', async t => {
  setup(t);
  const client = { searchListings: async () => ({ listings: [listing()], hasNextPage: true, endCursor: 'next' }) };
  const args = { query: 'laptop', latitude: 46.5, longitude: 6.5, radius_km: 20, limit: 20, hide_seen: true };
  assert.equal((await createSearchHandler(client)(args)).structuredContent.listings.length, 1);
  const again = await createSearchHandler(client)(args);
  assert.equal(again.structuredContent.listings.length, 0);
  assert.equal(again.structuredContent.endCursor, 'next');
  assert.equal(again.structuredContent.excluded.seen, 1);
});
test('alert inbox pagination is read-only; only explicit IDs are acknowledged', async t => {
  setup(t);
  await addMonitor('test', searchParams, { inspectLimit: 0 });
  await runChecks({ searchListings: async () => ({ listings: [listing('1'), listing('2')], hasNextPage: false, endCursor: null }) });
  const first = (await readAlerts({ limit: 1 })).structuredContent;
  assert.equal(first.hasMore, true);
  assert.equal(first.totalUnread, 2);
  const second = (await readAlerts({ after_id: first.nextCursor, limit: 1 })).structuredContent;
  assert.notEqual(second.alerts[0].id, first.alerts[0].id);
  await acknowledgeAlerts({ alert_ids: [first.alerts[0].id] });
  assert.equal((await readAlerts({})).structuredContent.totalUnread, 1);
});
test('legacy monitor migration preserves originals and private permissions; corruption fails closed', async t => {
  const dir = setup(t);
  const legacy = [{ id: 'old', name: 'legacy', params: searchParams, seenIds: ['1'], createdAt: now, lastChecked: null }];
  fs.writeFileSync(path.join(dir, 'monitors.json'), JSON.stringify(legacy));
  await updateState(() => {});
  assert.equal(readState().monitors[0].name, 'legacy');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'monitors.json'))), legacy);
  assert.equal(fs.statSync(path.join(dir, 'tracking.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'tracking.json'), '{broken');
  await assert.rejects(updateState(() => {}), /not been reset/);
  assert.equal(fs.readFileSync(path.join(dir, 'tracking.json'), 'utf8'), '{broken');
});
test('overlapping scheduler/manual runs are rejected before fetching', async t => {
  setup(t);
  await withLock('monitor-run', async () => {
    await assert.rejects(runChecks({ searchListings: async () => { throw new Error('must not fetch'); } }), BusyError);
  });
});
test('independent processes retain all committed state updates', async t => {
  const dir = setup(t);
  const module = pathToFileURL(fileURLToPath(new URL('../dist/storage/state.js', import.meta.url))).href;
  await Promise.all(Array.from({ length: 4 }, (_, id) => new Promise((resolve, reject) => {
    const code = `import {updateState} from ${JSON.stringify(module)}; for(let i=0;i<5;i++) await updateState(s=>s.alerts.push({id:'${id}-'+i,key:'${id}-'+i,createdAt:'${now}',kind:'review',source:'test',message:'test'}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, FB_DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(readState().alerts.length, 20);
});
test('automation defaults off, counts real request reservations, caps the day and requires explicit resume', async t => {
  setup(t);
  assert.equal(automationStatus().enabled, false);
  await assert.rejects(reserveAutomatedRequest(Date.now()), /disabled/);
  await configureAutomation('enable');
  const clock = Date.now();
  assert.equal(await reserveAutomatedRequest(clock), 0);
  assert.ok(await reserveAutomatedRequest(clock + 1000) > 0);
  assert.equal(automationStatus().requests, 1);
  for (let i = 1; i < 24; i++) assert.equal(await reserveAutomatedRequest(clock + i * 60000), 0);
  await assert.rejects(reserveAutomatedRequest(clock + 24 * 60000), /daily request cap/);
  await suspendAutomation('HTTP 429');
  await configureAutomation('enable');
  await assert.rejects(reserveAutomatedRequest(clock + 25 * 60000), /paused/);
  await configureAutomation('resume');
  assert.equal(automationStatus().pausedReason, undefined);
  assert.equal(automationStatus().requests, 24); // Resume cannot reset the daily cap.
});
test('manual and scheduled reservations share one global rate limit', async t => {
  setup(t);
  const clock = Date.now();
  for (const offset of [0, 1000, 2000]) assert.equal(await reserveRequestSlot(3, clock + offset), 0);
  assert.ok(await reserveRequestSlot(3, clock + 3000) >= 57000);
  assert.equal(await reserveRequestSlot(3, clock + 61000), 0);
});
test('photo fingerprints detect reused/resized photos and ignore plain backgrounds', async () => {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < 3; c++) pixels[(y * 64 + x) * 3 + c] = ((x >> 3) + (y >> 3)) % 2 ? 220 : 20;
  const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const resized = await sharp(png).resize(256, 256).jpeg({ quality: 70 }).toBuffer();
  const a = await fingerprintImage(png), b = await fingerprintImage(resized);
  assert.equal(comparePhotos(a, a), 'identical_bytes');
  assert.equal(comparePhotos(a, b), 'visually_similar');
  const blank = await fingerprintImage(await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer());
  assert.equal(comparePhotos(blank, blank), null);
  const s = state();
  const record = observeListing(s, { ...listing('2', 'CHF 1000'), sellerId: 'other' }, now);
  record.photos = [a];
  const report = assessEvidence(detail('1', 'CHF 100'), [b], s);
  assert.equal(report.status, 'review_recommended');
  assert.equal(report.photoMatches[0].differentKnownSellers, true);
  assert.ok(report.signals.some(s => s.code === 'lower_price_than_photo_match'));
  assert.match(report.limitations, /not proof of fraud/);
  assert.equal(assessEvidence(detail(), [], state()).status, 'insufficient_evidence');
});
test('timer installer dry-run uses absolute Node, 6-hour schedule, private files and no network startup', () => {
  const run = spawnSync(process.execPath, ['scripts/install-monitor-timer.mjs', '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const units = JSON.parse(run.stdout);
  assert.ok(units.service.includes(process.execPath));
  assert.match(units.service, /UMask=0077/);
  assert.match(units.timer, /00,06,12,18:00:00/);
  assert.match(units.timer, /Persistent=true/);
});
test('background CLI makes no requests until enabled', t => {
  const dir = setup(t);
  const run = spawnSync(process.execPath, ['dist/cli/check-monitors.js'], { encoding: 'utf8', env: { ...process.env, FB_DATA_DIR: dir } });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).reason, 'disabled');
  assert.equal(fs.existsSync(path.join(dir, 'request-times.json')), false);
});

test('checkpoint errors stop the run before checking the next saved search', async t => {
  setup(t);
  await addMonitor('one', searchParams);
  await addMonitor('two', searchParams);
  let calls = 0;
  const report = await runChecks({ searchListings: async () => { calls++; throw new Error('Facebook checkpoint requires manual login'); } });
  assert.equal(calls, 1);
  assert.equal(report.monitorsDeferred, 1);
});

test('a new UTC day resets only the daily count, never a checkpoint pause', async t => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'automation.json'), JSON.stringify({ enabled: true, day: '2000-01-01', requests: 24, lastRequest: 0, pausedReason: 'checkpoint' }));
  assert.equal(automationStatus().requests, 0);
  assert.equal(automationStatus().pausedReason, 'checkpoint');
  await assert.rejects(reserveAutomatedRequest(Date.now()), /paused/);
});

test('saving the same watch again does not repeat an already-reached-target alert', async t => {
  setup(t);
  const handler = createWatchHandler({ getListingDetail: async id => detail(id, 'CHF 300') });
  const args = { listing_id: '9', target_price: 400, currency: 'CHF' };
  await handler(args);
  await handler(args);
  assert.equal(readState().alerts.filter(a => a.kind === 'target_reached').length, 1);
});
