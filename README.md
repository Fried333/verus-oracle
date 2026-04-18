# Verus Oracle

On-chain USD pricing oracle for the Verus ecosystem. Derives prices from DEX basket reserve states, protected by multi-layer manipulation resistance.

## Overview

The Verus blockchain has a built-in DeFi protocol with fractional reserve baskets (CMMM — Constant Mean Market Maker). These baskets hold reserves of multiple currencies — including bridged stablecoins (DAI, vUSDC, vUSDT) and external assets (tBTC, vETH) — providing continuous on-chain price discovery.

This oracle reads the reserve state of every basket on every block and computes USD prices for all currencies in the Verus ecosystem. It does not rely on trade execution prices (which include AMM fees and slippage). Instead, it uses the theoretical mid-market rate derived from reserve ratios — the same rate arbitrageurs use to determine profitability.

---

## 1. Data Source

The oracle reads basket reserve state from the Verus daemon via `getcurrencystate` RPC. This returns the current reserves and `priceinreserve` ratios for every currency in the basket. Supports VRSC mainchain and all PBaaS chains (vDEX, vARRR, CHIPS) via their respective daemon connections.

```
> verus getcurrencystate "Floralis"

{
  "currencystate": {
    "reservecurrencies": [
      { "currencyid": "i5w5...", "weight": 0.125, "reserves": 59251.86, "priceinreserve": 19.6727 },
      { "currencyid": "iS8T...", "weight": 0.125, "reserves": 0.6163,   "priceinreserve": 0.0002046 },
      { "currencyid": "i9nw...", "weight": 0.125, "reserves": 12.2528,  "priceinreserve": 0.006509 },
      { "currencyid": "iGBs...", "weight": 0.125, "reserves": 29743.17, "priceinreserve": 15.8005 },
      { "currencyid": "i9oC...", "weight": 0.125, "reserves": 29779.10, "priceinreserve": 15.8196 },
      { "currencyid": "i61c...", "weight": 0.125, "reserves": 29762.42, "priceinreserve": 15.8107 },
      { "currencyid": "iC5T...", "weight": 0.125, "reserves": 10113.32, "priceinreserve": 13.4313 },
      { "currencyid": "i9nL...", "weight": 0.125, "reserves": 10825.95, "priceinreserve": 14.3777 }
    ]
  }
}
```

### What is `priceinreserve`?

`priceinreserve` = how many basket tokens 1 unit of this reserve currency is worth. It is derived from the reserve balance, weight, and total supply of the basket using the CMMM (Constant Mean Market Maker) formula.

This is the theoretical mid-market price — no fee, no slippage. It represents the rate at which the next infinitesimally small trade would execute.

### Why not use trade prices?

Trade execution prices include the AMM fee (0.025% per leg) and slippage from the reserve curve. In testing:

| Currency | Trade price | Reserve mid-price | External | Error (trade) | Error (reserve) |
|----------|------------|-------------------|----------|---------------|-----------------|
| tBTC     | $78,733    | $77,234           | $77,000  | +2.2%         | +0.3%           |
| vETH     | $2,376     | $2,429            | $2,420   | -1.8%         | +0.4%           |
| VRSC     | $0.804     | $0.804            | $0.801   | +0.4%         | +0.4%           |

Reserve mid-prices are consistently within 0.3-0.4% of external market prices.

---

## 2. USD Price Derivation

### Step 1: Stablecoin anchor

Stablecoins (DAI, vUSDC, vUSDT) are treated as $1.00 each. For any currency `X` in a basket containing a stablecoin:

```
price_usd(X) = stablecoin_priceinreserve / X_priceinreserve
```

**Why this works**: `priceinreserve` is denominated in basket tokens. If 1 DAI = 15.80 basket tokens and 1 vETH = 0.00651 basket tokens, then:

```
vETH/DAI = 15.80 / 0.00651 = 2,427 DAI per vETH = $2,427
```

