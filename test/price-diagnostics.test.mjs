import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inspectListingPriceData } from '../dist/facebook/price-diagnostics.js';
import { parseListingDetailFromPage } from '../dist/facebook/parser.js';

const html = (...nodes) => nodes.map(node => `<script type="application/json">${JSON.stringify(node)}</script>`).join('\n');
const money = amount => ({ amount: String(amount), currency: 'CHF', formatted_amount: `${amount} CHF` });

test('diagnostics distinguish missing, null and comparison fields without treating other offers as evidence', () => {
  const page = html({ id: '123', listing_price: money(150), strikethrough_price: null,
    comparable_price: money(300), comparable_price_type: 'UNVERIFIED_EXAMPLE',
    recommendation: { id: '999', listing_price: money(9999), strikethrough_price: money(88888) },
  }, { id: '999', listing_price: money(9999) });
  const report = inspectListingPriceData(page, '123');
  assert.equal(report.matchedFragmentCount, 1);
  assert.deepEqual(report.matchingFragments[0].fields.find(field => field.field === 'strikethrough_price'),
    { field: 'strikethrough_price', kind: 'null', value: null });
  assert.equal(report.matchingFragments[0].fields.find(field => field.field === 'comparable_price').value.amount, '300');
  assert.equal(report.matchingFragments[0].fields.find(field => field.field === 'comparable_price_type').value, 'UNVERIFIED_EXAMPLE');
  assert.doesNotMatch(JSON.stringify(report.matchingFragments), /9999|88888/);
  assert.equal(report.priceFieldNamesAnywhereInJson.listing_price, 3);
  assert.equal(parseListingDetailFromPage(page, '123').previousPrice, null);
  assert.equal(parseListingDetailFromPage(page, '123').priceReduction, null);
});

test('diagnostics inspect ID-linked fragments and nested price objects that normal extraction may not recognize', () => {
  const page = html({ id: 'internal', product_item: { id: '123' }, marketplace_listing_title: 'Guitar' },
    { id: 'internal', pricing: { previous_price: money(300), current_price: money(150) } },
    { id: '123', details: { extra_price: money(200) } });
  const report = inspectListingPriceData(page, '123');
  assert.equal(report.matchedFragmentCount, 4); // includes the public product_item node
  assert.deepEqual(report.matchingFragments[2].fields[0].value.previous_price, money(300));
  assert.equal(report.matchingFragments[3].fields[0].field, 'details.extra_price');
});

test('diagnostics show the detail-page price alias and distinguish filtered fields from empty objects', () => {
  const page = html({ id: '123', listing_price: money(150),
    strikethrough_price: { formattedAmountWithoutDecimals: '300\u00a0CHF' },
    other_price: { unknownMoneyField: 'private unknown value', access_token: 'private token' },
    empty_price: {},
  });
  const fields = inspectListingPriceData(page, '123').matchingFragments[0].fields;
  const previous = fields.find(field => field.field === 'strikethrough_price');
  assert.deepEqual(previous.keys, ['formattedAmountWithoutDecimals']);
  assert.deepEqual(previous.value, { formattedAmountWithoutDecimals: '300\u00a0CHF' });
  const unknown = fields.find(field => field.field === 'other_price');
  assert.deepEqual(unknown.keys, ['unknownMoneyField']);
  assert.deepEqual(unknown.value, {});
  assert.deepEqual(fields.find(field => field.field === 'empty_price').keys, []);
  assert.doesNotMatch(JSON.stringify(fields), /private unknown value|access_token|private token/);
});

test('diagnostics omit arbitrary text, credentials and unrelated personal data', () => {
  const page = html({ id: '123', listing_price: { ...money(150), cookie: 'private-cookie', access_token: 'private-access-token' },
    redacted_description: { text: 'private description' }, seller: { id: '777', name: 'private seller', address: 'private address' },
    price_comment: 'private contact details', price_token: 'private token', price_info: {
      amount: '300', currency: 'CHF', text: 'private-text', secret: 'private-secret', price_session: 'private-session',
    }, pricing_type: 'SESSION_TOKEN', unknown_price: 'A'.repeat(1000),
  });
  const report = inspectListingPriceData(page, '123');
  const encoded = JSON.stringify(report);
  for (const secret of ['private-cookie', 'private-access-token', 'private description', 'private seller', 'private address',
    'private contact details', 'private token', 'private-text', 'private-secret', 'private-session', 'SESSION_TOKEN']) assert.equal(encoded.includes(secret), false);
  assert.ok(encoded.includes('[omitted string]'));
  assert.ok(encoded.includes('300'));
  assert.ok(encoded.length < 6000);
});

