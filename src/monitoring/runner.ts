import crypto from "node:crypto";
import type { FacebookClient } from "../facebook/client.js";
import type { MarketplaceListing, MarketplaceListingDetail, SavedMonitor } from "../facebook/types.js";
import { readState, updateState, withLock, addAlert, type State, type PhotoFingerprint } from "../storage/state.js";
import { filterListings } from "../analysis/filters.js";
import { listingMoney, observeListing, priceSignals, type Money } from "../analysis/prices.js";
import { inspectPhotos, assessEvidence } from "../analysis/photos.js";

type Client = Pick<FacebookClient, "searchListings" | "getListingDetail">;
interface Coverage {
  name: string; pages: number; returned: number; newListings: number; inspected: number;
  coverage: "complete" | "page_limit" | "budget_limit" | "stalled" | "error";
  errors: string[]; excluded?: Record<string, number>;
}
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

export function recordPriceAlerts(state: State, source: string, listing: MarketplaceListing, previous: Money | undefined,
  target: Money | undefined, now: string): Money | undefined {
  const price = listingMoney(listing);
  if (!price || price.amount <= 1) return previous; // Placeholder prices must not trigger bargain alerts.
  const key = `${source}:${listing.id}:${now}:${price.currency}:${price.amount}`;
  if (previous?.currency === price.currency && price.amount < previous.amount) addAlert(state, {
    key: `${key}:drop`, kind: "price_drop", source, listingId: listing.id, url: listing.url,
    message: `${listing.title}: ${price.currency} ${previous.amount} → ${price.amount}.`,
  }, now);
  if (target && price.currency === target.currency && price.amount <= target.amount
    && (!previous || previous.currency !== price.currency || previous.amount > target.amount)) addAlert(state, {
    key: `${key}:target`, kind: "target_reached", source, listingId: listing.id, url: listing.url,
    message: `${listing.title}: ${price.currency} ${price.amount}, at or below your target ${target.currency} ${target.amount}.`,
  }, now);
  return price;
}

async function checkSearch(client: Client, monitor: SavedMonitor, budget: { remaining: number }): Promise<Coverage> {
  const report: Coverage = { name: monitor.name, pages: 0, returned: 0, newListings: 0, inspected: 0, coverage: "complete", errors: [] };
  const collected = new Map<string, MarketplaceListing>();
  const details = new Map<string, { listing: MarketplaceListingDetail; photos: PhotoFingerprint[]; errors: string[] }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const maxPages = Math.min(10, Math.max(1, monitor.maxPages ?? 3));
  try {
    for (let page = 0; page < maxPages; page++) {
      if (budget.remaining <= 0) { report.coverage = "budget_limit"; break; }
      budget.remaining--;
      const result = await client.searchListings({ ...monitor.params, cursor });
      report.pages++;
      for (const listing of result.listings) collected.set(listing.id, listing);
      if (!result.hasNextPage) break;
      if (!result.endCursor || cursors.has(result.endCursor)) { report.coverage = "stalled"; break; }
      cursors.add(result.endCursor);
      cursor = result.endCursor;
      if (page === maxPages - 1) report.coverage = "page_limit";
    }
    const snapshot = readState();
    const candidates = filterListings([...collected.values()], { ...monitor.filters, hide_seen: false }, snapshot).listings
      .filter(l => !snapshot.listings[l.id]?.photosCheckedAt || Date.now() - Date.parse(snapshot.listings[l.id].photosCheckedAt!) > 86400000)
      .sort((a, b) => (snapshot.listings[a.id]?.firstSeen ?? "9999").localeCompare(snapshot.listings[b.id]?.firstSeen ?? "9999"));
    for (const candidate of candidates.slice(0, monitor.inspectLimit ?? 0)) {
      if (budget.remaining <= 0) break;
      budget.remaining--;
      try {
        const listing = await client.getListingDetail(candidate.id);
        if (!listing.title && !listing.price) throw new Error("Listing details unavailable; availability and price were not verified.");
        const inspection = await inspectPhotos(listing);
        details.set(candidate.id, { listing, photos: inspection.photos, errors: inspection.failures.map(f => `${candidate.id}, photo ${f.photo}: ${f.error}`) });
        collected.set(candidate.id, { ...candidate, ...listing, priceAmount: listing.priceAmount, currency: listing.currency, postedDate: listing.postedDate || candidate.postedDate, sellerId: listing.sellerId || candidate.sellerId });
        report.inspected++;
      } catch (error) { report.errors.push(`${candidate.id}: ${error instanceof Error ? error.message : "Detail check failed"}`); }
    }
  } catch (error) {
    report.coverage = "error";
    report.errors.push(error instanceof Error ? error.message : "Search failed");
  }
  const now = new Date().toISOString();
  await updateState(state => {
    const current = state.monitors.find(m => m.id === monitor.id);
    if (!current) return; // A monitor deleted while requests were in flight stays deleted.
    const previouslySeen = new Set(current.seenIds);
    for (const listing of collected.values()) {
      const inspected = details.get(listing.id);
      const record = observeListing(state, listing, now, inspected?.listing.description);
      collected.set(listing.id, record.listing);
      if (inspected) { record.photos = inspected.photos; record.photosCheckedAt = now; report.errors.push(...inspected.errors); }
    }
    // Re-evaluate after details arrive so excluded phrases in fetched descriptions are respected.
    const filtered = filterListings([...collected.values()], { ...current.filters, hide_seen: false }, state);
    report.excluded = filtered.excluded;
    report.returned = filtered.listings.length;
    current.prices ??= {};
    for (const listing of filtered.listings) {
      const record = state.listings[listing.id];
      const hidden = current.filters?.hide_seen && record.seenAt;
      if (!previouslySeen.has(listing.id) && !hidden) {
        addAlert(state, { key: `new:${current.id}:${listing.id}`, kind: "new_listing", source: current.name,
          listingId: listing.id, url: listing.url, message: `${listing.title}: ${listing.price}. First encountered by this saved search; posting age may be unknown.` }, now);
        report.newListings++;
      }
      const target = current.targetPrice !== undefined && current.targetCurrency ? { amount: current.targetPrice, currency: current.targetCurrency } : undefined;
      const price = recordPriceAlerts(state, `monitor:${current.name}`, listing, current.prices[listing.id], target, now);
      if (price) current.prices[listing.id] = price;
      const inspected = details.get(listing.id);
      const review = inspected ? assessEvidence(inspected.listing, inspected.photos, state) : { signals: priceSignals(listing, record.description) };
      if (review.signals.length) addAlert(state, { key: `review:${current.id}:${listing.id}:${digest(review.signals)}`, kind: "review", source: current.name,
        listingId: listing.id, url: listing.url, message: review.signals.map(s => s.evidence).join("\n") }, now);
      record.seenAt = now;
      previouslySeen.add(listing.id);
    }
    current.seenIds = [...previouslySeen].slice(-5000);
    const keep = new Set(current.seenIds);
    current.prices = Object.fromEntries(Object.entries(current.prices).filter(([id]) => keep.has(id)));
    if (report.pages) current.lastChecked = now;
    if (report.errors.length) addAlert(state, { key: `error:${current.id}:${now.slice(0, 10)}:${digest(report.errors)}`,
      kind: "check_error", source: current.name, message: report.errors.join("\n") }, now);
  });
  return report;
}

