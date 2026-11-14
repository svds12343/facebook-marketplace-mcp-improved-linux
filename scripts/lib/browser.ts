import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type BrowserContext } from "playwright";
import { cookiesFile, dataDirectory } from "../../src/config.js";
import { readFacebookAuth, saveFacebookAuth } from "../../src/facebook/auth.js";

export async function openLoginBrowser(): Promise<BrowserContext> {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    throw new Error("DISPLAY is empty. Enable X11 forwarding in your MobaXterm SSH session and reconnect, then try again. Alternatively use npm run login -- --import /path/to/cookies.json.");
  }
  if (process.getuid?.() === 0) {
    throw new Error("Run browser login as your normal Ubuntu user, without sudo. Chromium's sandbox does not support running as root.");
  }
  if (!process.stdin.isTTY) throw new Error("Browser login needs an interactive terminal. Run npm run login directly in MobaXterm.");

  process.umask(0o077);
  const directory = path.join(dataDirectory(), "browser-profile");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const context = await chromium.launchPersistentContext(directory, {
    headless: false,
    chromiumSandbox: true,
    channel: process.env.FB_BROWSER_CHANNEL || undefined,
    viewport: null,
    args: process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu", "--disable-dev-shm-usage"] : [],
  });
  try {
    if (fs.existsSync(cookiesFile())) {
      try {
        const { cookies } = readFacebookAuth(cookiesFile());
        await context.addCookies(cookies.map(({ host, ...cookie }) => ({ domain: host, ...cookie })));
      } catch {
        console.error("Saved session is unusable; sign in again in the browser.");
      }
    }
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function waitForEnter(context: BrowserContext, prompt: string): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController();
  const onClose = () => controller.abort();
  const onSignal = () => controller.abort();
  context.on("close", onClose);
  readline.on("SIGINT", onSignal);
  try {
    await readline.question(prompt, { signal: controller.signal });
  } catch {
    throw new Error("Login/capture cancelled. Keep the browser open until you press Enter in the terminal.");
  } finally {
    context.off("close", onClose);
    readline.off("SIGINT", onSignal);
    readline.close();
  }
}

export async function saveBrowserSession(context: BrowserContext): Promise<void> {
  const page = context.pages().find(page => {
    const url = new URL(page.url());
    return url.protocol === "https:" && url.hostname === "www.facebook.com";
  });
  if (!page) throw new Error("Open https://www.facebook.com/marketplace/ and finish login before saving.");
  saveFacebookAuth({
    cookies: await context.cookies("https://www.facebook.com/"),
    userAgent: await page.evaluate(() => navigator.userAgent),
  });
  console.error(`Saved Facebook session to ${cookiesFile()} (owner-only permissions).`);
}
