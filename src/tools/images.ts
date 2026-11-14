import { z } from "zod";
import type { CallToolResult, ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { FacebookClient } from "../facebook/client.js";
import { downloadListingImage } from "../facebook/images.js";
import { getListingSchema } from "./listing.js";

export const getListingImagesSchema = {
  listing_id: getListingSchema.listing_id,
  photo_indices: z.array(z.number().int().positive()).min(1).max(3).optional()
    .describe("Up to 3 photo numbers from get_listing, starting at 1. Defaults to the first 3 photos. Request later numbers to inspect more photos."),
};

const inputSchema = z.object(getListingImagesSchema);

export function createListingImagesHandler(client: Pick<FacebookClient, "getListingDetail">) {
  return async (args: z.input<typeof inputSchema>): Promise<CallToolResult> => {
    try {
      const { listing_id, photo_indices } = inputSchema.parse(args);
      const listing = await client.getListingDetail(listing_id);
      const photos = listing.images;
      if (!photos.length) {
        return {
          isError: true,
          content: [{ type: "text", text: "No listing photos were found. The listing may be unavailable or Facebook's page format may have changed. No images were inspected." }],
          structuredContent: { listing_id, total_photos: 0, returned_photo_indices: [] },
        };
      }
      const indices = [...new Set(photo_indices ?? photos.slice(0, 3).map((_, index) => index + 1))];
      const results = await Promise.allSettled(indices.map(async index => {
        if (index > photos.length) throw new Error(`Photo ${index} does not exist; this listing has ${photos.length} photo(s).`);
        return downloadListingImage(photos[index - 1]);
      }));

      const content: Array<TextContent | ImageContent> = [{
        type: "text",
        text: `Listing ${listing_id}: ${listing.title || "Untitled listing"}\n${listing.url}\n${photos.length} photo(s) available. Each photo label below identifies the image that follows it.`,
      }];
      const returned: number[] = [];
      const failures: Array<{ photo_index: number; error: string }> = [];
      for (const [offset, result] of results.entries()) {
        const index = indices[offset];
        if (result.status === "fulfilled") {
          returned.push(index);
          content.push({ type: "text", text: `Photo ${index} of ${photos.length}, listing ${listing_id}:` }, result.value);
        } else {
          const error = result.reason instanceof Error ? result.reason.message : "Photo download failed.";
          failures.push({ photo_index: index, error });
          content.push({ type: "text", text: `Photo ${index} unavailable: ${error}` });
        }
      }
      content.push({ type: "text", text: `Returned photo numbers: ${returned.join(", ") || "none"}. Only describe images actually returned. Request other photo_indices in batches of up to 3 if needed.` });
      return {
        content,
        isError: returned.length === 0,
        structuredContent: {
          listing_id, title: listing.title, total_photos: photos.length,
          returned_photo_indices: returned, failed_photos: failures,
        },
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error fetching listing images: ${error instanceof Error ? error.message : "Photo retrieval failed."}` }],
      };
    }
  };
}
