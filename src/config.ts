import os from "node:os";
import path from "node:path";

export function dataDirectory(): string {
  return path.resolve(process.env.FB_DATA_DIR || path.join(os.homedir(), ".fb-marketplace"));
}

export function cookiesFile(): string {
  return path.resolve(process.env.FB_COOKIES_FILE || path.join(dataDirectory(), "session.json"));
}

export function queriesFile(): string {
  return path.join(dataDirectory(), "queries.json");
}