export async function runChecks(client: Client, options: { monitorName?: string; includeWatches?: boolean; requestBudget?: number } = {}) {
  return withLock("monitor-run", async () => {
    const initial = readState();
    const totalBudget = options.requestBudget ?? 20;
    const budget = { remaining: totalBudget };
    let stopped = false;
    const watched: Array<{ listingId: string; ok: boolean; error?: string }> = [];
    const watches = options.includeWatches === false ? [] : [...initial.watches].sort((a, b) => (a.lastChecked ?? "").localeCompare(b.lastChecked ?? ""));
    // Reserve capacity for saved searches; rotating oldest-first prevents watch starvation.
    const watchLimit = Math.min(5, initial.monitors.length ? Math.max(1, Math.floor(totalBudget / 3)) : totalBudget);
    for (const watch of watches.slice(0, watchLimit)) {
      if (budget.remaining <= 0) break;
      budget.remaining--;
      const now = new Date().toISOString();
      try {
        const listing = await client.getListingDetail(watch.listingId);
        if (!listing.title && !listing.price) throw new Error("Listing unavailable or page format changed; no price update recorded.");
        await updateState(state => {
          const current = state.watches.find(w => w.listingId === watch.listingId && w.createdAt === watch.createdAt);
          if (!current) return;
          const record = observeListing(state, listing, now, listing.description);
          current.lastPrice = recordPriceAlerts(state, `watch:${listing.id}`, record.listing, current.lastPrice,
            { amount: current.targetPrice, currency: current.currency }, now);
          current.lastChecked = now;
          const signals = priceSignals(listing, listing.description);
          if (signals.length) addAlert(state, { key: `watch-review:${listing.id}:${digest(signals)}`, kind: "review", source: `watch:${listing.id}`,
            listingId: listing.id, url: listing.url, message: signals.map(s => s.evidence).join("\n") }, now);
        });
        watched.push({ listingId: watch.listingId, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Watch check failed";
        watched.push({ listingId: watch.listingId, ok: false, error: message });
        await updateState(state => {
          const current = state.watches.find(w => w.listingId === watch.listingId);
          if (current) {
            current.lastChecked = now;
            addAlert(state, { key: `watch-error:${watch.listingId}:${now.slice(0, 10)}:${digest(message)}`, kind: "check_error",
              source: `watch:${watch.listingId}`, listingId: watch.listingId, message }, now);
          }
        });
        if (/paused|disabled|daily request cap|request budget|spacing limit|login|checkpoint|429|session/i.test(message)) { stopped = true; break; }
      }
    }
    const saved = initial.monitors;
    const rotation = saved.length ? initial.monitorRotation % saved.length : 0;
    const monitors = options.monitorName ? saved.filter(m => m.name === options.monitorName) : [...saved.slice(rotation), ...saved.slice(0, rotation)];
    if (options.monitorName && !monitors.length) throw new Error(`Monitor "${options.monitorName}" not found.`);
    const reports: Coverage[] = [];
    for (const monitor of monitors) {
      if (stopped || budget.remaining <= 0) break;
      reports.push(await checkSearch(client, monitor, budget));
      if (reports.at(-1)!.errors.some(e => /paused|disabled|daily request cap|request budget|spacing limit|login|checkpoint|429|session/i.test(e))) break;
    }
    if (!options.monitorName) await updateState(state => { state.monitorRotation = rotation + Math.max(reports.length, 1); });
    return { monitors: reports, watched, requestsUsed: totalBudget - budget.remaining,
      monitorsDeferred: monitors.length - reports.length, watchesDeferred: watches.length - watched.length,
      unreadAlerts: readState().alerts.filter(a => !a.readAt).length,
      note: "Alerts are stored locally; use read_alerts. A bounded scan is not exhaustive. Search/details can reuse observations up to 30 minutes old. requestsUsed counts requested operations, not HTTP traffic; activity_status has HTTP counts. Shared pauses and limits also apply to manual checks." };
  }, 0);
}
