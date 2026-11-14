import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const DOWNLOAD_TIMEOUT_MS = 15_000;

class ListingImageError extends Error {}

function imageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ListingImageError("The listing contains an invalid photo URL.");
  }
  const allowedHost = ["fbcdn.net", "fbsbx.com"].some(domain =>
    url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost) {
    throw new ListingImageError("Photo downloads must use HTTPS on Facebook's image CDN.");
  }
  return url;
}

function imageMimeType(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Fetch seller photos as MCP images. Never send Facebook session cookies to a CDN. */
export async function downloadListingImage(value: string): Promise<ImageContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timeout.unref();
  try {
    let url = imageUrl(value);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetch(url.href, {
        headers: { Accept: "image/jpeg, image/png, image/webp" },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) {
          throw new ListingImageError("The photo CDN returned an invalid or excessive redirect.");
        }
        // Recheck every hop, including redirects to a different host.
        url = imageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        throw new ListingImageError(`Photo download failed (HTTP ${response.status}). Retry get_listing_images to refresh the photo URL.`);
      }

      let contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType === "image/jpg") contentType = "image/jpeg";
      if (!["image/jpeg", "image/png", "image/webp"].includes(contentType ?? "")) {
        throw new ListingImageError("The photo CDN did not return a supported JPEG, PNG, or WebP image.");
      }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        throw new ListingImageError("This photo exceeds the 2 MiB download limit.");
      }
      if (!response.body) throw new ListingImageError("The photo CDN returned an empty image.");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_IMAGE_BYTES) {
            throw new ListingImageError("This photo exceeds the 2 MiB download limit.");
          }
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const data = Buffer.concat(chunks, bytes);
      if (!data.length) throw new ListingImageError("The photo CDN returned an empty image.");
      const mimeType = imageMimeType(data);
      if (!mimeType || mimeType !== contentType) {
        throw new ListingImageError("The photo bytes do not match a supported image format.");
      }
      return { type: "image", data: data.toString("base64"), mimeType };
    }
    throw new ListingImageError("The photo CDN returned too many redirects.");
  } catch (error) {
    if (error instanceof ListingImageError) throw error;
    // Fetch errors can contain signed CDN URLs. Keep those details out of results.
    throw new ListingImageError(controller.signal.aborted
      ? "Photo download timed out. Retry this photo."
      : "Could not download this photo. Retry get_listing_images to refresh its URL.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