test('diagnostics disclose malformed blocks, encoded JSON and output limits', () => {
  const page = '<script type="application/json">bad json</script>' + html({ encoded: JSON.stringify({ listing_price: money(150) }) },
    ...Array.from({ length: 21 }, () => ({ id: '123', listing_price: money(150) })));
  const report = inspectListingPriceData(page, '123');
  assert.equal(report.invalidJsonBlocks, 1);
  assert.equal(report.stringWrappedPriceData, 1);
  assert.equal(report.matchingFragments.length, 20);
  assert.equal(report.truncated, true);
});

test('CLI diagnostics use one page fetch, preserve null results, and do not save history or leak auth data', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-diagnostic-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cookies = path.join(directory, 'session.json');
  fs.writeFileSync(cookies, JSON.stringify({ cookies: ['c_user', 'xs'].map(name => ({
    domain: '.facebook.com', name, value: `private-cookie-${name}`, path: '/', expires: -1,
  })) }));
  const fixture = fileURLToPath(new URL('./fixtures/price-diagnostics-network.mjs', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/check-listing.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '123', '--diagnostics'], {
    env: { ...process.env, FB_DATA_DIR: directory, FB_COOKIES_FILE: cookies, DISPLAY: '', NODE_OPTIONS: `--import=${fixture}` },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, 'listing-page-diagnostics');
  assert.equal(report.currentPrice.amount, 150);
  assert.equal(report.previousPrice, null);
  assert.equal(report.priceReduction, null);
  assert.equal(report.diagnostics.matchingFragments[0].fields.find(field => field.field === 'comparable_price').value.amount, '300');
  assert.doesNotMatch(run.stdout + run.stderr, /private-fixture-auth-token|private-cookie|private fixture description|private fixture seller/);
  assert.equal(fs.existsSync(path.join(directory, 'tracking.json')), false);
});

test('CLI and stdio MCP return CHF 300 to CHF 150 from the detail-page alias without extra page requests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-price-alias-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cookies = path.join(directory, 'session.json');
  fs.writeFileSync(cookies, JSON.stringify({ cookies: ['c_user', 'xs'].map(name => ({
    domain: '.facebook.com', name, value: `private-cookie-${name}`, path: '/', expires: -1,
  })) }));
  const fixture = fileURLToPath(new URL('./fixtures/price-diagnostics-network.mjs', import.meta.url));
  const script = fileURLToPath(new URL('../scripts/check-listing.mjs', import.meta.url));
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const flags of [['--diagnostics'], []]) {
    const run = spawnSync(process.execPath, [script, '1398293835801835', ...flags], {
      env: { ...process.env, FB_DATA_DIR: directory, FB_COOKIES_FILE: cookies, DISPLAY: '', NODE_OPTIONS: `--import=${fixture}` },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.serverVersion ?? report.packageVersion, version);
    assert.equal(report.currentPrice.amount, 150);
    assert.deepEqual(report.previousPrice, {
      formatted: '300\u00a0CHF', source: 'facebook_strikethrough', amount: 300, currency: 'CHF',
    });
    assert.deepEqual(report.priceReduction, { amount: 150, currency: 'CHF', percent: 50 });
    if (flags.length) {
      assert.deepEqual(report.diagnostics.matchingFragments[0].fields.find(field => field.field === 'strikethrough_price').keys,
        ['formattedAmountWithoutDecimals']);
      assert.equal(fs.existsSync(path.join(directory, 'tracking.json')), false);
    }
    assert.doesNotMatch(run.stdout + run.stderr, /private-fixture-auth-token|private-cookie/);
  }
});
