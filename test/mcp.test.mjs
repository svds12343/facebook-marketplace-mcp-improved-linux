import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP initializes and lists tools without DISPLAY, browser, cookies or native SQLite', { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', DISPLAY: '', FB_DATA_DIR: directory,
      FB_COOKIES_FILE: path.join(directory, 'missing.json') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ubuntu-smoke-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'acknowledge_alerts', 'assess_listing', 'automation_status', 'check_monitors', 'delete_monitor', 'get_listing', 'get_listing_images', 'get_price_history', 'list_monitors', 'list_watches',
      'monitor_search', 'pause_automation', 'read_alerts', 'search_listings', 'search_location', 'unwatch_listing', 'watch_listing',
    ]);
    for (const tool of tools) {
      assert.ok(tool.description.length > 20);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean');
      assert.ok(tool.outputSchema);
    }
    assert.equal(tools.find(t => t.name === 'check_monitors').annotations.readOnlyHint, false);
    const status = await client.callTool({ name: 'automation_status', arguments: {} });
    assert.equal(status.structuredContent.enabled, false);
    const result = await client.callTool({ name: 'search_listings', arguments: {
      query: 'chair', latitude: 46.5, longitude: 6.6,
    } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /npm run login/);
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP transmits real image blocks through stdio and advertises the visual inspection workflow', { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mcp-image-test-'));
  const session = path.join(directory, 'session.json');
  fs.writeFileSync(session, JSON.stringify({ cookies: ['c_user', 'xs'].map(name => ({
    domain: '.facebook.com', name, value: `fixture-${name}`, path: '/', expires: -1,
  })) }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', fileURLToPath(new URL('./fixtures/image-network.mjs', import.meta.url)),
      fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', DISPLAY: '', FB_DATA_DIR: directory, FB_COOKIES_FILE: session },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'image-smoke-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions(), /get_listing_images/);
    assert.ok(client.getInstructions().length <= 512);
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === 'get_listing_images').annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'get_listing_images', arguments: {
      listing_id: '123', photo_indices: [2, 3],
    } });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.returned_photo_indices, [2, 3]);
    const images = result.content.filter(block => block.type === 'image');
    assert.equal(images.length, 2);
    assert.equal(images[0].mimeType, 'image/png');
    assert.equal(images[0].data, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=');
    const detail = await client.callTool({ name: 'get_listing', arguments: { listing_id: '123' } });
    assert.equal(detail.isError, undefined);
    assert.equal(detail.structuredContent.listing.price, 'CHF 500');
    const watch = await client.callTool({ name: 'watch_listing', arguments: { listing_id: '123', target_price: 600, currency: 'CHF' } });
    assert.equal(watch.isError, undefined);
    const checks = await client.callTool({ name: 'check_monitors', arguments: { request_budget: 1 } });
    assert.equal(checks.isError, undefined);
    assert.equal(checks.structuredContent.watched[0].ok, true);
    const history = await client.callTool({ name: 'get_price_history', arguments: { listing_id: '123' } });
    assert.equal(history.structuredContent.history[0].amount, 500);
    const alerts = await client.callTool({ name: 'read_alerts', arguments: {} });
    assert.equal(alerts.structuredContent.alerts[0].kind, 'target_reached');
    const ack = await client.callTool({ name: 'acknowledge_alerts', arguments: { alert_ids: [alerts.structuredContent.alerts[0].id] } });
    assert.equal(ack.structuredContent.acknowledged, 1);
    const risk = await client.callTool({ name: 'assess_listing', arguments: { listing_id: '123' } });
    assert.equal(risk.isError, undefined);
    assert.equal(risk.structuredContent.listingId, '123');
    const saved = await client.callTool({ name: 'monitor_search', arguments: { name: 'cameras', query: 'camera', latitude: 46.5, longitude: 6.5 } });
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent.monitor.inspectLimit, 0);
    const monitors = await client.callTool({ name: 'list_monitors', arguments: {} });
    assert.equal(monitors.structuredContent.monitors[0].seenCount, 0);
    assert.equal(Object.hasOwn(monitors.structuredContent.monitors[0], 'seenIds'), false);
    assert.equal((await client.callTool({ name: 'list_watches', arguments: {} })).structuredContent.watches.length, 1);
    assert.equal((await client.callTool({ name: 'unwatch_listing', arguments: { listing_id: '123' } })).structuredContent.removed, true);
    assert.equal((await client.callTool({ name: 'delete_monitor', arguments: { name: 'cameras' } })).structuredContent.deleted, true);
    assert.equal((await client.callTool({ name: 'pause_automation', arguments: {} })).structuredContent.enabled, false);
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
