import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "../config.js";
import { withLock } from "../storage/state.js";
import { writePrivateJson } from "../utils/private-file.js";
import { automationStatus, suspendAutomation } from "../monitoring/control.js";

const WINDOW = 86_400_000;
export const limitsSchema = z.object({
  authenticatedPer24Hours: z.number().int().min(1).max(1000),
  imagesPer24Hours: z.number().int().min(1).max(1000),
  minimumIntervalSeconds: z.number().int().min(1).max(86400),
});
export const DEFAULT_LIMITS = { authenticatedPer24Hours: 15, imagesPer24Hours: 60, minimumIntervalSeconds: 120 };
const budgetSchema = z.object({ used: z.number(), limit: z.number(), remaining: z.number(), nextBudgetRelease: z.string().nullable() });
export const activityStatusSchema = z.object({ paused: z.boolean(), pauseReason: z.string().nullable(), resumeNotBefore: z.string().nullable(),
  authenticated: budgetSchema, images: budgetSchema, minimumIntervalSeconds: z.number(), nextAuthenticatedRequestAt: z.string().nullable(),
  errorsLast24Hours: z.number(), cacheHitsSinceTrackingStarted: z.number(), note: z.string() });
const kinds = z.enum(["authenticated", "image"]);
export type RequestKind = z.infer<typeof kinds>;
const event = z.object({ at: z.number().finite().nonnegative(), kind: kinds });
const stateSchema = z.object({
  version: z.literal(1), limits: limitsSchema, requests: z.array(event).max(2000),
  errors: z.array(event).max(2000), cacheHits: z.number().int().nonnegative(),
  lastAuthenticatedRequest: z.number().finite().nonnegative(),
  paused: z.object({ reason: z.string(), at: z.number().finite().nonnegative(), notBefore: z.number().finite().nonnegative() }).nullable(),
});
type State = z.infer<typeof stateSchema>;
const filename = () => path.join(dataDirectory(), "activity.json");
function read(): State {
  if (!fs.existsSync(filename())) {
    // Carry forward security pauses from versions that only stopped the scheduler.
    const legacy = automationStatus().pausedReason;
    return { version: 1, limits: { ...DEFAULT_LIMITS }, requests: [], errors: [], cacheHits: 0,
      lastAuthenticatedRequest: 0, paused: legacy ? { reason: "Previous background security pause requires manual review.", at: Date.now(), notBefore: 0 } : null };
  }
  try { return stateSchema.parse(JSON.parse(fs.readFileSync(filename(), "utf8"))); }
  catch { throw new Error("Cannot read activity.json. All network requests are stopped; restore valid state instead of deleting request history."); }
}
async function update<T>(operation: (state: State) => T): Promise<T> {
  return withLock("activity-control", () => {
    const state = read();
    const value = operation(state);
    writePrivateJson(filename(), state);
    return value;
  });
}
export class ActivityStoppedError extends Error {}
export class SecurityStopError extends Error {
  constructor(message: string, readonly notBefore = 0) { super(message); }
}
function assertOpen(state: State) {
  if (state.paused) throw new ActivityStoppedError(`All Facebook requests paused: ${state.paused.reason} Complete manual account review, then use npm run activity:resume -- --reviewed. No automatic retry.`);
}
export async function assertActivityOpen(): Promise<void> {
  const state = await update(state => state); // Persist a legacy pause before rejecting, including across restarts.
  assertOpen(state);
}

