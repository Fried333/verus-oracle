# Verus Oracle

On-chain USD pricing oracle for the Verus ecosystem. Derives prices from DEX basket reserve states, protected by multi-layer manipulation resistance.

## Overview

The Verus blockchain has a built-in DeFi protocol with fractional reserve baskets (CMMM — Constant Mean Market Maker). These baskets hold reserves of multiple currencies — including bridged stablecoins (DAI, vUSDC, vUSDT) and external assets (tBTC, vETH) — providing continuous on-chain price discovery.

This oracle reads the reserve state of every basket on every block and computes USD prices for all currencies in the Verus ecosystem. It does not rely on trade execution prices (which include AMM fees and slippage). Instead, it uses the theoretical mid-market rate derived from reserve ratios — the same rate arbitrageurs use to determine profitability.

## How pricing works

### Reserve-based pricing

Each basket publishes its reserve state via the `getcurrencystate` RPC. The `priceinreserve` field represents how many basket tokens one unit of a reserve currency is worth, derived directly from the reserve balances and weights.

To get a USD price, we cross-reference any currency against a stablecoin in the same basket:

```
Bridge.vETH basket reserves:
  DAI:   priceinreserve = 12.65   (1 DAI  → 12.65 basket tokens)
  vETH:  priceinreserve = 0.0052  (1 vETH → 0.0052 basket tokens)
  VRSC:  priceinreserve = 15.74   (1 VRSC → 15.74 basket tokens)

USD prices:
  vETH = 12.65 / 0.0052 = $2,433
  VRSC = 12.65 / 15.74  = $0.804
```

This gives the theoretical mid-market price — no fee, no slippage, updated every block.

### Live example: pricing tBTC

Real data from block 4,029,296 (April 18, 2026):

```
Step 1 — Get Floralis basket reserve state via getcurrencystate("Floralis")

  tBTC:   0.6163 tBTC    priceinreserve = 0.00020455
  DAI:    $29,769         priceinreserve = 15.80829
  vUSDT:  $29,772         priceinreserve = 15.80994
  vUSDC:  $29,763         priceinreserve = 15.80538

Step 2 — Cross-reference each stablecoin against tBTC

  via DAI:   15.80829 / 0.00020455 = $77,283
  via vUSDT: 15.80994 / 0.00020455 = $77,291
  via vUSDC: 15.80538 / 0.00020455 = $77,269

Step 3 — Weighted average across stablecoins (~$29.7k depth each)

  tBTC oracle price = $77,281

Step 4 — Guard rail check

  Oracle:    $77,281
  External:  $77,000 (CoinGecko + Binance)
  Deviation: 0.37% → HEALTHY (under 2% threshold)
```

tBTC is only in the Floralis basket (with stablecoins), so there's one basket in the depth-weighted average. If tBTC appeared in multiple baskets, each would contribute proportionally to its stablecoin reserve depth.

### Why not use trade prices?

Trade execution prices include the AMM fee (0.025% per leg) and slippage from the reserve curve. In testing:

| Currency | Trade price (v1) | Reserve mid-price | External | Error (trade) | Error (reserve) |
|----------|-----------------|-------------------|----------|---------------|-----------------|
| tBTC     | $78,733         | $77,234           | $77,000  | +2.2%         | +0.3%           |
| vETH     | $2,376          | $2,429            | $2,420   | -1.8%         | +0.4%           |
| VRSC     | $0.804          | $0.804            | $0.801   | +0.4%         | +0.4%           |

Reserve mid-prices are consistently within 0.3-0.4% of external market prices.

### Multi-basket depth-weighted averaging

When a currency appears in multiple baskets, the oracle computes a depth-weighted average across all of them. Each basket's price is weighted by its total stablecoin reserve depth (in USD terms).

```
Floralis:     VRSC = $0.8036  |  stable depth = $89,293  →  weight 61%
Bridge.vETH:  VRSC = $0.8032  |  stable depth = $49,974  →  weight 34%
Kaiju:        VRSC = $0.8049  |  stable depth = $6,618   →  weight  5%

Weighted average: $0.8035
Spread across baskets: 0.2%
```

Small baskets naturally self-filter. A $7k basket has only 5% influence on the final price — even if fully manipulated, the weighted average barely moves.

