import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FacebookClient } from '../dist/facebook/client.js';
import { saveFacebookAuth } from '../dist/facebook/auth.js';
import { RateLimiter } from '../dist/utils/rate-limit.js';

const tokens = '"DTSGInitialData",[],{"token":"test-token"} "LSD",[],{"token":"test-lsd"} "client_revision":123 jazoest=42';
const params = { query: 'chair', latitude: 46.5, longitude: 6.6, radiusKm: 20, limit: 5 };
function setup(t, response, status = 200) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-client-test-'));
  const previous = { FB_COOKIES_FILE: process.env.FB_COOKIES_FILE, FB_DATA_DIR: process.env.FB_DATA_DIR,
    FB_SEARCH_DOC_ID: process.env.FB_SEARCH_DOC_ID };
  process.env.FB_COOKIES_FILE = path.join(directory, 'session.json');
  process.env.FB_DATA_DIR = directory;
  process.env.FB_SEARCH_DOC_ID = '987654321';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  saveFacebookAuth({ userAgent: 'SavedBrowser/123', cookies: ['c_user', 'xs'].map(name => ({
    domain: '.facebook.com', name, value: `fixture-${name}`, path: '/', expires: -1,
  })) });
  t.mock.method(RateLimiter.prototype, 'wait', async () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://www.facebook.com/marketplace/') return new Response(tokens);
    assert.equal(url, 'https://www.facebook.com/api/graphql/');
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), { status });
  });
  return { client: new FacebookClient(), requests };
}

test('headless HTTP client loads the saved session, preserves browser UA, and uses query overrides', async t => {
  const { client, requests } = setup(t, { data: { marketplace_search: { feed_units: {
    edges: [{ node: { listing: { id: '7', marketplace_listing_title: 'Chair', listing_price: { formatted_amount: 'CHF 30' } } } }],
    page_info: { has_next_page: false },
  } } } });
  const result = await client.searchListings(params);
  assert.equal(result.listings[0].title, 'Chair');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.headers['User-Agent'], 'SavedBrowser/123');
    assert.match(request.options.headers.Cookie, /c_user=fixture-c_user/);
    assert.ok(request.options.signal instanceof AbortSignal);
  }
  assert.equal(new URLSearchParams(requests[1].options.body).get('doc_id'), '987654321');
});

test('valid zero-result search remains successful', async t => {
  const { client } = setup(t, { data: { marketplace_search: { feed_units: { edges: [], page_info: {} } } } });
  assert.deepEqual((await client.searchListings(params)).listings, []);
});

test('GraphQL failures are not misreported as zero results or echoed with tokens', async t => {
  const { client } = setup(t, { errors: [{ message: 'private-token-response' }] });
  await assert.rejects(client.searchListings(params), error => {
    assert.doesNotMatch(error.message, /private-token-response/);
    return /GraphQL error/.test(error.message);
  });
});

test('changed response shape is surfaced as an error', async t => {
  const { client } = setup(t, { data: { different_shape: {} } });
  await assert.rejects(client.searchListings(params), /missing a listing connection/);
});

test('HTML/checkpoint response is not dumped to the MCP user', async t => {
  const { client } = setup(t, '<html>private-account-details</html>');
  await assert.rejects(client.searchListings(params), error => {
    assert.doesNotMatch(error.message, /private-account-details/);
    return /unsupported response/.test(error.message);
  });
});

test('401 clears the session and gives a login instruction', async t => {
  const { client, requests } = setup(t, {}, 401);
  await assert.rejects(client.searchListings(params), /npm run login/);
  await client.ensureSession();
  assert.equal(requests.filter(request => request.url.endsWith('/marketplace/')).length, 2);
});

test('429 responses pause background activity and never retry automatically', async t => {
  const { automationStatus } = await import('../dist/monitoring/control.js');
  const { client, requests } = setup(t, {}, 429);
  await assert.rejects(client.searchListings(params), /429/);
  assert.match(automationStatus().pausedReason, /429/);
  assert.equal(requests.length, 2);
});

test('login redirects are not followed and permanently pause background requests', async t => {
  const { automationStatus } = await import('../dist/monitoring/control.js');
  const { client, requests } = setup(t, {}, 302);
  await assert.rejects(client.searchListings(params), /redirected/);
  assert.match(automationStatus().pausedReason, /redirected/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.redirect, 'manual');
});
