// Adapted from AKosmachyov/facebook-marketplace-mcp PR #4, commit 0e1a4697af4f8272ac3be2e32199689cecdd3562.
// See docs/FORK_REVIEW.md for sources and the changes retained in this fork.
import type {
  MarketplaceListing,
  MarketplaceListingDetail,
  SearchResult,
} from "./types.js";
import { parseMoney } from "../analysis/prices.js";

type JsonRecord = Record<string, unknown>;

function numericPrice(price: JsonRecord | undefined): { priceAmount?: number; currency?: string } {
  const amount = typeof price?.amount === "number" || typeof price?.amount === "string" && price.amount.trim() !== "" ? Number(price.amount) : NaN;
  const currency = typeof price?.currency === "string" ? price.currency.toUpperCase() : undefined;
  return Number.isFinite(amount) && amount >= 0 && currency && /^[A-Z]{3}$/.test(currency)
    ? { priceAmount: amount, currency } : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return "";
}

function formattedPrice(price: JsonRecord | undefined): string {
  return textValue(price?.formatted_amount_zeros_stripped) ||
    textValue(price?.formatted_amount) || textValue(price?.amount);
}

function postedDate(timestamp: unknown): string {
  const seconds = typeof timestamp === "number" ? timestamp
    : typeof timestamp === "string" && timestamp.trim() !== "" ? Number(timestamp) : NaN;
  const date = new Date(seconds * 1000);
  return seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function displayedPricing(listing: JsonRecord, price: JsonRecord | undefined):
  Pick<MarketplaceListing, "previousPrice" | "priceReduction"> {
  const raw = isRecord(listing.strikethrough_price) ? listing.strikethrough_price : undefined;
  const formatted = formattedPrice(raw);
  if (!raw || !formatted) return { previousPrice: null, priceReduction: null };

  const currentNumeric = numericPrice(price);
  const currentText = parseMoney(formattedPrice(price));
  const current = currentNumeric.priceAmount !== undefined && currentNumeric.currency
    ? { amount: currentNumeric.priceAmount, currency: currentNumeric.currency } : currentText;
  const rawAmount = typeof raw.amount === "number" ? raw.amount
    : typeof raw.amount === "string" && /^\d+(?:\.\d+)?$/.test(raw.amount.trim()) ? Number(raw.amount) : NaN;
  const explicitCurrency = typeof raw.currency === "string" && /^[A-Z]{3}$/i.test(raw.currency)
    ? raw.currency.toUpperCase() : undefined;
  const fromText = parseMoney(formatted);
  // Currency-free amounts inherit the listing currency. Ambiguous symbols such
  // as "$" do not silently become CHF. Explicit currencies always take priority.
  const currency = explicitCurrency ?? fromText?.currency ??
    (/^[\d\s'’.,–—-]+$/.test(formatted) && raw.currency == null ? current?.currency : undefined);
  const amount = raw.amount == null ? parseMoney(formatted, currency)?.amount
    : Number.isFinite(rawAmount) && rawAmount >= 0 && rawAmount <= 1e12 ? rawAmount : undefined;
  const inconsistent = (raw.currency != null && !explicitCurrency) ||
    (fromText && ((currency && currency !== fromText.currency) || (amount !== undefined && amount !== fromText.amount)));
  const previousPrice: NonNullable<MarketplaceListing["previousPrice"]> = {
    formatted, source: "facebook_strikethrough",
    ...(!inconsistent && amount !== undefined ? { amount } : {}),
    ...(!inconsistent && currency ? { currency } : {}),
  };
  const currentInconsistent = current && currentText &&
    (current.amount !== currentText.amount || current.currency !== currentText.currency);
  let priceReduction: MarketplaceListing["priceReduction"] = null;
  if (!currentInconsistent && current && previousPrice.amount !== undefined && previousPrice.currency === current.currency &&
    previousPrice.amount > current.amount && current.amount >= 0) {
    const difference = previousPrice.amount - current.amount;
    const amount = Math.round(difference * 100) / 100;
    if (amount > 0) priceReduction = { amount, currency: current.currency,
      percent: Math.round(difference / previousPrice.amount * 10000) / 100 };
  }
  return { previousPrice, priceReduction };
}

function findListingConnection(root: unknown): JsonRecord | null {
  const seen = new Set<object>();
  const queue: unknown[] = [root];

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if ((!isRecord(current) && !Array.isArray(current)) || seen.has(current))
      continue;
    seen.add(current);

    if (isRecord(current) && Array.isArray(current.edges)) {
      const hasListing = current.edges.some((edge) => {
        if (!isRecord(edge) || !isRecord(edge.node)) return false;
        return (
          isRecord(edge.node.listing) ||
          typeof edge.node.marketplace_listing_title === "string"
        );
      });
      if (hasListing) return current;
    }

    for (const value of Object.values(current)) queue.push(value);
  }

  return null;
}

export function parseSearchResponse(data: unknown): SearchResult {
  if (!isRecord(data) || !isRecord(data.data)) {
    throw new Error("Marketplace search response is missing data");
  }
  const search = data.data.marketplace_search;
  const feedUnits =
    (isRecord(search) ? search.feed_units : undefined) ??
    findListingConnection(data.data);

  if (!isRecord(feedUnits)) {
    throw new Error(
      "Marketplace search response is missing a listing connection",
    );
  }
  if (!Array.isArray(feedUnits.edges)) {
    throw new Error("Marketplace listing connection has invalid edges");
  }

  const parsed = feedUnits.edges
    .map(parseSearchListing)
    .filter((listing): listing is MarketplaceListing => listing !== null);
  const listings = [...new Map(parsed.map(listing => [listing.id, listing])).values()];
  const explicitNoResults = feedUnits.edges.some(edge =>
    isRecord(edge) && isRecord(edge.node) && edge.node.__typename === "EntMarketplaceSearchFeedNoResults"
  );
  if (feedUnits.edges.length > 0 && listings.length === 0 && !explicitNoResults) {
    throw new Error(
      "Marketplace listing connection contains no usable listings. Run npm run capture-queries; Facebook's response format may have changed.",
    );
  }

  const pageInfo = isRecord(feedUnits.page_info) ? feedUnits.page_info : {};
  return {
    listings,
    hasNextPage: pageInfo.has_next_page === true,
    endCursor:
      typeof pageInfo.end_cursor === "string" ? pageInfo.end_cursor : null,
  };
}

function parseSearchListing(edge: unknown): MarketplaceListing | null {
  if (!isRecord(edge) || !isRecord(edge.node)) return null;
  const listing = edge.node.listing ?? edge.node;
  if (!isRecord(listing)) return null;
  if (!isRecord(edge.node.listing) && typeof listing.marketplace_listing_title !== "string") return null;
  const id =
    typeof listing.id === "string"
      ? listing.id
      : typeof listing.id === "number" && Number.isFinite(listing.id)
        ? String(listing.id)
        : "";
  if (!/^\d+$/.test(id)) return null;

  const price = isRecord(listing.listing_price) ? listing.listing_price : {};
  const location = isRecord(listing.location) ? listing.location : {};
  const geocode = isRecord(location.reverse_geocode)
    ? location.reverse_geocode
    : {};
  const cityPage = isRecord(geocode.city_page) ? geocode.city_page : {};
  const photo = isRecord(listing.primary_listing_photo)
    ? listing.primary_listing_photo
    : {};
  const image = isRecord(photo.image) ? photo.image : {};
  const seller = isRecord(listing.marketplace_listing_seller)
    ? listing.marketplace_listing_seller
    : {};
  return {
    id,
    ...numericPrice(price),
    ...displayedPricing(listing, price),
    ...(textValue(seller.id) ? { sellerId: textValue(seller.id) } : {}),
    title: textValue(listing.marketplace_listing_title),
    price:
      textValue(price.formatted_amount_zeros_stripped) || textValue(price.formatted_amount) || textValue(price.amount) || "N/A",
    location:
      textValue(cityPage.display_name) || textValue(geocode.city) || "Unknown",
    imageUrl: textValue(image.uri),
    sellerName: textValue(seller.name) || "Unknown",
    postedDate: postedDate(listing.creation_time),
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    isPending: listing.is_pending === true,
  };
}

function isListingNode(value: JsonRecord): boolean {
  return (
    typeof value.marketplace_listing_title === "string" ||
    isRecord(value.listing_price) ||
    isRecord(value.strikethrough_price) ||
    Object.hasOwn(value, "creation_time") ||
    isRecord(value.redacted_description) ||
    isRecord(value.marketplace_listing_seller) ||
    Array.isArray(value.listing_photos)
  );
}

function mergeMissing(target: JsonRecord, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (value === undefined || value === null) continue;
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    } else if (
      existing === undefined ||
      existing === null ||
      existing === "" ||
      (Array.isArray(existing) && existing.length === 0)
    ) {
      target[key] = value;
    }
  }
}

