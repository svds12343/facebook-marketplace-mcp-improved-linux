# Monitoring, prices, filters and listing review

Version 1.1.0 adds a local alert inbox, multi-page checks, individual price watches and photo comparison. It never sends Facebook messages or changes listings. Alerts stay on your Ubuntu server and are retrieved through the MCP; they are not ChatGPT or phone push notifications.

## Update without enabling background activity

On Ubuntu, as the user who saved the Facebook session:

```bash
cd ~/facebook-marketplace-mcp-improved-linux
git pull --ff-only
npm ci
npm run build
npm run monitors:status
```

Restart the MCP connection in ChatGPT Desktop. Existing SSH commands and session files continue to work. Do not omit optional npm dependencies: `sharp` uses a platform-specific image decoder. There is no OpenAI API key or paid image-analysis service involved.

Background requests are **disabled by default**. Creating a saved search or price watch does not enable them. You can keep using `search_listings`, `get_listing`, `get_listing_images`, `assess_listing` and manually requested `check_monitors` without installing a timer. Manual tools still contact Facebook when requested.

## Conservative background controls

These limits reduce unattended traffic; they do not establish a Facebook-approved or ban-proof rate. Keeping background checks disabled is the lower-activity alternative. Facebook's private Marketplace requests can change or be restricted regardless of request frequency.

| Control | Behavior |
| --- | --- |
| Opt-in | Disabled until explicitly enabled by the Ubuntu user. Installing/updating the code does not enable it. |
| Timer interval | Every six hours, at 00:00, 06:00, 12:00 and 18:00 in the server's timezone. Missed activations are coalesced by systemd. |
| Automated rate | At most one authenticated request per minute. |
| Automated daily cap | 24 authenticated request attempts per UTC day, including session-token acquisition and failed attempts. Resuming cannot reset the count. |
| Shared rate | All MCP processes and the scheduler share a maximum of three authenticated requests per minute. |
| Per-run budget | Up to six search/detail calls by default. Session-token acquisition also consumes the daily cap. The budget can be reduced with `FB_MONITOR_REQUEST_BUDGET=1` through `6` before timer installation. |
| Warning responses | HTTP 401/403/429, unexpected redirects, login/checkpoint/temporary-block pages, missing session tokens, and GraphQL errors pause background activity. No automated login, checkpoint solving, account switching or retry loop. |
| Restart behavior | A pause persists across SSH disconnects, process restarts and day changes. Review manually and explicitly resume. |
| Photos | Automatic photo downloads are disabled by default (`inspect_limit: 0`). Opting in adds bounded CDN requests without Facebook cookies; CDN downloads are separate from authenticated-request counts. |
| Concurrency | A shared lease prevents simultaneous scheduler/manual monitor runs. Short state locks and atomic writes protect saved observations. |

To install the timer while leaving requests disabled:

```bash
npm run monitors:install
sudo loginctl enable-linger "$USER"
```

`enable-linger` keeps the user systemd manager running after SSH logout and starts it at boot. Then, only if you decide to enable background checks:

```bash
npm run monitors:enable
systemctl --user list-timers facebook-marketplace.timer
```

Alternatively, `npm run monitors:install -- --enable` explicitly opts in during installation. Neither form clears a previous checkpoint pause. Reinstall the timer after changing the Node version/path or moving the repository; its unit uses absolute paths. The timer captures the current `FB_DATA_DIR`, `FB_COOKIES_FILE`, `CHROME_PROFILE`, `FB_SEARCH_DOC_ID` and request-budget settings when provided.

To stop or inspect activity:

```bash
npm run monitors:pause
npm run monitors:status
journalctl --user -u facebook-marketplace.service -n 30 --no-pager
```

ChatGPT can also call `pause_automation` or `automation_status`. An in-flight request may finish, but the next automated request is blocked. Manual user-requested tools remain available. After resolving a session/checkpoint or other error manually, `npm run monitors:resume` explicitly clears the background pause. Do not repeatedly resume an unresolved restriction. Remove the timer with `npm run monitors:uninstall`; saved data is kept.

`npm run monitors:check` runs the **background** worker once and respects the opt-in switch and daily cap. For an interactive check independent of background scheduling, ask ChatGPT to call `check_monitors`; its default budget is three calls. Larger manual checks and photo comparisons can take minutes: if needed, raise `tool_timeout_sec` for this MCP in your existing client configuration (for example, 600).

## Saved searches and filters

Example `monitor_search` arguments:

```json
{
  "name": "Laptops near Morges",
  "query": "ThinkPad T14",
  "latitude": 46.5113,
  "longitude": 6.4982,
  "radius_km": 25,
  "max_price": 600,
  "exclude_keywords": ["broken", "pour pièces", "defekt"],
  "max_age_days": 14,
  "include_unknown_age": false,
  "max_pages": 3,
  "inspect_limit": 0,
  "target_price": 400,
  "target_currency": "CHF"
}
```

Coordinates are example inputs; use `search_location` for the intended town. Keyword matching is literal, case/accent insensitive and word-bounded: `broken` does not exclude `unbroken`. It is not semantic analysis of negation. Titles and previously fetched descriptions are checked. If you explicitly enable detail/photo inspection, newly fetched descriptions are checked before generating alerts, but only for the inspected subset.

Unknown posting dates are excluded by default **when an age limit is specified** and counted separately. This can remove many offers if Facebook omits dates; use `include_unknown_age: true` if that tradeoff is undesirable. `hide_seen` refers to IDs already returned/opened on this server, not Facebook's own viewed/saved state. Search results are marked seen only after filtering. Monitors also deduplicate new-offer alerts against their own seen IDs, even without `hide_seen`.

