# Verus Oracle

On-chain USD pricing oracle for the Verus ecosystem. Derives prices from DEX basket reserve states, protected by depth-weighting + EMA smoothing + external guard rails. No trade execution prices, no per-tx middleware — purely a read-side observer of `getcurrencystate`.

## Table of contents

- [What you get](#what-you-get)
- [What you provide](#what-you-provide)
- [Quick start](#quick-start)
- [Pricing methodology](#pricing-methodology)
  - [Data source](#data-source-priceinreserve)
  - [USD derivation cascade](#usd-derivation-cascade)
  - [EMA smoothing](#ema-smoothing)
  - [External guard rails](#external-guard-rails)
  - [Manipulation resistance](#manipulation-resistance)
  - [Confidence score](#confidence-score)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Worked examples](#worked-examples)
- [Operating in production](#operating-in-production)
- [License](#license)
- [Disclaimer](#disclaimer)

## What you get

- USD price for every currency in the Verus ecosystem (VRSC, PBaaS natives, basket tokens, bridged stablecoins, tBTC, vETH, and every basket-listed token)
- A confidence score (0-100) per price — low-confidence prices are flagged as "indicative" so downstream consumers know not to settle on them
- Tracked status (`healthy` / `warning` / `rejected`) per price, with the external-guard-rail check that produced it
- Full price history table for charting + audit

## What you provide

- A local `verusd` (with PBaaS chains running if you want pricing for vDEX / vARRR / CHIPS native tokens)
- PostgreSQL for the price + history + guard-rail tables
- Node.js 20+
- Outbound HTTPS access for the guard rails (CoinGecko, Binance, optionally CMC)

The oracle is **read-only on-chain** — it never broadcasts a transaction.

## Quick start

```bash
git clone https://github.com/Fried333/verus-oracle.git
cd verus-oracle
npm install

cp .env.example .env             # if absent, build one from the Configuration section below
$EDITOR .env                     # fill VERUS_RPC_URL + DATABASE_URL

# Create tables (see Data model section for schema)
psql $DATABASE_URL < schema.sql  # or apply the CREATE TABLE statements inline

npm start
```

Sanity check after a few seconds (one block worth of data):

```bash
psql $DATABASE_URL -c "select currency_id, usd_price, confidence, status, updated_at from prices order by updated_at desc limit 10;"
```

## Pricing methodology

### Data source: `priceinreserve`

The oracle reads basket reserve state via `getcurrencystate`:

```
> verus getcurrencystate "Floralis"

{
  "currencystate": {
    "reservecurrencies": [
      { "currencyid": "i5w5...", "weight": 0.125, "reserves": 59251.86, "priceinreserve": 19.6727 },
      { "currencyid": "iS8T...", "weight": 0.125, "reserves": 0.6163,   "priceinreserve": 0.0002046 },
      …
    ]
  }
}
```

`priceinreserve` = how many basket tokens 1 unit of this reserve currency is worth, derived from reserve balance + weight + total supply via the CMMM (Constant Mean Market Maker) formula. **Theoretical mid-market price — no fee, no slippage.** Same rate arbitrageurs use to determine profitability.

**Why not trade execution prices?** They include the 0.025% per-leg AMM fee and slippage from the reserve curve. Reserve mid-prices are consistently within 0.3-0.4% of external markets vs ~2% for trade prices.

### USD derivation cascade

```
Level 1: Stablecoins (DAI, vUSDC, vUSDT) = $1.00            (verified by guard rail)
Level 2: tBTC, vETH                       = priceinreserve vs stables (guard rail)
Level 3: VRSC                              = priceinreserve vs stables, depth-weighted
Level 4: Tokens                            = priceinreserve vs VRSC, then × VRSC_usd
Level 5: PBaaS native (vDEX, vARRR, CHIPS) = on-chain ratio vs VRSC, then × VRSC_usd
```

Each step uses the deepest available liquidity path.

**Same-basket multi-stable:** when a basket has DAI + vUSDC + vUSDT, compute the price via each stablecoin and depth-weight:
```
price(X) = Σ(price_via_stable_i × stable_i_reserves) / Σ(stable_i_reserves)
```

**Multi-basket depth-weighted:** when a currency appears in multiple baskets:
```
final_price(X) = Σ(basket_price_X × basket_stable_depth) / Σ(basket_stable_depth)
```

A $7k basket has only 5% weight next to an $89k basket — small baskets self-filter, manipulating them barely moves the weighted average.

### EMA smoothing

Raw reserve prices can spike temporarily from a large trade imbalance. The oracle applies a 10-minute-half-life EMA, inspired by [Curve Finance's internal oracle](https://docs.curve.fi/stableswap-exchange/stableswap-ng/pools/oracles/).

```
elapsed = seconds since last update
alpha   = 1 - exp(-elapsed / HALF_LIFE)
alpha   = min(alpha, MAX_ALPHA)         // cap to prevent stale-reset attack
ema     = prev_ema × (1 - alpha) + spot × alpha
```

| Parameter | Value | Rationale |
|---|---|---|
| HALF_LIFE | 600 s (10 min) | Long enough to smooth manipulation, short enough to track real moves |
| MAX_ALPHA | 0.5 | After long dormancy, first observation gets at most 50% weight |

| Elapsed | Alpha | Weight of new observation |
|---|---|---|
| 1 min (1 block) | 0.095 | 9.5% |
| 5 min | 0.394 | 39.4% |
| 10 min | 0.500 (capped) | 50% |
| 30 min | 0.500 (capped) | 50% |

A single-block spike moves the EMA <1%. After 10 minutes sustained, the EMA is 50% converged; after 30 minutes, 87.5%.

### External guard rails

External prices for anchor assets polled every 5 minutes from multiple sources. Guard rails **do NOT set prices** — they only reject suspicious on-chain prices. On-chain reserve data remains the primary source.

| Asset | Primary | Fallback |
|---|---|---|
| BTC | CoinGecko | Binance |
| ETH | CoinGecko | Binance |
| DAI / USDC / USDT | CoinGecko | CoinMarketCap |

Logic:
```
deviation = |on_chain_price - external_price| / external_price × 100

< 2%   HEALTHY    Accept on-chain price
2-5%   WARNING    Accept on-chain price, log alert
> 5%   REJECT     Keep last known good price, log alert
```

**Stablecoin depeg detection** — all stables on Verus are bridged from Ethereum, so their value depends on the external stable AND the bridge. The external price check catches both a real depeg and a bridge exploit:
```
if external_stable_price deviates > 2% from $1.00:
    remove that stablecoin from anchor set
    remaining stables continue anchoring
    if ALL stables depegged: fall back to BTC/ETH ratios only
```

### Manipulation resistance

The Verus DeFi ecosystem forms a connected liquidity graph. Every basket shares VRSC as a common reserve; VRSC connects to global markets through tBTC and vETH bridges. Result: a multi-hop arbitrage path from any asset to external markets:

```
Small token → VRSC (basket arb) → tBTC/vETH (basket arb) → BTC/ETH (bridge arb)
```

Even Verus-native tokens can't be sustainably pumped — pumping dumps VRSC into the basket, creating an arb opportunity against deeper baskets, in turn creating a bridge arb to external markets. Two automatic arb hops correct any deviation.

To manipulate pricing, an attacker must (cumulatively):
1. **Overcome depth weighting** — pump deep baskets, not shallow ones (expensive)
2. **Overcome EMA** — sustain the pump for 30+ minutes (capital locked, losing to arb)
3. **Overcome arb bots** — every second the price is distorted, arb bots profit at the attacker's expense
4. **Overcome guard rails** — if anchor assets deviate >5%, the oracle rejects the update entirely

Cost scales with `basket depth × time sustained × arb-bot count`.

| Attack vector | Defense | Impact |
|---|---|---|
| Small basket pump | Depth-weighted avg | <1.2% oracle shift from 24% pump |
| Sustained manipulation | EMA smoothing | Attacker pays arb bots continuously |
| Multi-basket coordinated | Arb graph | Every basket connected to external via VRSC |
| Stablecoin depeg | External guard rail | Depegged stable removed from anchor set |
| Bridge exploit | External guard rail | tBTC/vETH diverge from BTC/ETH → caught |
| Stale EMA reset | Alpha cap (0.5) | First observation after dormancy gets max 50% weight |
| New basket injection | Minimum age | Probationary period before oracle inclusion |
| Native token pump | Double arb | Token → VRSC → external, self-correcting |

### Confidence score

Each price gets a confidence score (0-100):

| Factor | Points |
|---|---|
| Basket depth > $50k | +30 |
| Basket depth > $10k (≤ $50k) | +20 |
| Basket depth > $1k (≤ $10k) | +10 |
| Direct stablecoin pricing (no hop) | +20 |
| Multiple baskets agree within 1% | +20 |
| Updated within last 10 blocks | +10 |
| External guard rail status = healthy | +10 |
| Stale > 100 blocks | -30 |

Prices with confidence < 30 are marked **"indicative"** and not used for downstream calculations (portfolio values, tax exports, etc.).

## Architecture

```
┌─────────────────────────────────────────────┐
│              External Guard Rails           │
│  CoinGecko / Binance / CMC → BTC ETH DAI    │
│  Poll every 5 min, reject >5% deviation     │
└──────────────────┬──────────────────────────┘
                   │ reject / accept
┌──────────────────▼──────────────────────────┐
│              EMA Smoothing                  │
│  Per-currency, 10min half-life, alpha≤0.5   │
└──────────────────┬──────────────────────────┘
                   │ smoothed price
┌──────────────────▼──────────────────────────┐
│         Depth-Weighted Average              │
│  All baskets containing currency X          │
│  Weight = stablecoin reserve depth          │
└──────────────────┬──────────────────────────┘
                   │ per-basket prices
┌──────────────────▼──────────────────────────┐
│         Reserve Price Extraction            │
│  getcurrencystate → priceinreserve ratios   │
│  Cross-ref vs stablecoins = USD price       │
│  Every block, all chains (VRSC + PBaaS)     │
└─────────────────────────────────────────────┘
```

## Data model

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

## Configuration

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

## Worked examples

All examples use real on-chain data from block 4,029,296 (April 18, 2026).

### Example A — tBTC: single basket, multiple stablecoins

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
  numerator   = 77283.28×29769 + 77291.31×29772 + 77269.04×29763 = 6,900,691,603
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

### Example B — VRSC: multiple baskets, depth-weighted

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
  = (0.80318×89305 + 0.80374×49974 + 0.80848×6618) / (89305 + 49974 + 6618)
  = (71729 + 40171 + 5350) / 145897
  = $0.80354

Spread across baskets: 0.2%

Confidence: 30 (>50k depth) + 20 (direct stable) + 20 (3 baskets agree within 0.2%)
            + 10 (this block) + 10 (guard rail healthy) = 90/100
```

### Example C — NATI: cascade pricing via VRSC (no stablecoin in basket)

```
NATI basket has VRSC + NATI only (no stablecoins)

Step 1 — Get VRSC price from Example B: $0.80354
Step 2 — NATI/VRSC ratio from NATI basket reserves:
  VRSC priceinreserve = 19.67
  NATI priceinreserve = 6,842.31
  NATI/VRSC = 19.67 / 6,842.31 = 0.002874
Step 3 — Convert to USD:
  NATI_usd = $0.80354 × 0.002874 = $0.002309

Confidence: 40/100 (no direct stablecoin, single basket)
```

### Example D — Pump attack on small basket

```
Normal state: VRSC = $0.804 across all baskets

Attack: Pump VRSC to $1.00 in Kaiju basket ($7k depth)

Step 1 — Depth-weighted spot:
  Floralis  $0.804 × 61.1% = 0.4913
  Bridge    $0.804 × 34.2% = 0.2750
  Kaiju     $1.000 ×  4.5% = 0.0450
  Spot = $0.8113 (+0.9% from normal)

Step 2 — EMA smoothing (alpha = 0.095 for 1 block):
  EMA = $0.804 × 0.905 + $0.8113 × 0.095 = $0.8047 (+0.09%)

Step 3 — Arb response:
  Block 0:  Pump hits   → spot $0.8113 → EMA $0.8050  (+0.12%)
  Block 1:  Arb starts  → spot $0.8100 → EMA $0.8055  (+0.19%)  ← peak
  Block 5:  Fully arbed → spot $0.8040 → EMA $0.8054  (+0.17%)
  Block 30: Settled      → EMA $0.8040                 (0.00%)

Result: 24% pump in small basket → peak oracle deviation 0.19%
The attacker lost money to arb bots for a 0.19% blip lasting ~30 minutes.
```

## Operating in production

### Logs

stdout/stderr from `npm start`. Run under systemd:
```bash
journalctl -u verus-oracle -f
```

Key signals:
- `[block <N>] processed <K> currencies` — normal heartbeat (one per block)
- `[guard] BTC deviation 0.27% HEALTHY` — guard rail tick (every 5 min)
- `[guard] DAI deviation 3.2% WARNING` — accept but alert; investigate stablecoin / bridge state
- `[guard] BTC deviation 6.1% REJECT, keeping last good $77,000` — reject; check whether on-chain or external is wrong before acting

### Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `RPC connection refused` | wrong `VERUS_RPC_URL` or daemon down | `verus getinfo`; check `~/.komodo/VRSC/VRSC.conf` for `rpcuser`/`rpcpassword` |
| No PBaaS prices | PBaaS auto-discovery couldn't find conf files | Manually create symlinks under `~/.verus/pbaas/<hex>/` or set per-chain RPC URLs |
| All prices stale (>100 blocks) | Daemon stuck syncing OR oracle process hung | `verus getinfo` (check `blocks` vs `longestchain`); restart oracle |
| Guard rails REJECT on every check | External source rate-limited or down | Check CoinGecko/Binance reachability; failover to CMC requires `CMC_API_KEY` |
| New basket not appearing | Hasn't passed `MIN_BASKET_AGE_BLOCKS` yet | Wait — probationary period is a manipulation defence |
| Confidence stuck low for a known-good currency | Single basket OR no stablecoin in basket OR multi-basket disagreement | Check `source_basket` + `price_history` — usually means liquidity has fragmented |

### Backup considerations

Stateful — back up the Postgres database:
```bash
pg_dump $DATABASE_URL > oracle-backup-$(date +%F).sql
```

The `prices` table is recoverable from chain state at any time (one block worth of `getcurrencystate` rebuilds it). The `price_history` and `guard_rail_checks` tables are NOT recoverable — they're append-only audit trails. Back up nightly if you care about historical charts or guard-rail forensics.

### Upgrading

```bash
git pull
npm install          # if deps changed
systemctl restart verus-oracle
```

No schema migrations expected in the v2 line — if a schema change ships, it'll be flagged in the commit message with an explicit `ALTER TABLE` statement to run first.

## License

MIT — see [LICENSE](./LICENSE) if present, or the standard MIT terms.

## Disclaimer

This software is provided **"AS IS"**, without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.

**Do not use this oracle's prices to settle anything that can't be reversed without first independently verifying them.** The oracle is intentionally a read-side observer with manipulation defences, but every defence has a failure mode (external API outage, daemon de-sync, bridge exploit). Treat the `confidence` field as load-bearing — never settle on a price with confidence < 30, and consider raising your minimum threshold for high-stakes settlement (loans, custody, on-chain forced liquidation).
