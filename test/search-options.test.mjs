import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { buildSearchVariables, buildLocationSearchVariables } from '../dist/facebook/queries.js';
import { createSearchHandler, searchListingsSchema } from '../dist/tools/search.js';

const params = { query: 'desk', latitude: 46.5, longitude: 6.6, radiusKm: 10.5, limit: 20 };
const args = { query: 'desk', latitude: 46.5, longitude: 6.6, radius_km: 10.5, limit: 20 };

test('search uses refreshed request shape, zero max-price, categories, sorting and pickup flags', () => {
  const variables = buildSearchVariables({ ...params, maxPrice: 0, category: '123',
    sortBy: 'price_low_to_high', deliveryMethod: 'local_pickup' });
  const filters = variables.params.browse_request_params;
  assert.equal(filters.filter_price_upper_bound, 0);
  assert.deepEqual(filters.commerce_search_and_rp_category_id, ['123']);
  assert.equal(filters.commerce_search_sort_by, 'PRICE_ASCEND');
  assert.equal(filters.commerce_enable_shipping, false);
  assert.equal(filters.commerce_enable_local_pickup, true);
  assert.equal(filters.filter_radius_km, 11);
  assert.equal(variables.params.custom_request_params.search_vertical, 'C2C');
  assert.equal(variables.scale, 2);
  assert.equal(Object.hasOwn(variables, 'cursor'), false);
  assert.equal(buildSearchVariables({ ...params, cursor: 'opaque' }).cursor, 'opaque');
});

test('shipping-only and newest sorting map to Facebook request values', () => {
  const filters = buildSearchVariables({ ...params, sortBy: 'date_listed', deliveryMethod: 'shipping' }).params.browse_request_params;
  assert.equal(filters.commerce_enable_local_pickup, false);
  assert.equal(filters.commerce_enable_shipping, true);
  assert.equal(filters.commerce_search_sort_by, 'CREATION_TIME_DESCEND');
  assert.equal(buildLocationSearchVariables('Lausanne').params.search_type, 'PLACE_TYPEAHEAD');
});

test('search schemas reject invalid coordinates, negative prices, and invalid pagination size', () => {
  const schema = z.object(searchListingsSchema);
  for (const bad of [{ latitude: 100 }, { longitude: -181 }, { min_price: -1 }, { radius_km: 0 }, { limit: 0 }, { limit: 1.5 }]) {
    assert.equal(schema.safeParse({ ...args, ...bad }).success, false);
  }
});

test('MCP exposes continuation even when the current page is empty', async () => {
  let sent;
  const handler = createSearchHandler({ searchListings: async input => {
    sent = input;
    return { listings: [], hasNextPage: true, endCursor: 'second-page' };
  } });
  const result = await handler({ ...args, sort_by: 'distance', delivery_method: 'local_pickup' });
  assert.equal(sent.sortBy, 'distance');
  assert.equal(sent.deliveryMethod, 'local_pickup');
  assert.equal(result.structuredContent.paginationStatus, 'more_results');
  assert.equal(result.structuredContent.endCursor, 'second-page');
  assert.match(result.content[0].text, /second-page/);
});

test('repeated and missing cursors are surfaced as stalled', async () => {
  for (const cursor of ['same-page', null]) {
    const handler = createSearchHandler({ searchListings: async () => ({ listings: [], hasNextPage: true, endCursor: cursor }) });
    const result = await handler({ ...args, cursor: 'same-page' });
    assert.equal(result.structuredContent.paginationStatus, 'stalled');
    assert.match(result.content[0].text, /stop here/);
  }
});

test('a larger Facebook page is kept intact so advancing its cursor skips no listings', async () => {
  const listings = [1, 2, 3].map(id => ({ id: String(id), title: `Item ${id}`, price: 'CHF 10' }));
  const handler = createSearchHandler({ searchListings: async () => ({ listings, hasNextPage: true, endCursor: 'next' }) });
  const result = await handler({ ...args, limit: 1 });
  assert.equal(result.structuredContent.listings.length, 3);
});

test('inverted price range fails before a network request', async () => {
  let called = false;
  const handler = createSearchHandler({ searchListings: async () => { called = true; } });
  assert.equal((await handler({ ...args, min_price: 20, max_price: 10 })).isError, true);
  assert.equal(called, false);
});
