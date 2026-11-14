import { z } from "zod";
export const listingContract = z.object({
  id: z.string(), title: z.string(), price: z.string(), location: z.string(), imageUrl: z.string(),
  sellerName: z.string(), postedDate: z.string(), url: z.string(), isPending: z.boolean(),
  priceAmount: z.number().optional(), currency: z.string().optional(), sellerId: z.string().optional(),
});
export const detailContract = listingContract.extend({ description: z.string(), images: z.array(z.string()), condition: z.string(),
  seller: z.object({ name: z.string(), profileUrl: z.string() }) });
export const signalContract = z.object({ code: z.string(), evidence: z.string() });
export const priceContract = z.object({ amount: z.number(), currency: z.string() });
export const monitorContract = z.object({ id: z.string(), name: z.string(),
  params: z.object({ query: z.string(), latitude: z.number(), longitude: z.number(), radiusKm: z.number(), limit: z.number() }).passthrough(),
  seenIds: z.array(z.string()), createdAt: z.string(), lastChecked: z.string().nullable(),
  maxPages: z.number().optional(), inspectLimit: z.number().optional(), targetPrice: z.number().optional(), targetCurrency: z.string().optional(),
}).passthrough();
export const watchContract = z.object({ listingId: z.string(), targetPrice: z.number(), currency: z.string(), createdAt: z.string(),
  lastChecked: z.string().optional(), lastPrice: priceContract.optional() });
export const alertContract = z.object({ id: z.string(), key: z.string(), createdAt: z.string(),
  kind: z.enum(["new_listing", "price_drop", "target_reached", "review", "check_error"]), source: z.string(),
  listingId: z.string().optional(), url: z.string().optional(), message: z.string(), readAt: z.string().optional() });
export const checkContract = {
  monitors: z.array(z.object({ name: z.string(), pages: z.number(), returned: z.number(), newListings: z.number(), inspected: z.number(),
    coverage: z.enum(["complete", "page_limit", "budget_limit", "stalled", "error"]), errors: z.array(z.string()), excluded: z.record(z.string(), z.number()).optional() })),
  watched: z.array(z.object({ listingId: z.string(), ok: z.boolean(), error: z.string().optional() })),
  requestsUsed: z.number(), monitorsDeferred: z.number(), watchesDeferred: z.number(), unreadAlerts: z.number(), note: z.string(),
};
