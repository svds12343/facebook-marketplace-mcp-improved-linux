import { z } from "zod";
import type { ListingFilters, MarketplaceListing } from "../facebook/types.js";
import type { State } from "../storage/state.js";

export const filterSchema = {
  exclude_keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe("Exclude literal words/phrases, ignoring accents/case, e.g. broken, pour pièces. Checks titles and cached descriptions only; unfetched descriptions are not checked."),
  exclude_ids: z.array(z.string().regex(/^\d+$/)).max(2000).optional().describe("Listing IDs to omit, for example IDs already returned on earlier pages."),
  hide_seen: z.boolean().optional().describe("Hide IDs previously returned by search/get_listing or saved monitor checks on this server. Returned search results are marked seen."),
  max_age_days: z.number().positive().max(3650).optional().describe("Maximum age from Facebook's posting timestamp, never from when this server first saw it."),
  include_unknown_age: z.boolean().optional().describe("When max_age_days is set, include listings without a usable posting date. Default false; omitted items are counted."),
};
const normalized = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function filterListings(listings: MarketplaceListing[], filters: ListingFilters, state: State, now = Date.now()) {
  const excluded = { keyword: 0, id: 0, seen: 0, age: 0, unknown_age: 0 };
  let descriptionsChecked = 0;
  const ids = new Set(filters.exclude_ids ?? []);
  const words = (filters.exclude_keywords ?? []).map(normalized).filter(Boolean);
  const kept = listings.filter(listing => {
    const cached = state.listings[listing.id];
    if (cached?.description !== undefined) descriptionsChecked++;
    const haystack = ` ${normalized(`${listing.title} ${cached?.description ?? ""}`)} `;
    if (words.some(word => haystack.includes(` ${word} `))) { excluded.keyword++; return false; }
    if (ids.has(listing.id)) { excluded.id++; return false; }
    if (filters.hide_seen && cached?.seenAt) { excluded.seen++; return false; }
    if (filters.max_age_days !== undefined) {
      const timestamp = Date.parse(listing.postedDate);
      if (!Number.isFinite(timestamp) || timestamp > now + 300000) {
        if (!filters.include_unknown_age) { excluded.unknown_age++; return false; }
      } else if (now - timestamp > filters.max_age_days * 86400000) { excluded.age++; return false; }
    }
    return true;
  });
  return { listings: kept, excluded, keywordCoverage: { titles: listings.length, cachedDescriptions: descriptionsChecked } };
}