### Step 2: Multiple stablecoins in one basket

When a basket has multiple stablecoins (e.g., Floralis has DAI + vUSDC + vUSDT), compute the price via each stablecoin and take a reserve-depth-weighted average:

```
price(X) = Σ(price_via_stable_i × stable_i_reserves) / Σ(stable_i_reserves)
```

### Step 3: Multi-basket depth-weighted average

When a currency appears in multiple baskets, compute the price in each basket, then combine with a depth-weighted average:

```
final_price(X) = Σ(basket_price_X × basket_stable_depth) / Σ(basket_stable_depth)
```

Where `basket_stable_depth` = total stablecoin reserves in that basket (in USD terms). Small baskets naturally self-filter — a $7k basket has only 5% weight next to a $89k basket. Even if fully manipulated, the weighted average barely moves.

### Step 4: Price cascade

Not every currency shares a basket with a stablecoin. The oracle derives prices through a cascade:

```
Level 1: Stablecoins = $1.00 (axiom, verified by external guard rail)
Level 2: tBTC, vETH = priceinreserve ratio vs stablecoins (verified by external guard rail)
Level 3: VRSC = priceinreserve ratio vs stablecoins (depth-weighted)
Level 4: Tokens = priceinreserve ratio vs VRSC, then × VRSC_usd
Level 5: PBaaS native (vDEX, vARRR, CHIPS) = on-chain ratio vs VRSC, then × VRSC_usd
```

Each step uses the deepest available liquidity path.

---

## 3. EMA Smoothing

