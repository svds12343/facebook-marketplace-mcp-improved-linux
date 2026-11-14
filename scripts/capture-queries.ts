#!/usr/bin/env tsx
import { queriesFile } from "../src/config.js";
import { identifyQuery, readQueryIds, saveQueryIds, type QueryIds } from "../src/facebook/query-config.js";
import { openLoginBrowser, saveBrowserSession, waitForEnter } from "./lib/browser.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run capture-queries\nOpen Marketplace, run a search and change its location. Press Enter in the terminal to save compatible query IDs and the session.");
    return;
  }
  const captured: QueryIds = {};
  const context = await openLoginBrowser();
  try {
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== "https://www.facebook.com" || !/^\/api\/graphql\/?$/.test(url.pathname)) return;
      const query = identifyQuery(request.postData() ?? "");
      if (query) {
        captured[query.kind] = query.docId;
        console.error(`Captured ${query.kind}: ${query.docId}`);
      }
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.error("In the browser, sign in if needed, run a Marketplace search, then open the location selector and type a city. Only compatible query IDs are saved; request bodies and tokens are not logged.");
    await waitForEnter(context, "Press Enter here when finished: ");
    await saveBrowserSession(context);
    if (!Object.keys(captured).length) {
      throw new Error("No compatible queries captured. Existing query IDs were left unchanged. Facebook's request format may have changed.");
    }
    let existing: QueryIds;
    try { existing = readQueryIds(); } catch { existing = {}; }
    saveQueryIds({ ...existing, ...captured });
    console.error(`Saved IDs to ${queriesFile()}. Future requests use them automatically, without rebuilding.`);
    for (const kind of ["marketplace_search", "city_street_search"] as const) {
      if (!captured[kind]) console.error(`No new ${kind} ID captured; its previous value remains in use.`);
    }
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Query capture failed.");
  process.exitCode = 1;
});
