import crypto from "node:crypto";
import { z } from "zod";
import type { FacebookSession, SearchParams, SearchResult, MarketplaceListingDetail } from "./types.js";
import { loadFacebookAuth, cookiesToHeader, getCookieValue } from "./auth.js";
import { MARKETPLACE_SEARCH_DOC_ID, LOCATION_SEARCH_DOC_ID, LISTING_DETAIL_DOC_ID, buildSearchVariables, buildLocationSearchVariables } from "./queries.js";
import { parseSearchResponse, parseListingDetailFromPage } from "./parser.js";
import { inspectListingPriceData } from "./price-diagnostics.js";
import { RateLimiter } from "../utils/rate-limit.js";
import { queryDocId } from "./query-config.js";
import { runGuardedRequest, SecurityStopError, assertActivityOpen } from "../activity/control.js";
import { checkResponsePage, checkResponseStatus } from "./response-guard.js";
import { cachedResponse } from "../storage/response-cache.js";
import { detailContract, listingContract } from "../tools/contracts.js";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";
const PLATFORM = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
  : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
const USER_AGENT = `Mozilla/5.0 (${PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36`;
const BROWSER_HEADERS: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "sec-fetch-user": "?1", "Upgrade-Insecure-Requests": "1" };
const pageContract = z.object({ listings: z.array(listingContract), hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const locationsContract = z.array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number() }));

