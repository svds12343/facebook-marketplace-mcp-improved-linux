import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseListingDetailFromPage, parseSearchResponse } from '../dist/facebook/parser.js';

const html = (...payloads) => payloads.map(payload => `<script type="application/json">${JSON.stringify(payload)}</script>`).join('\n');

test('listing details merge only matching Relay fragments, ignoring recommendations', () => {
  const page = html({ recommendations: [{ id: '999', marketplace_listing_title: 'WRONG',
    listing_price: { formatted_amount: 'CHF 9999' }, marketplace_listing_seller: { name: 'Wrong seller' } }] },
    { id: '123', marketplace_listing_title: 'Correct item', redacted_description: { text: 'Full description' } },
    { id: '123', listing_price: { formatted_amount_zeros_stripped: 'CHF 35' },
      marketplace_listing_seller: { id: '45', name: 'Correct seller' },
      location_text: { text: 'Lausanne' }, attribute_data: [{ attribute_name: 'Condition', label: 'Used' }],
      listing_photos: [{ image: { uri: 'https://example.test/one.jpg' } }, { image: { uri: 'https://example.test/two.jpg' } }],
    });
  const detail = parseListingDetailFromPage(page, '123');
  assert.equal(detail.title, 'Correct item');
  assert.equal(detail.price, 'CHF 35');
  assert.equal(detail.description, 'Full description');
  assert.equal(detail.seller.name, 'Correct seller');
  assert.equal(detail.seller.profileUrl, 'https://www.facebook.com/45');
  assert.equal(detail.location, 'Lausanne');
  assert.equal(detail.condition, 'Used');
  assert.equal(detail.images.length, 2);
});

test('product_item links public URL IDs to matching internal listing fragments', () => {
  const page = html({ id: 'internal-id', product_item: { id: '123' }, marketplace_listing_title: 'Linked item' },
    { id: 'internal-id', listing_price: { formatted_amount: 'CHF 80' } });
  const detail = parseListingDetailFromPage(page, '123');
  assert.equal(detail.title, 'Linked item');
  assert.equal(detail.price, 'CHF 80');
});

test('unmatched listing fields stay unknown instead of borrowing another item', () => {
  const detail = parseListingDetailFromPage(html({ id: '999', marketplace_listing_title: 'Wrong',
    listing_price: { amount: 100 }, marketplace_listing_seller: { name: 'Wrong' } }), '123');
  assert.equal(detail.title, '');
  assert.equal(detail.price, '');
  assert.equal(detail.seller.name, '');
});

test('invalid dates and prototype keys in embedded data are handled safely', () => {
  const page = '<script type="application/json">{"id":"123","marketplace_listing_title":"Safe","creation_time":1e30,"__proto__":{"polluted":true}}</script>';
  assert.equal(parseListingDetailFromPage(page, '123').postedDate, '');
  assert.equal({}.polluted, undefined);
});

test('search finds nested connections, preserves cursors, skips bad entries and deduplicates IDs', () => {
  const listing = { id: '123', marketplace_listing_title: 'Desk',
    listing_price: { formatted_amount_zeros_stripped: 'CHF 50' }, creation_time: 'not-a-date' };
  const result = parseSearchResponse({ data: { viewer: { search_connection: {
    edges: [null, { node: { listing } }, { node: { listing } }, { node: { id: 'tracking-id' } }],
    page_info: { has_next_page: true, end_cursor: 'next-page' },
  } } } });
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].price, 'CHF 50');
  assert.equal(result.listings[0].postedDate, '');
  assert.equal(result.endCursor, 'next-page');
  assert.equal(result.hasNextPage, true);
});

test('distinguishes explicit no-results stories from outdated queries returning only tracking IDs', () => {
  const response = node => ({ data: { marketplace_search: { feed_units: { edges: [{ node }] } } } });
  assert.equal(parseSearchResponse(response({ __typename: 'EntMarketplaceSearchFeedNoResults' })).listings.length, 0);
  assert.throws(() => parseSearchResponse(response({ story_key: '123', id: 'tracking' })), /capture-queries/);
});
