#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { cookiesFile } from "../src/config.js";
import { readFacebookAuth, saveFacebookAuth } from "../src/facebook/auth.js";
import { openLoginBrowser, saveBrowserSession, waitForEnter } from "./lib/browser.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    import: { type: "string" },
    help: { type: "boolean", short: "h" },
  }});
  if (values.help) {
    console.log("Usage: npm run login [-- --import /path/to/cookies.json]\n\nDefault: open a dedicated Chromium profile using your forwarded X11 display.\nImport: accept a Playwright storage-state file or a browser-exported JSON cookie array.\nFB_DATA_DIR, FB_COOKIES_FILE and FB_BROWSER_CHANNEL are optional overrides.");
    return;
  }
  if (values.import) {
    saveFacebookAuth(readFacebookAuth(values.import));
    console.error(`Imported Facebook session to ${cookiesFile()}. Run npm run auth:check to verify it online.`);
    return;
  }
  const context = await openLoginBrowser();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    console.error("A browser window will appear through X11. Sign into Facebook yourself, complete any 2FA/checkpoint, and open Marketplace.");
    await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForEnter(context, "When Marketplace is accessible, return here and press Enter to save the session: ");
    await saveBrowserSession(context);
    console.error("The MCP can now run without DISPLAY or an open browser. Run npm run auth:check to verify the saved session.");
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Login failed.");
  process.exitCode = 1;
});
