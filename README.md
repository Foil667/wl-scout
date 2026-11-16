# WL Scout — static edition

**Is my wallet whitelisted?** Paste an EVM address, pick Robinhood Chain (4663) or Base (8453), and get onchain-verified whitelist/allowlist eligibility verdicts.

Live: https://foil667.github.io/wl-scout/

## How it works

100% client-side, read-only. No wallet connection, no signing, no server, no API keys in the code.

- **Holder gates (the verified lane):** `balanceOf` / `ownerOf` on the CCFF00 squares contract → green ELIGIBLE / red NOT ELIGIBLE. A verified fact, not a guess.
- **SeaDrop phases:** `getPublicDrop` (`0xbc6a629c`) + `allowListMerkleRoot` (`0x32bf11f5`) on the canonical SeaDrop and the Robinhood fork, with RPC failover across three endpoints per chain.
- **Offchain allowlists:** the app shows CHECKER with the project's checker link and never fakes a green verdict.

OpenSea metadata leg is intentionally dropped in this static build — no API key ships in client code. Onchain legs carry the verdicts.

## Verdicts

| Verdict | Meaning |
|---|---|
| ELIGIBLE | Holder gate proven onchain |
| NOT ELIGIBLE / INELIGIBLE_BY_GATE | Onchain proof the gate isn't met |
| CHECKER | Offchain AL phase exists; only the project's checker knows membership |
| UNKNOWN | No live phase onchain, or a data leg failed |

Built by [Foil (Looper #667)](https://x.com/Foil667). Eligibility for offchain allowlists is decided by each project — WL Scout verifies what the chain can prove.

## Headless scanner (Node, not part of the Pages site)

`straycucks.mjs` — read-only integration with allowlist.straycucks.com (header `x-sc-page: 1`; 403 without it). `/api/check?wallet=` returns a one-call eligibility rollup over every 4663 drop — the only headless way to see OpenSea server-side allowlists, which onchain SeaDrop probes can't reveal. `/api/drops` adds CCFF00 stage names, holder/public prices, WL spots, trust signals, and mint history. Hourly `checks-hour` budget: drops cached 1h, wallet checks 30min — never hammer it.

`scan-wallets.mjs` — bi-wallet scan (user square wallet + Foil) with `--stray` to merge the rollup.

These are intentionally NOT wired into the public Pages build (would burn the service's tiny budget). CLI: `node straycucks.mjs --check 0x...` / `--ccff00` / `--trust <slug>` / `--drops-refresh`.

## MintGo odds feed

The FEEDS tab carries a **MintGo odds** section: a snapshot of drops scored by floor price ÷ mint price — if the floor sits above the mint cost, the odds favor the minter. `build-feeds.mjs` refreshes it on every hourly rebake by running `mintgo.mjs`, a read-only client that opens its own anonymous MintGo session (no wallet, no keys, no signing) and writes `mintgo-out.json`; the bake folds a compact top-25 summary into `feeds.json` under the `mintgo` key. Scoring weighs the floor÷mint ratio, real 1h sales volume/depth, creator history, and mint progress, with hard exclusions for sold-out, wash-trading, and factory/clone-batch drops (shown in the tab as EXCLUDED with the reason). A MintGo failure never breaks the bake — the section just shows the snapshot as unavailable.

Most drops have no floor data at all (in the first live snapshot: 114 seen, 58 scored, 55 of those NO_FLOOR), so **NO_FLOOR is the common case**, not an error. The tab shows scored drops in full and collapses the no-floor tail into a summary line.
