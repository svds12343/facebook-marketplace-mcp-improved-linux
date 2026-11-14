# Facebook Marketplace MCP: Ubuntu / SSH edition

A Marketplace MCP server that reads Facebook and stores tracking data locally, adapted from [jdcodes1/facebook-marketplace-mcp](https://github.com/jdcodes1/facebook-marketplace-mcp). Log in through a dedicated browser window forwarded by MobaXterm, then run the MCP from the CLI with no browser or X display required.

This fork adds Ubuntu login, JSON-session import, private session storage, query-ID refresh, structured search results and pagination, sorting, pickup/shipping filters, safer listing extraction, actual listing images, bounded multi-page monitoring, a local alert inbox, price history, keyword/age/seen filters, and evidence-based checks for reused photos and inconsistent prices. Existing MCP tool names remain unchanged. Background requests are disabled by default. [Fork review and attribution](docs/FORK_REVIEW.md).

## Requirements

- Ubuntu 22.04 or 24.04 and a normal non-root user. The setup script uses an existing **Node.js 22+** with npm, or installs **Node.js 24** and npm for your user through [nvm](https://github.com/nvm-sh/nvm). Ubuntu's default `nodejs` package may be too old.
- A Facebook account that can access Marketplace.
- For interactive login only: MobaXterm's local X server and SSH X11 forwarding. No desktop environment is needed on Ubuntu.
- The included setup script installs Chromium and its Linux libraries through Playwright. It may request sudo for system packages; run the script itself as your normal user.

## Ubuntu + MobaXterm setup

1. Start MobaXterm's X server. In your SSH session settings, enable **X11-Forwarding** under **Advanced SSH settings**, then connect to Ubuntu. The X server runs on your Windows computer; Ubuntu runs the browser and forwards its window.
2. On Ubuntu, confirm forwarding works:

   ```bash
   sudo apt update
   sudo apt install -y git xauth x11-apps
   echo "$DISPLAY"
   xclock
   ```

   `DISPLAY` should be nonempty, often `localhost:10.0`. Close the clock window. If `xauth` was just installed, reconnect the SSH session first. Do not manually set `DISPLAY=:0`; that bypasses SSH's forwarded display.
3. Clone your fork (or extract the supplied source archive), then install:

   ```bash
   git clone https://github.com/svds12343/facebook-marketplace-mcp-improved-linux.git
   cd facebook-marketplace-mcp-improved-linux
   bash scripts/setup-ubuntu.sh --login
   ```

4. In the forwarded Chromium window, sign into Facebook, complete any verification, and open Marketplace. Return to the terminal and press **Enter**. Keep the browser open until the command saves the session.
5. The setup command automatically runs `auth:check` after login. To repeat that check later:

   ```bash
   npm run auth:check
   ```

   This checks cookies and the Marketplace session token. It does not establish that search queries still work. Then test `search_listings` from your MCP client.

Login writes `~/.fb-marketplace/session.json` with mode `0600`. The dedicated profile is `~/.fb-marketplace/browser-profile` with mode `0700`. After login, X11 forwarding is no longer needed for MCP requests. Re-run login when Facebook expires or rejects the session.

If setup installed nvm, a new terminal should load it from your shell profile. In an already-open terminal, source `$NVM_DIR/nvm.sh` (normally `~/.nvm/nvm.sh`) and run `nvm use 24` before using npm. The `--login` setup option avoids this extra step by running login and verification in the same shell as installation. No global Node installation is replaced.

### Manual installation

If you already have Node.js 22+:

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
npm run login
```

Keep development dependencies installed: `tsx` and Playwright power the login and capture commands. Do not use `--omit=optional` during setup: the TypeScript runner also uses a platform-specific optional dependency. SQLite is optional for this project and is only loaded by the legacy macOS fallback.

## If X11 login is unavailable

Use a Playwright storage-state file (`{"cookies":[...]}`), a browser-exported JSON cookie array, or a session file created by `npm run login` on another computer. Only valid Facebook cookies are retained, and `c_user` plus `xs` are required. Transferring a session to another machine can still trigger Facebook verification.

Transfer the file to Ubuntu with MobaXterm's SFTP panel or `scp`, then run:

```bash
npm run login -- --import /absolute/path/to/exported-cookies.json
npm run auth:check
```

This import requires neither a browser installation nor `DISPLAY`. If the imported file includes `userAgent`, requests reuse it; cookie-only exports use a platform-specific fallback user agent. Prefer a session produced by the login command. Session files grant account access: keep them private, out of Git, and do not paste them into chat.

## Connect an MCP client

### Client running on Ubuntu

```json
{
  "mcpServers": {
    "facebook-marketplace": {
      "command": "/absolute/path/to/node",
      "args": ["/home/USER/facebook-marketplace-mcp-improved-linux/dist/index.js"]
    }
  }
}
```

Replace the Node path with the result of `command -v node`. Login and the server must run as the same Ubuntu user, or both must set `FB_COOKIES_FILE` to the same absolute path.

### Client running on Windows or another computer

Use the local SSH executable to carry MCP stdio to Ubuntu:

```json
{
  "mcpServers": {
    "facebook-marketplace": {
      "command": "ssh",
      "args": [
        "-T",
        "USER@SERVER",
        "/absolute/path/to/node",
        "/home/USER/facebook-marketplace-mcp-improved-linux/dist/index.js"
      ]
    }
  }
}
```

Set up a working SSH key/login for that SSH executable and accept the host key in a normal terminal first. MobaXterm's saved credentials are not automatically available to Windows OpenSSH. Use an absolute Node path, especially with nvm: a noninteractive SSH session may not load your shell's Node configuration. Do not request a TTY (`-t`) or emit shell greetings on stdout. This is stdio over SSH; this fork does not open an HTTP port.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_location` | Look up city/town coordinates. |
| `search_listings` | Search a single result page, with filters and a continuation cursor. |
| `get_listing` | Read the requested listing's title, description, price, condition, photos and seller. |
| `get_listing_images` | Return actual listing photos as MCP image content so an image-capable model can inspect them. |
| `monitor_search` | Save a search locally. |
| `check_monitors` | Check multiple pages and watched offers within a request budget; record alerts and coverage. |
| `list_monitors` | List saved searches. |
| `delete_monitor` | Delete a monitor by `name`. |
| `watch_listing`, `list_watches`, `unwatch_listing` | Track a particular listing against a target price/currency, including after it leaves search pages. |
| `get_price_history` | Read locally observed price changes. |
| `read_alerts`, `acknowledge_alerts` | Read the local alert inbox and explicitly mark selected alerts read. |
| `assess_listing` | Inspect price inconsistencies, photo reuse and low-resolution photos; returns evidence and limitations. |
| `automation_status`, `pause_automation` | Inspect or immediately stop background request activity without contacting Facebook. |

### Search options

Required: `query`, `latitude`, `longitude`.

| Option | Values / behavior |
| --- | --- |
| `radius_km` | Positive radius; default 50. Sent as a whole number rounded upward. Facebook may broaden results. |
| `min_price`, `max_price` | Nonnegative amounts in the selected Marketplace's currency, for example CHF in Switzerland. A zero maximum is preserved. |
| `category` | Facebook category ID. |
| `limit` | Requested page size, 1–100; default 20. Facebook may return a different count. |
| `sort_by` | `suggested`, `distance`, `date_listed` (newest), `price_low_to_high`, `price_high_to_low`. |
| `delivery_method` | `all`, `local_pickup`, `shipping`. |
| `cursor` | Previous result's `endCursor`; keep the query and filters unchanged. |
| `exclude_keywords` | Up to 100 literal words/phrases; case/accent insensitive. Checks titles and cached descriptions; unfetched descriptions remain unchecked. |
| `exclude_ids` | Up to 2,000 listing IDs to omit. |
| `hide_seen` | Omit IDs previously returned by searches, opened with `get_listing`/`assess_listing`, or recorded by monitor checks on this server. |
| `max_age_days` | Maximum posting age from Facebook's timestamp. Never substitutes the local first-seen time. |
| `include_unknown_age` | Default false when an age filter is used. Set true to retain offers without a usable posting date. |

Search returns readable text and `structuredContent` with `listings`, `hasNextPage`, `endCursor`, `paginationStatus` and `effectiveRadiusKm`. A larger returned page is not truncated, since that would skip listings when advancing Facebook's cursor. IDs are deduplicated within the page. Stop when pagination is `end` or `stalled`; callers should also remember earlier cursors and bound the number of pages they request. Empty pages can still have a continuation cursor.

Saved monitors support the same filters and default to newest-first sorting, up to three pages, and no automatic photo inspection. Monitor checks save new-offer, price-drop, target-crossing and review alerts. The first check can report existing offers as newly encountered; it does not establish that they were just posted. No Facebook messaging or listing-creation tools are exposed.

Search and listing-detail tools now persist observed prices and seen IDs locally, so they are annotated as state-changing even though they do not modify Facebook. All tools declare their read/write behavior and output schemas. [Monitoring, risk checks and conservative automation setup](docs/MONITORING.md).

### Inspect listing photos

`get_listing` returns numbered photo URLs. `get_listing_images` fetches the listing's current photo URLs and returns the image bytes in MCP `image` content blocks, with labels linking each image to its listing and photo number. The image bytes are not placed in text, `structuredContent`, or UI-only metadata.

Call it with a numeric `listing_id`. It returns the first three photos by default. To choose photos or inspect additional ones, pass up to three 1-based `photo_indices`:

```json
{"listing_id":"123456789012345","photo_indices":[1,3]}
```

Example prompt: **"Use facebook-marketplace to open this listing and inspect its photos for visible wear, included accessories, and differences from the description."** The model must support images, and the MCP client must forward image content to it. An image displayed by a UI or a URL in a text result alone does not establish that the model inspected it. Photos can show visible details; they do not prove functionality or authenticity.

Downloads accept JPEG, PNG, and WebP from HTTPS Facebook CDN hosts (`fbcdn.net` and `fbsbx.com`, including subdomains). Each photo is limited to 2 MiB and 15 seconds; redirects are bounded and rechecked. No Facebook cookies are sent to the image CDN, and downloaded image bytes are not saved to disk. Missing, expired, oversized, or unsupported photos produce explicit per-photo errors while other selected images can still be returned. The tool reports total photo count, returned photo numbers, and failures so the model can distinguish unseen photos.

Implementation references checked against the official documentation:

- [OpenAI tool-result reference](https://developers.openai.com/plugins/reference#tool-results): `content` and `structuredContent` are visible to the model; `_meta` is not.
- [MCP TypeScript SDK image results](https://ts.sdk.modelcontextprotocol.io/server#image-and-audio-results): images use `type: "image"`, base64 `data`, and `mimeType` inside `content`.
- [OpenAI MCP instructions](https://learn.chatgpt.com/docs/extend/mcp#supported-mcp-features): server instructions describe the search → listing → image workflow to Codex.

After updating on Ubuntu, rebuild and restart the MCP connection in ChatGPT Desktop so it discovers the new tool:

```bash
git pull --ff-only && npm ci && npm run build
```

The image transport and tracking tools are tested through a real MCP stdio client with fixtures. Live Facebook CDN access and visual interpretation in your installed ChatGPT Desktop version still require a live listing test. If the client does not pass image blocks to the model, download the numbered photo URLs from `get_listing` and attach those photos directly in chat.

## Refresh Facebook query IDs

If `auth:check` succeeds but searches fail:

```bash
npm run capture-queries
```

In the forwarded browser, search Marketplace, **scroll to load more results** or change the sort/filter, then open the location selector and type a city. Press Enter in the terminal when finished. The command captures supported query requests and saves their IDs to `~/.fb-marketplace/queries.json`; future requests use them without a rebuild. It also refreshes the saved session. Request bodies, search terms and tokens are not written to the capture file.

The built-in IDs and request shapes come from community fixes, not a live verification today. Changing an ID cannot repair a changed request/response format; the code may need a further update if Facebook changes that format.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FB_DATA_DIR` | `~/.fb-marketplace` | Session, dedicated profile, captured IDs and monitors. |
| `FB_COOKIES_FILE` | `$FB_DATA_DIR/session.json` | Explicit JSON-session path; takes precedence over macOS extraction. |
| `FB_BROWSER_CHANNEL` | Playwright Chromium | Optionally use an already installed supported browser, e.g. `chrome`. Login/capture only. |
| `FB_SEARCH_DOC_ID` | Captured ID, then built-in ID | Override the search query ID. Digits only. |
| `FB_LOCATION_DOC_ID` | Captured ID, then built-in ID | Override the city query ID. Digits only. |
| `CHROME_PROFILE` | `Default` | Legacy macOS cookie extraction only. |

Paths are resolved independently of the working directory by default. Use absolute paths for overrides. This application does not load `.env` files automatically.

## Troubleshooting

- **`DISPLAY is empty` / no window:** enable X11 forwarding in MobaXterm, start its X server and reconnect. Ensure Ubuntu has `xauth` and the effective SSH server configuration allows `X11Forwarding yes`. Test `xclock` before trying Chromium.
- **`npm` missing / Node too old:** run `git pull --ff-only && bash scripts/setup-ubuntu.sh --login`. Setup now installs a suitable Node.js/npm automatically and stops if any installation step fails.
- **Missing browser executable/libraries:** `npx playwright install --with-deps chromium`.
- **Root / sandbox error:** use a normal Ubuntu user. Some Ubuntu/container policies restrict Chromium user namespaces. Use a supported system Chrome installation with `FB_BROWSER_CHANNEL=chrome npm run login`, or use the cookie-import route. The login command does not disable Chromium's sandbox.
- **Profile already in use:** close the dedicated login/capture browser before starting another login/capture command. Ordinary MCP searches do not open that profile.
- **`Missing or expired c_user/xs` or token extraction failure:** finish login and any Facebook verification, then save again. Importing expired cookies will not fix it.
- **Authentication succeeds, search fails:** refresh query IDs. If only tracking IDs or an unknown connection shape are returned, the tool reports an error instead of silently saying zero results.
- **`node` not found over SSH:** use its absolute path in the client configuration.
- **MCP appears idle when run manually:** expected. It waits for JSON-RPC on stdin; connect it using an MCP client. Use `node dist/index.js` for clean stdio, not the npm wrapper.

## Verification and limits

```bash
npm run typecheck
npm test
```

Tests use synthetic sessions and Facebook responses, plus a real MCP subprocess. They cover cookie filtering and expiry, private file writes, CLI import without X11, search/listing parsing, filters, cursor handling, image transport, photo selection, and image-download boundaries. They make no Facebook requests. The build and these tests passing do **not** verify your account, your server's X11 connection, today's Facebook endpoint behavior, or visual interpretation by your MCP client/model.

Facebook's internal API is unofficial and can change or restrict requests. The existing direct-request limit is three requests per minute. The optional macOS extraction path is retained but was not hardware-tested during this Ubuntu adaptation.
