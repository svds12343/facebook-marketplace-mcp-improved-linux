import { z } from "zod";
import { readState, updateState } from "../storage/state.js";
import { benchmarkCriteriaSchema, calculateBenchmark, comparableBasis, type PriceBenchmark } from "../analysis/benchmarks.js";
import { getListingSchema } from "./listing.js";
import { guarded, result } from "./common.js";

export const benchmarkNameSchema = { name: z.string().trim().min(1).max(100).describe("Name of a locally saved price benchmark.") };
export const saveBenchmarkSchema = {
  ...benchmarkNameSchema,
  criteria: benchmarkCriteriaSchema,
  comparables: z.array(z.object({ listing_id: getListingSchema.listing_id,
    match_notes: z.string().trim().min(1).max(1000).describe("Evidence that this offer matches the exact model/configuration, condition, required accessories and market. Exclude uncertain matches, parts-only offers or bundles unless the entire cohort intentionally matches them.") })).min(1).max(50),
  replace: z.boolean().default(false).describe("Explicitly replace an existing named benchmark and its selection. Does not delete listing observations."),
};
const saveInput = z.object(saveBenchmarkSchema);
export const getBenchmarkSchema = { ...benchmarkNameSchema,
  candidate_listing_id: getListingSchema.listing_id.optional().describe("Always supply the offer being evaluated so it is excluded from its own comparison sample."),
  selected_listing_ids: z.array(getListingSchema.listing_id).min(1).max(50).optional()
    .describe("Explicit subset of this benchmark's saved comparable IDs to include in the calculation. Defaults to all saved IDs. The assistant decides which are relevant, recent and usable; the MCP does not remove statistical outliers or repeated sellers.") };
const getInput = z.object(getBenchmarkSchema);
const nameInput = z.object(benchmarkNameSchema);
const sameName = (a: string, b: string) => a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase();

export const savePriceBenchmark = guarded(async (raw: z.input<typeof saveInput>) => {
  const args = saveInput.parse(raw);
  return updateState(state => {
    const benchmarks = state.benchmarks ??= [];
    const previous = benchmarks.find(b => sameName(b.name, args.name));
    if (previous && !args.replace) throw new Error("A benchmark with this name exists. Use replace=true to replace its selected comparables explicitly.");
    if (!previous && benchmarks.length >= 50) throw new Error("Maximum 50 benchmarks. Delete an unused benchmark first.");
    const ids = args.comparables.map(c => c.listing_id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate listing IDs cannot count as independent comparables.");
    const now = new Date().toISOString();
    const benchmark: PriceBenchmark = { name: args.name, criteria: args.criteria,
      createdAt: previous?.createdAt ?? now, updatedAt: now,
      comparables: args.comparables.map(comparable => {
        const record = state.listings[comparable.listing_id];
        if (!record) throw new Error(`Listing ${comparable.listing_id} has no stored observation. Search or read it first; prices cannot be invented or supplied manually.`);
        return { listingId: comparable.listing_id, matchNotes: comparable.match_notes, basisHash: comparableBasis(record), addedAt: now };
      }) };
    state.benchmarks = [...benchmarks.filter(b => !sameName(b.name, args.name)), benchmark];
    return result({ benchmark, report: calculateBenchmark(state, benchmark) });
  });
});
export const getPriceBenchmark = guarded(async (raw: z.input<typeof getInput>) => {
  const args = getInput.parse(raw), state = readState();
  const benchmark = state.benchmarks?.find(b => sameName(b.name, args.name));
  if (!benchmark) throw new Error("Benchmark not found. Use list_price_benchmarks or save_price_benchmark first.");
  return result(calculateBenchmark(state, benchmark, args.candidate_listing_id, args.selected_listing_ids));
});
export const listPriceBenchmarks = guarded(async () => result({ benchmarks: (readState().benchmarks ?? []).map(b => ({
  name: b.name, criteria: b.criteria, selectedCount: b.comparables.length,
  createdAt: b.createdAt, updatedAt: b.updatedAt,
})) }));
export const deletePriceBenchmark = guarded(async (raw: z.input<typeof nameInput>) => {
  const { name } = nameInput.parse(raw);
  return updateState(state => {
    const before = state.benchmarks ?? [];
    state.benchmarks = before.filter(b => !sameName(b.name, name));
    return result({ name, deleted: state.benchmarks.length < before.length });
  });
});
