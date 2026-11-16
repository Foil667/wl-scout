#!/usr/bin/env node
/**
 * mintgo.mjs — READ-ONLY MintGo (mintgo.fun) radar client for Foil's WL/mint stack.
 *
 * What it does:
 *   Opens mintgo.fun in headless Chromium (Playwright), lets the page establish
 *   its OWN anonymous session (POST /api/session -> mg_access cookie, realtime
 *   WebSocket registration, sessionStorage client id), then fetches the radar
 *   (upcoming/live mints) + market snapshot via in-page same-origin fetch —
 *   the only route that passes MintGo's "Active realtime session required"
 *   gate. Scores every drop with the mintgo-monitor model (floor/mint odds +
 *   real 1h volume + creator history + progress) and HARD-EXCLUDES wash-traded,
 *   factory/clone-batch, and sold-out drops (flagged with reasons, never
 *   silently dropped). Writes JSON + prints a short digest.
 *
 * Access recipe (from xcchc/mintgo-monitor, MIT — see
 * ~/workspace/goals/wl-scout/hidden_files/wl-tooling-research.md, 2026-11-16):
 *   - Default headless UA gets 403 from nginx -> spoof a real Chrome UA.
 *   - /api/view/* requires the page's own sessionStorage
 *     'mintgo-realtime-client-id' AND a live realtime (WebSocket) session;
 *     a bare cookie via curl gets 403 REALTIME_REQUIRED.
 *   - This client NEVER accepts a pasted cookie/session: every run mints a
 *     fresh anonymous session in a fresh browser context. (A "mintgo scraper"
 *     asking for your session cookie is a credential-theft vector.)
 *
 * VM egress note: this box reaches the internet only through an authenticated
 * HTTP egress proxy (env https_proxy). That proxy answers unauthenticated
 * CONNECT with 403 + close (not a 407 challenge), so Chromium never gets to
 * present credentials and the tunnel dies. Workaround built in below: a
 * loopback relay that injects preemptive Basic auth into the upstream
 * CONNECT — exactly what curl does. Credentials are read from the env at
 * runtime and never written to disk or logs. The proxy also MITMs TLS with
 * its own CA, so the context uses ignoreHTTPSErrors (all VM egress already
 * transits that proxy; the data fetched here is public and read-only).
 *
 * HARD LINES: no wallet, no keys, no signing, no minting, no transactions.
 * Detection + scoring only.
 *
 * Usage:
 *   node mintgo.mjs [--chains robinhood,base,ethereum,ink] [--max-pages 12]
 *                   [--lookahead 48] [--out /path/mintgo-out.json] [--quiet]
 * Exit codes: 0 ok · 1 fetch/session failure · 2 zero drops (session suspect)
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'https://mintgo.fun/';
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Scoring thresholds (ported from mintgo-monitor src/score.py defaults)
const MIN_VOLUME_1H_ETH = 0.001; // below this, many sales = dust wash trading
const MIN_SALES_1H = 5;
const MIN_FLOOR_RATIO = 1.0;
const LATE_PROGRESS_PCT = 95;
const FACTORY_PROJECTS = 20; // deployer with >= this many projects = factory

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const CHAINS = argVal('--chains', 'robinhood,base,ethereum,ink')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(argVal('--max-pages', '12'), 10);
const LOOKAHEAD_H = parseFloat(argVal('--lookahead', '48'));
const OUT_PATH = argVal('--out', path.join(HERE, 'mintgo-out.json'));
const QUIET = args.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };

// ------------------------------------------------- chromium resolution
function resolveChromium() {
  if (process.env.MINTGO_CHROME && fs.existsSync(process.env.MINTGO_CHROME)) {
    return process.env.MINTGO_CHROME;
  }
  const roots = [
    path.join(HERE, '.browsers'),
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
  ];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium')); } catch { /* none */ }
    dirs.sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(root, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null; // fall back to playwright's own resolution
}

