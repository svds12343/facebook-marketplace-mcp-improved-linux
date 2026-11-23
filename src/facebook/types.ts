// Adapted from AKosmachyov/facebook-marketplace-mcp PR #4, commit 0e1a4697af4f8272ac3be2e32199689cecdd3562.
// See docs/FORK_REVIEW.md for sources and the changes retained in this fork.
export interface FacebookCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

export interface FacebookSession {
  cookies: FacebookCookie[];
  cookieHeader: string;
  fbDtsg: string;
  lsd: string;
  jazoest: string;
  clientRevision: string;
  userId: string;
}

export interface MarketplaceListing {
  retrieval?: { source: "live" | "cache"; observedAt: string };
  id: string;
  title: string;
  price: string;
  location: string;
  imageUrl: string;
  sellerName: string;
  postedDate: string;
  url: string;
  isPending: boolean;
  priceAmount?: number;
  currency?: string;
  sellerId?: string;
  /** Facebook's displayed crossed-out asking price, not a historical observation. */
  previousPrice?: {
    formatted: string;
    amount?: number;
    currency?: string;
    source: "facebook_strikethrough";
  } | null;
  /** Arithmetic only, when both displayed amounts have the same known currency. */
  priceReduction?: { amount: number; currency: string; percent: number } | null;
}

export interface MarketplaceListingDetail extends MarketplaceListing {
  description: string;
  images: string[];
  condition: string;
  seller: {
    name: string;
    profileUrl: string;
  };
}

export type SearchSortBy =
  | "suggested"
  | "distance"
  | "date_listed"
  | "price_low_to_high"
  | "price_high_to_low";

export type DeliveryMethod = "all" | "local_pickup" | "shipping";

export interface SearchParams {
  query: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  sortBy?: SearchSortBy;
  deliveryMethod?: DeliveryMethod;
  limit: number;
  cursor?: string;
}

export interface SearchResult {
  retrieval?: { source: "live" | "cache"; observedAt: string };
  listings: MarketplaceListing[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface SavedMonitor {
  id: string;
  name: string;
  params: Omit<SearchParams, "cursor">;
  seenIds: string[];
  createdAt: string;
  lastChecked: string | null;
  filters?: ListingFilters;
  maxPages?: number;
  inspectLimit?: number;
  targetPrice?: number;
  targetCurrency?: string;
  prices?: Record<string, { amount: number; currency: string }>;
}

export interface ListingFilters {
  exclude_keywords?: string[];
  exclude_ids?: string[];
  hide_seen?: boolean;
  max_age_days?: number;
  include_unknown_age?: boolean;
}