/** Accounted before sending, including failed requests. Shared by all processes using FB_DATA_DIR. */
export async function reserveActivityRequest(kind: RequestKind, now = Date.now()): Promise<void> {
  await update(state => {
    assertOpen(state);
    state.requests = state.requests.filter(item => now - item.at < WINDOW);
    state.errors = state.errors.filter(item => now - item.at < WINDOW);
    const requests = state.requests.filter(item => item.kind === kind);
    const cap = kind === "authenticated" ? state.limits.authenticatedPer24Hours : state.limits.imagesPer24Hours;
    if (requests.length >= cap) throw new ActivityStoppedError(`${kind} request budget exhausted (${cap}/rolling 24 hours). Read activity_status; do not loop or change limits to continue this run.`);
    const wait = kind === "authenticated" ? state.lastAuthenticatedRequest + state.limits.minimumIntervalSeconds * 1000 - now : 0;
    if (wait > 0) throw new ActivityStoppedError(`Facebook request spacing limit: retry no earlier than ${new Date(now + wait).toISOString()}. Use cached data or finish this run; no automatic waiting/retry.`);
    state.requests.push({ at: now, kind });
    if (kind === "authenticated") state.lastAuthenticatedRequest = now;
  });
}
export async function recordCacheHit(): Promise<void> { await update(state => { state.cacheHits++; }); }
export async function pauseActivity(reason = "Paused manually.", notBefore = 0): Promise<void> {
  await update(state => { state.paused ??= { reason, at: Date.now(), notBefore }; state.paused.notBefore = Math.max(state.paused.notBefore, notBefore); });
}
export async function resumeActivity(reviewed: boolean): Promise<void> {
  if (!reviewed) throw new Error("Review Facebook manually first, then use npm run activity:resume -- --reviewed. This does not verify the account or make automated access safe.");
  await update(state => {
    if (state.paused && state.paused.notBefore > Date.now()) throw new Error(`Facebook Retry-After has not elapsed. Resume no earlier than ${new Date(state.paused.notBefore).toISOString()}.`);
    state.paused = null; // Keep budgets, spacing and counters. Never enable the scheduler here.
  });
}
export async function configureActivity(limits: z.infer<typeof limitsSchema>): Promise<void> {
  const parsed = limitsSchema.parse(limits);
  await update(state => { state.limits = parsed; });
}
export async function activityStatus() {
  return withLock("activity-control", () => {
    const state = read(), now = Date.now();
    const counts = (kind: RequestKind) => {
      const used = state.requests.filter(r => r.kind === kind && now - r.at < WINDOW);
      const limit = kind === "authenticated" ? state.limits.authenticatedPer24Hours : state.limits.imagesPer24Hours;
      return { used: used.length, limit, remaining: Math.max(0, limit - used.length),
        nextBudgetRelease: used.length ? new Date(Math.min(...used.map(r => r.at)) + WINDOW).toISOString() : null };
    };
    return { paused: state.paused !== null, pauseReason: state.paused?.reason ?? null,
      resumeNotBefore: state.paused?.notBefore ? new Date(state.paused.notBefore).toISOString() : null,
      authenticated: counts("authenticated"), images: counts("image"),
      minimumIntervalSeconds: state.limits.minimumIntervalSeconds,
      nextAuthenticatedRequestAt: state.lastAuthenticatedRequest ? new Date(state.lastAuthenticatedRequest + state.limits.minimumIntervalSeconds * 1000).toISOString() : null,
      errorsLast24Hours: state.errors.filter(e => now - e.at < WINDOW).length, cacheHitsSinceTrackingStarted: state.cacheHits,
      note: "Local counters only, starting with this version. These experimental limits are not Facebook-approved safe thresholds. Cache reads do not verify availability. Manual browser/login/capture activity is not metered. All MCP processes and timers must share FB_DATA_DIR." };
  });
}

/** Hold a cross-process lease through response validation, so a queued request cannot pass a checkpoint. */
export async function runGuardedRequest<T>(kind: RequestKind, operation: () => Promise<T>): Promise<T> {
  return withLock("facebook-network", async () => {
    await assertActivityOpen();
    await reserveActivityRequest(kind);
    try { return await operation(); }
    catch (error) {
      await update(state => { state.errors = [...state.errors.filter(e => Date.now() - e.at < WINDOW), { at: Date.now(), kind }].slice(-2000); });
      if (error instanceof SecurityStopError) {
        await pauseActivity(error.message, error.notBefore);
        await suspendAutomation(error.message);
      }
      throw error;
    }
  });
}
