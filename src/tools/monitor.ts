import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";
import { searchOptionsSchema, searchListingsSchema } from "./search.js";
import { filterSchema } from "../analysis/filters.js";
import { addMonitor, loadMonitors, deleteMonitor } from "../storage/monitors.js";
import { runChecks } from "../monitoring/runner.js";
import { result, guarded } from "./common.js";

export const currencySchema = z.string().regex(/^[A-Z]{3}$/).describe("Explicit ISO currency code, e.g. CHF; currencies are never converted automatically.");
export const monitorSearchSchema = {
  name: z.string().trim().min(1).max(100).describe("Unique name for this saved search."),
  query: searchListingsSchema.query, latitude: searchListingsSchema.latitude, longitude: searchListingsSchema.longitude,
  radius_km: searchListingsSchema.radius_km, min_price: searchListingsSchema.min_price, max_price: searchListingsSchema.max_price,
  category: searchListingsSchema.category, ...searchOptionsSchema, ...filterSchema,
  max_pages: z.number().int().min(1).max(10).default(3).describe("Maximum Facebook pages per check, subject to the shared run budget. Default 3; not an exhaustive scan."),
  inspect_limit: z.number().int().min(0).max(10).default(0).describe("Maximum listings per check for description/photo inspection, subject to request budget. Each inspects up to 3 photos. Default 0: no automatic photo downloads. Opt in explicitly to enable."),
  target_price: z.number().positive().optional().describe("Notify when an observed offer reaches this price or lower; requires target_currency. Use watch_listing for reliable rechecks of one ID outside search pages."),
  target_currency: currencySchema.optional(),
};
export const checkMonitorsSchema = {
  monitor_name: z.string().optional().describe("Check this saved search only; omit for saved searches plus individually watched listings."),
  request_budget: z.number().int().min(1).max(30).default(3).describe("Maximum search/detail calls for this manual run. Default 3; larger values can take several minutes at the shared 3 requests/minute limit."),
};
export const deleteMonitorSchema = { name: z.string().describe("Saved search name to remove. Existing alerts and price history remain.") };
export const listMonitorsSchema = {};

export function createMonitorSearchHandler() {
  return guarded(async (input: z.input<z.ZodObject<typeof monitorSearchSchema>>) => {
    const args = z.object(monitorSearchSchema).parse(input);
    if (args.min_price !== undefined && args.max_price !== undefined && args.min_price > args.max_price) throw new Error("min_price must not exceed max_price.");
    if ((args.target_price === undefined) !== (args.target_currency === undefined)) throw new Error("Supply target_price and target_currency together.");
    const monitor = await addMonitor(args.name, {
      query: args.query, latitude: args.latitude, longitude: args.longitude, radiusKm: args.radius_km,
      minPrice: args.min_price, maxPrice: args.max_price, category: args.category,
      sortBy: args.sort_by ?? "date_listed", deliveryMethod: args.delivery_method, limit: 24,
    }, { maxPages: args.max_pages, inspectLimit: args.inspect_limit, targetPrice: args.target_price, targetCurrency: args.target_currency,
      filters: { exclude_keywords: args.exclude_keywords, exclude_ids: args.exclude_ids, hide_seen: args.hide_seen,
        max_age_days: args.max_age_days, include_unknown_age: args.include_unknown_age } });
    return result({ monitor, scheduling: "Saved locally. Automatic checks require the Ubuntu timer installed with npm run monitors:install. Alerts appear in read_alerts, not as phone/ChatGPT push notifications." });
  });
}
export function createCheckMonitorsHandler(client: FacebookClient) {
  return guarded(async (input: z.input<z.ZodObject<typeof checkMonitorsSchema>>) => {
    const args = z.object(checkMonitorsSchema).parse(input);
    return result(await runChecks(client, { monitorName: args.monitor_name, includeWatches: !args.monitor_name, requestBudget: args.request_budget }));
  });
}
export function createDeleteMonitorHandler() {
  return guarded(async (args: { name: string }) => result({ deleted: await deleteMonitor(args.name), name: args.name }));
}
export function createListMonitorsHandler() {
  return guarded(async () => result({ monitors: loadMonitors().map(({ seenIds, prices, ...monitor }) => ({ ...monitor, seenCount: seenIds.length })), scheduling: "Saved search definitions do not confirm that the Ubuntu timer is active. Check systemctl --user status facebook-marketplace.timer." }));
}
