import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { downloadListingImage, MAX_IMAGE_BYTES } from '../dist/facebook/images.js';
import { createListingImagesHandler } from '../dist/tools/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=', 'base64');
let directory, oldDataDir;
beforeEach(() => {
  oldDataDir = process.env.FB_DATA_DIR;
  process.env.FB_DATA_DIR = directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-image-control-'));
});
afterEach(() => {
  if (oldDataDir === undefined) delete process.env.FB_DATA_DIR; else process.env.FB_DATA_DIR = oldDataDir;
  fs.rmSync(directory, { recursive: true, force: true });
});
const photo = n => `https://scontent.example.fbcdn.net/photo-${n}.png?signature=private-signature`;
const response = () => new Response(png, { headers: { 'content-type': 'image/png' } });
const listing = (images = [photo(1), photo(2), photo(3), photo(4)]) => ({
  id: '123', title: 'Fixture camera', images, url: 'https://www.facebook.com/marketplace/item/123/',
});

test('downloads native image content without forwarding credentials and validates the MCP shape', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, photo(1));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  });
  const image = await downloadListingImage(photo(1));
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  assert.equal(CallToolResultSchema.safeParse({ content: [image] }).success, true);
});

test('blocks arbitrary hosts, host lookalikes, credentials, ports and non-HTTPS before making a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  for (const url of ['http://scontent.fbcdn.net/photo.jpg', 'file:///etc/passwd', 'https://127.0.0.1/photo.jpg',
    'https://fbcdn.net.attacker.test/photo.jpg', 'https://notfbcdn.net/photo.jpg',
    'https://user:password@scontent.fbcdn.net/photo.jpg', 'https://scontent.fbcdn.net:8443/photo.jpg', 'not a URL']) {
    await assert.rejects(downloadListingImage(url), /HTTPS|invalid photo URL/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('follows a bounded CDN redirect and revalidates the destination', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.fbsbx.com/photo.png' } })
      : response();
  });
  assert.equal((await downloadListingImage(photo(1))).mimeType, 'image/png');
  assert.deepEqual(requests, [photo(1), 'https://cdn.fbsbx.com/photo.png']);
});

test('never follows redirects into local networks or arbitrary websites', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/metadata' } }));
  await assert.rejects(downloadListingImage(photo(1)), /HTTPS/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('stops redirect loops', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 302, headers: { location: photo(1) } }));
  await assert.rejects(downloadListingImage(photo(1)), /excessive redirect/);
  assert.equal(fetch.mock.callCount(), 3);
});

test('rejects HTML, unsupported images, empty images and misleading image content types', async t => {
  let next;
  t.mock.method(globalThis, 'fetch', async () => next);
  for (const [data, contentType] of [
    ['<html>not a photo</html>', 'text/html'], [png, 'image/svg+xml'],
    ['<html>private content</html>', 'image/jpeg'], [png, 'image/jpeg'], [null, 'image/png'],
  ]) {
    next = new Response(data, { headers: { 'content-type': contentType } });
    await assert.rejects(downloadListingImage(photo(1)), /supported|empty|match/);
  }
});

test('bounds downloads using both declared length and actual streamed bytes', async t => {
  let cancelled = false;
  let next = new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } });
  t.mock.method(globalThis, 'fetch', async () => next);
  await assert.rejects(downloadListingImage(photo(1)), /2 MiB/);
  let chunks = 0;
  next = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(chunks++ === 0 ? png : new Uint8Array(MAX_IMAGE_BYTES));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(downloadListingImage(photo(1)), /2 MiB/);
  assert.equal(cancelled, true);
});

test('download errors omit signed URLs, response bodies and other private error details', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`secret-cookie ${photo(1)}`); });
  await assert.rejects(downloadListingImage(photo(1)), error => {
    assert.doesNotMatch(error.message, /signature|secret-cookie|fbcdn/);
    return /Could not download/.test(error.message);
  });
});

test('a stalled download times out without exposing its URL', async t => {
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    if (delay !== 15_000) return originalTimeout(callback, delay);
    queueMicrotask(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error(`Aborted ${photo(1)}`)), { once: true });
  }));
  await assert.rejects(downloadListingImage(photo(1)), /Photo download timed out/);
});

test('photo tool returns three labeled images by default, with metadata separated from image bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => response());
  const handler = createListingImagesHandler({ getListingDetail: async () => listing() });
  const result = await handler({ listing_id: '123' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.returned_photo_indices, [1, 2, 3]);
  assert.equal(result.structuredContent.total_photos, 4);
  assert.equal(result.content.filter(block => block.type === 'image').length, 3);
  for (const index of [1, 2, 3]) assert.match(result.content[index * 2 - 1].text, new RegExp(`Photo ${index} of 4`));
  assert.equal(JSON.stringify(result.structuredContent).includes(png.toString('base64')), false);
  assert.equal(CallToolResultSchema.safeParse(result).success, true);
});

test('photo tool preserves requested order, deduplicates numbers and keeps successes when another photo fails', async t => {
  t.mock.method(globalThis, 'fetch', async url => url === photo(2)
    ? new Response('private-error-body', { status: 403 }) : response());
  const handler = createListingImagesHandler({ getListingDetail: async () => listing() });
  const result = await handler({ listing_id: '123', photo_indices: [4, 4, 2] });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.returned_photo_indices, [4]);
  assert.equal(result.structuredContent.failed_photos[0].photo_index, 2);
  assert.doesNotMatch(JSON.stringify(result.content), /private-error-body|private-signature/);
  assert.match(result.content[1].text, /Photo 4 of 4/);
});

test('out-of-range photo numbers are reported without losing other images', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response());
  const handler = createListingImagesHandler({ getListingDetail: async () => listing() });
  const result = await handler({ listing_id: '123', photo_indices: [99, 1] });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.returned_photo_indices, [1]);
  assert.equal(result.structuredContent.failed_photos[0].photo_index, 99);
  assert.equal(fetch.mock.callCount(), 1);
});

test('all failed downloads and no-photo listings explicitly fail the visual inspection', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  const handler = createListingImagesHandler({ getListingDetail: async () => listing() });
  assert.equal((await handler({ listing_id: '123' })).isError, true);
  const empty = await createListingImagesHandler({ getListingDetail: async () => listing([]) })({ listing_id: '123' });
  assert.equal(empty.isError, true);
  assert.deepEqual(empty.structuredContent.returned_photo_indices, []);
  assert.match(empty.content[0].text, /No images were inspected/);
});

test('invalid IDs, photo indices and oversized batches are rejected before fetching a listing', async () => {
  const handler = createListingImagesHandler({ getListingDetail: async () => { assert.fail('Unexpected listing request'); } });
  for (const args of [{ listing_id: 'https://example.test' }, { listing_id: '123', photo_indices: [0] },
    { listing_id: '123', photo_indices: [1.5] }, { listing_id: '123', photo_indices: [] },
    { listing_id: '123', photo_indices: [1, 2, 3, 4] }]) {
    assert.equal((await handler(args)).isError, true);
  }
});
