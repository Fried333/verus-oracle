# Oracle v2 — Technical Specification

## 1. Data Source

The oracle reads basket reserve state from the Verus daemon via `getcurrencystate` RPC. This returns the current reserves and `priceinreserve` ratios for every currency in the basket.

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

#### Calculation example — tBTC in Floralis:

```
Floralis reserves:
  tBTC:  priceinreserve = 0.00020455
  DAI:   priceinreserve = 15.80829,  reserves = $29,769
  vUSDT: priceinreserve = 15.80994,  reserves = $29,772
  vUSDC: priceinreserve = 15.80538,  reserves = $29,763

Price via each stable:
  via DAI:   15.80829 / 0.00020455 = $77,283.28
  via vUSDT: 15.80994 / 0.00020455 = $77,291.31
  via vUSDC: 15.80538 / 0.00020455 = $77,269.04

Weighted average:
  = ($77,283.28 × 29,769 + $77,291.31 × 29,772 + $77,269.04 × 29,763)
    / (29,769 + 29,772 + 29,763)
  = $77,281.21
```

### Step 3: Multi-basket depth-weighted average

When a currency appears in multiple baskets, compute the price in each basket (step 2), then combine with a depth-weighted average:

```
final_price(X) = Σ(basket_price_X × basket_stable_depth) / Σ(basket_stable_depth)
```

Where `basket_stable_depth` = total stablecoin reserves in that basket (in USD terms).

#### Calculation example — VRSC across 3 baskets:

```
Floralis:     VRSC = $0.8036  |  stable depth = $89,305  →  weight 61.1%
Bridge.vETH:  VRSC = $0.8032  |  stable depth = $49,974  →  weight 34.2%
Kaiju:        VRSC = $0.8049  |  stable depth = $6,618   →  weight  4.5%

VRSC = ($0.8036 × 89,305 + $0.8032 × 49,974 + $0.8049 × 6,618)
       / (89,305 + 49,974 + 6,618)
     = $0.8035

Spread: max - min = $0.8049 - $0.8032 = $0.0017 (0.2%)
```

### Step 4: Price cascade

Not every currency shares a basket with a stablecoin. Derive prices through intermediate currencies:

```
Level 1: Stablecoins = $1.00 (axiom)
Level 2: tBTC, vETH, MKR = priceinreserve ratio vs stablecoins
Level 3: VRSC = priceinreserve ratio vs stablecoins (depth-weighted)
Level 4: Tokens = priceinreserve ratio vs VRSC, then × VRSC_usd
Level 5: PBaaS native = on-chain ratio vs VRSC, then × VRSC_usd
```

#### Calculation example — NATI (no stablecoin in basket):

```
NATI basket reserves:
  NATI: priceinreserve = 6,842.31
  VRSC: priceinreserve = 19.67

NATI/VRSC ratio = 19.67 / 6,842.31 = 0.002874

NATI_usd = VRSC_usd × NATI_VRSC_ratio
         = $0.8035 × 0.002874
         = $0.002309
```

## 3. EMA Smoothing

Raw reserve prices can spike temporarily if a large trade imbalances the reserves. The oracle applies an Exponential Moving Average (EMA) with a 10-minute half-life to smooth out transient spikes.

### Formula

```
elapsed = seconds since last update
alpha = 1 - exp(-elapsed / HALF_LIFE)
alpha = min(alpha, MAX_ALPHA)          // cap to prevent stale-reset attack
ema = prev_ema × (1 - alpha) + spot × alpha
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| HALF_LIFE | 600 seconds (10 min) | Matches Curve Finance's oracle. Long enough to smooth manipulation, short enough to track real price moves |
| MAX_ALPHA | 0.5 | After long dormancy, first observation gets at most 50% weight |

### How alpha behaves

| Elapsed time | Alpha | Weight of new observation |
|-------------|-------|--------------------------|
| 1 min (1 block) | 0.095 | 9.5% |
| 5 min | 0.394 | 39.4% |
| 10 min | 0.500 | 50.0% (capped) |
| 30 min | 0.500 | 50.0% (capped) |

### Calculation example — pump smoothing:

```
State: VRSC EMA = $0.8040
Block 0: Small basket pumped → depth-weighted spot = $0.8140
  alpha = 1 - exp(-60/600) = 0.095
  EMA = $0.8040 × 0.905 + $0.8140 × 0.095 = $0.8050

