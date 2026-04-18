// Oracle v2 worker — reserve-based pricing with EMA + guard rails.
// Polls getcurrencystate for all baskets, computes depth-weighted USD prices,
// applies EMA smoothing, checks external guard rails for BTC/ETH/stables.

import { VerusRpc } from "./rpc.mjs";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const OUT = process.env.OUT_DIR || "./out";
mkdirSync(OUT, { recursive: true });
const PRICES_PATH = `${OUT}/prices.json`;
const HISTORY_PATH = `${OUT}/price-history.jsonl`;
const GUARD_PATH = `${OUT}/guard-checks.jsonl`;

function loadPrices() {
  if (!existsSync(PRICES_PATH)) return {};
  return JSON.parse(readFileSync(PRICES_PATH, "utf8"));
}
function savePrices(prices) {
  writeFileSync(PRICES_PATH, JSON.stringify(prices, null, 2));
}
function appendHistory(entry) {
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n");
}
function appendGuard(entry) {
  appendFileSync(GUARD_PATH, JSON.stringify(entry) + "\n");
}

// Multi-chain RPC — VRSC + PBaaS daemons
const chains = new Map();
chains.set("vrsc", new VerusRpc());

// Discover PBaaS chains from conf files
import { homedir } from "os";

try {
  const pbaasDir = join(homedir(), ".verus", "pbaas");
  for (const d of readdirSync(pbaasDir)) {
    const confPath = join(pbaasDir, d, `${d}.conf`);
    try {
      const conf = readFileSync(confPath, "utf8");
      const user = conf.match(/^rpcuser=(.+)/m)?.[1]?.trim();
      const pass = conf.match(/^rpcpassword=(.+)/m)?.[1]?.trim();
      const port = conf.match(/^rpcport=(.+)/m)?.[1]?.trim();
      if (!user || !pass || !port) continue;
      const pbaasRpc = new VerusRpc();
      pbaasRpc._url = `http://127.0.0.1:${port}`;
      pbaasRpc._user = user;
      pbaasRpc._pass = pass;
      pbaasRpc.call = async function(method, params = []) {
        const res = await fetch(this._url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${this._user}:${this._pass}`).toString("base64") },
          body: JSON.stringify({ jsonrpc: "1.0", id: "oracle", method, params }),
        });
        const json = await res.json();
        if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
        return json.result;
      };
      // Test connection and get chain name
      try {
        const info = await pbaasRpc.call("getinfo");
        const name = info.name?.toLowerCase();
        if (name) { chains.set(name, pbaasRpc); console.log(`  PBaaS: ${name} on port ${port}`); }
      } catch {}
    } catch {}
  }
} catch {}

console.log(`  ${chains.size} chain(s) connected: ${[...chains.keys()].join(", ")}`);

// --- Config ---
const EMA_HALF_LIFE = 600;   // seconds
const EMA_MAX_ALPHA = 0.5;
const GUARD_WARN_PCT = 2;
const GUARD_REJECT_PCT = 5;
const POLL_SECONDS = 60;
const HISTORY_EVERY_N = 10;  // snapshot every N polls
const MIN_BASKET_AGE = 1000; // blocks

const STABLES = new Set([
  "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM", // DAI
  "i61cV2uicKSi1rSMQCBNQeSYC3UAi9GVzd", // vUSDC
  "i9oCSqKALwJtcv49xUKS2U2i79h1kX6NEY", // vUSDT
  // NOT EURC (iC5T) — Euro-denominated, ~$1.18 not $1
  // NOT scrvUSD (i9nL) — yield-bearing, ~$1.10 not $1
]);

const EXTERNAL_IDS = {
  "iS8TfRPfVpKo5FVfSUzfHBQxo9KuzpnqLU": "bitcoin",       // tBTC
  "i9nwxtKuVYX4MSbeULLiK2ttVi6rUEhh4X": "ethereum",       // vETH
  "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM": "dai",            // DAI
  "i61cV2uicKSi1rSMQCBNQeSYC3UAi9GVzd": "usd-coin",       // vUSDC
  "i9oCSqKALwJtcv49xUKS2U2i79h1kX6NEY": "tether",         // vUSDT
};

// --- State ---
const emaState = new Map();  // currencyId → { price, lastUpdate }
let lastBlock = 0;
let pollCount = 0;

// --- External guard rails ---
async function fetchExternalPrices() {
  const ids = [...new Set(Object.values(EXTERNAL_IDS))].join(",");
  const prices = {};

  // CoinGecko
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const data = await res.json();
    for (const [cid, cgId] of Object.entries(EXTERNAL_IDS)) {
      if (data[cgId]?.usd) prices[cid] = { price: data[cgId].usd, source: "coingecko" };
    }
  } catch (e) { console.warn("[guard] CoinGecko error:", e.message); }

  // Binance fallback for BTC + ETH
  try {
    const [btcRes, ethRes] = await Promise.all([
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
      fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
    ]);
    const btc = await btcRes.json();
    const eth = await ethRes.json();
    const tbtcId = "iS8TfRPfVpKo5FVfSUzfHBQxo9KuzpnqLU";
    const vethId = "i9nwxtKuVYX4MSbeULLiK2ttVi6rUEhh4X";
    if (!prices[tbtcId] && btc.price) prices[tbtcId] = { price: parseFloat(btc.price), source: "binance" };
    if (!prices[vethId] && eth.price) prices[vethId] = { price: parseFloat(eth.price), source: "binance" };
  } catch (e) { console.warn("[guard] Binance error:", e.message); }

  return prices;
}

function checkGuardRail(currencyId, onChainPrice, externalPrices) {
  const ext = externalPrices[currencyId];
  if (!ext) return { status: "no_external", deviation: null };
  const deviation = Math.abs(onChainPrice - ext.price) / ext.price * 100;
  let status = "healthy";
  if (deviation > GUARD_REJECT_PCT) status = "rejected";
  else if (deviation > GUARD_WARN_PCT) status = "warning";
  return { status, deviation, externalPrice: ext.price, source: ext.source };
}

// --- Basket discovery (all chains) ---
async function discoverBaskets() {
  const allBaskets = [];

  for (const [chainId, chainRpc] of chains) {
    try {
      const all = await chainRpc.call("listcurrencies", [{ systemtype: "local" }]);
      const info = await chainRpc.call("getinfo");
      const tip = info.blocks;

      const baskets = all
        .filter(c => {
          const def = c.currencydefinition;
          const curs = def?.currencies ? Object.keys(def.currencies) : [];
          const isFractional = (def?.options & 32) !== 0;
          const hasReserves = curs.length >= 2;
          const oldEnough = (tip - (def?.startblock || 0)) > MIN_BASKET_AGE;
          return isFractional && hasReserves && oldEnough;
        })
        .map(c => ({
          name: c.currencydefinition.fullyqualifiedname,
          id: c.currencydefinition.currencyid,
          chainId,
          rpc: chainRpc,
          reserveIds: Object.keys(c.currencydefinition.currencies),
        }));

      allBaskets.push(...baskets);
    } catch (e) {
      console.warn(`[discover] ${chainId}: ${e.message.slice(0, 60)}`);
    }
  }

  return allBaskets;
}

// --- Price computation ---
function computeBasketPrices(reserves) {
  const stableReserves = reserves.filter(r => STABLES.has(r.currencyid));
  if (stableReserves.length === 0) return null;

  const totalStableDepth = stableReserves.reduce((s, r) => s + r.reserves, 0);
  if (totalStableDepth < 1) return null;

  // Average stablecoin priceinreserve (weighted by reserve depth)
  const stablePir = stableReserves.reduce((s, r) => s + r.priceinreserve * r.reserves, 0) / totalStableDepth;

  const prices = {};
  for (const r of reserves) {
    if (STABLES.has(r.currencyid)) {
      prices[r.currencyid] = 1.0; // stablecoins = $1
    } else if (r.priceinreserve > 0) {
      prices[r.currencyid] = stablePir / r.priceinreserve;
    }
  }

  return { prices, stableDepth: totalStableDepth };
}

function applyEma(currencyId, spotPrice, now) {
  const prev = emaState.get(currencyId);
  if (!prev) {
    emaState.set(currencyId, { price: spotPrice, lastUpdate: now });
    return spotPrice;
  }

  const elapsed = (now - prev.lastUpdate) / 1000;
  let alpha = 1 - Math.exp(-elapsed / EMA_HALF_LIFE);
  alpha = Math.min(alpha, EMA_MAX_ALPHA);

  const ema = prev.price * (1 - alpha) + spotPrice * alpha;
  emaState.set(currencyId, { price: ema, lastUpdate: now });
  return ema;
}

// --- Main loop ---
async function poll() {
  const now = new Date();
  const vrscRpc = chains.get("vrsc");
  const info = await vrscRpc.call("getinfo");
  const tip = info.blocks;
  if (tip === lastBlock) return;
  lastBlock = tip;
  pollCount++;

  // Discover baskets (refresh every 100 polls)
  if (pollCount === 1 || pollCount % 100 === 0) {
    const baskets = await discoverBaskets();
    console.log(`[${now.toISOString()}] discovered ${baskets.length} baskets`);
    global._baskets = baskets;
  }
  const baskets = global._baskets || [];

  // Collect per-currency prices from all baskets
  const currencyPrices = new Map(); // currencyId → [{ price, depth, basket }]

  for (const basket of baskets) {
    try {
      const state = await basket.rpc.call("getcurrencystate", [basket.name]);
      const cs = state[0]?.currencystate;
      if (!cs?.reservecurrencies) continue;

      const result = computeBasketPrices(cs.reservecurrencies);
      if (!result) continue;

      for (const [cid, price] of Object.entries(result.prices)) {
        if (!currencyPrices.has(cid)) currencyPrices.set(cid, []);
        currencyPrices.get(cid).push({ price, depth: result.stableDepth, basket: basket.name });
      }
    } catch {}
  }

  if (currencyPrices.size === 0) return;

  // Fetch external prices for guard rails (every 5 polls ≈ 5 min)
  let externalPrices = {};
  if (pollCount === 1 || pollCount % 5 === 0) {
    externalPrices = await fetchExternalPrices();
    global._externalPrices = externalPrices;

    // Log guard rail checks
    for (const [cid, ext] of Object.entries(externalPrices)) {
      const entries = currencyPrices.get(cid);
      if (!entries) continue;
      const totalDepth = entries.reduce((s, e) => s + e.depth, 0);
      const weightedPrice = entries.reduce((s, e) => s + e.price * e.depth, 0) / totalDepth;
      const check = checkGuardRail(cid, weightedPrice, externalPrices);
      appendGuard({ currency_id: cid, on_chain: weightedPrice, external: check.externalPrice, deviation: check.deviation, status: check.status, source: check.source, at: now.toISOString() });
    }
  }
  externalPrices = global._externalPrices || {};

  // Compute depth-weighted average + EMA for each currency
  let updated = 0;
  for (const [cid, entries] of currencyPrices) {
    const totalDepth = entries.reduce((s, e) => s + e.depth, 0);
    const weightedPrice = entries.reduce((s, e) => s + e.price * e.depth, 0) / totalDepth;
    const bestBasket = entries.sort((a, b) => b.depth - a.depth)[0].basket;

    // Guard rail check — reject if >5% deviation from external
    const guard = checkGuardRail(cid, weightedPrice, externalPrices);
    if (guard.status === "rejected") {
      console.log(`[guard] REJECTED ${cid.slice(0, 8)} on-chain=$${weightedPrice.toFixed(4)} ext=$${guard.externalPrice.toFixed(4)} dev=${guard.deviation.toFixed(1)}%`);
      continue;
    }

    const emaPrice = applyEma(cid, weightedPrice, now);

    // Confidence score
    let confidence = 0;
    if (totalDepth > 50000) confidence += 30;
    else if (totalDepth > 10000) confidence += 20;
    else if (totalDepth > 1000) confidence += 10;
    if (entries.some(e => STABLES.has(cid) || entries.length > 0)) confidence += 20; // has stablecoin anchor
    if (entries.length > 1) {
      const prices = entries.map(e => e.price);
      const spread = (Math.max(...prices) - Math.min(...prices)) / weightedPrice;
      if (spread < 0.01) confidence += 20; // baskets agree within 1%
    }
    confidence += 10; // freshness (we just polled)
    if (guard.status === "healthy") confidence += 10;
    else if (guard.status === "warning") confidence += 5;
    confidence = Math.min(100, confidence);

    const status = guard.status === "no_external" ? "healthy" : guard.status;

    const allPrices = loadPrices();
    allPrices[cid] = { usd_price: weightedPrice, ema_price: emaPrice, source: "reserve", source_block: tip, source_basket: bestBasket, confidence, status, updated_at: now.toISOString() };
    savePrices(allPrices);
    updated++;

    // Price history snapshot
    if (pollCount % HISTORY_EVERY_N === 0) {
      appendHistory({ currency_id: cid, usd_price: emaPrice, block: tip, basket: bestBasket, confidence, at: now.toISOString() });
    }
  }

  if (pollCount % 10 === 0 || pollCount === 1) {
    const sample = [...currencyPrices.entries()].slice(0, 3).map(([cid, e]) => {
      const p = e.reduce((s, x) => s + x.price * x.depth, 0) / e.reduce((s, x) => s + x.depth, 0);
      return `${cid.slice(0, 6)}=$${p.toFixed(4)}`;
    }).join(" ");
    console.log(`[${now.toISOString()}] block ${tip} updated ${updated} prices (${sample})`);
  }
}

// --- Entry ---
console.log("oracle v2 worker starting");
console.log(`  EMA half-life: ${EMA_HALF_LIFE}s, max alpha: ${EMA_MAX_ALPHA}`);
console.log(`  guard rails: warn=${GUARD_WARN_PCT}% reject=${GUARD_REJECT_PCT}%`);
console.log(`  poll interval: ${POLL_SECONDS}s`);
console.log();

// Initial poll
await poll();

// Poll loop
setInterval(async () => {
  try { await poll(); }
  catch (e) { console.error("[poll error]", e.message); }
}, POLL_SECONDS * 1000);
