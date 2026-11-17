import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";
import { updateState } from "../storage/state.js";
import { observeListing, priceSignals } from "../analysis/prices.js";
import { listingContext } from "./listing-context.js";

export const getListingSchema = {
  listing_id: z.string().regex(/^\d+$/).describe("Numeric Facebook Marketplace listing ID"),
};

export function createListingHandler(client: FacebookClient) {
  return async (args: { listing_id: string }) => {
    try {
      const listing = await client.getListingDetail(args.listing_id);
      if (!listing.title && !listing.price) throw new Error("Listing unavailable or page format changed; details could not be verified.");
      await updateState(state => observeListing(state, listing, new Date().toISOString(), listing.description, true));
      const priceReview = priceSignals(listing, listing.description);

      const parts = [
        `# ${listing.title}`,
        "",
        `**Price:** ${listing.price}`,
        ...listingContext(listing, true),
        listing.condition ? `**Condition:** ${listing.condition}` : null,
        `**Location:** ${listing.location}`,
        listing.isPending ? "**Status:** ⏳ Pending" : null,
        "",
        listing.description
          ? `## Description\n${listing.description}`
          : null,
        "",
        `**Seller:** ${listing.seller.name}`,
        listing.seller.profileUrl
          ? `**Profile:** ${listing.seller.profileUrl}`
          : null,
        "",
        listing.images.length > 0
          ? `**Images:** ${listing.images.length} photo(s)\n${listing.images.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`
          : null,
        listing.images.length > 0
          ? "Use get_listing_images with this listing_id and photo_indices to inspect the actual photos. URLs alone are not image observations."
          : null,
        "",
        `🔗 ${listing.url}`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: parts }],
        structuredContent: { listing, priceReview },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching listing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}
