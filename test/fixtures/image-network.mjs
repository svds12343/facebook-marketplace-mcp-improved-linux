import { RateLimiter } from "../../dist/utils/rate-limit.js";
RateLimiter.prototype.wait = async () => {};
// Preloaded only by the MCP integration test. No live Facebook requests or accounts.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=', 'base64');
globalThis.fetch = async url => {
  if (url === 'https://www.facebook.com/marketplace/') {
    return new Response('"DTSGInitialData",[],{"token":"fixture-token"}');
  }
  if (url === 'https://www.facebook.com/marketplace/item/123/') {
    return new Response(`<script type="application/json">${JSON.stringify({
      id: '123', marketplace_listing_title: 'Camera fixture',
      listing_price: { formatted_amount: 'CHF 500', amount: '500', currency: 'CHF' },
      strikethrough_price: { formatted_amount: 'CHF 750', amount: '750', currency: 'CHF' },
      creation_time: Date.parse('2026-10-13T12:00:00.000Z') / 1000,
      redacted_description: { text: 'Camera for sale' },
      listing_photos: [1, 2, 3].map(index => ({ image: { uri: `https://scontent.example.fbcdn.net/${index}.png` } })),
    })}</script>`);
  }
  if (/^https:\/\/scontent\.example\.fbcdn\.net\/[123]\.png$/.test(url)) {
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  }
  throw new Error('Unexpected network request in image integration test');
};
