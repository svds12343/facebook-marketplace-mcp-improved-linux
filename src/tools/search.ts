import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";
import type { SearchSortBy, DeliveryMethod } from "../facebook/types.js";

export const searchOptionsSchema = {
  sort_by: z.enum(["suggested", "distance", "date_listed", "price_low_to_high", "price_high_to_low"]).optional()
    .describe("Facebook sort order (default: suggested)"),
  delivery_method: z.enum(["all", "local_pickup", "shipping"]).optional()
    .describe("Include local pickup, shipping, or both (default: all)"),
};

export const searchListingsSchema = {
  query: z.string().trim().min(1).max(500).describe("Search query (e.g. 'macbook pro', 'couch')"),
  latitude: z.number().min(-90).max(90).describe("Latitude of search center"),
  longitude: z.number().min(-180).max(180).describe("Longitude of search center"),
  radius_km: z
    .number()
    .positive()
    .default(50)
    .describe("Search radius in kilometers (default: 50)"),
  min_price: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum price in the Marketplace location's currency, e.g. CHF in Switzerland"),
  max_price: z
    .number()
    .nonnegative()
    .optional()
    .describe("Maximum price in the Marketplace location's currency, e.g. CHF in Switzerland"),
  category: z
    .string()
    .optional()
    .describe("Category ID to filter by"),
  limit: z
    .number()
    .int().min(1).max(100)
    .default(20)
    .describe("Requested page size, 1-100 (default: 20); Facebook may return a different count"),
  cursor: z.string().min(1).max(10000).optional().describe("endCursor from the previous page; retain the same query and filters"),
  ...searchOptionsSchema,
};

export function createSearchHandler(client: FacebookClient) {
  return async (args: {
    query: string;
    latitude: number;
    longitude: number;
    radius_km: number;
    min_price?: number;
    max_price?: number;
    category?: string;
    limit: number;
    cursor?: string;
    sort_by?: SearchSortBy;
    delivery_method?: DeliveryMethod;
  }) => {
    try {
      if (args.min_price !== undefined && args.max_price !== undefined && args.min_price > args.max_price) {
        throw new Error("min_price must not exceed max_price.");
      }
      const result = await client.searchListings({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        radiusKm: args.radius_km,
        minPrice: args.min_price,
        maxPrice: args.max_price,
        category: args.category,
        limit: args.limit,
        cursor: args.cursor,
        sortBy: args.sort_by,
        deliveryMethod: args.delivery_method,
      });

      const paginationStatus = !result.hasNextPage ? "end"
        : !result.endCursor || result.endCursor === args.cursor ? "stalled" : "more_results";
      const structuredContent = { ...result, paginationStatus, effectiveRadiusKm: Math.ceil(args.radius_km) };
      const continuation = paginationStatus === "more_results"
        ? `\n\nMore results available. Next cursor: ${result.endCursor}`
        : paginationStatus === "stalled" ? "\n\nPagination stalled: stop here; Facebook did not supply a new cursor." : "";

      if (result.listings.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No listings returned on this page for "${args.query}".${continuation}`,
            },
          ],
          structuredContent,
        };
      }

      const summary = result.listings
        .map(
          (l, i) =>
            `${i + 1}. **${l.title}** — ${l.price}\n   📍 ${l.location} | 👤 ${l.sellerName}${l.isPending ? " ⏳ PENDING" : ""}\n   🔗 ${l.url}`
        )
        .join("\n\n");

      const text = `Found ${result.listings.length} listings for "${args.query}":\n\n${summary}${continuation}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching listings: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}