Block 1: Arb starts correcting → spot = $0.8100
  alpha = 0.095
  EMA = $0.8050 × 0.905 + $0.8100 × 0.095 = $0.8055

Block 5: Fully arbed → spot = $0.8040
  alpha = 0.095
  EMA = $0.8055 × 0.905 + $0.8040 × 0.095 = $0.8054

Block 20: Settled for 15 blocks → spot = $0.8040
  EMA = $0.8042

Block 30: → EMA = $0.8040 (back to normal)

Peak deviation: 0.19%. Attacker lost money to arb bots for a 0.19% blip.
```

## 4. External Guard Rails

External BTC, ETH, and stablecoin prices are polled every 5 minutes from multiple sources as a sanity check.

### Sources

| Asset | Primary | Fallback |
|-------|---------|----------|
| BTC | CoinGecko `/simple/price?ids=bitcoin` | Binance `BTCUSDT` ticker |
| ETH | CoinGecko `/simple/price?ids=ethereum` | Binance `ETHUSDT` ticker |
| DAI | CoinGecko `/simple/price?ids=dai` | CoinMarketCap |
| USDC | CoinGecko `/simple/price?ids=usd-coin` | CoinMarketCap |
| USDT | CoinGecko `/simple/price?ids=tether` | CoinMarketCap |

### Guard rail logic

```
deviation = abs(on_chain_price - external_price) / external_price × 100

< 2%    HEALTHY    Accept on-chain price
2-5%    WARNING    Accept on-chain price, log alert
> 5%    REJECT     Keep last known good price, log alert
```

Guard rails do NOT set prices. They only reject suspicious on-chain prices. On-chain reserve data remains the primary source.

### Stablecoin depeg detection

```
if external_stable_price deviates > 2% from $1.00:
    remove that stablecoin from anchor set
    remaining stables continue anchoring
    if ALL stables depegged: fall back to BTC/ETH ratios only
```

## 5. Confidence Score

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

#### Calculation example — VRSC confidence:

```
Floralis depth $89k > $50k           → +30
Direct stablecoin anchor (DAI)       → +20
3 baskets agree within 0.2%          → +20
Updated this block                   → +10
BTC/ETH guard rail healthy           → +10
                                        ----
