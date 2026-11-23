import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { dataDirectory } from "../config.js";
import { withLock } from "./state.js";
import { writePrivateJson } from "../utils/private-file.js";
import { recordCacheHit } from "../activity/control.js";

const entriesSchema = z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime(), value: z.unknown() })).max(120);
const filename = () => path.join(dataDirectory(), "response-cache.json");
function read() {
  if (!fs.existsSync(filename())) return [];
  try { return entriesSchema.parse(JSON.parse(fs.readFileSync(filename(), "utf8"))); }
  catch { throw new Error("Cannot read response-cache.json. Repair or move aside this cache before retrying; no request was sent."); }
}
export interface Retrieval { source: "live" | "cache"; observedAt: string }
export async function cachedResponse<T>(keyParts: unknown, schema: z.ZodType<T>, retrieve: () => Promise<T>, maxAgeMs = 30 * 60_000): Promise<{ value: T; retrieval: Retrieval }> {
  const key = crypto.createHash("sha256").update(JSON.stringify(keyParts)).digest("hex");
  // Identical concurrent calls cannot independently miss then spend two requests.
  return withLock(`response-${key}`, async () => {
    const entry = read().find(e => e.key === key && maxAgeMs > 0 && Date.now() >= Date.parse(e.observedAt) && Date.now() - Date.parse(e.observedAt) <= maxAgeMs);
    if (entry) {
      const value = schema.parse(entry.value);
      await recordCacheHit();
      return { value, retrieval: { source: "cache", observedAt: entry.observedAt } };
    }
    const value = schema.parse(await retrieve());
    const observedAt = new Date().toISOString();
    await withLock("response-cache", () => {
      writePrivateJson(filename(), [...read().filter(e => e.key !== key), { key, observedAt, value }].slice(-120));
    });
    return { value, retrieval: { source: "live", observedAt } };
  });
}
