import crypto from "node:crypto";
import { readState, updateState } from "./state.js";
import type { SavedMonitor, SearchParams } from "../facebook/types.js";

export function loadMonitors(): SavedMonitor[] { return readState().monitors; }
export function getMonitor(name: string) { return loadMonitors().find(m => m.name === name); }
export async function addMonitor(name: string, params: Omit<SearchParams, "cursor">,
  options: Pick<SavedMonitor, "filters" | "maxPages" | "inspectLimit" | "targetPrice" | "targetCurrency"> = {}): Promise<SavedMonitor> {
  return updateState(state => {
    if (state.monitors.length >= 50) throw new Error("At most 50 saved searches are supported. Delete an unused monitor first.");
    if (state.monitors.some(m => m.name === name)) throw new Error(`Monitor "${name}" already exists. Choose a different name.`);
    const monitor: SavedMonitor = { id: crypto.randomUUID(), name, params, seenIds: [], createdAt: new Date().toISOString(), lastChecked: null, ...options };
    state.monitors.push(monitor);
    return monitor;
  });
}
export async function deleteMonitor(name: string): Promise<boolean> {
  return updateState(state => {
    const index = state.monitors.findIndex(m => m.name === name);
    if (index < 0) return false;
    state.monitors.splice(index, 1);
    return true;
  });
}
