import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createSmartSearchHandler, planQueries, smartSearchSchema, smartSearchOutput } from '../dist/tools/smart-search.js';
import { savePriceBenchmark, getPriceBenchmark, listPriceBenchmarks, deletePriceBenchmark } from '../dist/tools/benchmarks.js';
import { calculateBenchmark, comparableBasis, benchmarkReportSchema } from '../dist/analysis/benchmarks.js';
import { observeListing } from '../dist/analysis/prices.js';
import { readState, updateState } from '../dist/storage/state.js';

const listing = (id, amount = 100, extra = {}) => ({ id: String(id), title: 'Sony WH-1000XM5', price: `CHF ${amount}`,
  location: 'Morges', imageUrl: '', sellerName: 'Seller', sellerId: `seller-${id}`, postedDate: '',
  url: `https://www.facebook.com/marketplace/item/${id}/`, isPending: false, ...extra });
const page = (...listings) => ({ listings, hasNextPage: false, endCursor: null });
const search = { query: 'Sony WH-1000XM5', query_variants: ['Sony WH1000XM5', 'casque Sony'], latitude: 46.5, longitude: 6.5 };
const criteria = { product: 'Sony WH-1000XM5', variant: 'standard', condition: 'used, working, good cosmetic condition',
  accessories: ['case', 'charging cable'], market_area: 'Vaud, Switzerland', currency: 'CHF' };
const selection = ids => ({ name: 'Sony headphones', criteria, comparables: ids.map(id => ({ listing_id: String(id),
  match_notes: 'Same exact model, working used condition with case and cable; Morges listing.' })) });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-deals-')), old = process.env.FB_DATA_DIR;
  process.env.FB_DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.FB_DATA_DIR; else process.env.FB_DATA_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const seed = async (items, at = new Date().toISOString()) => updateState(s => { for (const item of items) observeListing(s, item, at); });
const assertReport = response => { assert.equal(response.isError, undefined); benchmarkReportSchema.parse(response.structuredContent); return response.structuredContent; };

test('query planning preserves assistant-chosen terms and priority, removes duplicates, and invents no terms', () => {
  assert.deepEqual(planQueries('Sony ordinateur portable X123', ['SONY ordinateur portable X123', 'Sony laptop X123']), ['Sony ordinateur portable X123', 'Sony laptop X123']);
  assert.deepEqual(planQueries('écran PC AOC CU34G4'), ['écran PC AOC CU34G4']);
  assert.deepEqual(planQueries('cameraman bag'), ['cameraman bag']);
  assert.deepEqual(planQueries('laptop'), ['laptop']);
  assert.equal(planQueries('laptop', ['a', 'b', 'c', 'd', 'e']).length, 6);
});

test('smart search shares a two-call default budget, forwards filters, deduplicates and preserves per-query cursors', async t => {
  setup(t); const calls = [];
  const handler = createSmartSearchHandler({ searchListings: async p => {
    calls.push(p); return { ...page(listing(1, calls.length === 1 ? 200 : 190), listing(calls.length + 1)), hasNextPage: true, endCursor: `next-${calls.length}` };
  } });
  const response = await handler({ ...search, radius_km: 10.5, min_price: 10, max_price: 400, category: '11', delivery_method: 'local_pickup', sort_by: 'date_listed' });
  const data = response.structuredContent; z.object(smartSearchOutput).parse(data);
  assert.equal(calls.length, 2); assert.equal(data.requestsUsed, 2); assert.equal(data.duplicatesRemoved, 1);
  assert.deepEqual(data.listings.map(l => l.id), ['1', '2', '3']);
  assert.equal(data.listings[0].price, 'CHF 190'); assert.equal(data.listings[0].matchedQueries.length, 2);
  assert.equal(data.queries[1].endCursor, 'next-2'); assert.equal(data.queries[2].source, 'deferred');
  assert.equal(calls[0].radiusKm, 11); assert.equal(calls[0].deliveryMethod, 'local_pickup'); assert.equal(calls[1].maxPrice, 400);
  assert.equal(calls[0].cursor, undefined); assert.equal(calls[1].category, '11');
});

