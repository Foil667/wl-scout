// opensea-leg.mjs — first-party OpenSea eligibility leg for WL Scout.
//
// Replaces the Stray Cucks rollup (paywalled behind a partner key since
// ~Oct/Nov 2026; the user chose to drop that dependency). OpenSea hosts the
// allowlists server-side, so eligibility for a signed stage is probed the
// same way Foil's mint pipeline does:
//
//   POST https://api.opensea.io/api/v2/drops/{slug}/mint  {minter, quantity}
//     200 → ELIGIBLE_SIGNED  (OpenSea returns a minter-bound signed tx
//                             payload — recorded here as a status ONLY; the
//                             payload is discarded unread, never parsed,
//                             never stored, never signed, never submitted)
//     422 → NOT_ON_LIST      (hard negative: wallet not allowlisted)
//     429 → RATE_LIMITED     (free-key budget hit — batch stops probing)
//     *   → UNKNOWN
//
// The endpoint builds for whatever stage is active, so the stage type is
// read separately from GET /api/v2/drops/{slug} (active_stage.stage_type)
// on a best-effort basis.
//
// AUTH: uses Foil's existing headless OpenSea auth, either or both of:
//   - the free agent API key at ~/.opensea/key.json (JSON {"api_key": ...}
//     or a raw string — read tolerantly; the value is NEVER printed), and
//   - the SIWE session cookies saved by nft-god/opensea-connect
//     (hidden_files/os-session.json).
// If neither is available, or OpenSea answers 401/403, the verdict is
// AUTH_UNAVAILABLE — reported distinctly, never guessed around.
//
// TRANSPORT: curl with a browser User-Agent + Origin/Referer — Node fetch
// gets bot-walled on this endpoint (established in the mint pipeline).
//
// RATE DISCIPLINE: ~5 builds/min max on the free key. Batch runs pace POSTs
// ≥12.5s apart and stop entirely on a 429. Verdicts are cached per
// (wallet, slug) for 30 min next to the Stray caches; only real verdicts
// (ELIGIBLE_SIGNED / NOT_ON_LIST) are cached — an error or UNKNOWN never
// clobbers a good cached verdict.
//
// Usage:
//   node opensea-leg.mjs --check <wallet> <slug>   # one verdict, JSON out
//   node opensea-leg.mjs --coverage                # slug coverage of PROJECTS
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";

const OS_API = "https://api.opensea.io/api/v2";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HIDDEN = `${process.env.HOME}/workspace/goals/robinhood-chain-free-mint-watch/hidden_files`;
const SESSION_FILE = `${HIDDEN}/os-session.json`;
const CACHE_DIR = `${HIDDEN}/opensea-leg`;
const SLUGMAP_FILE = `${CACHE_DIR}/slug-map.json`;
const CHECK_TTL = 1800_000; // 30 min, same as the Stray wallet-check TTL
const POST_PACE_MS = 12_500; // ≤ ~5 builds/min on the free key

mkdirSync(CACHE_DIR, { recursive: true });

// ---------- auth (values never logged) ----------
function loadApiKey() {
  try {
    const raw = readFileSync(`${process.env.HOME}/.opensea/key.json`, "utf8").trim();
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      const k = j.api_key || j.key || j.apiKey;
      return typeof k === "string" && k.trim() ? k.trim() : null;
    } catch {
      // Raw-string format (the auto-provisioner rewrites the file raw).
      return /^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : null;
    }
  } catch { return null; }
}

function loadSessionCookies() {
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (!s.authed || !s.cookies) return null;
    const c = Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    return c || null;
  } catch { return null; }
}

const API_KEY = loadApiKey();
const COOKIES = loadSessionCookies();
export const hasOpenSeaAuth = !!(API_KEY || COOKIES);

function osHeaders(slug) {
  const h = {
    "User-Agent": UA,
    "Origin": "https://opensea.io",
    "Referer": `https://opensea.io/collection/${slug}/drops`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (API_KEY) h["X-API-KEY"] = API_KEY;
  if (COOKIES) h["Cookie"] = COOKIES;
  return h;
}

// ---------- transport (curl; Node fetch is bot-walled here) ----------
function curlJson(method, url, slug, body) {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "--max-time", "30", "-X", method, "-w", "\n__OS_HTTP__%{http_code}"];
    for (const [k, v] of Object.entries(osHeaders(slug))) args.push("-H", `${k}: ${v}`);
    if (body !== undefined) args.push("--data-binary", "@-");
    args.push(url);
    execFile("curl", args, { input: body !== undefined ? JSON.stringify(body) : undefined, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error("curl failed: " + (err.message || err)));
        const m = String(stdout).match(/\n__OS_HTTP__(\d{3})\s*$/);
        const status = m ? Number(m[1]) : 0;
        const text = m ? String(stdout).slice(0, m.index) : String(stdout);
        resolve({ status, text });
      });
  });
}

