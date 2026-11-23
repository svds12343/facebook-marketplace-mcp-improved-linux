import fs from "node:fs";
import path from "node:path";
import { reserveAutomatedRequest } from "../monitoring/control.js";
import { dataDirectory } from "../config.js";
import { withLock } from "../storage/state.js";
import { writePrivateJson } from "./private-file.js";
import { ActivityStoppedError, assertActivityOpen } from "../activity/control.js";

/** Reserve a slot shared by SSH MCP processes and the Ubuntu scheduler. */
export async function reserveRequestSlot(maxPerMinute: number, now: number | undefined = undefined, automated = false): Promise<number> {
  return withLock("request-rate", async () => {
    const stamp = now ?? Date.now();
    const filename = path.join(dataDirectory(), "request-times.json");
    const stored: unknown = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : [];
    if (!Array.isArray(stored) || stored.some(t => typeof t !== "number" || !Number.isFinite(t))) throw new Error("Invalid request-times.json; rate limit state needs repair.");
    const times = stored.filter(t => stamp - t < 60000).sort((a, b) => a - b);
    const wait = Math.max(0, times.length >= maxPerMinute ? times[times.length - maxPerMinute] + 60000 - stamp : 0, (times.at(-1) ?? 0) + 1000 - stamp);
    if (wait) return wait;
    if (automated) {
      const automatedWait = await reserveAutomatedRequest(stamp);
      if (automatedWait) return automatedWait;
    }
    times.push(stamp);
    writePrivateJson(filename, times);
    return 0;
  });
}
export class RateLimiter {
  constructor(private maxPerMinute: number, private automated = false) {}
  async wait(): Promise<void> {
    await assertActivityOpen();
    const wait = await reserveRequestSlot(this.maxPerMinute, undefined, this.automated);
    if (wait) throw new ActivityStoppedError(`Facebook request spacing limit: retry no earlier than ${new Date(Date.now() + wait).toISOString()}. No automatic waiting/retry.`);
  }
}
