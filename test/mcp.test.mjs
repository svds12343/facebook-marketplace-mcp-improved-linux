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
      'check_monitors', 'delete_monitor', 'get_listing', 'list_monitors',
      'monitor_search', 'search_listings', 'search_location',
    ]);
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