function findListingNodeInPage(
  html: string,
  listingId: string,
): JsonRecord | null {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/json["'][^>]*>(.*?)<\/script>/gis,
  );
  const candidates: JsonRecord[] = [];
  const listingIds = new Set([listingId]);

  for (const block of blocks) {
    let payload: unknown;
    try {
      payload = JSON.parse(block[1]);
    } catch {
      continue;
    }

    const seen = new Set<object>();
    const queue: unknown[] = [payload];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if ((!isRecord(current) && !Array.isArray(current)) || seen.has(current))
        continue;
      seen.add(current);

      if (isRecord(current) && isListingNode(current)) {
        candidates.push(current);
        // The public URL can use product_item.id while Relay fragments share
        // a different listing ID. Resolve that link before merging fragments.
        if (
          isRecord(current.product_item) &&
          textValue(current.product_item.id) === listingId &&
          textValue(current.id)
        ) {
          listingIds.add(textValue(current.id));
        }
      }
      queue.push(...Object.values(current));
    }
  }

  const merged: JsonRecord = {};
  let matched = false;
  for (const candidate of candidates) {
    if (listingIds.has(textValue(candidate.id))) {
      mergeMissing(merged, candidate);
      matched = true;
    }
  }
  return matched ? merged : null;
}

export function parseListingDetailFromPage(
  html: string,
  listingId: string,
): MarketplaceListingDetail {
  // Facebook embeds listing data as JSON in script tags.
  // Look for structured data or relay-style data payloads.

  const detail: MarketplaceListingDetail = {
    id: listingId,
    title: "",
    description: "",
    price: "",
    location: "",
    imageUrl: "",
    images: [],
    sellerName: "",
    postedDate: "",
    url: `https://www.facebook.com/marketplace/item/${listingId}/`,
    isPending: false,
    condition: "",
    previousPrice: null,
    priceReduction: null,
    seller: { name: "", profileUrl: "" },
  };

  // Pages contain related listings too; only use Relay nodes that match the
  // requested ID, then merge the partial nodes Facebook emits for that item.
  const listing = findListingNodeInPage(html, listingId);
  if (listing) {
    detail.title = textValue(listing.marketplace_listing_title);
    const price = isRecord(listing.listing_price)
      ? listing.listing_price
      : undefined;
    detail.price =
      textValue(price?.formatted_amount_zeros_stripped) ||
      textValue(price?.formatted_amount) ||
      textValue(price?.amount);
    Object.assign(detail, numericPrice(price));
    Object.assign(detail, displayedPricing(listing, price));
    const location = isRecord(listing.location) ? listing.location : undefined;
    const reverseGeocode = isRecord(location?.reverse_geocode)
      ? location.reverse_geocode
      : undefined;
    const cityPage = isRecord(reverseGeocode?.city_page)
      ? reverseGeocode.city_page
      : undefined;
    detail.location =
      textValue(
        isRecord(listing.location_text)
          ? listing.location_text.text
          : undefined,
      ) ||
      textValue(cityPage?.display_name) ||
      textValue(reverseGeocode?.city);
    detail.description = textValue(
      isRecord(listing.redacted_description)
        ? listing.redacted_description.text
        : isRecord(listing.description)
          ? listing.description.text
          : undefined,
    );
    const seller = isRecord(listing.marketplace_listing_seller)
      ? listing.marketplace_listing_seller
      : undefined;
    detail.sellerName = textValue(seller?.name);
    detail.seller.name = detail.sellerName;
    const sellerId = textValue(seller?.id);
    if (sellerId) detail.sellerId = sellerId;
    if (sellerId)
      detail.seller.profileUrl = `https://www.facebook.com/${sellerId}`;
    detail.condition =
      textValue(listing.condition) || textValue(listing.condition_text);
    if (!detail.condition && Array.isArray(listing.attribute_data)) {
      const condition = listing.attribute_data.find(
        (attribute) =>
          isRecord(attribute) && attribute.attribute_name === "Condition",
      );
      if (isRecord(condition)) detail.condition = textValue(condition.label);
    }
    detail.isPending = listing.is_pending === true;
    detail.postedDate = postedDate(listing.creation_time);
    const primaryPhoto = isRecord(listing.primary_listing_photo)
      ? listing.primary_listing_photo
      : undefined;
    const primaryImage = isRecord(primaryPhoto?.image)
      ? primaryPhoto.image
      : undefined;
    const primaryUri = textValue(primaryImage?.uri);
    if (primaryUri) {
      detail.imageUrl = primaryUri;
      detail.images.push(primaryUri);
    }
    if (Array.isArray(listing.listing_photos)) {
      for (const photo of listing.listing_photos) {
        const image =
          isRecord(photo) && isRecord(photo.image) ? photo.image : undefined;
        const uri = textValue(image?.uri);
        if (uri && !detail.images.includes(uri)) detail.images.push(uri);
      }
    }
    if (!detail.imageUrl) detail.imageUrl = detail.images[0] ?? "";
  }

  // Open Graph metadata belongs to the current page and is a safe fallback for
  // title, description, and hero-image fields when Relay markup changes.
  const titleMatch = html.match(
    /<meta\s+property="og:title"\s+content="([^"]*)"/,
  );
  if (!detail.title && titleMatch)
    detail.title = decodeHtmlEntities(titleMatch[1]);

  const descMatch = html.match(
    /<meta\s+property="og:description"\s+content="([^"]*)"/,
  );
  if (!detail.description && descMatch)
    detail.description = decodeHtmlEntities(descMatch[1]);

  const imageMatch = html.match(
    /<meta\s+property="og:image"\s+content="([^"]*)"/,
  );
  if (!detail.imageUrl && imageMatch) {
    detail.imageUrl = decodeHtmlEntities(imageMatch[1]);
    detail.images.push(detail.imageUrl);
  }

  return detail;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}
