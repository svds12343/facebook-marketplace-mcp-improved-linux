import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";
import { readState, updateState } from "../storage/state.js";
import { observeListing } from "../analysis/prices.js";
import { assessEvidence, inspectPhotos } from "../analysis/photos.js";
import { recordPriceAlerts } from "../monitoring/runner.js";
import { getListingSchema } from "./listing.js";
import { currencySchema } from "./monitor.js";
import { guarded, result } from "./common.js";

export const watchSchema = { ...getListingSchema,
  target_price: z.number().positive().describe("Alert when the listing reaches this price or lower; 0/1 placeholder prices are excluded."),
  currency: currencySchema,
};
export const alertSchema = {
  unread_only: z.boolean().default(true).describe("Only unread alerts by default. Reading does not acknowledge them."),
  limit: z.number().int().min(1).max(100).default(50),
  after_id: z.string().optional().describe("Continue after this returned alert ID; keep unread_only unchanged. Acknowledge after paging."),
};
export const acknowledgeSchema = { alert_ids: z.array(z.string().uuid()).min(1).max(100).describe("Explicit alert IDs to mark read. No deletion.") };
export const assessSchema = { ...getListingSchema,
  compare_listing_ids: z.array(getListingSchema.listing_id).max(3).optional().describe("Optionally fetch up to 3 suspected duplicate listings to compare with this offer, in addition to the local photo catalogue."),
  reference_price: z.number().positive().optional().describe("Optional user-supplied expected price, not a market valuation. Requires reference_currency."),
  reference_currency: currencySchema.optional(),
};

export const readAlerts = guarded(async (input: z.input<z.ZodObject<typeof alertSchema>>) => {
  const args = z.object(alertSchema).parse(input);
  const state = readState();
  const all = state.alerts.filter(a => !args.unread_only || !a.readAt);
  const cursor = args.after_id ? all.findIndex(a => a.id === args.after_id) : -1;
  if (args.after_id && cursor < 0) throw new Error("Alert cursor is no longer in this result set. Restart without after_id; acknowledge only after paging.");
  const alerts = all.slice(cursor + 1, cursor + 1 + args.limit);
  const hasMore = cursor + 1 + alerts.length < all.length;
  return result({ alerts, hasMore, nextCursor: hasMore ? alerts.at(-1)!.id : null, totalUnread: state.alerts.filter(a => !a.readAt).length });
});
export const acknowledgeAlerts = guarded(async (args: z.infer<z.ZodObject<typeof acknowledgeSchema>>) => {
  const ids = new Set(args.alert_ids);
  return result(await updateState(state => {
    let acknowledged = 0;
    for (const alert of state.alerts) if (ids.has(alert.id) && !alert.readAt) { alert.readAt = new Date().toISOString(); acknowledged++; }
    return { acknowledged };
  }));
});
export const getPriceHistory = guarded(async (args: { listing_id: string }) => {
  const record = readState().listings[args.listing_id];
  return result({ listingId: args.listing_id, history: record?.history ?? [], firstSeen: record?.firstSeen ?? null, lastSeen: record?.lastSeen ?? null,
    note: "Only this server's observations; no historical Facebook data is backfilled. Up to 365 price changes are retained; posting age is separate." });
});
export const listWatches = guarded(async () => result({ watches: readState().watches }));
export const unwatchListing = guarded(async (args: { listing_id: string }) => result(await updateState(state => {
  const count = state.watches.length;
  state.watches = state.watches.filter(w => w.listingId !== args.listing_id);
  return { removed: state.watches.length < count, listingId: args.listing_id };
})));

export function createWatchHandler(client: FacebookClient) {
  return guarded(async (args: z.infer<z.ZodObject<typeof watchSchema>>) => {
    const listing = await client.getListingDetail(args.listing_id);
    if (!listing.title && !listing.price) throw new Error("Cannot verify this listing; watch was not saved.");
    const now = new Date().toISOString();
    return result(await updateState(state => {
      if (state.watches.length >= 100 && !state.watches.some(w => w.listingId === args.listing_id)) throw new Error("Maximum 100 watched listings; remove an unused watch first.");
      observeListing(state, listing, now, listing.description, true);
      const existing = state.watches.find(w => w.listingId === args.listing_id);
      const previous = existing?.targetPrice === args.target_price && existing.currency === args.currency ? existing.lastPrice : undefined;
      const watch = { listingId: args.listing_id, targetPrice: args.target_price, currency: args.currency, createdAt: now, lastChecked: now,
        lastPrice: recordPriceAlerts(state, `watch:${args.listing_id}`, listing, previous, { amount: args.target_price, currency: args.currency }, now) };
      state.watches = [...state.watches.filter(w => w.listingId !== args.listing_id), watch];
      return { watch, note: "Saved or replaced watch. Timer checks up to 5 watches per run, oldest checked first. Alerts are stored in the MCP inbox." };
    }));
  });
}
export function createAssessmentHandler(client: FacebookClient) {
  return guarded(async (args: z.infer<z.ZodObject<typeof assessSchema>>) => {
    if ((args.reference_price === undefined) !== (args.reference_currency === undefined)) throw new Error("Supply reference_price and reference_currency together.");
    const failures: Array<{ listingId: string; error: string }> = [];
    for (const id of new Set(args.compare_listing_ids ?? [])) {
      if (id === args.listing_id) continue;
      try {
        const other = await client.getListingDetail(id);
        const inspection = await inspectPhotos(other);
        await updateState(state => {
          const record = observeListing(state, other, new Date().toISOString(), other.description);
          record.photos = inspection.photos; record.photosCheckedAt = new Date().toISOString();
        });
        for (const failure of inspection.failures) failures.push({ listingId: id, error: `Photo ${failure.photo}: ${failure.error}` });
      } catch { failures.push({ listingId: id, error: "Comparison listing could not be inspected." }); }
    }
    const listing = await client.getListingDetail(args.listing_id);
    if (!listing.title && !listing.price) throw new Error("Listing unavailable; risk assessment could not be completed.");
    const inspection = await inspectPhotos(listing);
    const reference = args.reference_price !== undefined ? { amount: args.reference_price, currency: args.reference_currency! } : undefined;
    return result(await updateState(state => {
      const record = observeListing(state, listing, new Date().toISOString(), listing.description, true);
      record.photos = inspection.photos; record.photosCheckedAt = new Date().toISOString();
      return { listingId: listing.id, ...assessEvidence(listing, inspection.photos, state, reference),
        photosChecked: inspection.photos.length, totalPhotos: inspection.totalPhotos, photoFailures: inspection.failures, comparisonFailures: failures };
    }));
  });
}
