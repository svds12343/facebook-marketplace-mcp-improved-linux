import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { activityStatus, configureActivity, pauseActivity, resumeActivity, reserveActivityRequest,
  runGuardedRequest, SecurityStopError } from '../dist/activity/control.js';
import { configureAutomation, suspendAutomation } from '../dist/monitoring/control.js';
import { FacebookClient } from '../dist/facebook/client.js';
import { saveFacebookAuth } from '../dist/facebook/auth.js';
import { RateLimiter } from '../dist/utils/rate-limit.js';
import { downloadListingImage } from '../dist/facebook/images.js';
import { createListingHandler } from '../dist/tools/listing.js';
import { readState, updateState } from '../dist/storage/state.js';
import { observeListing } from '../dist/analysis/prices.js';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-global-control-'));
  const previous = { FB_DATA_DIR: process.env.FB_DATA_DIR, FB_COOKIES_FILE: process.env.FB_COOKIES_FILE };
  process.env.FB_DATA_DIR = directory;
  process.env.FB_COOKIES_FILE = path.join(directory, 'session.json');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  saveFacebookAuth({ cookies: ['c_user', 'xs'].map(name => ({ domain: '.facebook.com', name, value: `fixture-${name}`, path: '/', expires: -1 })) });
  t.mock.method(RateLimiter.prototype, 'wait', async () => {}); // Global network gate stays real.
  return directory;
}
const html = id => `<script type="application/json">${JSON.stringify({ id, marketplace_listing_title: 'Fixture guitar',
  listing_price: { amount: '150', currency: 'CHF', formatted_amount: 'CHF 150' }, redacted_description: { text: 'Fixture' } })}</script>`;
const params = { query: 'guitar', latitude: 46.5, longitude: 6.6, radiusKm: 30, limit: 5 };

test('one shared rolling budget counts failed requests and survives midnight, pause and resume', async t => {
  setup(t);
  const clock = Date.parse('2026-11-22T23:59:30Z');
  await configureActivity({ authenticatedPer24Hours: 2, imagesPer24Hours: 3, minimumIntervalSeconds: 1 });
  await reserveActivityRequest('authenticated', clock);
  await reserveActivityRequest('authenticated', clock + 60000);
  await assert.rejects(reserveActivityRequest('authenticated', clock + 120000), /budget exhausted/);
  await pauseActivity();
  await assert.rejects(resumeActivity(false), /manual|manually/);
  await resumeActivity(true);
  await assert.rejects(reserveActivityRequest('authenticated', clock + 180000), /budget exhausted/);
  await reserveActivityRequest('authenticated', clock + 86400001);
});

test('interactive and automated clients consume the same budget and a restart cannot reset it', async t => {
  setup(t);
  await configureActivity({ authenticatedPer24Hours: 2, imagesPer24Hours: 3, minimumIntervalSeconds: 1 });
  await configureAutomation('enable');
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    clock += 61000;
    return new Response(html(url.match(/item\/(\d+)/)[1]));
  });
  await new FacebookClient().getListingDetail('123');
  await new FacebookClient({ automated: true }).getListingDetail('456');
  await assert.rejects(new FacebookClient().getListingDetail('789'), /budget exhausted/);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal((await activityStatus()).authenticated.remaining, 0);
});

test('failed transport attempts spend budget once without an automatic retry', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private URL and cookie'); });
  await assert.rejects(new FacebookClient().getListingDetail('123'), error => {
    assert.doesNotMatch(error.message, /private URL|cookie/);
    return /No automatic retry/.test(error.message);
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await activityStatus()).authenticated.used, 1);
  assert.equal((await activityStatus()).errorsLast24Hours, 1);
});