test('cache is persistent, private, reapplies filters and avoids Facebook calls', async t => {
  const dir = setup(t); let calls = 0;
  const handler = createSmartSearchHandler({ searchListings: async () => { calls++; return page(listing(1), listing(2, 100, { title: 'Broken Sony' })); } });
  const first = await handler({ ...search, query_variants: [], exclude_keywords: ['broken'] });
  assert.equal(first.structuredContent.listings.length, 1);
  const next = createSmartSearchHandler({ searchListings: async () => { throw new Error('Must not call Facebook'); } });
  const cached = await next({ ...search, query_variants: [], request_budget: 0 });
  assert.equal(cached.isError, undefined); assert.equal(cached.structuredContent.cacheHits, 1);
  assert.equal(cached.structuredContent.requestsUsed, 0); assert.equal(cached.structuredContent.listings.length, 2); assert.equal(calls, 1);
  const hidden = await next({ ...search, query_variants: [], request_budget: 0, hide_seen: true });
  assert.equal(hidden.structuredContent.listings.length, 0);
  assert.equal(fs.statSync(path.join(dir, 'search-cache.json')).mode & 0o777, 0o600);
});

test('cache reuse never overwrites a newer observed price or advances its observation timestamp', async t => {
  setup(t);
  const handler = createSmartSearchHandler({ searchListings: async () => page(listing(1, 200)) });
  await handler({ ...search, query_variants: [] });
  const freshAt = new Date(Date.now() + 1000).toISOString();
  await seed([listing(1, 250)], freshAt);
  const cached = await handler({ ...search, query_variants: [], request_budget: 0 });
  assert.equal(cached.structuredContent.listings[0].price, 'CHF 250');
  assert.equal(cached.structuredContent.listings[0].observedAt, freshAt);
  assert.equal(readState().listings['1'].lastSeen, freshAt);
  assert.deepEqual(readState().listings['1'].history.map(p => p.amount), [200, 250]);
});

test('current cached prices outside the original search price bounds are excluded', async t => {
  setup(t); const handler = createSmartSearchHandler({ searchListings: async () => page(listing(1, 200)) });
  await handler({ ...search, query_variants: [], max_price: 220 });
  await seed([listing(1, 250)], new Date(Date.now() + 1000).toISOString());
  const cached = await handler({ ...search, query_variants: [], max_price: 220, request_budget: 0 });
  assert.equal(cached.structuredContent.cacheHits, 1); assert.equal(cached.structuredContent.excluded.price_range, 1);
  assert.equal(cached.structuredContent.listings.length, 0);
});

test('cache keys separate location, price ceiling, sort, delivery and page size', async t => {
  setup(t); const handler = createSmartSearchHandler({ searchListings: async () => page(listing(1)) });
  await handler({ ...search, query_variants: [] });
  for (const change of [{ latitude: 47 }, { max_price: 150 }, { sort_by: 'distance' }, { delivery_method: 'local_pickup' }, { limit: 5 }]) {
    const r = await handler({ ...search, query_variants: [], request_budget: 0, ...change });
    assert.equal(r.structuredContent.cacheHits, 0); assert.equal(r.structuredContent.queries[0].source, 'deferred');
  }
});

test('expired or future-dated pages are not reused, and explicit refresh obeys the budget', async t => {
  const dir = setup(t); let calls = 0;
  const handler = createSmartSearchHandler({ searchListings: async () => { calls++; return page(listing(1)); } });
  const args = { ...search, query_variants: [] };
  await handler(args);
  const file = path.join(dir, 'search-cache.json'), cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const offset of [-31 * 60000, 60000]) {
    cache[0].fetchedAt = new Date(Date.now() + offset).toISOString(); fs.writeFileSync(file, JSON.stringify(cache));
    const r = await handler({ ...args, request_budget: 0 });
    assert.equal(r.structuredContent.cacheHits, 0); assert.equal(r.structuredContent.requestsUsed, 0);
  }
  await handler({ ...args, cache_max_age_minutes: 0 }); assert.equal(calls, 2);
});

test('a Facebook error stops remaining variants, preserves previous results and never retries', async t => {
  setup(t); let calls = 0;
  const response = await createSmartSearchHandler({ searchListings: async () => {
    if (++calls === 2) throw new Error('HTTP 429 checkpoint'); return page(listing(1));
  } })({ ...search, request_budget: 3 });
  assert.equal(calls, 2); assert.equal(response.structuredContent.requestsUsed, 2);
  assert.deepEqual(response.structuredContent.queries.map(q => q.source), ['live', 'error', 'deferred']);
  assert.equal(response.structuredContent.listings[0].id, '1'); assert.ok(readState().listings['1']);
});

test('invalid requests and corrupt cache/state fail before network activity', async t => {
  const dir = setup(t); let calls = 0;
  const handler = createSmartSearchHandler({ searchListings: async () => { calls++; return page(); } });
  for (const bad of [{ request_budget: 4 }, { request_budget: -1 }, { min_price: 100, max_price: 50 }, { query_variants: new Array(6).fill('x') }]) {
    assert.equal((await handler({ ...search, ...bad })).isError, true);
  }
  assert.equal(z.object(smartSearchSchema).safeParse({ ...search, latitude: 100 }).success, false);
  const cache = path.join(dir, 'search-cache.json'); fs.writeFileSync(cache, '{');
  assert.equal((await handler(search)).isError, true); fs.unlinkSync(cache);
  fs.writeFileSync(path.join(dir, 'tracking.json'), '{}');
  assert.equal((await handler(search)).isError, true); assert.equal(calls, 0);
});