// --------------------------------------- loopback auth-injecting relay
// Chromium -> 127.0.0.1 relay (no auth) -> upstream egress proxy (Basic auth
// injected preemptively, like curl) -> target. Needed because the upstream
// proxy 403s unauthenticated CONNECT instead of issuing a 407 challenge.
function startRelay() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY || '';
  if (!raw) return Promise.resolve(null); // no proxy env: direct egress
  const up = new URL(raw);
  const auth = 'Basic ' + Buffer.from(
    `${decodeURIComponent(up.username || '')}:${decodeURIComponent(up.password || '')}`
  ).toString('base64');
  const upHost = up.hostname.replace(/^\[|\]$/g, '');
  const upPort = Number(up.port || 3128);

  const server = http.createServer((req, res) => {
    res.writeHead(501, { 'Content-Length': '0' });
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    const upstreamSock = net.connect(upPort, upHost, () => {
      upstreamSock.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n` +
        `Proxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      upstreamSock.off('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
      const rest = buf.slice(idx + 4);
      if (/ 200 /.test(statusLine)) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) clientSocket.unshift(rest);
        if (head && head.length) upstreamSock.write(head);
        upstreamSock.pipe(clientSocket);
        clientSocket.pipe(upstreamSock);
      } else {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        clientSocket.end();
        upstreamSock.end();
      }
    };
    upstreamSock.on('data', onData);
    upstreamSock.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSock.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ------------------------------------------------------- in-page fetch
// Ported from mintgo-monitor src/fetch_radar.py JS_COLLECT. These are real
// functions: Playwright serializes and runs them in the page. They must not
// reference Node-scope variables — everything arrives via the argument.
async function jsCollect(opts) {
  const { chains, maxPages } = opts;
  const out = { radar: {}, market: {}, client: '', errors: [] };
  const cid = sessionStorage.getItem('mintgo-realtime-client-id');
  out.client = cid || '';
  const jget = async (url) => {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text.slice(0, 200));
    return JSON.parse(text);
  };
  for (const chain of chains) {
    let cursor = null;
    const items = [];
    let meta = null;
    for (let p = 0; p < maxPages; p++) {
      const q = new URLSearchParams({ client: cid, chain, limit: '24' });
      if (cursor) q.set('cursor', cursor);
      let j;
      try {
        j = await jget('/api/view/radar?' + q.toString());
      } catch (e) {
        out.errors.push(chain + ' radar page ' + p + ': ' + String(e).slice(0, 160));
        break;
      }
      if (!meta) meta = { chainName: j.chainName, fetchedAt: j.fetchedAt, updatedAt: j.updatedAt, latestBlock: j.latestBlock };
      const pageItems = j.items || [];
      items.push(...pageItems);
      const page = j.page || {};
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
      if (pageItems.length === 0) break;
    }
    out.radar[chain] = { meta, items };
  }
  for (const chain of chains) {
    try {
      out.market[chain] = await jget('/api/market-snapshot?chain=' + encodeURIComponent(chain));
    } catch (e) {
      out.errors.push(chain + ' market: ' + String(e).slice(0, 160));
      out.market[chain] = null;
    }
  }
  return out;
}

// Readiness probe: the realtime (WebSocket) session must be ACTIVE before
// /api/view/* answers 200; poll the first chain's radar until it does.
async function jsProbe(chain) {
  const cid = sessionStorage.getItem('mintgo-realtime-client-id');
  if (!cid) return { status: 0, why: 'no client id' };
  try {
    const q = new URLSearchParams({ client: cid, chain, limit: '1' });
    const r = await fetch('/api/view/radar?' + q.toString(), { credentials: 'same-origin', cache: 'no-store' });
    return { status: r.status, why: r.status === 200 ? 'ok' : (await r.text()).slice(0, 120) };
  } catch (e) {
    return { status: -1, why: String(e).slice(0, 120) };
  }
}

async function collect() {
  const relay = await startRelay();
  const exe = resolveChromium();
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  };
  if (exe) launchOpts.executablePath = exe;
  if (relay) launchOpts.proxy = { server: relay.url };

  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true, // egress proxy MITMs TLS with its own CA
      userAgent: CHROME_UA,
      viewport: { width: 1600, height: 1000 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    const page = await ctx.newPage();
    const resp = await page.goto(PAGE_URL, { timeout: 90000, waitUntil: 'domcontentloaded' });
    if (!resp || resp.status() !== 200) {
      throw new Error(`page load failed: HTTP ${resp ? resp.status() : 'no response'}`);
    }
    await page.waitForFunction(
      "() => !!sessionStorage.getItem('mintgo-realtime-client-id')",
      null,
      { timeout: 30000 }
    );
    // Wait until the realtime session is actually active (WS registered).
    let ready = null;
    for (let i = 0; i < 18; i++) {
      ready = await page.evaluate(jsProbe, CHAINS[0]);
      if (ready.status === 200) break;
      await page.waitForTimeout(2500);
    }
    if (!ready || ready.status !== 200) {
      throw new Error(`realtime session never activated: ${JSON.stringify(ready)}`);
    }
    const data = await page.evaluate(jsCollect, { chains: CHAINS, maxPages: MAX_PAGES });
    data.collectedAt = Date.now();
    return data;
  } finally {
    await browser.close();
    if (relay) relay.server.close();
  }
}

