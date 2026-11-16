// build-feeds.mjs — bakes fresh feed snapshots into the static WL Scout build.
// Run before every deploy: node build-feeds.mjs
// Output: feeds.json (raffles snapshot + radar card snapshot) in this directory.
import { writeFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; WLScout/1.0)" };
const out = { fetched_at: new Date().toISOString(), raffles: null, radar_cards: null };

// 1) Raffles feed (used by the FEEDS tab)
try {
  const r = await fetch("https://cdn.neverfuckingtrade.com/raffles/data.json?t=" + Date.now(), { headers: UA });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json();
  const list = (j.base && j.base.raffles) || [];
  out.raffles = { total: list.length, live: list.filter(x => x.live) };
  console.log("raffles: total", list.length, "live", out.raffles.live.length);
} catch (e) { console.error("raffles fetch failed:", e.message); }

// 2) Radar feed snapshot (lightweight card list for future use)
try {
  const v = await (await fetch("https://cdn.neverfuckingtrade.com/version.json", { headers: UA })).json();
  const html = await (await fetch("https://cdn.neverfuckingtrade.com/feed.html?v=" + v.v, { headers: { ...UA, "Accept-Encoding": "gzip" } })).text();
  const cards = [];
  const re = /<[a-z]+[^>]*class="card[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const attr = (n) => { const mm = tag.match(new RegExp(n + '="([^"]*)"')); return mm ? mm[1] : null; };
    cards.push({ chain: attr("data-chain"), addr: attr("data-addr"), slug: attr("data-slug"), price: attr("data-price"), pub: attr("data-pub"), start: attr("data-start"), end: attr("data-end"), title: attr("title") });
  }
  out.radar_cards = { build: v.v, total: cards.length, cards };
  console.log("radar: build", v.v, "cards", cards.length);
} catch (e) { console.error("radar fetch failed:", e.message); }

// 3) MintGo odds snapshot — run the read-only client, then fold a compact
// summary into feeds.json. Failure-tolerant by design: any error here logs
// and leaves mintgo null; the raffles/radar bake above must never break.
out.mintgo = null;
try {
  await new Promise((resolve) => {
    execFile(process.execPath, ["mintgo.mjs"], { cwd: new URL(".", import.meta.url).pathname, timeout: 240000 }, (err, stdout) => {
      if (err) console.error("mintgo run failed:", err.message);
      else console.log("mintgo run ok:", (stdout || "").trim().split("\n").filter(Boolean).pop() || "");
      resolve();
    });
  });
} catch (e) { console.error("mintgo step failed:", e.message); }
try {
  const mj = JSON.parse(readFileSync(new URL("./mintgo-out.json", import.meta.url), "utf8"));
  const pick = (d) => ({ name: d.name, contract: d.contract, chain: d.chain, mintPriceEth: d.mintPriceEth, floorEth: d.floorEth, ratio: d.ratio, sales1h: d.sales1h, volume1hEth: d.volume1hEth, score: d.score, verdict: d.verdict, status: d.status, startAt: d.startAt, endAt: d.endAt, opensea: d.opensea, twitter: d.twitter });
  const drops = [...(mj.drops || [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 25).map(pick);
  const excluded = (mj.excluded || []).slice(0, 25).map((d) => ({ name: d.name, chain: d.chain, contract: d.contract, reason: [d.excludeReason, d.excludeDetail].filter(Boolean).join(" — ") || "excluded" }));
  out.mintgo = { generated_at: mj.generatedAt || null, counts: mj.counts || null, drops, excluded };
  console.log("mintgo snapshot: seen", mj.counts && mj.counts.seen, "scored", mj.counts && mj.counts.scored, "drops kept", drops.length, "excluded kept", excluded.length);
} catch (e) { console.error("mintgo-out.json unavailable:", e.message); out.mintgo = null; }

writeFileSync(new URL("./feeds.json", import.meta.url), JSON.stringify(out));
console.log("wrote feeds.json");
