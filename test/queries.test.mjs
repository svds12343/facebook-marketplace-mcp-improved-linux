import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { identifyQuery, queryDocId, readQueryIds, saveQueryIds } from '../dist/facebook/query-config.js';

test('capture only accepts supported variable shapes and numeric IDs', () => {
  const request = (variables, doc_id = '123') => new URLSearchParams({ doc_id, variables: JSON.stringify(variables) }).toString();
  assert.deepEqual(identifyQuery(request({ params: { bqf: { callsite: 'COMMERCE_MKTPLACE_WWW' } } })), { kind: 'marketplace_search', docId: '123' });
  assert.deepEqual(identifyQuery(request({ params: { caller: 'MARKETPLACE' } })), { kind: 'city_street_search', docId: '123' });
  assert.equal(identifyQuery(request({ targetId: '1' })), undefined);
  assert.equal(identifyQuery(request({ params: { caller: 'MARKETPLACE' } }, 'oops')), undefined);
  assert.equal(identifyQuery('doc_id=123&variables=not-json'), undefined);
});

test('environment overrides captured IDs, captured IDs override defaults, invalid values fail clearly', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-query-test-'));
  const old = { FB_DATA_DIR: process.env.FB_DATA_DIR, FB_SEARCH_DOC_ID: process.env.FB_SEARCH_DOC_ID };
  process.env.FB_DATA_DIR = directory;
  delete process.env.FB_SEARCH_DOC_ID;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(queryDocId('marketplace_search', '111'), '111');
  saveQueryIds({ marketplace_search: '222' });
  assert.deepEqual(readQueryIds(), { marketplace_search: '222' });
  assert.equal(queryDocId('marketplace_search', '111'), '222');
  process.env.FB_SEARCH_DOC_ID = '333';
  assert.equal(queryDocId('marketplace_search', '111'), '333');
  process.env.FB_SEARCH_DOC_ID = 'bad';
  assert.throws(() => queryDocId('marketplace_search', '111'), /only digits/);
  delete process.env.FB_SEARCH_DOC_ID;
  fs.writeFileSync(path.join(directory, 'queries.json'), '{bad');
  assert.throws(() => readQueryIds(), /capture-queries/);
});
