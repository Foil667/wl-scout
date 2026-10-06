// scan-wallets.mjs — headless WL Scout scan for one or more EVM addresses.
// Replicates the static site's verdict engine (SeaDrop canon+fork probes + CCFF00 holder gate).
// Usage: node scan-wallets.mjs <addr1> [addr2 ...] [--out file.json]
// Output: JSON verdict report on stdout (and optionally to --out).
import { readFileSync, writeFileSync } from "node:fs";

// Optional Stray Cucks integration (allowlist.straycucks.com): one-call
// eligibility rollup per wallet (OpenSea server-side WL lists are invisible to
// our onchain SeaDrop probes) + per-drop CCFF00 gate / trust enrichment.
// Pass --stray to enable. Budget-limited (hourly) — degrades gracefully.
const USE_STRAY = process.argv.includes("--stray");
let strayCheckWallet = null, strayFetchDrops = null;
if (USE_STRAY) {
  ({ checkWallet: strayCheckWallet, fetchDrops: strayFetchDrops } =
    await import("./straycucks.mjs"));
}

const SEADROP_CANON = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_FORK = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
const SQUARES = "0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146";
const SEL_PUB = "0xbc6a629c", SEL_ROOT = "0x32bf11f5", SEL_BAL = "0x70a08231";
const RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.nodeflare.app/robinhood/public",
];
const UA = "Mozilla/5.0 (compatible; WLScout/1.0)";

// Single source of truth: the PROJECTS list baked into the static site.
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const m = html.match(/const PROJECTS=(\[.*?\]);/s);
if (!m) { console.error("PROJECTS list not found in index.html"); process.exit(1); }
const PROJECTS = JSON.parse(m[1]);

const encAddr = (sel, a) => sel + a.toLowerCase().replace("0x", "").padStart(64, "0");
const decUint = (hex) => BigInt(hex);

async function rpcBatch(calls) {
  let lastErr = "";
  for (const url of RPCS) {
    try {
      const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      for (const x of arr) if (x.error) throw new Error(x.error.message || "rpc error");
      return arr.map(x => x.result);
    } catch (e) { lastErr = e.message || String(e); }
  }
  throw new Error("all RPC endpoints failed: " + lastErr);
}

const mk = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

async function scanWallet(addr) {
  const calls = [mk(SQUARES, encAddr(SEL_BAL, addr))];
  for (const p of PROJECTS) {
    calls.push(mk(SEADROP_CANON, encAddr(SEL_PUB, p.contract)));
    calls.push(mk(SEADROP_CANON, encAddr(SEL_ROOT, p.contract)));
    calls.push(mk(SEADROP_FORK, encAddr(SEL_PUB, p.contract)));
    calls.push(mk(SEADROP_FORK, encAddr(SEL_ROOT, p.contract)));
  }
  const res = await rpcBatch(calls);
  const holderN = Number(decUint(res[0] || "0x0"));
  const now = Math.floor(Date.now() / 1000);
  const results = [];
  PROJECTS.forEach((p, i) => {
    const [pubC, rootC, pubF, rootF] = res.slice(1 + i * 4, 1 + i * 4 + 4);
    const phases = [];
    for (const pub of [pubC, pubF]) {
      if (!pub || /^0x0{1,}$/.test(pub)) continue;
      const w = []; for (let k = 0; k < 6; k++) w.push(decUint("0x" + pub.slice(2 + k * 64, 2 + (k + 1) * 64)));
      const [price, start, end, maxW] = w;
      if (end === 0n) continue;
      phases.push({ price: Number(price) / 1e18, start: Number(start), end: Number(end), maxW: Number(maxW) });
    }
    const root = rootC && !/^0x0{1,}$/.test(rootC) ? rootC : (rootF && !/^0x0{1,}$/.test(rootF) ? rootF : null);
    const live = phases.filter(x => x.start <= now && now <= x.end);
    const upcoming = phases.filter(x => x.start > now).sort((a, b) => a.start - b.start)[0] || null;
    const need = p.gateNeed || 1;
    let verdict = "UNKNOWN", why = "";
    if (p.gate === "ccff00-holder") {
      if (live.length) {
        if (holderN >= need) { verdict = "ELIGIBLE"; why = `Live SeaDrop phase · holds ${holderN} CCFF00 square(s), gate needs ${need}.`; }
        else { verdict = "INELIGIBLE_BY_GATE"; why = `Live SeaDrop phase · gate needs ${need} square(s), holds ${holderN}.`; }
      } else if (root) { verdict = "CHECKER"; why = "Gated phase merkle root onchain — membership offchain; project checker decides."; }
      else { verdict = "UNKNOWN"; why = "No live SeaDrop phase onchain for this contract."; }
    } else {
      if (live.length) { verdict = "CHECKER"; why = "Live onchain phase, no known holder gate — check project checker/announcement."; }
      else if (root) { verdict = "CHECKER"; why = "Gated phase merkle root onchain — membership offchain."; }
      else { verdict = "UNKNOWN"; why = "No live SeaDrop phase onchain for this contract."; }
    }
    results.push({ name: p.name, contract: p.contract, status: p.status, gate: p.gate, gateNeed: need, verdict, why, live: live[0] || null, upcoming });
  });

  // Stray Cucks enrichment: per-drop CCFF00-gate/trust data + wallet rollup.
  let stray = null;
  if (USE_STRAY && strayFetchDrops) {
    try {
      const drops = await strayFetchDrops();
      const byAddr = {};
      for (const d of (drops.drops || [])) {
        if (d.address) byAddr[d.address.toLowerCase()] = d;
      }
      for (const r of results) {
        const d = byAddr[r.contract.toLowerCase()];
        if (d) {
          r.stray = {
            slug: d.slug, live: d.live === true,
            ccff00: d.ccff00 && d.ccff00.gated ? {
              holderPrice: d.ccff00.holderPrice, publicPrice: d.ccff00.publicPrice,
              wlSpots: d.ccff00.wlSpots ?? null, stages: (d.ccff00.stages || []).slice(0, 4),
            } : null,
            trust: (d.trust && d.trust.signals) || [],
            minted: d.minted ?? null, max: d.max ?? null,
          };
        }
      }
      if (strayCheckWallet) {
        const c = await strayCheckWallet(addr);
        stray = {
          budgetLimited: !!c.budgetLimited, fromCache: !!c.fromCache,
          eligible: (c.eligible || []).slice(0, 100),
          publicOnly: (c.publicOnly || []).slice(0, 100),
          freeCount: c.freeCount || 0,
          holdings: c.holdings || null, listOpen: c.listOpen ?? null,
        };
      }
    } catch (e) { stray = { error: e.message || String(e) }; }
  }
  return { addr, squares: holderN, ts: new Date().toISOString(), results, ...(stray ? { stray } : {}) };
}

const rawArgs = process.argv.slice(2);
const outIdx = rawArgs.indexOf("--out");
const outFile = outIdx >= 0 ? rawArgs[outIdx + 1] : null;
const args = rawArgs.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));
const report = [];
for (const a of args) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { console.error("skip invalid address:", a); continue; }
  report.push(await scanWallet(a));
}
const json = JSON.stringify(report, null, 1);
if (outFile) writeFileSync(outFile, json);
console.log(json);