### Price cascade

Not every currency shares a basket with a stablecoin. The oracle derives prices through a cascade:

1. **Stablecoins** (DAI, vUSDC, vUSDT) = $1 — verified by external price check
2. **tBTC, vETH** = reserve ratio vs stablecoins in Bridge.vETH / Floralis — verified by external
3. **VRSC** = reserve ratio vs stablecoins (depth-weighted across all baskets)
4. **Tokens** (MKR, Kaiju, Pure, etc.) = reserve ratio vs VRSC or stablecoins in their basket
5. **PBaaS native** (vDEX, vARRR, CHIPS) = on-chain VRSC/native ratio × VRSC price

Each step uses the deepest available liquidity path.

## Manipulation resistance

### Layer 1: Depth-weighted averaging

A pump in a small basket barely affects the oracle because the weight is proportional to reserve depth.

**Example**: attacker pumps VRSC from $0.804 to $1.00 in Kaiju ($7k basket):

```
Weighted price = ($0.804 × 61%) + ($0.804 × 34%) + ($1.00 × 5%) = $0.814
```

A 24% pump in the small basket → only 1.2% shift in the oracle. And this is before EMA smoothing.

### Layer 2: Exponential Moving Average (EMA)

Inspired by [Curve Finance's internal oracle](https://docs.curve.fi/stableswap-exchange/stableswap-ng/pools/oracles/), the oracle applies an EMA with a 10-minute half-life to smooth out transient spikes.

```
alpha = 1 - exp(-elapsed_seconds / 600)
ema_price = prev_ema × (1 - alpha) + spot_price × alpha
```

Properties:
- A single-block spike moves the EMA less than 1%
- After 10 minutes at a sustained new price, the EMA is 50% converged
- After 30 minutes, 87.5% converged
- Alpha is capped at 0.5 to prevent stale-reset attacks (if no updates for hours, the first new observation doesn't get full weight)

**Full attack scenario** — attacker pumps Kaiju 24%, arb corrects over 5 blocks:

```
Block 0:  Pump hits → spot $0.814 → EMA moves to $0.8050  (+0.12%)
Block 1:  Arb starts → spot $0.810 → EMA $0.8055           (+0.19%)  ← peak
Block 2:  Arb continues → spot $0.806 → EMA $0.8055        (+0.19%)
Block 5:  Fully arbed → spot $0.804 → EMA $0.8054          (+0.17%)
Block 10: Settled → EMA $0.8048                              (+0.10%)
Block 20: → EMA $0.8042                                     (+0.02%)
Block 30: → EMA $0.8040                                     (0.00%)
```

Peak oracle deviation: **0.19%**. The attacker lost money to arb bots for a 0.19% blip lasting ~30 minutes.

### Layer 3: External guard rails

External prices for anchor assets are polled every 5 minutes from multiple sources:

| Asset | Source 1 | Source 2 |
|-------|----------|----------|
| BTC   | CoinGecko API | Binance API |
| ETH   | CoinGecko API | Binance API |
| DAI   | CoinGecko API | CoinMarketCap API |
| USDC  | CoinGecko API | CoinMarketCap API |
| USDT  | CoinGecko API | CoinMarketCap API |

Guard rail logic:
```
deviation = abs(on_chain_price - external_price) / external_price

< 2%   →  HEALTHY    accept on-chain price
2-5%   →  WARNING    accept on-chain price, log alert
> 5%   →  REJECT     keep last known good price, alert
```

For stablecoins, an additional check: if external price deviates >2% from $1.00, the stablecoin is removed from the anchor set. Remaining stables continue to anchor the system. If ALL stables depeg, fall back to BTC/ETH anchoring only.

**Important**: external prices are guard rails, not the price source. On-chain reserve prices remain primary. External data only triggers rejection of suspicious updates.

### Why manipulation is economically infeasible

The Verus DeFi ecosystem forms a connected liquidity graph. Every basket shares VRSC as a common reserve. VRSC connects to global markets through tBTC and vETH bridges. This creates a multi-hop arbitrage path from any asset to external markets:

```
Small token → VRSC (basket arb) → tBTC/vETH (basket arb) → BTC/ETH (bridge arb)
```

To manipulate pricing, an attacker must:

1. **Overcome depth weighting** — pump deep baskets, not shallow ones (expensive)
2. **Overcome EMA** — sustain the pump for 30+ minutes (capital locked, losing to arb)
3. **Overcome arb bots** — every second the price is distorted, arb bots profit at the attacker's expense
4. **Overcome guard rails** — if anchor assets (BTC/ETH/stables) deviate >5%, the oracle rejects the update entirely

The cost of manipulation scales with: basket depth × time sustained × number of arb bots active. In practice, arb bots correct deviations within minutes, making sustained manipulation prohibitively expensive.

### Attack surface summary

| Attack vector | Defense | Impact |
|---------------|---------|--------|
| Small basket pump | Depth-weighted avg | <1.2% oracle shift from 24% pump |
| Sustained manipulation | EMA smoothing | Attacker pays arb bots continuously |
| Multi-basket coordinated | Arb graph | Every basket connected to external via VRSC |
| Stablecoin depeg | External guard rail | Depegged stable removed from anchor set |
| Bridge exploit | External guard rail | tBTC/vETH diverge from BTC/ETH → rejected |
| Stale EMA reset | Alpha cap (0.5) | First observation after dormancy gets max 50% weight |
| New basket injection | Minimum age | Probationary period before oracle inclusion |
| Native token pump | Double arb | Token→VRSC→external, self-correcting |

## Architecture

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
│  Every block, every basket                  │
└─────────────────────────────────────────────┘
```

## Data model

```sql
-- Current prices (one row per currency)
CREATE TABLE oracle_prices (
    currency_id     VARCHAR(64) PRIMARY KEY,
    usd_price       NUMERIC(38,18) NOT NULL,
    ema_price       NUMERIC(38,18) NOT NULL,
    source_basket   VARCHAR(64),
    source_block    INT,
    confidence      SMALLINT,           -- 0-100
    status          VARCHAR(16),        -- healthy / warning / stale / rejected
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Price history (for charting)
CREATE TABLE oracle_price_history (
    currency_id     VARCHAR(64),
    usd_price       NUMERIC(38,18),
    block_height    INT,
    source_basket   VARCHAR(64),
    confidence      SMALLINT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (currency_id, block_height)
);

-- Guard rail check log
CREATE TABLE oracle_guard_checks (
    id              SERIAL PRIMARY KEY,
    currency_id     VARCHAR(64),
    on_chain_price  NUMERIC(38,18),
    external_price  NUMERIC(38,18),
    deviation_pct   NUMERIC(8,4),
    status          VARCHAR(16),        -- healthy / warning / rejected
    external_source VARCHAR(32),        -- coingecko / binance / cmc
    checked_at      TIMESTAMPTZ DEFAULT NOW()
);
```

## Confidence scoring

Each price receives a confidence score (0-100):

| Factor | Points |
|--------|--------|
| Basket depth > $50k | +30 |
| Basket depth > $10k | +20 |
| Stablecoin in basket (direct pricing) | +20 |
| Multiple baskets agree within 1% | +20 |
| Updated within last 10 blocks | +10 |
| External guard rail healthy | +10 |
| Deductions: stale > 100 blocks | -30 |

Prices with confidence < 30 are shown as "indicative" and not used for downstream calculations.

## Configuration

```env
# Basket polling
POLL_INTERVAL_BLOCKS=1          # Check reserves every N blocks

# EMA
EMA_HALF_LIFE_SECONDS=600      # 10 minutes
EMA_MAX_ALPHA=0.5              # Cap for stale reset protection

# Guard rails
GUARD_RAIL_POLL_SECONDS=300    # External price check every 5 min
GUARD_RAIL_WARN_PCT=2          # Warning threshold
GUARD_RAIL_REJECT_PCT=5        # Rejection threshold
STABLE_DEPEG_THRESHOLD_PCT=2   # Remove stable from anchor set

# External sources
COINGECKO_API_URL=https://api.coingecko.com/api/v3
BINANCE_API_URL=https://api.binance.com/api/v3
CMC_API_URL=https://pro-api.coinmarketcap.com/v1
CMC_API_KEY=                   # Optional, for stablecoin checks

# Minimum basket age before inclusion
MIN_BASKET_AGE_BLOCKS=1000
```

## License

MIT