export class FacebookClient {
  private session: FacebookSession | null = null;
  private initializing: Promise<FacebookSession> | null = null;
  private auth: ReturnType<typeof loadFacebookAuth> | null = null;
  private rateLimiter: RateLimiter;
  private reqCounter = 0;
  private chromeProfile: string;
  private browserHeaders = { ...BROWSER_HEADERS };
  constructor(options: { maxRequestsPerMinute?: number; automated?: boolean; chromeProfile?: string } = {}) {
    this.rateLimiter = new RateLimiter(options.maxRequestsPerMinute ?? 3, options.automated ?? false);
    this.chromeProfile = options.chromeProfile ?? "Default";
  }
  private async credentials() {
    this.auth ??= loadFacebookAuth(this.chromeProfile);
    const auth = await this.auth;
    if (!getCookieValue(auth.cookies, "c_user")) throw new Error("No c_user cookie found. Run npm run login to save a Facebook session.");
    this.browserHeaders = { ...BROWSER_HEADERS, "User-Agent": auth.userAgent ?? USER_AGENT };
    return auth;
  }
  async cacheScope(): Promise<string> {
    const { cookies } = await this.credentials();
    return crypto.createHash("sha256").update(getCookieValue(cookies, "c_user")!).digest("hex");
  }
  async ensureSession(): Promise<FacebookSession> {
    await assertActivityOpen();
    if (this.session) return this.session;
    if (!this.initializing) this.initializing = this.initSession().finally(() => { this.initializing = null; });
    return this.initializing;
  }
  async initSession(): Promise<FacebookSession> {
    const { cookies } = await this.credentials();
    const cookieHeader = cookiesToHeader(cookies);
    const tokens = await this.request(MARKETPLACE_URL, { headers: { ...this.browserHeaders, Cookie: cookieHeader, Accept: "text/html" } }, text => {
      const dtsg = text.match(/"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)
        ?? text.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)
        ?? text.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/);
      if (!dtsg) throw new SecurityStopError("Marketplace session token unavailable. All requests paused; inspect login/checkpoints or a page-format change manually.");
      return { fbDtsg: dtsg[1], lsd: (text.match(/"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)
        ?? text.match(/name="lsd"\s+value="([^"]+)"/))?.[1] ?? "", jazoest: text.match(/jazoest=(\d+)/)?.[1] ?? "",
        clientRevision: (text.match(/"client_revision"\s*:\s*(\d+)/) ?? text.match(/__spin_r:\s*(\d+)/))?.[1] ?? "1" };
    });
    this.session = { cookies, cookieHeader, userId: getCookieValue(cookies, "c_user")!, ...tokens };
    return this.session;
  }
  private async request<T>(url: string, init: RequestInit, parse: (text: string) => T): Promise<T> {
    await assertActivityOpen();
    await this.rateLimiter.wait();
    try {
      return await runGuardedRequest("authenticated", async () => {
        let response: Response;
        try { response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
        catch { throw new Error("Facebook request failed or timed out. No automatic retry; inspect activity_status before deciding whether to continue."); }
        try {
          checkResponseStatus(response);
          if (!response.ok) throw new Error(`Facebook request failed (HTTP ${response.status}). No automatic retry.`);
          const text = await response.text();
          checkResponsePage(text);
          return parse(text);
        } finally { await response.body?.cancel().catch(() => {}); }
      });
    } catch (error) {
      if (error instanceof SecurityStopError) this.clearSession();
      throw error;
    }
  }
  private async graphqlRequest(docId: string, variables: Record<string, unknown>): Promise<unknown> {
    const session = await this.ensureSession();
    const body = new URLSearchParams({ fb_dtsg: session.fbDtsg, lsd: session.lsd, jazoest: session.jazoest,
      doc_id: docId, variables: JSON.stringify(variables), __a: "1", __req: (++this.reqCounter).toString(36), __rev: session.clientRevision });
    return this.request(GRAPHQL_URL, { method: "POST", headers: { ...this.browserHeaders,
      Cookie: cookiesToHeader(session.cookies, GRAPHQL_URL), "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*",
      "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", Origin: "https://www.facebook.com",
      Referer: MARKETPLACE_URL, "X-FB-LSD": session.lsd }, body: body.toString() }, text => {
      if (/^\s*</.test(text)) throw new SecurityStopError("Facebook returned an unsupported response. All requests paused; inspect access manually.");
      const jsonStart = text.indexOf("{");
      let data: any;
      try { data = JSON.parse(jsonStart > 0 ? text.slice(jsonStart) : text); }
      catch { throw new SecurityStopError("Facebook returned an unsupported response. All requests paused; review access or query changes manually."); }
      if (!data || typeof data !== "object") throw new SecurityStopError("Facebook returned an unsupported response. All requests paused; review access manually.");
      if (data.errors?.length || data.error) throw new SecurityStopError("Facebook returned a GraphQL error. All requests paused; inspect restrictions or query changes manually.");
      return data;
    });
  }
  async searchListings(params: SearchParams, options: { cacheMaxAgeMs?: number } = {}): Promise<SearchResult> {
    const variables = buildSearchVariables(params);
    const docId = queryDocId("marketplace_search", MARKETPLACE_SEARCH_DOC_ID);
    const response = await cachedResponse([await this.cacheScope(), "search", docId, variables], pageContract,
      async () => parseSearchResponse(await this.graphqlRequest(docId, variables)), options.cacheMaxAgeMs);
    return { ...response.value, listings: response.value.listings.map(listing => ({ ...listing, retrieval: response.retrieval })), retrieval: response.retrieval };
  }
  async getListingDetail(listingId: string): Promise<MarketplaceListingDetail> {
    if (!/^\d+$/.test(listingId)) throw new Error("A numeric Marketplace listing ID is required.");
    const response = await cachedResponse([await this.cacheScope(), "listing", listingId], detailContract, async () => {
      const listing = LISTING_DETAIL_DOC_ID ? await this.graphqlRequest(LISTING_DETAIL_DOC_ID, { targetId: listingId }) as MarketplaceListingDetail
        : parseListingDetailFromPage(await this.fetchListingPage(listingId), listingId);
      if (!listing.title && !listing.price) throw new Error("Listing unavailable or page format changed; details could not be verified.");
      return listing;
    });
    return { ...response.value, retrieval: response.retrieval };
  }
  async diagnoseListingPrice(listingId: string) {
    const html = await this.fetchListingPage(listingId);
    return { listing: parseListingDetailFromPage(html, listingId), diagnostics: inspectListingPriceData(html, listingId) };
  }
  private async fetchListingPage(listingId: string): Promise<string> {
    if (!/^\d+$/.test(listingId)) throw new Error("A numeric Marketplace listing ID is required.");
    // A listing HTML GET needs cookies, not a separate GraphQL token bootstrap.
    const { cookies } = await this.credentials();
    const url = `${MARKETPLACE_URL}item/${listingId}/`;
    return this.request(url, { headers: { ...this.browserHeaders, Cookie: cookiesToHeader(cookies, url), Accept: "text/html" } }, text => text);
  }
  async searchLocation(query: string): Promise<Array<{ name: string; latitude: number; longitude: number }>> {
    const docId = queryDocId("city_street_search", LOCATION_SEARCH_DOC_ID);
    const response = await cachedResponse([await this.cacheScope(), "location", docId, query], locationsContract, async () => {
      const data = await this.graphqlRequest(docId, buildLocationSearchVariables(query));
      const results = (data as any)?.data?.city_street_search?.street_results;
      if (!results) throw new Error("Facebook returned an unrecognized location response. Inspect query configuration manually.");
      return (results.edges ?? []).map((edge: any) => ({ name: edge.node?.single_line_address ?? edge.node?.subtitle ?? "Unknown",
        latitude: edge.node?.location?.latitude ?? 0, longitude: edge.node?.location?.longitude ?? 0 }));
    });
    return response.value;
  }
  clearSession() { this.session = null; this.auth = null; this.reqCounter = 0; }
}