test('simultaneous smart searches do not multiply a batch while the shared lease is held', async t => {
  setup(t); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const handler = createSmartSearchHandler({ searchListings: async () => { started(); await wait; return page(); } });
  const first = handler({ ...search, query_variants: [] }); await entered;
  const second = await handler({ ...search, query_variants: [] });
  assert.equal(second.isError, true); assert.match(second.content[0].text, /already running/);
  release(); await first;
});

test('benchmarks calculate source-backed statistics for exactly the chosen sample without outlier judgments', async t => {
  setup(t); await seed([100, 200, 300, 400, 1000].map((price, i) => listing(i + 1, price)));
  const saved = await savePriceBenchmark(selection([1, 2, 3, 4, 5])); assert.equal(saved.isError, undefined);
  const data = assertReport(await getPriceBenchmark({ name: 'SONY HEADPHONES' }));
  assert.equal(data.calculationStatus, 'complete'); assert.equal(data.count, 5);
  assert.deepEqual(data.statistics, { mean: 400, median: 300, min: 100, max: 1000, p25: 200, p75: 400 });
  assert.equal(data.samples.find(s => s.listingId === '5').amount, 1000);
  assert.equal('priceOutlier' in data.samples[0], false);
  assert.equal(data.source, 'observed_asking_prices'); assert.equal(data.samples[0].url.startsWith('https://www.facebook.com/'), true);
  assert.match(data.notes, /not sold prices/);
});

test('candidate exclusion is explicit and sample-size judgment remains with the assistant', async t => {
  setup(t); await seed([1, 2, 3, 4, 5].map(id => listing(id, id * 100)));
  await savePriceBenchmark(selection([1, 2, 3, 4, 5]));
  const data = assertReport(await getPriceBenchmark({ name: 'Sony headphones', candidate_listing_id: '1' }));
  assert.equal(data.count, 4); assert.equal(data.calculationStatus, 'complete'); assert.equal(data.statistics.median, 350);
  assert.ok(data.omittedByRequest.includes('1')); assert.equal('minimumSamples' in data, false);
});

test('new observed prices update benchmarks and changed details are exposed without deciding comparability', async t => {
  setup(t); await seed([listing(1, 200), listing(2, 200), listing(3, 200)]);
  await savePriceBenchmark(selection([1, 2, 3]));
  await seed([listing(1, 100)]);
  let data = assertReport(await getPriceBenchmark({ name: 'Sony headphones' }));
  assert.equal(data.statistics.min, 100); assert.equal(data.calculationStatus, 'complete');
  await seed([listing(2, 200, { title: 'Different model' })]);
  data = assertReport(await getPriceBenchmark({ name: 'Sony headphones' }));
  assert.equal(data.samples.find(s => s.listingId === '2').detailsChangedSinceSelection, true);
  assert.equal(data.count, 3);
  data = assertReport(await getPriceBenchmark({ name: 'Sony headphones', selected_listing_ids: ['1', '3'] }));
  assert.equal(data.count, 2); assert.equal(data.statistics.mean, 150); assert.deepEqual(data.omittedByRequest, ['2']);
});

