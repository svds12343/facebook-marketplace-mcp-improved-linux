# Fork review and attribution

Reviewed 14 November 2026. Base upstream commit: `30fd6d15d1933ecd4bd351729fcdd17a82dae2b9`.

The public fork endpoint returned 63 visible forks. I screened their metadata, compared the 22 forks with pushes after the upstream baseline, inspected their relevant non-default branches, and reviewed all seven upstream pull requests. A changed push timestamp does not itself prove changed code: several forks keep an unchanged `master` and put their work on another branch. This is a targeted feature/code review, not a security audit or live verification of every fork.

## Incorporated

| Source | Useful change | Integration in this fork |
| --- | --- | --- |
| [AKosmachyov PR #4](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/4), commit `0e1a4697af4f8272ac3be2e32199689cecdd3562` | Session login, updated queries, nested search parsing, listing-ID-specific Relay merging, sorting/delivery filters, structured output | `src/facebook/parser.ts`, `queries.ts`, and `types.ts` are adapted directly from that revision with attribution. Existing tool names are retained. Ubuntu auth was implemented separately. Added deduplication, safer merging, zero-price handling, invalid-date handling, and cursor tests. |
| [marcelo-otero PR #3](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/3) | Refreshed query shapes, item-ID matching, price and location fields | Reviewed as the earlier source of the query/parser fixes carried into PR #4. The PR's reported live capture date was 28 August 2026; that is not a current-live guarantee. |
| [carteakey PR #8](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/8) | Newer `better-sqlite3` for modern Node versions | Updated to the current compatible 13.x release, made optional and lazy-loaded only for the legacy macOS path. Tested installation/build on Node 24. |
| [LLRHook](https://github.com/LLRHook/facebook-marketplace-mcp) | Explicit pagination, complete returned pages, structured data and uncertainty | Independently implemented compatible `cursor`/structured-result support and stalled-cursor warnings. Avoided truncating a Facebook page before advancing its cursor. Whole-kilometer radius requests follow this fork's reported live finding. |

## Other useful implementations

| Source | Implemented capability | Assessment for this Ubuntu server |
| --- | --- | --- |
| [Pop101](https://github.com/Pop101/facebook-marketplace-mcp) | Native MCP image responses, bounded multi-page search, HTTP hosting, Messenger read/send tools | Image inspection is a useful next addition. Its README explicitly says outbound messaging has not passed end-to-end acceptance testing, so it should not be presented as reliable seller messaging. Not merged. |
| [cgrdavies](https://github.com/cgrdavies/facebook-marketplace-mcp/tree/main) | Streamable HTTP, bearer-token authentication, Docker/Compose | Useful if a client needs an HTTPS MCP endpoint. Current fork uses stdio over SSH and opens no HTTP port. Not merged. |
| [jstoneburner `selfhost`](https://github.com/jstoneburner/facebook-marketplace-mcp/tree/selfhost) and [Jrachraf](https://github.com/Jrachraf/facebook-marketplace-mcp) | Standalone HTTP hosting and Docker | Alternative deployment implementations; extra auth/deployment review would be needed before exposing an endpoint. Not merged. |
| [loganmwilcox `fedora-firefox`](https://github.com/loganmwilcox/facebook-marketplace-mcp/tree/fedora-firefox) | Linux Firefox cookie extraction, paginated JSON export, optional listing-detail and photo downloads | Useful for command-line exports. The Ubuntu login/import route avoids dependence on an existing Firefox profile. Not merged. |
| [alex036](https://github.com/alex036/facebook-marketplace-mcp) | Vehicle shortlist, price/age history and an inquiry-log dashboard | Could support motorcycle shopping, but it is a separate tracker application rather than a small MCP fix. Not merged. |
| [LLRHook](https://github.com/LLRHook/facebook-marketplace-mcp) | Travel-cost/deal calculator, price-review flags, exclusion lists and age/distance filters | Useful with user-supplied assumptions. Its docs explicitly report missing/ambiguous coordinates and unsupported price formats; calculated headroom is not a verified bargain. Not merged. |
| [mwzkhalil PR #6](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/6) | Windows DPAPI and Chrome/Edge/Brave extraction | Mostly unnecessary for an Ubuntu server. JSON session import already provides a cross-machine alternative. Not merged. |
| [AmmarTN PR #5](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/5) | Hydrate tracking-only search results by fetching each listing page | Avoided: extra requests can make searches slow and increase request volume. This fork reports the stale/unsupported shape and provides query refresh instead. |
| [tarun3234 PR #7](https://github.com/jdcodes1/facebook-marketplace-mcp/pull/7) | Dedicated capture profile, JavaScript-bundle query discovery, improved cookie DB path lookup | Dedicated profile and non-network-idle navigation are independently used here. Bundle discovery is a possible future improvement; this fork currently captures actual matching query requests. |

Other reviewed branch changes included car-monitoring workflows (Cipher-gg, Patchmcm, edkane435), a marketplace-watch workflow (bsb20), security hardening (0Downtime), installation hooks (iloveitaly), and result truncation (rsmidtjensen). They were not merged wholesale. In particular, truncating results while retaining Facebook's end-of-page cursor can skip inventory.

## Validation boundary

This fork has automated fixture tests and MCP transport smoke tests. No live Facebook account or Ubuntu/MobaXterm session was available during implementation. A local attempt to launch Chromium in the development environment was blocked by its Unix-socket restrictions before a page could open; this does not establish whether Chromium will launch on the target Ubuntu host. Use `npm run login`, `npm run auth:check`, then a real MCP search on the target server.

No fork's README claim is treated as proof that its features work today. The adopted parts are covered by local regression tests; live compatibility still depends on Facebook.