test('cross-process reservations cannot overspend the final shared slots', async t => {
  const directory = setup(t);
  await configureActivity({ authenticatedPer24Hours: 2, imagesPer24Hours: 2, minimumIntervalSeconds: 1 });
  const fixture = fileURLToPath(new URL('./fixtures/activity-reservation.mjs', import.meta.url));
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, FB_DATA_DIR: directory } });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Child exit ${code}`)));
  })));
  assert.equal(results.filter(r => r === 'reserved').length, 2);
  assert.equal(results.filter(r => r === 'blocked').length, 4);
  assert.equal((await activityStatus()).images.used, 2);
  assert.equal(fs.statSync(path.join(directory, 'activity.json')).mode & 0o777, 0o600);
});

test('a queued request cannot run after the preceding response opens the security latch', async t => {
  setup(t);
  let called = 0;
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const finished = new Promise(resolve => { finish = resolve; });
  const first = runGuardedRequest('image', async () => { called++; enter(); await finished; throw new SecurityStopError('Fixture checkpoint'); });
  await entered;
  const second = runGuardedRequest('image', async () => { called++; });
  const settled = Promise.allSettled([first, second]);
  finish();
  const results = await settled;
  assert.equal(called, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 2);
  assert.match(results[1].reason.message, /paused/);
  assert.equal((await activityStatus()).images.used, 1);
});

test('legacy background checkpoint is promoted; scheduler resume cannot unlock network activity', async t => {
  setup(t);
  await suspendAutomation('Legacy checkpoint');
  assert.equal((await activityStatus()).paused, true);
  await assert.rejects(new FacebookClient().getListingDetail('123'), /paused/);
  await configureAutomation('resume');
  await assert.rejects(reserveActivityRequest('authenticated'), /paused/);
});

test('429 pauses all clients and respects Retry-After even with explicit resume', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('private-body', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(new FacebookClient().getListingDetail('123'), /429/);
  await assert.rejects(new FacebookClient().getListingDetail('456'), /paused/);
  await assert.rejects(downloadListingImage('https://scontent.example.fbcdn.net/image.png'), /paused/);
  await assert.rejects(resumeActivity(true), /Retry-After/);
  const status = await activityStatus();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(status.authenticated.used, 1);
  assert.equal(status.errorsLast24Hours, 1);
  assert.doesNotMatch(JSON.stringify(status), /private-body|fixture-xs/);
});

test('HTTP 200 checkpoint HTML and login redirects pause without following or leaking response data', async t => {
  setup(t);
  let response = new Response('<title>Confirm your identity</title><p>private-account-data</p>');
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => { assert.equal(init.redirect, 'manual'); return response; });
  await assert.rejects(new FacebookClient().getListingDetail('123'), /checkpoint/);
  assert.equal((await activityStatus()).paused, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('unknown/failed image download does not pretend the account hit a security checkpoint', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(downloadListingImage('https://scontent.example.fbcdn.net/image.png'), /403/);
  assert.equal((await activityStatus()).paused, false);
  assert.equal((await activityStatus()).images.used, 1);
});

test('CDN redirects consume separate slots and a CDN 429 stops all subsequent requests', async t => {
  setup(t);
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1
    ? new Response(null, { status: 302, headers: { location: 'https://scontent.example.fbcdn.net/other.png' } })
    : new Response(null, { status: 429 }));
  await assert.rejects(downloadListingImage('https://scontent.example.fbcdn.net/image.png'), /429/);
  const status = await activityStatus();
  assert.equal(status.images.used, 2);
  assert.equal(status.paused, true);
});

test('listing cache avoids token bootstrap and duplicate concurrent requests, including after restart and pause', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://www.facebook.com/marketplace/item/123/');
    return new Response(html('123'));
  });
  const [a, b] = await Promise.all([new FacebookClient().getListingDetail('123'), new FacebookClient().getListingDetail('123')]);
  assert.equal(a.retrieval.source, 'live'); assert.equal(b.retrieval.source, 'cache');
  assert.equal(a.retrieval.observedAt, b.retrieval.observedAt);
  await pauseActivity();
  const cached = await new FacebookClient().getListingDetail('123');
  assert.equal(cached.retrieval.source, 'cache');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await activityStatus()).authenticated.used, 1);
  assert.equal((await activityStatus()).cacheHitsSinceTrackingStarted, 2);
});

test('expired caches and different accounts cannot reuse a previous account observation', async t => {
  const directory = setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(html('123')));
  await new FacebookClient().getListingDetail('123');
  const cacheFile = path.join(directory, 'response-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache[0].observedAt = new Date(Date.now() - 31 * 60000).toISOString();
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  await pauseActivity();
  await assert.rejects(new FacebookClient().getListingDetail('123'), /paused/);
  cache[0].observedAt = new Date().toISOString(); fs.writeFileSync(cacheFile, JSON.stringify(cache));
  saveFacebookAuth({ cookies: ['c_user', 'xs'].map(name => ({ domain: '.facebook.com', name, value: `second-${name}`, path: '/', expires: -1 })) });
  await assert.rejects(new FacebookClient().getListingDetail('123'), /paused/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('cache reads never fabricate a new price observation or roll a newer observed price backwards', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(html('123')));
  const client = new FacebookClient();
  const handler = createListingHandler(client);
  await handler({ listing_id: '123' });
  const before = readState().listings['123'];
  await handler({ listing_id: '123' });
  assert.equal(readState().listings['123'].lastSeen, before.lastSeen);
  await updateState(state => observeListing(state, { ...before.listing, price: 'CHF 200', priceAmount: 200, retrieval: undefined }, new Date(Date.now() + 1000).toISOString()));
  await handler({ listing_id: '123' });
  assert.equal(readState().listings['123'].listing.priceAmount, 200);
  assert.deepEqual(readState().listings['123'].history.map(p => p.amount), [150, 200]);
});

test('search bootstrap consumes one slot then defers the query; a later request can reuse its session', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async url => url.endsWith('/marketplace/')
    ? new Response('"DTSGInitialData",[],{"token":"fixture"}')
    : new Response(JSON.stringify({ data: { marketplace_search: { feed_units: { edges: [], page_info: {} } } } })));
  const client = new FacebookClient();
  await assert.rejects(client.searchListings(params), /spacing limit/);
  assert.equal(fetch.mock.callCount(), 1);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 121000);
  const result = await client.searchListings(params);
  assert.deepEqual(result.listings, []);
  const cached = await new FacebookClient().searchListings(params);
  assert.equal(cached.retrieval.source, 'cache');
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal((await activityStatus()).authenticated.used, 2);
});

test('invalid/corrupt activity state fails closed without an automatic reset', async t => {
  const directory = setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Network must remain blocked'));
  fs.writeFileSync(path.join(directory, 'activity.json'), '{');
  await assert.rejects(new FacebookClient().getListingDetail('123'), /Cannot read activity/);
  await assert.rejects(resumeActivity(true), /Cannot read activity/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(fs.readFileSync(path.join(directory, 'activity.json'), 'utf8'), '{');
});