// ------------------------------------------------------------ scoring
// Ported from mintgo-monitor src/score.py (read-only scoring core; the
// OpenSea sale-median enrichment and demand re-check belong to that repo's
// automation path and are intentionally NOT ported).
const NOISE_NAMES = new Set([
  'dnd', 'els', 'scott', 'mccall', 'vine', 'wif', 'testc', 'trytestsv',
  'bblo-test', 'dang', 'lpcg', 'vfbvfbvfb', 'test', 'testing',
]);

function namePenalty(name) {
  const n = (name || '').trim();
  if (!n) return -20;
  if (/^0x[0-9a-fA-F]{40}$/.test(n)) return -25;
  if (NOISE_NAMES.has(n.toLowerCase())) return -25;
  if (n.length <= 6 && n === n.toLowerCase() && !n.includes(' ')) return -12;
  return 0;
}

function ageToDays(age) {
  if (!age) return null;
  const parts = String(age).toLowerCase().replace('ago', '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const n = parseFloat(parts[0]);
  if (Number.isNaN(n)) return null;
  const unit = parts[1].replace(/s$/, '');
  const factor = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[unit];
  return factor === undefined ? null : n * factor;
}

function buildMarketIndex(market) {
  const idx = new Map(); // key: chain|addr
  for (const [chain, snap] of Object.entries(market || {})) {
    if (!snap) continue;
    for (const [window, rows] of Object.entries(snap.runners || {})) {
      for (const row of rows || []) {
        const addr = (row.contractAddress || '').toLowerCase();
        if (!addr) continue;
        const key = `${chain}|${addr}`;
        let mr = idx.get(key);
        if (!mr) {
          mr = {
            name: row.name || '', floors: {}, vol: {}, tx: {},
            change1d: row.windowFloorPriceChange ?? null,
            deployerProjects: row.deployerNftProjectCount ?? null,
            deployerAge: row.deployerCreatedAgo ?? null,
            twitter: row.twitterUrl ?? null, opensea: row.openSeaUrl ?? null,
          };
          idx.set(key, mr);
        }
        if (row.floorPriceEth) mr.floors[window] = parseFloat(row.floorPriceEth);
        if (row.windowVolumeEth != null) mr.vol[window] = parseFloat(row.windowVolumeEth);
        if (row.windowTxCount != null) mr.tx[window] = parseInt(row.windowTxCount, 10);
        if (row.deployerNftProjectCount != null) mr.deployerProjects = parseInt(row.deployerNftProjectCount, 10);
        if (row.deployerCreatedAgo) mr.deployerAge = row.deployerCreatedAgo;
      }
    }
  }
  for (const mr of idx.values()) {
    mr.floor = ['1d', '1h', '15m', '5m'].map((w) => mr.floors[w]).find((v) => v) ?? null;
    mr.sales1h = parseInt(mr.tx['1h'] || 0, 10);
    mr.volume1h = mr.vol['1h'] != null ? parseFloat(mr.vol['1h']) : 0;
  }
  return idx;
}

function firstNum(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && !Number.isNaN(parseFloat(v))) return parseFloat(v);
  }
  return null;
}

