# AI-directed deal research

Version 1.2.0 adds search batching/caching and persistent price references. The MCP is an extension of the AI: it executes requested operations, retains observations and calculates statistics. ChatGPT chooses search terms and comparable offers, evaluates evidence and uncertainty, and decides whether an offer is attractive and what resale price may be reasonable. There is no separate OCR, model-identification service or change to image retrieval.

## Update

```bash
cd ~/facebook-marketplace-mcp-improved-linux
git pull --ff-only
npm ci
npm run build
```

Restart the MCP connection in ChatGPT Desktop to discover the five additional tools. Existing login/session files, SSH commands, monitors, watches and image tools continue to work. The update does not enable or change the scheduler. No new dependencies or API keys are needed.

## Search variants

`smart_search` accepts the same location, category, price, sorting, delivery and local exclusion filters as `search_listings`, except `cursor`. The AI supplies the main query and up to five prioritized `query_variants`. The MCP removes duplicate query strings (case/whitespace), then executes them in that order. It does not translate queries, invent spelling variants, widen geography or rank deals on its own.

Illustrative call:

```json
{
  "query": "Sony WH-1000XM5",
  "query_variants": ["casque Sony", "Sony headphones"],
  "latitude": 46.51,
  "longitude": 6.50,
  "radius_km": 25,
  "max_price": 120,
  "request_budget": 2
}
```

This can fetch the first page for the first two uncached queries. The third is reported as deferred if it is not cached. The AI decides whether a follow-up is useful. This is a retrieval example, not a current valuation or recommended budget for this model.

| Parameter or result | Meaning |
| --- | --- |
| `request_budget` | Default 2, integer 0–3. One shared budget for new search-page calls, not a fresh budget per variant. Zero means cache only. Token initialization may add a separate authenticated request. |
| `cache_max_age_minutes` | Default 30, range 0–1440. Zero bypasses cache reuse within the same request budget. |
| `queries[].source` | `live`, `cache`, `deferred` or `error`. Errors stop later variants; no retries. |
| `queries[].fetchedAt` | When the page was actually retrieved, not when it was read from cache. |
| `queries[].endCursor` | Continue only that query through `search_listings`, keeping its search parameters. No automatic pagination. |
| `matchedQueries` | Which requested queries returned each listing ID. Duplicate IDs appear once. |
| `observedAt` | Timestamp of the listing observation returned. A newer stored observation takes precedence over an older cached price. Cache reuse never refreshes observation dates. |
| `excluded`, `keywordCoverage` | Counts and coverage for the explicit local filters requested by the AI. |

Cached pages are scoped to query, coordinates, radius, price bounds, category, page size, sort and delivery settings. Local exclusion/age/seen filters are reapplied, so an old exclusion does not permanently remove an item from the cache. Listings returned to the AI are marked seen. Cache pages do not prove current availability.

At most 40 pages of up to 500 listings each are cached in private `search-cache.json`; larger pages are returned intact but not cached. A cross-process lease prevents concurrent smart-search batches. Calls use the existing shared three-authenticated-requests-per-minute limiter. No background activity is created. Limits constrain traffic; they are not a Facebook-approved request rate.

## Reusable price benchmarks

1. Use `list_price_benchmarks` to find an existing reference before spending more requests.
2. The AI inspects relevant listings using the existing tools and chooses genuinely comparable models/configurations, condition, accessories and locations. Search-price ceilings used for buying candidates should be removed when collecting market comparisons.
3. Call `save_price_benchmark` with a name, `criteria`, selected observed IDs and a `match_notes` explanation for each. Prices are read from actual stored observations; the caller cannot inject arbitrary prices. The AI remains responsible for the matching judgments. The evaluated purchase candidate should not form part of its own baseline.
4. Call `get_price_benchmark` with the name and `candidate_listing_id`. Review the sources and facts. If needed, pass `selected_listing_ids` to explicitly use a subset of the saved references. This changes only that calculation; replace the saved definition to persist a different reference selection.
5. The AI interprets sample size, age, independence, condition differences and asking-versus-sold-price uncertainty, and decides what conclusions are justified.

The required `criteria` fields are `product`, `variant`, `condition`, `accessories` (an array), `market_area` and ISO `currency`. They describe the AI's comparison set; the server does not independently identify products, verify matching, or geocode the area.

For example, after observing real offers, save an exact product such as Sony WH-1000XM5, its configuration, used/working condition, required case/cable, Vaud/Switzerland market and CHF currency. Each `comparables` entry supplies `listing_id` and the evidence in `match_notes`. Do not fabricate IDs or claim a listing was inspected when only a search snippet was returned.

`save_price_benchmark` requires `replace: true` to replace an existing name. Definitions are case-insensitive by name, capped at 50 references with at most 50 distinct listing IDs each. `delete_price_benchmark` removes only the definition, preserving listing observations and histories. Observations referenced by saved benchmarks are protected from catalogue eviction.

### What the calculation does

- Reads the latest locally observed asking price for each ID in the AI's selection, excluding only IDs explicitly omitted by the requested subset or `candidate_listing_id`.
- Returns mean, median, minimum, maximum and interpolated 25th/75th percentiles in the one specified currency. Mean, median and percentiles are rounded to two decimal places.
- Returns source links, raw asking prices, last observation dates and ages, cached descriptions, pending flags, seller IDs, and whether title/description/condition changed since selection.
- Groups repeated known seller IDs as a factual observation. It does not merge sellers by name or remove their offers.
- Does not automatically exclude low prices (including 0/1), high prices, older observations, pending offers, changed details, conflicts in descriptions or statistical outliers. The AI decides whether to remove them and passes a revised selection.
- Returns `calculationStatus: unavailable_prices` and null statistics when any selected observation is missing, its price cannot be parsed, its amount exceeds the supported range, or its currency differs. It never averages different currencies or silently substitutes a smaller sample. The supported numeric range is 0–1,000,000,000,000.
- Uses `calculationStatus: complete` solely for successful arithmetic, including small samples. `empty_selection` means no IDs remain after explicit exclusions. Neither is a deal-quality or confidence judgment.

Prices change when other requested search/detail/monitor operations observe updates. Benchmarks themselves make **zero Facebook requests**, create no watches and schedule no refreshes. Old observations remain old. A current computed report can therefore contain old price evidence; the AI must assess the dates before relying on it.

## Example instruction to ChatGPT

> Find candidates near Morges using a small set of French/English search terms you choose. Reuse cached results and existing benchmarks first. Select comparable offers yourself, explain the model/configuration/condition/accessory matches, and use the MCP to calculate their average and median. Review dates, pending status, changed descriptions, repeated sellers and unusual prices before deciding which offers belong in the sample. Keep asking prices distinct from confirmed sales, judge uncertainty yourself, and suggest a resale range only when supported. Do not enable background checks or contact sellers.

This uses the existing image workflow when useful. The new tools never fetch images automatically and do not alter the existing image tool or image analysis.