Raw reserve prices can spike temporarily if a large trade imbalances the reserves. The oracle applies an Exponential Moving Average (EMA) with a 10-minute half-life to smooth out transient spikes, inspired by [Curve Finance's internal oracle](https://docs.curve.fi/stableswap-exchange/stableswap-ng/pools/oracles/).

### Formula

```
elapsed = seconds since last update
alpha   = 1 - exp(-elapsed / HALF_LIFE)
alpha   = min(alpha, MAX_ALPHA)             // cap to prevent stale-reset attack
ema     = prev_ema × (1 - alpha) + spot × alpha
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| HALF_LIFE | 600 seconds (10 min) | Long enough to smooth manipulation, short enough to track real moves |
| MAX_ALPHA | 0.5 | After long dormancy, first observation gets at most 50% weight |

### How alpha behaves

| Elapsed time | Alpha | Weight of new observation |
|-------------|-------|--------------------------|
| 1 min (1 block) | 0.095 | 9.5% |
| 5 min | 0.394 | 39.4% |
| 10 min | 0.500 | 50.0% (capped) |
| 30 min | 0.500 | 50.0% (capped) |

A single-block spike moves the EMA less than 1%. After 10 minutes at a sustained new price, the EMA is 50% converged. After 30 minutes, 87.5% converged.

---

## 4. External Guard Rails

External prices for anchor assets are polled every 5 minutes from multiple sources as a sanity check. Guard rails do NOT set prices — they only reject suspicious on-chain prices. On-chain reserve data remains the primary source.

### Sources

| Asset | Primary | Fallback |
|-------|---------|----------|
| BTC | CoinGecko API | Binance API |
| ETH | CoinGecko API | Binance API |
| DAI | CoinGecko API | CoinMarketCap API |
| USDC | CoinGecko API | CoinMarketCap API |
| USDT | CoinGecko API | CoinMarketCap API |

### Guard rail logic

```
deviation = abs(on_chain_price - external_price) / external_price × 100

< 2%    HEALTHY    Accept on-chain price
2-5%    WARNING    Accept on-chain price, log alert
> 5%    REJECT     Keep last known good price, log alert
```

### Stablecoin depeg detection

All stablecoins on Verus are bridged from Ethereum (no native stablecoins). Their value depends on both the external stablecoin AND the bridge. The external price check catches both a real depeg and a bridge exploit.

```
if external_stable_price deviates > 2% from $1.00:
    remove that stablecoin from anchor set
    remaining stables continue anchoring
    if ALL stables depegged: fall back to BTC/ETH ratios only
```

---

## 5. Manipulation Resistance

### Why manipulation is economically infeasible

The Verus DeFi ecosystem forms a connected liquidity graph. Every basket shares VRSC as a common reserve. VRSC connects to global markets through tBTC and vETH bridges. This creates a multi-hop arbitrage path from any asset to external markets:

```
Small token → VRSC (basket arb) → tBTC/vETH (basket arb) → BTC/ETH (bridge arb)
```

Even Verus-native tokens can't be sustainably pumped — pumping a token dumps VRSC into the basket, creating an arb opportunity against deeper baskets, which in turn creates a bridge arb to external markets. Two automatic arb hops correct any deviation.

To manipulate pricing, an attacker must:

1. **Overcome depth weighting** — pump deep baskets, not shallow ones (expensive)
2. **Overcome EMA** — sustain the pump for 30+ minutes (capital locked, losing to arb)
3. **Overcome arb bots** — every second the price is distorted, arb bots profit at the attacker's expense
4. **Overcome guard rails** — if anchor assets (BTC/ETH/stables) deviate >5%, the oracle rejects the update entirely

The cost of manipulation scales with: basket depth × time sustained × number of arb bots active.

### Attack surface summary

| Attack vector | Defense | Impact |
|---------------|---------|--------|
| Small basket pump | Depth-weighted avg | <1.2% oracle shift from 24% pump |
| Sustained manipulation | EMA smoothing | Attacker pays arb bots continuously |
| Multi-basket coordinated | Arb graph | Every basket connected to external via VRSC |
| Stablecoin depeg | External guard rail | Depegged stable removed from anchor set |
| Bridge exploit | External guard rail | tBTC/vETH diverge from BTC/ETH → caught |
| Stale EMA reset | Alpha cap (0.5) | First observation after dormancy gets max 50% weight |
| New basket injection | Minimum age | Probationary period before oracle inclusion |
| Native token pump | Double arb | Token→VRSC→external, self-correcting |

---

## 6. Confidence Score

Each price receives a confidence score (0-100):

| Factor | Points |
|--------|--------|
| Basket depth > $50k | +30 |
| Basket depth > $10k (but ≤$50k) | +20 |
| Basket depth > $1k (but ≤$10k) | +10 |
| Direct stablecoin pricing (no hop) | +20 |
| Multiple baskets agree within 1% | +20 |
| Updated within last 10 blocks | +10 |
| External guard rail status = healthy | +10 |
| Stale > 100 blocks | -30 |

Prices with confidence < 30 are marked "indicative" and not used for downstream calculations (portfolio values, tax exports, etc.).

---

## 7. Architecture

```
┌─────────────────────────────────────────────┐
│              External Guard Rails            │
│  CoinGecko / Binance / CMC → BTC ETH DAI    │
│  Poll every 5 min, reject >5% deviation     │
└──────────────────┬──────────────────────────┘
                   │ reject / accept
┌──────────────────▼──────────────────────────┐
│              EMA Smoothing                   │
│  Per-currency, 10min half-life, alpha≤0.5   │
└──────────────────┬──────────────────────────┘
                   │ smoothed price
┌──────────────────▼──────────────────────────┐
│         Depth-Weighted Average               │
│  All baskets containing currency X           │
│  Weight = stablecoin reserve depth           │
└──────────────────┬──────────────────────────┘
                   │ per-basket prices
┌──────────────────▼──────────────────────────┐
│         Reserve Price Extraction             │
│  getcurrencystate → priceinreserve ratios   │
│  Cross-ref vs stablecoins = USD price       │
│  Every block, all chains (VRSC + PBaaS)     │
└─────────────────────────────────────────────┘
```

---

## 8. Data Model

```sql
CREATE TABLE prices (
    currency_id     VARCHAR(64) PRIMARY KEY,
    usd_price       NUMERIC(38,18) NOT NULL,
    ema_price       NUMERIC(38,18),
    source          VARCHAR(32) DEFAULT 'reserve',
    source_block    INT,
    source_basket   VARCHAR(64),
    confidence      SMALLINT DEFAULT 0,
    status          VARCHAR(16) DEFAULT 'healthy',
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE price_history (
    currency_id     VARCHAR(64),
    usd_price       NUMERIC(38,18),
    block_height    INT,
    source_basket   VARCHAR(64),
    confidence      SMALLINT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (currency_id, block_height)
);

CREATE TABLE guard_rail_checks (
    id              SERIAL PRIMARY KEY,
    currency_id     VARCHAR(64),
    on_chain_price  NUMERIC(38,18),
    external_price  NUMERIC(38,18),
    deviation_pct   NUMERIC(8,4),
    status          VARCHAR(16),
    external_source VARCHAR(32),
    checked_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 9. Configuration

```env
# Chain RPC (auto-discovers PBaaS from ~/.verus/pbaas/)
VERUS_RPC_URL=http://127.0.0.1:27486

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/oracle_lab

# EMA
EMA_HALF_LIFE_SECONDS=600
EMA_MAX_ALPHA=0.5

# Guard rails
GUARD_RAIL_POLL_SECONDS=300
GUARD_RAIL_WARN_PCT=2
GUARD_RAIL_REJECT_PCT=5
STABLE_DEPEG_THRESHOLD_PCT=2

# External sources
COINGECKO_API_URL=https://api.coingecko.com/api/v3
BINANCE_API_URL=https://api.binance.com/api/v3
CMC_API_URL=https://pro-api.coinmarketcap.com/v1
CMC_API_KEY=

# Basket filtering
MIN_BASKET_AGE_BLOCKS=1000
```

---

## 10. Worked Examples

All examples use real on-chain data from block 4,029,296 (April 18, 2026).

### Example A: tBTC — single basket, multiple stablecoins

```
Input: getcurrencystate("Floralis")

Reserve data:
  tBTC:   priceinreserve = 0.00020455
  DAI:    priceinreserve = 15.80829    reserves = $29,769
  vUSDT:  priceinreserve = 15.80994    reserves = $29,772
  vUSDC:  priceinreserve = 15.80538    reserves = $29,763

Step 1 — Price via each stablecoin:
  via DAI:   15.80829 / 0.00020455 = $77,283.28
  via vUSDT: 15.80994 / 0.00020455 = $77,291.31
  via vUSDC: 15.80538 / 0.00020455 = $77,269.04

Step 2 — Depth-weighted average across stablecoins:
  numerator   = 77283.28 × 29769 + 77291.31 × 29772 + 77269.04 × 29763
              = 2,300,357,661 + 2,300,627,023 + 2,299,706,919
              = 6,900,691,603
  denominator = 29769 + 29772 + 29763 = 89,304
  tBTC spot   = $77,281.21

Step 3 — Only one basket has tBTC with stables → no multi-basket average.

Step 4 — EMA (prev EMA = $77,200, 60 seconds elapsed):
  alpha = 1 - exp(-60/600) = 0.0952
  EMA   = $77,200 × 0.9048 + $77,281 × 0.0952 = $77,207.71

Step 5 — Guard rail:
  External BTC (CoinGecko): $77,000
  Deviation: |77208 - 77000| / 77000 = 0.27% → HEALTHY

Output: tBTC = $77,207.71 (EMA), confidence 80, status healthy
```

### Example B: VRSC — multiple baskets, depth-weighted

```
Input: getcurrencystate for Floralis, Bridge.vETH, Kaiju

Floralis (stable depth $89,305):
  VRSC priceinreserve = 19.6727
  DAI  priceinreserve = 15.8005
  VRSC price = 15.8005 / 19.6727 = $0.80318

Bridge.vETH (stable depth $49,974):
  VRSC priceinreserve = 15.7399
  DAI  priceinreserve = 12.6510
  VRSC price = 12.6510 / 15.7399 = $0.80374

Kaiju (stable depth $6,618):
  VRSC priceinreserve = 4.8783
  DAI  priceinreserve = 3.9438
  VRSC price = 3.9438 / 4.8783 = $0.80848

Depth-weighted average:
  = (0.80318 × 89305 + 0.80374 × 49974 + 0.80848 × 6618)
    / (89305 + 49974 + 6618)
  = (71729 + 40171 + 5350) / 145897
  = $0.80354

Spread across baskets: 0.2%

Confidence:
  Floralis depth $89k > $50k           → +30
  Direct stablecoin anchor             → +20
  3 baskets agree within 0.2%          → +20
  Updated this block                   → +10
  BTC/ETH guard rail healthy           → +10
  VRSC confidence = 90/100
```

### Example C: NATI — cascade pricing via VRSC (no stablecoin in basket)

```
NATI basket has VRSC + NATI only (no stablecoins)

Step 1 — Get VRSC price from Example B: $0.80354

Step 2 — Get NATI/VRSC ratio from NATI basket reserves:
  VRSC priceinreserve = 19.67
  NATI priceinreserve = 6,842.31
  NATI/VRSC = 19.67 / 6,842.31 = 0.002874

Step 3 — Convert to USD:
  NATI_usd = $0.80354 × 0.002874 = $0.002309

Confidence: 40/100 (no direct stablecoin, single basket)
```

### Example D: Pump attack on small basket

```
Normal state: VRSC = $0.804 across all baskets

Attack: Someone pumps VRSC to $1.00 in Kaiju basket ($7k depth)

Step 1 — Depth-weighted spot price:
  Floralis  $0.804 × 61.1% = 0.4913
  Bridge    $0.804 × 34.2% = 0.2750
  Kaiju     $1.000 ×  4.5% = 0.0450
  Spot = $0.8113 (+0.9% from normal)

Step 2 — EMA smoothing (alpha = 0.095 for 1 block):
  EMA = $0.804 × 0.905 + $0.8113 × 0.095 = $0.8047 (+0.09%)

Step 3 — Arb bots respond:
  Block 0:  Pump hits   → spot $0.8113 → EMA $0.8050  (+0.12%)
  Block 1:  Arb starts  → spot $0.8100 → EMA $0.8055  (+0.19%)  ← peak
  Block 2:  Arb ongoing → spot $0.8060 → EMA $0.8055  (+0.19%)
  Block 5:  Fully arbed → spot $0.8040 → EMA $0.8054  (+0.17%)
  Block 10: Settled      → EMA $0.8048                 (+0.10%)
  Block 20:              → EMA $0.8042                 (+0.02%)
  Block 30:              → EMA $0.8040                 (0.00%)

Result: 24% pump in small basket → peak oracle deviation of 0.19%
The attacker lost money to arb bots for a 0.19% blip lasting ~30 minutes.
```

### Example E: VRSC confidence score calculation

```
Factor                              Points
─────────────────────────────────────────
Floralis depth $89k > $50k           +30
Direct stablecoin anchor (DAI)       +20
3 baskets agree within 0.2%          +20
Updated this block                   +10
BTC/ETH guard rail healthy           +10
─────────────────────────────────────────
Total                                 90

VRSC confidence = 90/100 → high confidence, used for all downstream pricing
```

Compare with NATI:
```
Factor                              Points
─────────────────────────────────────────
Basket depth $7k > $1k               +10
No direct stablecoin (cascade)         +0
Single basket (no cross-check)         +0
Updated this block                   +10
Guard rail N/A (no external)           +0
Stale? No                             +0
─────────────────────────────────────────
Total                                 20

NATI confidence = 20/100 → low confidence, marked "indicative"
```

---

## License

MIT
