import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseListingDetailFromPage, parseSearchResponse } from '../dist/facebook/parser.js';
import { observeListing } from '../dist/analysis/prices.js';
import { createListingHandler } from '../dist/tools/listing.js';
import { createSearchHandler } from '../dist/tools/search.js';
import { createSmartSearchHandler } from '../dist/tools/smart-search.js';
import { detailContract } from '../dist/tools/contracts.js';

// Representative payload shapes, not a captured live response from the user's account.
const posted = '2026-10-13T12:00:00.000Z';
const money = amount => ({ amount: String(amount), currency: 'CHF', formatted_amount: `CHF ${amount}` });
const raw = (changes = {}) => ({ id: '123', marketplace_listing_title: 'Guitar bundle',
  listing_price: money(150), strikethrough_price: { amount: '300.00', formatted_amount: 'CHF 300' },
  creation_time: Date.parse(posted) / 1000, ...changes });
const html = (...nodes) => nodes.map(node => `<script type="application/json">${JSON.stringify(node)}</script>`).join('\n');
const detail = node => parseListingDetailFromPage(html(node), '123');
const search = node => parseSearchResponse({ data: { marketplace_search: { feed_units: {
  edges: [{ node: { listing: node } }], page_info: { has_next_page: false },
} } } });
const previous = { formatted: 'CHF 300', amount: 300, currency: 'CHF', source: 'facebook_strikethrough' };
const reduction = { amount: 150, currency: 'CHF', percent: 50 };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-displayed-price-'));
  const old = process.env.FB_DATA_DIR;
  process.env.FB_DATA_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.FB_DATA_DIR; else process.env.FB_DATA_DIR = old;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('search and details return the displayed price pair, arithmetic and posting date', () => {
  for (const listing of [detail(raw()), search(raw()).listings[0]]) {
    assert.deepEqual(listing.previousPrice, previous);
    assert.deepEqual(listing.priceReduction, reduction);
    assert.equal(listing.priceAmount, 150);
    assert.equal(listing.postedDate, posted);
  }
});

test('price-only and date-only fragments resolve through the matching public item ID', () => {
  const listing = parseListingDetailFromPage(html(
    raw({ id: '999', strikethrough_price: money(9999) }),
    { id: 'internal', product_item: { id: '123' }, marketplace_listing_title: 'Guitar' },
    { id: 'internal', listing_price: money(150) },
    { id: 'internal', strikethrough_price: money(300) },
    { id: 'internal', creation_time: Date.parse(posted) / 1000 },
  ), '123');
  assert.deepEqual(listing.previousPrice, previous);
  assert.deepEqual(listing.priceReduction, reduction);
  assert.equal(listing.postedDate, posted);
});

test('missing or malformed prior prices never come from descriptions, comparisons or other listings', () => {
  for (const value of [undefined, null, {}, 'CHF 300', { amount: null }]) {
    const listing = parseListingDetailFromPage(html(raw({ strikethrough_price: value,
      redacted_description: { text: 'Bought for CHF 300. Now CHF 150.' }, comparable_price: money(300) }),
      raw({ id: '999', strikethrough_price: money(900) })), '123');
    assert.equal(listing.previousPrice, null);
    assert.equal(listing.priceReduction, null);
  }
});

test('formatted and currency-free previous amounts are usable without confusing currencies', () => {
  for (const previousPrice of [
    { formatted_amount_zeros_stripped: '300 CHF' },
    { amount: '300.00' },
    { amount: 300, currency: 'chf' },
  ]) assert.deepEqual(detail(raw({ strikethrough_price: previousPrice })).priceReduction, reduction);
  const euros = detail(raw({ strikethrough_price: { amount: 300, currency: 'EUR', formatted_amount: '€300' } }));
  assert.equal(euros.previousPrice.currency, 'EUR');
  assert.equal(euros.priceReduction, null);
  const dollars = detail(raw({ strikethrough_price: { amount: 300, formatted_amount: '$300' } }));
  assert.equal(dollars.previousPrice.currency, undefined);
  assert.equal(dollars.priceReduction, null);
});

test('invalid or contradictory values never produce a discount; displayed text is retained', () => {
  for (const previousPrice of [
    { amount: -300, currency: 'CHF', formatted_amount: 'CHF 300' },
    { amount: 'NaN', currency: 'CHF', formatted_amount: 'CHF 300' },
    { amount: true, currency: 'CHF', formatted_amount: 'CHF 300' },
    { amount: 300, currency: 'CHF', formatted_amount: 'EUR 300' },
    { amount: 500, currency: 'CHF', formatted_amount: 'CHF 300' },
    { amount: 300, currency: 'invalid', formatted_amount: 'CHF 300' },
    money(0), money(100), money(150),
  ]) {
    const listing = detail(raw({ strikethrough_price: previousPrice }));
    assert.equal(listing.priceReduction, null);
    assert.ok(listing.previousPrice.formatted);
  }
  assert.equal(detail(raw({ listing_price: { amount: 100, currency: 'CHF', formatted_amount: 'CHF 150' } })).priceReduction, null);
  assert.equal(detail(raw({ listing_price: { amount: 150, formatted_amount: '$150' } })).priceReduction, null);
});

