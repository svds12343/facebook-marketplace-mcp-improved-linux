import { RateLimiter } from '../../dist/utils/rate-limit.js';
RateLimiter.prototype.wait = async () => {};
// Synthetic missing-price and camelCase-price cases, not captured live pages.
// Refuse repeated calls, searches or image downloads.
const called = new Set();
globalThis.fetch = async input => {
  const url = String(input);
  if (called.has(url)) throw new Error('Diagnostic repeated a request');
  called.add(url);
  if (url === 'https://www.facebook.com/marketplace/') return new Response('"DTSGInitialData",[],{"token":"private-fixture-auth-token"}');
  if (url === 'https://www.facebook.com/marketplace/item/123/') return new Response(`<script type="application/json">${JSON.stringify({
    id: '123', marketplace_listing_title: 'Diagnostic guitar', listing_price: { amount: '150', currency: 'CHF', formatted_amount: '150 CHF' },
    creation_time: Date.parse('2026-10-12T13:39:19.000Z') / 1000,
    strikethrough_price: null, comparable_price: { amount: '300', currency: 'CHF', formatted_amount: '300 CHF' },
    comparable_price_type: 'UNVERIFIED_EXAMPLE', redacted_description: { text: 'private fixture description' },
    marketplace_listing_seller: { id: '777', name: 'private fixture seller' },
  })}</script>`);
  if (url === 'https://www.facebook.com/marketplace/item/1398293835801835/') return new Response(`<script type="application/json">${JSON.stringify({
    id: '1398293835801835', marketplace_listing_title: 'Synthetic guitar bundle',
    listing_price: { amount: '150.00', currency: 'CHF', formatted_amount_zeros_stripped: '150\u00a0CHF',
      amount_with_offset_in_currency: '17797' },
    strikethrough_price: { formattedAmountWithoutDecimals: '300\u00a0CHF' },
    creation_time: Date.parse('2026-10-12T13:39:19.000Z') / 1000,
  })}</script>`);
  throw new Error('Unexpected diagnostic network request');
};