test('benchmark facts preserve stale, pending, very low, conflicting and same-seller offers until the AI chooses otherwise', async t => {
  setup(t);
  await seed([listing(1), listing(2, 1), listing(3, 100), listing(4, 100, { isPending: true }),
    listing(5, 100, { sellerId: 'same-seller' }), listing(6, 120, { sellerId: 'same-seller' }), listing(7), listing(8), listing(9, 0)]);
  await updateState(s => { s.listings['7'].description = 'Prix de vente: CHF 250'; s.listings['8'].lastSeen = '2020-01-01T00:00:00.000Z'; });
  await savePriceBenchmark(selection([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const data = assertReport(await getPriceBenchmark({ name: 'Sony headphones' }));
  assert.equal(data.count, 9); assert.equal(data.calculationStatus, 'complete'); assert.equal(data.statistics.min, 0);
  assert.equal(data.samples.find(s => s.listingId === '4').isPending, true);
  assert.equal(data.samples.find(s => s.listingId === '7').cachedDescription, 'Prix de vente: CHF 250');
  assert.ok(data.samples.find(s => s.listingId === '8').observationAgeDays > 30);
  assert.deepEqual(data.repeatedKnownSellers, [{ sellerId: 'same-seller', listingIds: ['5', '6'] }]);
  assert.deepEqual(data.omittedByRequest, []);
});

test('unknown sellers are not merged by name; unavailable observations produce no invented statistics', async t => {
  setup(t); await seed([listing(1, 100, { sellerId: undefined }), listing(2, 120, { sellerId: undefined })]);
  await savePriceBenchmark(selection([1, 2]));
  let data = assertReport(await getPriceBenchmark({ name: 'Sony headphones' })); assert.equal(data.count, 2);
  const s = readState(); delete s.listings['1']; delete s.listings['2'];
  data = calculateBenchmark(s, s.benchmarks[0]); assert.equal(data.statistics, null); assert.equal(data.calculationStatus, 'unavailable_prices');
  assert.equal(data.priceIssues[0].reason, 'observation_missing');
});

test('mixed or unusable prices block the entire calculation until the assistant supplies a usable subset', async t => {
  setup(t); await seed([listing(1, 100), listing(2, 150, { price: 'EUR 150' }), listing(3, 100, { price: 'Contact me' })]);
  await savePriceBenchmark(selection([1, 2, 3]));
  let data = assertReport(await getPriceBenchmark({ name: 'Sony headphones' }));
  assert.equal(data.count, 3); assert.equal(data.statistics, null);
  assert.deepEqual(data.priceIssues.map(i => i.reason), ['currency_mismatch', 'unusable_price']);
  data = assertReport(await getPriceBenchmark({ name: 'Sony headphones', selected_listing_ids: ['1'] }));
  assert.equal(data.statistics.mean, 100); assert.equal(data.count, 1); assert.equal(data.calculationStatus, 'complete');
  assert.equal((await getPriceBenchmark({ name: 'Sony headphones', selected_listing_ids: ['99'] })).isError, true);
});

test('benchmark matching snapshots ignore price-only updates but detect description and condition changes', () => {
  const record = { listing: listing(1), description: 'Used, working', history: [], firstSeen: '', lastSeen: '' };
  const basis = comparableBasis(record); record.listing.price = 'CHF 80'; assert.equal(comparableBasis(record), basis);
  record.description = 'For parts'; assert.notEqual(comparableBasis(record), basis);
  record.description = 'Used, working'; record.listing.condition = 'Broken'; assert.notEqual(comparableBasis(record), basis);
});

test('benchmark management persists, validates known IDs, requires explicit replacement and keeps listing history', async t => {
  setup(t); await seed([listing(1), listing(2)]);
  assert.equal((await savePriceBenchmark(selection([999]))).isError, true);
  assert.equal((await savePriceBenchmark(selection([1, 1]))).isError, true);
  await savePriceBenchmark(selection([1]));
  assert.equal((await savePriceBenchmark(selection([2]))).isError, true);
  assert.equal(readState().benchmarks[0].comparables[0].listingId, '1');
  await savePriceBenchmark({ ...selection([2]), replace: true });
  assert.equal((await listPriceBenchmarks()).structuredContent.benchmarks[0].selectedCount, 1);
  assert.equal(readState().benchmarks[0].comparables[0].listingId, '2');
  assert.equal((await deletePriceBenchmark({ name: 'Sony headphones' })).structuredContent.deleted, true);
  assert.equal((await listPriceBenchmarks()).structuredContent.benchmarks.length, 0);
  assert.equal(readState().listings['1'].history.length, 1);
  assert.equal((await getPriceBenchmark({ name: 'Sony headphones' })).isError, true);
});

test('older tracking files load without benchmarks; damaged benchmark data is not reset or overwritten', async t => {
  const dir = setup(t); await seed([listing(1)]);
  const file = path.join(dir, 'tracking.json'), old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.benchmarks;
  fs.writeFileSync(file, JSON.stringify(old)); assert.deepEqual(readState().benchmarks, []);
  const bad = JSON.stringify({ ...old, benchmarks: [{ name: 'broken' }] }); fs.writeFileSync(file, bad);
  assert.throws(() => readState(), /Cannot read tracking/);
  assert.equal((await savePriceBenchmark(selection([1]))).isError, true); assert.equal(fs.readFileSync(file, 'utf8'), bad);
});

test('saved comparable observations survive catalogue retention', async t => {
  setup(t); await seed([listing(1)], '2020-01-01T00:00:00.000Z'); await savePriceBenchmark(selection([1]));
  await updateState(s => { for (let id = 2; id <= 10002; id++) observeListing(s, listing(id), '2026-11-15T12:00:00.000Z'); });
  assert.ok(readState().listings['1']); assert.equal(Object.keys(readState().listings).length, 10001);
});
