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
