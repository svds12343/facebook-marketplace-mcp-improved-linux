#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const usage = 'Usage: npm run listing:check -- <listing-id-or-Facebook-item-URL> [--diagnostics]';
const supplied = process.argv.slice(2);
const diagnostics = supplied.includes('--diagnostics');
const args = supplied.filter(arg => arg !== '--diagnostics');
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
  console.log('Calls get_listing once through the built MCP. No browser, images, searches or background monitoring. Uses your saved login and the existing rate limit.');
  console.log('--diagnostics uses the same listing-page client once and prints only sanitized price fields to diagnose missing previous prices. No page dumps or cookies are printed.');
  process.exit(0);
}
let listingId = args[0];
if (args.length === 1 && !/^\d+$/.test(listingId ?? '')) {
  try {
    const url = new URL(listingId);
    listingId = url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname)
      ? url.pathname.match(/^\/marketplace\/item\/(\d+)\/?$/)?.[1] : undefined;
  } catch { listingId = undefined; }
}
if (args.length !== 1 || !/^\d+$/.test(listingId ?? '')) {
  console.error(usage);
  process.exit(1);
}

let client;
try {
  let listing, priceDiagnostics, version;
  if (diagnostics) {
    const { FacebookClient } = await import('../dist/facebook/client.js');
    const response = await new FacebookClient({ chromeProfile: process.env.CHROME_PROFILE }).diagnoseListingPrice(listingId);
    listing = response.listing;
    priceDiagnostics = response.diagnostics;
    version = { mode: 'listing-page-diagnostics', packageVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version };
  } else {
    client = new Client({ name: 'listing-check', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
      stderr: 'inherit',
    });
    await client.connect(transport);
    const response = await client.callTool({ name: 'get_listing', arguments: { listing_id: listingId } }, undefined, { timeout: 120000 });
    if (response.isError) throw new Error(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    listing = response.structuredContent?.listing;
    version = { serverVersion: client.getServerVersion()?.version };
  }
  if (!listing) throw new Error('The MCP did not return structured listing details. Run npm run build and retry.');
  if (!listing.title && !listing.price) throw new Error('Listing unavailable or page format changed. Stop and inspect access before retrying.');
  const age = listing.postedDate ? Date.now() - Date.parse(listing.postedDate) : NaN;
  console.log(JSON.stringify({
    ...version,
    listingId: listing.id, title: listing.title,
    currentPrice: { formatted: listing.price, amount: listing.priceAmount ?? null, currency: listing.currency ?? null },
    previousPrice: listing.previousPrice ?? null,
    priceReduction: listing.priceReduction ?? null,
    postedDate: listing.postedDate || null,
    postingAgeDays: Number.isFinite(age) && age >= 0 ? Math.floor(age / 86400000) : null,
    note: 'Previous price is Facebook’s displayed reference, not an earlier dated observation. Null means unavailable, not no price change. Reduction date is unknown.',
    ...(priceDiagnostics ? { diagnostics: priceDiagnostics } : {}),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Listing check failed.');
  process.exitCode = 1;
} finally {
  await client?.close();
}
