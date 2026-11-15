import crypto from "node:crypto";
import { z } from "zod";
import type { ListingRecord, State } from "../storage/state.js";
import type { MarketplaceListingDetail } from "../facebook/types.js";
import { listingMoney } from "./prices.js";

const label = z.string().trim().min(1).max(200);
export const benchmarkCriteriaSchema = z.object({
  product: label.describe("Exact brand/model, not a broad category."),
  variant: label.describe("Configuration such as storage, generation and size. Use standard only when there is no relevant variant; do not pool unknown variants."),
  condition: label.describe("Comparable cosmetic and functional condition. Do not mix working, untested and parts-only offers."),
  accessories: z.array(label).max(30).describe("Included accessories required in every selected comparable; [] means none are required."),
  market_area: label.describe("Geographic market represented by these offers, e.g. Vaud, Switzerland. This label is supplied by the assistant, not independently geocoded."),
  currency: z.string().regex(/^[A-Z]{3}$/).describe("One ISO currency, e.g. CHF. A mismatch blocks the calculation until the assistant revises its selection; no conversion or automatic removal."),
});
export const benchmarkDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(100), criteria: benchmarkCriteriaSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  comparables: z.array(z.object({ listingId: z.string().regex(/^\d+$/), matchNotes: z.string().trim().min(1).max(1000),
    basisHash: z.string().regex(/^[a-f0-9]{64}$/), addedAt: z.string().datetime() })).min(1).max(50),
});
export type PriceBenchmark = z.infer<typeof benchmarkDefinitionSchema>;

/** Detect product/description changes for the assistant; price changes do not change this fingerprint. */
export function comparableBasis(record: ListingRecord): string {
  const details = record.listing as Partial<MarketplaceListingDetail>;
  return crypto.createHash("sha256").update(JSON.stringify({ title: record.listing.title,
    description: record.description ?? "", condition: details.condition ?? "" })).digest("hex");
}

const sampleSchema = z.object({ listingId: z.string(), title: z.string(), url: z.string(), askingPrice: z.string(),
  amount: z.number().nullable(), currency: z.string().nullable(), location: z.string(), observedAt: z.string(),
  observationAgeDays: z.number().nullable(), matchNotes: z.string(), detailsChangedSinceSelection: z.boolean(),
  sellerId: z.string().nullable(), isPending: z.boolean(), cachedDescription: z.string().nullable() });
export const benchmarkReportSchema = z.object({
  name: z.string(), criteria: benchmarkCriteriaSchema, calculatedAt: z.string(),
  calculationStatus: z.enum(["complete", "unavailable_prices", "empty_selection"]), source: z.literal("observed_asking_prices"),
  count: z.number(), selectedListingIds: z.array(z.string()), candidateExcluded: z.string().nullable(),
  statistics: z.object({ mean: z.number(), median: z.number(), min: z.number(), max: z.number(), p25: z.number(), p75: z.number() }).nullable(),
  samples: z.array(sampleSchema), omittedByRequest: z.array(z.string()),
  priceIssues: z.array(z.object({ listingId: z.string(), reason: z.string() })),
  repeatedKnownSellers: z.array(z.object({ sellerId: z.string(), listingIds: z.array(z.string()) })), notes: z.string(),
});

function quantile(sorted: number[], fraction: number) {
  const position = (sorted.length - 1) * fraction, lower = Math.floor(position), weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(position)] * weight;
}
const round = (value: number) => Math.round(value * 100) / 100;

export function calculateBenchmark(state: State, benchmark: PriceBenchmark, candidateId?: string, selectedIds?: string[], now = Date.now()) {
  const priceIssues: Array<{ listingId: string; reason: string }> = [];
  const samples: Array<z.infer<typeof sampleSchema>> = [];
  const selected = new Set(selectedIds ?? benchmark.comparables.map(c => c.listingId));
  for (const id of selected) if (!benchmark.comparables.some(c => c.listingId === id)) throw new Error(`Listing ${id} is not in this benchmark. Save a revised selection first.`);
  const selectedListingIds: string[] = [], omittedByRequest: string[] = [];
  for (const comparable of benchmark.comparables) {
    const id = comparable.listingId, record = state.listings[id];
    if (!selected.has(id) || id === candidateId) { omittedByRequest.push(id); continue; }
    selectedListingIds.push(id);
    if (!record) { priceIssues.push({ listingId: id, reason: "observation_missing" }); continue; }
    const money = record && listingMoney(record.listing);
    if (!money || money.amount > 1e12) priceIssues.push({ listingId: id, reason: "unusable_price" });
    else if (money.currency !== benchmark.criteria.currency) priceIssues.push({ listingId: id, reason: "currency_mismatch" });
    const observed = Date.parse(record.lastSeen);
    samples.push({ listingId: id, title: record.listing.title, url: record.listing.url, askingPrice: record.listing.price,
      amount: money?.amount ?? null, currency: money?.currency ?? null, location: record.listing.location,
      observedAt: record.lastSeen, observationAgeDays: Number.isFinite(observed) ? round((now - observed) / 86400000) : null,
      matchNotes: comparable.matchNotes, detailsChangedSinceSelection: comparableBasis(record) !== comparable.basisHash,
      sellerId: record.listing.sellerId ?? null, isPending: record.listing.isPending, cachedDescription: record.description ?? null });
  }
  const sellers = new Map<string, string[]>();
  for (const sample of samples) if (sample.sellerId) sellers.set(sample.sellerId, [...(sellers.get(sample.sellerId) ?? []), sample.listingId]);
  const repeatedKnownSellers = [...sellers].filter(([, ids]) => ids.length > 1).map(([sellerId, listingIds]) => ({ sellerId, listingIds }));
  // No statistical sample is silently narrowed. The assistant must explicitly revise an unusable selection.
  const values = priceIssues.length ? [] : samples.map(s => s.amount!).sort((a, b) => a - b);
  const stats = values.length ? { mean: round(values.reduce((sum, value) => sum + value / values.length, 0)),
    median: round(quantile(values, .5)), min: values[0], max: values.at(-1)!, p25: round(quantile(values, .25)), p75: round(quantile(values, .75)) } : null;
  return { name: benchmark.name, criteria: benchmark.criteria, calculatedAt: new Date(now).toISOString(),
    calculationStatus: !selectedListingIds.length ? "empty_selection" as const : priceIssues.length ? "unavailable_prices" as const : "complete" as const,
    source: "observed_asking_prices" as const, count: selectedListingIds.length, selectedListingIds, candidateExcluded: candidateId ?? null,
    statistics: stats, samples, omittedByRequest, priceIssues, repeatedKnownSellers,
    notes: "Statistics cover exactly the assistant's selected observed asking prices, not sold prices or resale value. No automatic exclusions for age, low/high price, pending status, changed details or repeated sellers; the assistant must judge these facts and refine selected_listing_ids. Missing/unparseable prices or a currency mismatch make statistics unavailable for the entire selection; nothing is silently removed or converted. Matching notes and geographic criteria are assistant-supplied, not verified by the server. No deal score, confidence verdict or resale recommendation is generated. No Facebook requests were made." };
}