VRSC confidence = 90/100
```

## 6. Data Model

```sql
-- Current price per currency
CREATE TABLE prices (
    currency_id     VARCHAR(64) PRIMARY KEY,
    usd_price       NUMERIC(38,18) NOT NULL,   -- spot (depth-weighted)
    ema_price       NUMERIC(38,18),            -- EMA-smoothed price
    source          VARCHAR(32),               -- 'reserve'
    source_block    INT,
    source_basket   VARCHAR(64),               -- deepest basket used
    confidence      SMALLINT DEFAULT 0,
    status          VARCHAR(16) DEFAULT 'healthy',
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Price history for charting
CREATE TABLE price_history (
    currency_id     VARCHAR(64),
    usd_price       NUMERIC(38,18),
    block_height    INT,
    source_basket   VARCHAR(64),
    confidence      SMALLINT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (currency_id, block_height)
);

-- Guard rail audit log
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

## 7. Worker Configuration

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
STABLE_DEPEG_PCT=2

# History
HISTORY_SNAPSHOT_INTERVAL=10    # every N polls
MIN_BASKET_AGE_BLOCKS=1000     # probationary period
```

## 8. Full Worked Examples

### Example A: tBTC pricing (single basket with stablecoins)

```
Input: getcurrencystate("Floralis") at block 4,029,296

Reserve data:
  tBTC:   priceinreserve = 0.00020455
  DAI:    priceinreserve = 15.80829    reserves = $29,769
  vUSDT:  priceinreserve = 15.80994    reserves = $29,772
  vUSDC:  priceinreserve = 15.80538    reserves = $29,763

Step 1 — Price via each stable:
  via DAI:   15.80829 / 0.00020455 = $77,283.28
  via vUSDT: 15.80994 / 0.00020455 = $77,291.31
  via vUSDC: 15.80538 / 0.00020455 = $77,269.04

Step 2 — Weighted average:
  numerator = 77283.28×29769 + 77291.31×29772 + 77269.04×29763
            = 2,300,357,661 + 2,300,627,023 + 2,299,706,919
            = 6,900,691,603
  denominator = 29769 + 29772 + 29763 = 89,304
  tBTC spot = $77,281.21

Step 3 — Only one basket has tBTC with stables, so no multi-basket average needed.

Step 4 — EMA (assuming prev EMA = $77,200, 60 seconds elapsed):
  alpha = 1 - exp(-60/600) = 0.0952
  EMA = $77,200 × 0.9048 + $77,281 × 0.0952 = $77,207.71

Step 5 — Guard rail:
  External BTC (CoinGecko): $77,000
  Deviation: |77208 - 77000| / 77000 = 0.27% → HEALTHY

Output: tBTC = $77,207.71 (EMA), confidence 80, status healthy
```

### Example B: VRSC pricing (multiple baskets)

```
Input: getcurrencystate for Floralis, Bridge.vETH, Kaiju

Floralis (stable depth $89,305):
  VRSC priceinreserve = 19.6727
  DAI  priceinreserve = 15.8005
  VRSC/DAI = 15.8005 / 19.6727 = $0.80318

Bridge.vETH (stable depth $49,974):
  VRSC priceinreserve = 15.7399
  DAI  priceinreserve = 12.6510
  VRSC/DAI = 12.6510 / 15.7399 = $0.80374

Kaiju (stable depth $6,618):
  VRSC priceinreserve = 4.8783
  DAI  priceinreserve = 3.9438
  VRSC/DAI = 3.9438 / 4.8783 = $0.80848

Depth-weighted average:
  = (0.80318×89305 + 0.80374×49974 + 0.80848×6618) / (89305+49974+6618)
  = (71729 + 40171 + 5350) / 145897
  = $0.80354

Confidence: depth>$50k(+30) + stablecoin(+20) + 3 baskets agree(+20)
            + fresh(+10) + guard healthy(+10) = 90
```

### Example C: Pump attack on small basket

```
Normal state: VRSC = $0.804 across all baskets

Attack: Pump VRSC to $1.00 in Kaiju basket ($7k depth)

Depth-weighted spot:
  Floralis $0.804 × 61.1% = 0.4913
  Bridge   $0.804 × 34.2% = 0.2750
  Kaiju    $1.000 ×  4.5% = 0.0450
  Spot = $0.8113 (+0.9%)

EMA (alpha = 0.095 for 1 block):
  EMA = $0.804 × 0.905 + $0.8113 × 0.095 = $0.8047 (+0.09%)

Result: 24% pump in small basket → 0.09% oracle movement
Cost to attacker: capital locked in Kaiju + arb losses
```

### Example D: NATI pricing (no stablecoin, cascade via VRSC)

```
NATI basket has VRSC + NATI only (no stablecoins)

Step 1 — Get VRSC price from Example B: $0.80354

Step 2 — Get NATI/VRSC ratio from NATI basket:
  VRSC priceinreserve = 19.67
  NATI priceinreserve = 6,842.31
  NATI/VRSC = 19.67 / 6,842.31 = 0.002874

Step 3 — Convert to USD:
  NATI = $0.80354 × 0.002874 = $0.002309

Confidence: lower because:
  - No direct stablecoin anchor (-20 vs direct)
  - Single basket (no cross-check, -20)
  Confidence = 40
```
