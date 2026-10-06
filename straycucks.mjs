// straycucks.mjs — read-only integration with allowlist.straycucks.com
// (Stray Cucks scanner: "which Robinhood Chain lists is your wallet on?").
//
// What it gives the WL desk that we don't have:
//   1. /api/check?wallet= — a one-call rollup of every 4663 drop a wallet is
//      ELIGIBLE / NOT-ON / PUBLIC-ONLY on. Crucially, whitelists on 4663 live on
//      OpenSea's servers, not on chain — our SeaDrop probes cannot see them.
//   2. /api/drops — per-drop CCFF00 gate parsing (holder price, public price,
//      stage names, wlSpots) + trust signals (created-today, no X, copycat,
//      paid-mint-in-free-stage facts, creator-wallet clustering).
//   3. /api/catalog — 3k+ collection index with ccff00/free/live/junk facets.
//
// RATE LIMITS (respect them): the site gates feed endpoints behind an
// `x-sc-page: 1` header (403 "not-public" without it) and caps /api/check with
// an hourly "checks-hour" budget. drops are cached 1h; wallet checks 30min.
// Do NOT raise these frequencies without asking the user.
//
// Usage:
//   node straycucks.mjs --check 0x...        # eligibility rollup for one wallet
//   node straycucks.mjs --ccff00             # CCFF00-gated drops w/ phases+prices
//   node straycucks.mjs --trust <slug>       # trust signals for one collection
//   node straycucks.mjs --drops-refresh      # force refresh drops cache
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const BASE = "https://allowlist.straycucks.com";
const UA = "Mozilla/5.0 (compatible; WLScout/1.0; +straycucks-integration)";
const HEADERS = { "User-Agent": UA, "x-sc-page": "1" };
const CACHE_DIR = `${process.env.HOME}/workspace/goals/robinhood-chain-free-mint-watch/hidden_files/straycucks`;
const DROPS_TTL = 3600_000;   // 1h
const CHECK_TTL = 1800_000;   // 30min

mkdirSync(CACHE_DIR, { recursive: true });

async function getJSON(path, { noStore = false } = {}) {
  const r = await fetch(BASE + path, {
    headers: HEADERS,
    cache: noStore ? "no-store" : "default",
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 403) throw new Error(`403 not-public for ${path} (header rejected)`);
  if (!r.ok) throw new Error(`http ${r.status} for ${path}`);
  return r.json();
}

function loadCache(name, ttl) {
  const f = `${CACHE_DIR}/${name}`;
  if (!existsSync(f)) return null;
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (Date.now() - (d.savedAt || 0) > ttl) return null;
  return d.data;
}
function saveCache(name, data) {
  writeFileSync(`${CACHE_DIR}/${name}`, JSON.stringify({ savedAt: Date.now(), data }));
}

// ---- drops catalog (trust + CCFF00 gate data) ----
export async function fetchDrops(force = false) {
  if (!force) {
    const hit = loadCache("drops.json", DROPS_TTL);
    if (hit) return hit;
  }
  const d = await getJSON("/api/drops", { noStore: true });
  saveCache("drops.json", d);
  return d;
}

// ---- wallet eligibility rollup ----
export async function checkWallet(addr) {
  const a = addr.toLowerCase();
  const hit = loadCache(`check-${a}.json`, CHECK_TTL);
  if (hit) return { ...hit, fromCache: true };
  const d = await getJSON(`/api/check?wallet=${encodeURIComponent(a)}`, { noStore: true });
  if (d && d.budget && d.budget.limited) {
    // Hourly checks budget exhausted (shared anonymous allowance). Keep the
    // last good rollup instead of clobbering it with a zero-ask response.
    const prev = loadCache(`check-${a}.json`, CHECK_TTL * 48);
    return { ...(prev || d), budgetLimited: true, fromCache: !!prev };
  }
  saveCache(`check-${a}.json`, d);
  return d;
}

export function eligibleSlugs(check) {
  const out = {};
  for (const k of ["eligible", "publicOnly", "notOn", "unfunded", "maxed", "noAnswer"]) {
    out[k] = (check && Array.isArray(check[k])) ? check[k] : [];
  }
  return out;
}

// ---- CLI (only when run directly, not when imported) ----
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  if (args.length) {
  const cmd = args[0];
  if (cmd === "--drops-refresh") {
    const d = await fetchDrops(true);
    console.log(JSON.stringify({ refreshed: true, drops: d.drops ? d.drops.length : 0, t: d.t }));
  } else if (cmd === "--check") {
    const addr = args[1];
    if (!addr) { console.error("usage: --check <wallet>"); process.exit(1); }
    const c = await checkWallet(addr);
    const e = eligibleSlugs(c);
    console.log(JSON.stringify({
      wallet: addr,
      budgetLimited: !!c.budgetLimited,
      fromCache: !!c.fromCache,
      eligibleCount: e.eligible.length,
      eligible: e.eligible.slice(0, 60),
      publicOnlyCount: e.publicOnly.length,
      publicOnly: e.publicOnly.slice(0, 60),
      freeCount: c.freeCount || 0,
      skipped: c.skipped ?? null,
      holdings: c.holdings || null,
      listOpen: c.listOpen ?? null,
    }, null, 2));
  } else if (cmd === "--ccff00") {
    const d = await fetchDrops();
    const cc = (d.drops || []).filter(x => x.ccff00 && typeof x.ccff00 === "object" && x.ccff00.gated);
    const now = Math.floor(Date.now() / 1000);
    const rows = cc.map(x => ({
      name: x.name, slug: x.slug, addr: x.address,
      holderPrice: x.ccff00.holderPrice || null,
      publicPrice: x.ccff00.publicPrice || null,
      wlSpots: x.ccff00.wlSpots ?? null,
      stages: (x.ccff00.stages || []).slice(0, 4),
      live: x.live === true,
      startsIn: x.startsIn ?? null,
      endsIn: x.endsIn ?? null,
      trust: (x.trust && x.trust.signals) || [],
      priceEth: x.priceEth ?? null,
    }));
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === "--trust") {
    const slug = (args[1] || "").toLowerCase();
    const d = await fetchDrops();
    const hit = (d.drops || []).find(x => (x.slug || "").toLowerCase() === slug);
    if (!hit) { console.log(JSON.stringify({ slug, found: false })); }
    else console.log(JSON.stringify({ slug, name: hit.name, addr: hit.address, trust: hit.trust, owner: hit.owner }, null, 2));
  } else {
    console.error("unknown cmd", cmd);
    process.exit(1);
  }
}
}
