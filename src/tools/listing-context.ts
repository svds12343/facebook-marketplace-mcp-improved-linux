import type { MarketplaceListing } from "../facebook/types.js";

/** Metadata also belongs in text: some MCP clients do not expose structuredContent. */
export function listingContext(listing: MarketplaceListing, includeUnknown = false): string[] {
  const lines: string[] = [];
  if (listing.previousPrice) {
    lines.push(`**Previous displayed price:** ${listing.previousPrice.formatted} (Facebook crossed-out asking price)`);
    if (listing.priceReduction) lines.push(`**Displayed reduction:** ${listing.priceReduction.currency} ${listing.priceReduction.amount} (${listing.priceReduction.percent}%)`);
  } else if (includeUnknown) lines.push("**Previous displayed price:** Unavailable in the returned data; this does not establish that the price never changed.");
  if (listing.postedDate) lines.push(`**Posted:** ${listing.postedDate} (Facebook posting timestamp)`);
  else if (includeUnknown) lines.push("**Posted:** Unavailable; local first-seen time is not the posting date.");
  if (includeUnknown && listing.previousPrice) lines.push("The displayed previous price is not a verified market value or a dated price-history observation. The reduction date is unknown.");
  return lines;
}
