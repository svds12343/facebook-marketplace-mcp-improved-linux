import fs from "node:fs";
import path from "node:path";
import { dataDirectory } from "../config.js";
import { writePrivateJson } from "../utils/private-file.js";
import { withLock, updateState, addAlert } from "../storage/state.js";

export const AUTOMATED_DAILY_LIMIT = 24;
export class AutomationStoppedError extends Error {}
export interface AutomationControl { enabled: boolean; day: string; requests: number; lastRequest: number; pausedReason?: string }
export function automationStatus(): AutomationControl {
  const filename = path.join(dataDirectory(), "automation.json");
  const day = new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(filename)) return { enabled: false, day, requests: 0, lastRequest: 0 };
  const data = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (typeof data.enabled !== "boolean" || !Number.isInteger(data.requests) || data.requests < 0 || typeof data.day !== "string" || typeof data.lastRequest !== "number") throw new Error("Invalid automation.json; background requests are stopped until repaired.");
  return { ...data, day, requests: data.day === day ? data.requests : 0 };
}
export async function configureAutomation(action: "enable" | "pause" | "resume") {
  return withLock("automation-control", () => {
    const control = automationStatus();
    control.enabled = action !== "pause";
    if (action === "resume") delete control.pausedReason;
    writePrivateJson(path.join(dataDirectory(), "automation.json"), control);
    return control;
  });
}
export async function suspendAutomation(reason: string) {
  await withLock("automation-control", () => {
    const control = automationStatus();
    control.pausedReason = reason;
    writePrivateJson(path.join(dataDirectory(), "automation.json"), control);
  });
  const now = new Date().toISOString();
  await updateState(state => addAlert(state, { key: `automation-paused:${now.slice(0, 10)}:${reason}`, kind: "check_error", source: "automation",
    message: `Background checks paused: ${reason}. Review the account/session manually, then explicitly run npm run monitors:resume. No automatic retry.` }, now));
}
/** Called inside the global rate lock, so counting and reservations cannot race. */
export async function reserveAutomatedRequest(now: number): Promise<number> {
  return withLock("automation-control", () => {
    const control = automationStatus();
    if (!control.enabled) throw new AutomationStoppedError("Background checks are disabled; enable them explicitly if desired.");
    if (control.pausedReason) throw new AutomationStoppedError(`Background checks paused: ${control.pausedReason}`);
    if (control.requests >= AUTOMATED_DAILY_LIMIT) throw new AutomationStoppedError("Background daily request cap reached. No more automated requests until the next UTC day.");
    const wait = Math.max(0, control.lastRequest + 60000 - now);
    if (wait) return wait;
    control.requests++;
    control.lastRequest = now;
    writePrivateJson(path.join(dataDirectory(), "automation.json"), control);
    return 0;
  });
}
