import fs from "node:fs";
import { cookiesFile } from "../config.js";
import { writePrivateJson } from "../utils/private-file.js";
import type { FacebookCookie } from "./types.js";

export interface FacebookAuth {
  cookies: FacebookCookie[];
  userAgent?: string;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesHost(host: string, hostname: string): boolean {
  if (!host.startsWith(".")) return host === hostname;
  const domain = host.slice(1);
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesPath(cookiePath: string, pathname: string): boolean {
  return pathname === cookiePath || (pathname.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || pathname[cookiePath.length] === "/"));
}

export function cookiesToHeader(cookies: FacebookCookie[], url = MARKETPLACE_URL): string {
  const target = new URL(url);
  // This helper must never attach the Facebook session to another service.
  if (target.protocol !== "https:" || target.hostname !== "www.facebook.com") {
    throw new Error("Facebook cookies may only be sent to https://www.facebook.com.");
  }
  return cookies.filter(cookie =>
    matchesHost(cookie.host, target.hostname) && matchesPath(cookie.path, target.pathname) &&
    (cookie.expires <= 0 || cookie.expires > Date.now() / 1000)
  ).sort((a, b) => b.path.length - a.path.length).map(cookie => {
    if (!COOKIE_NAME.test(cookie.name) || !COOKIE_VALUE.test(cookie.value)) {
      throw new Error("Invalid characters in Facebook cookies. Export a fresh session.");
    }
    return `${cookie.name}=${cookie.value}`;
  }).join("; ");
}

export function getCookieValue(cookies: FacebookCookie[], name: string): string | undefined {
  return cookies.find(cookie => cookie.name === name)?.value;
}

/** Accept Playwright storage state, exported cookie arrays, or this app's saved session. */
export function parseFacebookAuth(input: unknown, now = Date.now() / 1000): FacebookAuth {
  const entries = Array.isArray(input) ? input : record(input) ? input.cookies : undefined;
  if (!Array.isArray(entries)) {
    throw new Error('Expected a JSON cookie array or an object containing a "cookies" array.');
  }
  const cookies: FacebookCookie[] = [];
  for (const entry of entries) {
    if (!record(entry)) throw new Error("Invalid cookie entry in session file.");
    const host = typeof entry.domain === "string" ? entry.domain : entry.host;
    if (typeof host !== "string") throw new Error("Cookie is missing its domain.");
    const normalizedHost = host.toLowerCase();
    if (!["facebook.com", ".facebook.com", "www.facebook.com", ".www.facebook.com"].includes(normalizedHost)) continue;
    // Exporters may represent a domain cookie without the leading dot.
    const cookieHost = normalizedHost === "facebook.com" && entry.hostOnly === false
      ? ".facebook.com" : normalizedHost;
    if (!matchesHost(cookieHost, "www.facebook.com")) continue;
    if (typeof entry.name !== "string" || typeof entry.value !== "string" ||
        !COOKIE_NAME.test(entry.name) || !COOKIE_VALUE.test(entry.value)) {
      throw new Error("Invalid characters in Facebook cookies. Export a fresh session.");
    }
    const rawExpiry = entry.expires ?? entry.expirationDate ?? -1;
    if (typeof rawExpiry !== "number" || !Number.isFinite(rawExpiry)) {
      throw new Error("Cookie expiry must be a Unix timestamp in seconds.");
    }
    if (rawExpiry > 0 && rawExpiry <= now) continue;
    const cookiePath = entry.path ?? "/";
    if (typeof cookiePath !== "string" || !cookiePath.startsWith("/")) {
      throw new Error("Invalid cookie path.");
    }
    cookies.push({ host: cookieHost, name: entry.name, value: entry.value,
      path: cookiePath, expires: rawExpiry, secure: entry.secure !== false,
      httpOnly: entry.httpOnly === true });
  }
  for (const name of ["c_user", "xs"]) {
    if (!cookies.some(cookie => cookie.name === name && cookie.value && cookie.path === "/")) {
      throw new Error(`Missing or expired ${name} cookie. Run npm run login and finish Facebook login first.`);
    }
  }
  const userAgent = record(input) && typeof input.userAgent === "string" ? input.userAgent : undefined;
  if (userAgent && !/^[\x20-\x7E]+$/.test(userAgent)) throw new Error("Invalid saved user agent.");
  return { cookies, userAgent };
}

export function readFacebookAuth(filename: string): FacebookAuth {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No Facebook session at ${filename}. Run npm run login, or npm run login -- --import /path/to/cookies.json.`);
    }
    // JSON errors can quote credential values. Never forward the raw parse error.
    throw new Error(`Cannot read valid session JSON from ${filename}. Check the file and its permissions.`);
  }
  return parseFacebookAuth(input);
}

export function saveFacebookAuth(input: unknown, filename = cookiesFile()): void {
  const auth = parseFacebookAuth(input);
  writePrivateJson(filename, {
    cookies: auth.cookies.map(({ host, ...cookie }) => ({ domain: host, ...cookie })),
    userAgent: auth.userAgent,
    savedAt: new Date().toISOString(),
  });
}

export async function loadFacebookAuth(profile = "Default"): Promise<FacebookAuth> {
  const filename = cookiesFile();
  if (process.env.FB_COOKIES_FILE || fs.existsSync(filename) || process.platform !== "darwin") {
    return readFacebookAuth(filename);
  }
  // The native SQLite dependency is optional and is never imported on Linux.
  const { extractChromeCookies } = await import("./chrome-macos.js");
  return parseFacebookAuth({ cookies: extractChromeCookies("facebook.com", profile) });
}