function normalize(item, chain) {
  // Radar `supply` is an object { minted, max } when present (18/114 items in
  // the 2026-11-16 live snapshot), a plain number/null otherwise.
  let supply = null;
  let minted = null;
  if (item.supply && typeof item.supply === 'object') {
    minted = firstNum(item.supply, ['minted', 'count', 'current']);
    supply = firstNum(item.supply, ['max', 'total', 'supply', 'maxSupply']);
  }
  if (supply == null) supply = firstNum(item, ['maxSupply', 'totalSupply', 'collectionSize']);
  if (minted == null) minted = firstNum(item, ['minted', 'mintedCount', 'totalMinted', 'mintCount', 'supplyUsed']);
  let progressPct = null;
  if (item.soldOut) progressPct = 100;
  else if (supply && minted != null) progressPct = Math.round((minted / supply) * 1000) / 10;
  return {
    name: item.displayName || item.name || '',
    contract: item.contractAddress || '',
    chain: item.chain || chain,
    mintPriceEth: parseFloat(item.priceEth || 0),
    floorEth: null, // filled from market index in scoreAll
    minted,
    supply,
    progressPct,
    soldOut: !!item.soldOut,
    deployer: item.deployerAddress || item.deployer || item.creatorAddress || item.creator || null,
    startAt: item.startAt || null,
    endAt: item.endAt || null,
    status: item.status || '',
    stageLabel: item.firstStageLabel || '',
    maxPerWallet: item.maxPerWallet ?? null,
    twitter: item.xUrl || null,
    opensea: item.openseaUrl || null,
    openSeaSlug: item.openSeaSlug || null,
    projectUrl: item.projectUrl || null,
    explorer: item.explorerUrl || null,
    raw: item,
  };
}

function scoreOne(drop, mr, nowMs) {
  const reasons = [];
  let score = 0;
  const price = drop.mintPriceEth;
  const floor = mr ? mr.floor : null;
  drop.floorEth = floor;
  const sales1h = mr ? mr.sales1h : 0;
  const vol1h = mr ? mr.volume1h : 0;
  const deployerProjects = mr ? mr.deployerProjects : null;
  const deployerAgeDays = mr ? ageToDays(mr.deployerAge) : null;
  const progress = drop.progressPct;

  const nPen = namePenalty(drop.name);
  if (nPen < 0) { score += nPen; reasons.push(`untrusted name (${JSON.stringify(drop.name)}), possible deploy test`); }

  // 1. Odds: floor / mint price
  let ratio = null;
  if (floor && price > 0) {
    ratio = floor / price;
    if (ratio >= 2) { score += 40; reasons.push(`odds ${ratio.toFixed(2)}x (floor ${floor} / mint ${price})`); }
    else if (ratio >= 1) { score += 25; reasons.push(`odds ${ratio.toFixed(2)}x`); }
    else if (ratio >= 0.5) { score += 8; reasons.push(`thin odds ${ratio.toFixed(2)}x`); }
    else { score -= 25; reasons.push(`underwater odds ${ratio.toFixed(2)}x (floor below mint)`); }
  } else if (price === 0 && floor) {
    ratio = Infinity; score += 35; reasons.push(`free mint with a real floor ${floor}`);
  } else if (price === 0) {
    score += 12; reasons.push('free mint (no floor data yet)');
  } else {
    score -= 10; reasons.push(`paid ${price} ETH with no floor data`);
  }

  // 2. Secondary depth: count AND volume (count alone is wash-bait)
  const volOk = vol1h >= MIN_VOLUME_1H_ETH;
  if (!mr) { score -= 15; reasons.push('no market record (zero secondary activity in 24h)'); }
  else if (sales1h >= 20 && volOk) { score += 20; reasons.push(`1h sales ${sales1h} / ${vol1h} ETH, deep`); }
  else if (sales1h >= 5 && volOk) { score += 10; reasons.push(`1h sales ${sales1h} / ${vol1h} ETH`); }
  else if (sales1h >= 5 && !volOk) { score -= 20; reasons.push(`wash suspect: ${sales1h} sales but only ${vol1h} ETH in 1h`); }
  else { score -= 12; reasons.push(`thin depth: ${sales1h} sales in 1h`); }

  // 3. Creator risk
  if (deployerProjects != null) {
    if (deployerProjects >= FACTORY_PROJECTS) { score -= 25; reasons.push(`creator shipped ${deployerProjects} projects (factory)`); }
    else if (deployerProjects >= 10) { score -= 15; reasons.push(`creator shipped ${deployerProjects} projects`); }
    else if (deployerProjects <= 3) { score += 5; reasons.push(`creator project count ${deployerProjects}, normal`); }
  }
  if (deployerAgeDays != null) {
    if (deployerAgeDays < 1) { score -= 20; reasons.push(`creator wallet brand new (${mr.deployerAge})`); }
    else if (deployerAgeDays < 3) { score -= 10; reasons.push(`creator wallet very new (${mr.deployerAge})`); }
  }

  // 4. Progress
  if (progress != null) {
    if (progress >= LATE_PROGRESS_PCT) { score -= 15; reasons.push(`progress ${progress}%, window nearly gone`); }
    else if (progress >= 20 && progress <= 80) { score += 8; reasons.push(`progress ${progress}%, window in range`); }
    else if (progress < 20) { score += 3; reasons.push(`progress ${progress}%, just opened`); }
  }

  // 5. Floor trend
  if (mr && mr.change1d != null) {
    const chg = parseFloat(mr.change1d);
    if (chg <= -0.5) { score -= 15; reasons.push(`floor down ${Math.round(chg * 100)}% in 24h`); }
    else if (chg >= 0.2) { score += 5; reasons.push(`floor up ${Math.round(chg * 100)}% in 24h`); }
  }

  // Hard fails (verdict capped at SKIP; the three spec'd hard exclusions are
  // applied earlier, in scoreAll, and reported in `excluded`)
  const hardFail =
    nPen < 0 ||
    (ratio != null && ratio !== Infinity && ratio < MIN_FLOOR_RATIO) ||
    (mr != null && sales1h < MIN_SALES_1H) ||
    (progress != null && progress >= LATE_PROGRESS_PCT);

  let verdict;
  if (floor == null) verdict = 'NO_FLOOR';
  else if (score >= 45 && !hardFail) verdict = 'GO';
  else if (score >= 20 && !hardFail) verdict = 'WATCH';
  else verdict = 'SKIP';

  return {
    ...drop,
    floorEth: floor,
    ratio: ratio === Infinity ? 'inf' : (ratio == null ? null : Math.round(ratio * 1000) / 1000),
    sales1h, volume1hEth: vol1h,
    deployerProjects, deployerAge: mr ? mr.deployerAge : null,
    score: Math.round(score * 10) / 10,
    verdict, reasons,
  };
}