Multi-page scans stop at the configured page count, exhausted request budget, end of results, repeated/missing cursor, or an error. Empty pages may still have a next cursor. Results report `coverage`, pages checked and deferred monitors/watches. Limits and API ordering mean these scans are not exhaustive. Monitors rotate between runs when the budget cannot cover all of them.

`inspect_limit` defaults to 0 and can be set up to 10 when saving a monitor. It is also bounded by the run's request budget. Each inspected listing downloads at most three photos, up to 2 MiB each, with a 20-megapixel decode cap. Inspections are cached for a day. There is no automatic photo collection just because you save a search.

## Price history and individual watches

Search results, opened listing details and monitor/watch checks save observed price changes. `get_price_history` reads them without contacting Facebook. History begins when this server observes an offer; it does not recover prices from before installation.

For an offer you specifically want to follow, use `watch_listing`:

```json
{"listing_id":"123456789012345","target_price":350,"currency":"CHF"}
```

This fetches a baseline and creates/replaces the watch. The scheduler checks listing IDs directly even after they leave search pages. It checks up to five watches per run, oldest checked first, subject to the shared budget; multiple watches may therefore take more than one scheduled run. `list_watches` reports actual last-check times. `unwatch_listing` stops a watch without erasing history.

A same-currency reduction generates `price_drop`; reaching or crossing the target downward generates `target_reached`. An already-under-target offer can generate a target alert at the first observation. Unchanged prices do not repeat alerts. Currency changes and ambiguous prices are not treated as reductions, and currencies are never converted. Prices of 0 or 1 are recorded for review but excluded from bargain/target alerts. A deleted/unavailable listing produces an error; it is not treated as a zero-price sale.

Saved-search target alerts apply to offers found in the scanned pages. Use an individual watch when retaining coverage of one offer matters.

## Read the inbox

Ask ChatGPT: **“Read my Marketplace alerts.”** It calls `read_alerts`, which returns new-offer, reduction, target, review and failed-check notices. Results are oldest first, up to 50 by default, with a continuation cursor. Reading does not mark them read. Use `acknowledge_alerts` for explicit IDs after reviewing/paging through them. No external notification service is configured.

## Price inconsistencies and copied photos

`get_listing` and scheduled detail checks flag advertised 0/1 prices and explicit asking-price differences in the description. Swiss apostrophes, spaces and decimal separators are supported. Recognized original/retail costs, delivery charges and different currencies are not treated as conflicting asking prices. Unlabelled or ambiguous amounts may be missed; this is not a complete natural-language price parser.

For suspected copied listings, ask ChatGPT to call `assess_listing`, optionally providing up to three `compare_listing_ids`. It fetches up to three photos from each selected listing and compares them with its previously inspected local catalogue:

- SHA-256 identifies identical downloaded files.
- A 64-bit difference hash, colour similarity and aspect-ratio check flag visually similar resized/recompressed photos. Low-information images such as blank backgrounds are excluded from matching.
- Match evidence includes both listing URLs, photo numbers and whether known seller IDs differ.
- Low-resolution photos are flagged as an inspection limitation; Facebook may have resized them. The code does not claim to detect every blurry or compressed image.
- A much cheaper offer using matching photos is flagged relative to that other asking price. An optional `reference_price` plus `reference_currency` is a supplied comparison, not an independently calculated market valuation.

This is **not** a Facebook-wide or web-wide reverse-image search, identity verification, or a fraud classifier. It can miss crops/edits and unobserved duplicates; legitimate reposts and stock photos can match. No flags do not establish safety. Missing photos/price evidence are reported as incomplete. Use `get_listing_images` for the AI to inspect actual visible details; numerical fingerprints are not visual observations.

## Data and validation

State is stored in `~/.fb-marketplace/tracking.json` (or `FB_DATA_DIR`) with mode 0600, separate from your session. The first write imports existing `monitors.json`; the original is retained. Corrupt state fails explicitly instead of resetting history. Back up the data directory before moving servers. The latest 10,000 observed listings plus protected watches, 365 price changes per listing, 5,000 alerts and 5,000 seen IDs per monitor are retained. Evicted IDs/history are no longer available to filters or comparisons.

Downloaded image bytes are not persisted. Local photo fingerprints, listing metadata and descriptions are stored for comparison. No account cookies are sent to image CDNs. The systemd journal contains check counts and failure summaries rather than listing contents.

Automated tests cover migration, concurrent processes, real MCP stdio schemas/results, pagination loops, partial failures, repeated alerts, target crossings, currencies, age/keyword filters, copied/resized images, opt-in controls, daily caps and persistent pauses. Network tests use fixtures; they do not establish live Facebook compatibility or a safe request frequency. The timer's unit files are checked with `systemd-analyze verify`.

Implementation references:

- [OpenAI: define tools](https://developers.openai.com/plugins/plan/tools) and [server instructions](https://developers.openai.com/plugins/build/mcp-server): explicit tool scope, side effects, output contracts and concise shared guidance.
- [systemd timer documentation](https://www.freedesktop.org/software/systemd/man/255/systemd.timer.html): calendar activation and persistence.
- [sharp image metadata](https://sharp.pixelplumbing.com/api-input/) and [bounded decoding](https://sharp.pixelplumbing.com/api-constructor/).
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile): process-shared locks with heartbeat and stale-lock recovery.
