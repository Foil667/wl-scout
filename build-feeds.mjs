// build-feeds.mjs — bakes fresh feed snapshots into the static WL Scout build.
// Run before every deploy: node build-feeds.mjs
// Output: feeds.json (raffles snapshot + radar card snapshot) in this directory.
import { writeFileSync } from "node:fs";

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

writeFileSync(new URL("./feeds.json", import.meta.url), JSON.stringify(out));
console.log("wrote feeds.json");
