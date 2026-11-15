import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import lockfile from "proper-lockfile";
import { dataDirectory } from "../config.js";
import { writePrivateJson } from "../utils/private-file.js";
import type { MarketplaceListing, SavedMonitor } from "../facebook/types.js";
import { benchmarkDefinitionSchema, type PriceBenchmark } from "../analysis/benchmarks.js";

export interface PricePoint { at: string; amount: number; currency: string; formatted: string }
export interface PhotoFingerprint {
  sha256: string; dhash: string; width: number; height: number;
  mean: number[]; informative: boolean; photo: number;
}
export interface ListingRecord {
  listing: MarketplaceListing; description?: string; firstSeen: string; lastSeen: string;
  seenAt?: string; history: PricePoint[]; photos?: PhotoFingerprint[]; photosCheckedAt?: string;
}
export interface Watch {
  listingId: string; targetPrice: number; currency: string; createdAt: string; lastChecked?: string;
  lastPrice?: { amount: number; currency: string };
}
export interface Alert {
  id: string; key: string; createdAt: string; kind: "new_listing" | "price_drop" | "target_reached" | "review" | "check_error";
  source: string; listingId?: string; url?: string; message: string; readAt?: string;
}
export interface State {
  version: 1; monitors: SavedMonitor[]; listings: Record<string, ListingRecord>; watches: Watch[];
  alerts: Alert[]; monitorRotation: number;
  benchmarks?: PriceBenchmark[];
}
const empty = (): State => ({ version: 1, monitors: [], listings: {}, watches: [], alerts: [], monitorRotation: 0 });
export class BusyError extends Error {}

/** Short state transactions and a separate long-running monitor lease work across processes. */
export async function withLock<T>(name: string, task: () => Promise<T> | T, waitMs = 5000): Promise<T> {
  const root = dataDirectory();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path.join(root, name), {
      realpath: false, stale: 60000, update: 10000,
      retries: { retries: Math.ceil(waitMs / 100), minTimeout: 100, maxTimeout: 100 },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new BusyError(`${name} is already running; retry after it completes.`);
    throw error;
  }
  try { return await task(); }
  finally { await release(); }
}

export function readState(): State {
  const filename = path.join(dataDirectory(), "tracking.json");
  if (!fs.existsSync(filename)) {
    const state = empty();
    const legacy = path.join(dataDirectory(), "monitors.json");
    if (fs.existsSync(legacy)) {
      const monitors: unknown = JSON.parse(fs.readFileSync(legacy, "utf8"));
      if (!Array.isArray(monitors) || monitors.some(m => !m || typeof m.id !== "string" || typeof m.name !== "string" || !m.params || !Array.isArray(m.seenIds))) {
        throw new Error("Invalid legacy monitors.json; restore it before continuing. No data was overwritten.");
      }
      state.monitors = monitors;
    }
    return state;
  }
  try {
    const state = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (state.version !== 1 || !Array.isArray(state.monitors) || !state.listings || typeof state.listings !== "object" || Array.isArray(state.listings)
      || !Array.isArray(state.alerts) || !Array.isArray(state.watches)) throw new Error("Invalid state structure");
    if (state.monitors.some((m: SavedMonitor) => !m || typeof m.id !== "string" || typeof m.name !== "string" || !m.params || !Array.isArray(m.seenIds))
      || Object.entries(state.listings).some(([id, record]) => !/^\d+$/.test(id) || !record || typeof record !== "object" || !Array.isArray((record as ListingRecord).history))
      || state.watches.some((w: Watch) => !w || !/^\d+$/.test(w.listingId) || typeof w.targetPrice !== "number" || typeof w.currency !== "string")
      || state.alerts.some((a: Alert) => !a || typeof a.id !== "string" || typeof a.message !== "string")) throw new Error("Invalid stored record");
    const benchmarks = benchmarkDefinitionSchema.array().max(50).parse(state.benchmarks ?? []);
    return { ...state, monitorRotation: state.monitorRotation ?? 0, benchmarks };
  } catch {
    throw new Error("Cannot read tracking.json. Restore a valid backup; existing data has not been reset.");
  }
}

export async function updateState<T>(task: (state: State) => T): Promise<T> {
  return withLock("tracking", () => {
    const state = readState();
    const result = task(state);
    // Keep bounded history; watched offers and saved benchmark references are protected from eviction.
    const protectedIds = new Set(state.watches.map(w => w.listingId));
    for (const benchmark of state.benchmarks ?? []) for (const comparable of benchmark.comparables) protectedIds.add(comparable.listingId);
    const entries = Object.entries(state.listings).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
    state.listings = Object.fromEntries(entries.filter(([id], index) => index < 10000 || protectedIds.has(id)));
    state.alerts = state.alerts.slice(-5000);
    writePrivateJson(path.join(dataDirectory(), "tracking.json"), state);
    return result;
  });
}

export function addAlert(state: State, alert: Omit<Alert, "id" | "createdAt">, now: string): void {
  if (state.alerts.some(a => a.key === alert.key)) return;
  state.alerts.push({ ...alert, id: crypto.randomUUID(), createdAt: now });
}