function scoreAll(data) {
  const nowMs = Date.now();
  const marketIdx = buildMarketIndex(data.market);
  const scored = [];
  const excluded = [];
  const outOfWindow = [];
  let seen = 0;

  for (const [chain, block] of Object.entries(data.radar || {})) {
    for (const item of block.items || []) {
      seen++;
      const drop = normalize(item, chain);
      // Time window filter (reported, not silent)
      if (drop.startAt && (drop.startAt - nowMs) / 3600000 > LOOKAHEAD_H) {
        outOfWindow.push({ ...drop, why: `starts in ${((drop.startAt - nowMs) / 3600000).toFixed(1)}h (> ${LOOKAHEAD_H}h lookahead)` });
        continue;
      }
      if (drop.endAt && drop.endAt < nowMs) {
        outOfWindow.push({ ...drop, why: 'window already ended' });
        continue;
      }
      const mr = marketIdx.get(`${chain}|${drop.contract.toLowerCase()}`) || null;
      // ---- HARD EXCLUSIONS (flagged with reason, never silently dropped)
      if (drop.soldOut) {
        excluded.push({ ...drop, floorEth: mr ? mr.floor : null, excludeReason: 'sold_out', excludeDetail: 'MintGo reports soldOut=true; supply exhausted, window closed.' });
        continue;
      }
      if (mr && mr.sales1h >= MIN_SALES_1H && mr.volume1h < MIN_VOLUME_1H_ETH) {
        excluded.push({ ...drop, floorEth: mr.floor, excludeReason: 'wash_trading', excludeDetail: `${mr.sales1h} sales in 1h but only ${mr.volume1h} ETH total volume (avg ${(mr.volume1h / mr.sales1h).toExponential(1)} ETH/trade) — dust wash pattern.` });
        continue;
      }
      if (mr && mr.deployerProjects != null && mr.deployerProjects >= FACTORY_PROJECTS) {
        excluded.push({ ...drop, floorEth: mr.floor, excludeReason: 'factory', excludeDetail: `Deployer has shipped ${mr.deployerProjects} NFT projects (>= ${FACTORY_PROJECTS}) — clone-batch/factory pattern.` });
        continue;
      }
      scored.push(scoreOne(drop, mr, nowMs));
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { seen, scored, excluded, outOfWindow };
}

// ------------------------------------------------------------- selftest
// Offline check of the hard-exclusion logic (no network). Run: --selftest
function selftest() {
  const now = Date.now();
  const base = {
    chain: 'robinhood', priceEth: '0.001', soldOut: false,
    startAt: now + 3600000, endAt: now + 86400000, status: 'upcoming',
    firstStageLabel: 'Public sale', maxPerWallet: 5,
  };
  const mkRow = (addr, over) => ({
    contractAddress: addr, name: 'Fixture', floorPriceEth: 0.002,
    windowVolumeEth: 0.5, windowTxCount: 30, windowFloorPriceChange: 0,
    deployerNftProjectCount: 2, deployerCreatedAgo: '30 days ago', ...over,
  });
  const data = {
    radar: {
      robinhood: {
        meta: {}, items: [
          { ...base, contractAddress: '0x1111111111111111111111111111111111111111', displayName: 'SoldOut Fixture', soldOut: true },
          { ...base, contractAddress: '0x2222222222222222222222222222222222222222', displayName: 'Wash Fixture' },
          { ...base, contractAddress: '0x3333333333333333333333333333333333333333', displayName: 'Factory Fixture' },
          { ...base, contractAddress: '0x4444444444444444444444444444444444444444', displayName: 'Clean Fixture', priceEth: '0' },
        ],
      },
    },
    market: {
      robinhood: {
        runners: {
          '1h': [
            mkRow('0x2222222222222222222222222222222222222222', { windowVolumeEth: 0.0002, windowTxCount: 60 }),
            mkRow('0x3333333333333333333333333333333333333333', { deployerNftProjectCount: 25 }),
            mkRow('0x4444444444444444444444444444444444444444', {}),
          ],
        },
      },
    },
  };
  const { scored, excluded } = scoreAll(data);
  const byReason = Object.fromEntries(excluded.map((d) => [d.name, d.excludeReason]));
  const checks = [
    ['sold_out excluded', byReason['SoldOut Fixture'] === 'sold_out'],
    ['wash_trading excluded', byReason['Wash Fixture'] === 'wash_trading'],
    ['factory excluded', byReason['Factory Fixture'] === 'factory'],
    ['clean fixture scored', scored.some((d) => d.name === 'Clean Fixture')],
  ];
  let ok = true;
  for (const [label, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); if (!pass) ok = false; }
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- main
async function main() {
  let data;
  try {
    data = await collect();
  } catch (e) {
    console.error(`mintgo: FETCH FAILED — ${e.stack || e.message}`);
    process.exit(1);
  }
  const { seen, scored, excluded, outOfWindow } = scoreAll(data);
  if (seen === 0) {
    console.error('mintgo: zero drops returned — session/proxy problem suspected, no output written');
    if (data.errors?.length) console.error('errors:', data.errors.join(' | '));
    process.exit(2);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'mintgo.fun /api/view/radar + /api/market-snapshot (in-page session fetch)',
    chains: CHAINS,
    counts: {
      seen,
      scored: scored.length,
      excluded: excluded.length,
      outOfWindow: outOfWindow.length,
      byVerdict: scored.reduce((m, d) => ((m[d.verdict] = (m[d.verdict] || 0) + 1), m), {}),
      exclusionsByReason: excluded.reduce((m, d) => ((m[d.excludeReason] = (m[d.excludeReason] || 0) + 1), m), {}),
    },
    errors: data.errors || [],
    drops: scored,
    excluded,
    outOfWindow,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));

  log(`MintGo radar — ${new Date().toISOString()}`);
  log(`seen ${seen} | scored ${scored.length} | excluded ${excluded.length} | out-of-window ${outOfWindow.length}`);
  log(`verdicts: ${JSON.stringify(out.counts.byVerdict)} | exclusions: ${JSON.stringify(out.counts.exclusionsByReason)}`);
  log('--- top drops by score ---');
  for (const d of scored.slice(0, 10)) {
    const ratio = d.ratio === 'inf' ? 'inf' : (d.ratio == null ? '—' : `${d.ratio}x`);
    log(`${String(d.score).padStart(6)}  ${d.verdict.padEnd(8)} ${d.name} [${d.chain}] mint ${d.mintPriceEth} ETH | floor ${d.floorEth ?? '—'} | odds ${ratio} | ${d.reasons[0] || ''}`);
  }
  if (excluded.length) {
    log('--- excluded (hard) ---');
    for (const d of excluded.slice(0, 10)) {
      log(`EXCLUDED [${d.excludeReason}] ${d.name} [${d.chain}] ${d.contract}`);
    }
  }
  log(`JSON -> ${OUT_PATH}`);
}

if (args.includes('--selftest')) selftest();
else main().catch((e) => { console.error('mintgo: FATAL', e); process.exit(1); });