// ---------- verdict mapping (exported for offline tests) ----------
export function verdictFromStatus(httpStatus) {
  if (httpStatus === 200) return "ELIGIBLE_SIGNED";
  if (httpStatus === 422) return "NOT_ON_LIST";
  if (httpStatus === 429) return "RATE_LIMITED";
  if (httpStatus === 401 || httpStatus === 403) return "AUTH_UNAVAILABLE";
  return "UNKNOWN";
}

// ---------- cache (only real verdicts are ever written) ----------
function cacheFile(wallet, slug) {
  return `${CACHE_DIR}/check-${wallet.toLowerCase()}-${slug}.json`;
}
function loadVerdictCache(wallet, slug) {
  const f = cacheFile(wallet, slug);
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, "utf8"));
    if (Date.now() - (d.savedAt || 0) > CHECK_TTL) return null;
    return d.data;
  } catch { return null; }
}
function saveVerdictCache(wallet, slug, data) {
  writeFileSync(cacheFile(wallet, slug), JSON.stringify({ savedAt: Date.now(), data }));
}

// ---------- slug resolution ----------
// A project's OpenSea slug comes from (a) its own `slug` field in PROJECTS,
// or (b) the hand-maintained contract→slug map at SLUGMAP_FILE. Nothing is
// ever guessed from a project name.
export function resolveSlug(project) {
  if (project.slug) return project.slug;
  try {
    if (existsSync(SLUGMAP_FILE)) {
      const map = JSON.parse(readFileSync(SLUGMAP_FILE, "utf8"));
      return map[project.contract.toLowerCase()] || null;
    }
  } catch { /* unreadable map = no slugs from it */ }
  return null;
}

export function slugCoverage(projects) {
  const withSlug = projects.filter(p => resolveSlug(p));
  return { projects: projects.length, withSlug: withSlug.length, names: withSlug.map(p => p.name) };
}

// ---------- the probe ----------
export async function checkOpenSeaEligibility(wallet, slug, { useCache = true } = {}) {
  const w = wallet.toLowerCase();
  if (useCache) {
    const hit = loadVerdictCache(w, slug);
    if (hit) return { ...hit, fromCache: true };
  }
  if (!hasOpenSeaAuth) {
    return { slug, status: "AUTH_UNAVAILABLE", stageType: null, httpStatus: null, fromCache: false, note: "no OpenSea API key or SIWE session available headlessly" };
  }

  // Stage type, best-effort (the mint POST builds for the active stage).
  let stageType = null;
  try {
    const g = await curlJson("GET", `${OS_API}/drops/${encodeURIComponent(slug)}`, slug);
    if (g.status === 200) {
      const j = JSON.parse(g.text);
      stageType = j.active_stage?.stage_type || j.activeStage?.stage_type || null;
    }
  } catch { /* stage type is decoration; the POST verdict is the substance */ }

  // The eligibility build. On 200 the body IS a signed tx payload — it is
  // deliberately never parsed, logged, cached, signed or submitted; only
  // the HTTP status is read.
  const p = await curlJson("POST", `${OS_API}/drops/${encodeURIComponent(slug)}/mint`, slug, { minter: w, quantity: 1 });
  const status = verdictFromStatus(p.status);
  const out = { slug, status, stageType, httpStatus: p.status, fromCache: false };
  if (status === "ELIGIBLE_SIGNED" || status === "NOT_ON_LIST") saveVerdictCache(w, slug, out);
  return out;
}

// Batch over a project list (scan-wallets' PROJECTS). Only projects with a
// resolvable slug are probed; POSTs are paced and a 429 stops the batch.
export async function openseaForWallet(wallet, projects) {
  const out = [];
  let lastPostAt = 0;
  for (const p of projects) {
    const slug = resolveSlug(p);
    if (!slug) continue;
    const cached = loadVerdictCache(wallet, slug);
    if (!cached) {
      const wait = POST_PACE_MS - (Date.now() - lastPostAt);
      if (lastPostAt && wait > 0) await new Promise(r => setTimeout(r, wait));
      lastPostAt = Date.now();
    }
    const v = await checkOpenSeaEligibility(wallet, slug);
    out.push({ name: p.name, contract: p.contract, ...v });
    if (v.status === "RATE_LIMITED") break; // hard stop: free-key budget
  }
  return out;
}

// ---- CLI (only when run directly, not when imported) ----
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    const [, wallet, slug] = args;
    if (!wallet || !slug) { console.error("usage: --check <wallet> <slug>"); process.exit(1); }
    console.log(JSON.stringify(await checkOpenSeaEligibility(wallet, slug), null, 2));
  } else if (args[0] === "--coverage") {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const m = html.match(/const PROJECTS=(\[.*?\]);/s);
    if (!m) { console.error("PROJECTS list not found in index.html"); process.exit(1); }
    console.log(JSON.stringify({ authAvailable: hasOpenSeaAuth, ...slugCoverage(JSON.parse(m[1])) }, null, 2));
  } else {
    console.error("usage: opensea-leg.mjs --check <wallet> <slug> | --coverage");
    process.exit(1);
  }
}