test('free items preserve a zero price, and currency arithmetic is rounded', () => {
  assert.deepEqual(detail(raw({ listing_price: money(0), strikethrough_price: money(50) })).priceReduction,
    { amount: 50, currency: 'CHF', percent: 100 });
  assert.deepEqual(detail(raw({ listing_price: money(99.9), strikethrough_price: money(150) })).priceReduction,
    { amount: 50.1, currency: 'CHF', percent: 33.4 });
});

test('missing, blank, invalid and boolean dates stay unknown in both parser paths', () => {
  for (const creation_time of [undefined, null, '', ' ', true, false, 0, -1, 'bad', 1e30]) {
    const node = raw({ creation_time });
    assert.equal(detail(node).postedDate, '');
    assert.equal(search(node).listings[0].postedDate, '');
  }
});

test('crossed-out amounts are never backfilled into history and stale display fields are cleared', () => {
  const state = { listings: {} };
  const listing = detail(raw());
  observeListing(state, listing, '2026-11-17T20:00:00.000Z');
  assert.deepEqual(state.listings['123'].history.map(point => point.amount), [150]);
  observeListing(state, detail(raw({ strikethrough_price: null })), '2026-11-17T20:01:00.000Z');
  assert.equal(state.listings['123'].listing.previousPrice, null);
  assert.equal(state.listings['123'].listing.priceReduction, null);
  assert.equal(state.listings['123'].history.length, 1);
});

test('listing and search tools expose the metadata in both text and structured output', async t => {
  temporary(t);
  const listing = detail(raw());
  const response = await createListingHandler({ getListingDetail: async () => listing })({ listing_id: '123' });
  detailContract.parse(response.structuredContent.listing);
  assert.match(response.content[0].text, /Previous displayed price:\*\* CHF 300/);
  assert.match(response.content[0].text, /CHF 150 \(50%\)/);
  assert.ok(response.content[0].text.includes(posted));
  const result = await createSearchHandler({ searchListings: async () => search(raw()) })({ query: 'guitar', latitude: 46.5, longitude: 6.5, radius_km: 30, limit: 20 });
  assert.match(result.content[0].text, /CHF 300/);
  assert.ok(result.content[0].text.includes(posted));
  assert.deepEqual(result.structuredContent.listings[0].previousPrice, previous);
  const unknown = await createListingHandler({ getListingDetail: async () => detail(raw({ strikethrough_price: null, creation_time: null })) })({ listing_id: '123' });
  assert.match(unknown.content[0].text, /Previous displayed price:\*\* Unavailable/);
  assert.match(unknown.content[0].text, /Posted:\*\* Unavailable/);
});

test('smart search cache preserves price context without new requests or fabricated history', async t => {
  temporary(t);
  const args = { query: 'guitar', latitude: 46.5, longitude: 6.5, request_budget: 1 };
  const first = await createSmartSearchHandler({ searchListings: async () => search(raw()) })(args);
  assert.deepEqual(first.structuredContent.listings[0].previousPrice, previous);
  const cached = await createSmartSearchHandler({ searchListings: async () => { throw new Error('No request expected'); } })({ ...args, request_budget: 0 });
  assert.equal(cached.structuredContent.cacheHits, 1);
  assert.deepEqual(cached.structuredContent.listings[0].priceReduction, reduction);
});

test('CLI tests the actual stdio MCP with a saved login and prints just the selected fields', t => {
  const directory = temporary(t);
  const cookies = path.join(directory, 'session.json');
  fs.writeFileSync(cookies, JSON.stringify({ cookies: ['c_user', 'xs'].map(name => ({
    domain: '.facebook.com', name, value: `fixture-${name}`, path: '/', expires: -1,
  })) }));
  const fixture = fileURLToPath(new URL('./fixtures/image-network.mjs', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/check-listing.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, 'https://www.facebook.com/marketplace/item/123/?ref=test'], {
    env: { ...process.env, DISPLAY: '', FB_COOKIES_FILE: cookies, NODE_OPTIONS: `--import=${fixture}` }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.serverVersion, '1.3.0');
  assert.equal(output.currentPrice.amount, 500);
  assert.equal(output.previousPrice.amount, 750);
  assert.equal(output.priceReduction.percent, 33.33);
  assert.equal(output.postedDate, posted);
  assert.equal(Object.hasOwn(output, 'images'), false);
  assert.doesNotMatch(run.stdout, /fixture-token|fixture-xs/);
});

test('CLI rejects invalid arguments before starting any Facebook request', () => {
  const script = fileURLToPath(new URL('../scripts/check-listing.mjs', import.meta.url));
  for (const arg of ['https://example.test/marketplace/item/123/', 'https://facebook.com.evil.test/marketplace/item/123/', 'https://user:pass@facebook.com/marketplace/item/123/', 'not-an-id']) {
    const run = spawnSync(process.execPath, [script, arg], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage:/);
  }
});
