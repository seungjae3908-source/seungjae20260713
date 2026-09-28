# One-year four-market benchmark preregistration — 2026-09-28

## Revision provenance
V1 initially targeted 2025-09-28 through 2026-09-27. A dry-run found that Binance Vision had not yet published the 2026-09-27 daily archive. This V2 changes **only the date-resolution rule for public-data availability**; strategy parameters, baskets, costs, entry logic and exit logic are unchanged.

The final benchmark window is resolved before outcome calculation:
1. start from 2026-09-27;
2. scan backward at most 10 days;
3. choose the newest UTC day for which checksum documents exist for **all five** frozen futures symbols;
4. use that day as the last day and the preceding 364 UTC days as the benchmark, yielding exactly 365 calendar days;
5. use 140 earlier days only as indicator warmup.

The chosen day is a provider-availability fact, not a performance-selection criterion.

## Fixed research baskets
- KR_STOCK: 005930, 000660, 035420, 005380, 068270
- US_STOCK: AAPL, MSFT, NVDA, AMZN, META
- CRYPTO_SPOT: BTC, ETH, XRP, SOL, ADA on Upbit KRW public candles
- CRYPTO_FUTURES: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT

This is a bounded research basket, not a full point-in-time market universe.

## Data provenance
- KR/US: Yahoo public daily history
- Crypto Spot: Upbit public 4H history aggregated only from complete six-bar UTC days
- Crypto Futures primary: Binance public REST
- If REST is region-blocked: checksum-verified Binance Vision USD-M monthly archive plus current-month daily archive
- Current-month futures funding tail may use Bitget public funding history, while archived earlier funding remains checksum-verified Binance Vision history
- Any futures dataset that fails full warmup + 365-day daily continuity is rejected; a 90-day provider fallback cannot masquerade as a one-year benchmark.

## Entry hypothesis frozen before benchmark outcomes
The candidate uses merged canonical Adaptive Multi-Evidence V2 features. Entry is admitted only when:
1. canonical feature state is READY/PARTIAL research-only;
2. either Indicator Runner state is ACCELERATION with non-opposing price structure, or NORMAL has a direction-aligned confirmed BREAKOUT_UNRETESTED/RETEST_HELD event;
3. NORMAL additionally requires EMA/ADX trend alignment, ROC+MACD+RSI momentum alignment, relative volume >= 1.0, ADX >= 18, and no abnormal-volatility flag.

No threshold grid or retrospective rescue is permitted in this benchmark.

## Exit comparison
Same improved entry set is evaluated twice:
- Fixed: LONG_RUNNER_3ATR
- Adaptive: same Runner with canonical Indicator Runner ATR-trail state
- forced indicator exit remains OFF because prior observed-history testing did not justify it

## Costs
Fixed conservative research assumptions are used for fee/slippage/spread. KR adds a one-way exit tax assumption. Futures additionally applies historical public funding records when available. These assumptions are not claimed to be a user's broker/exchange fee schedule.

## Event intelligence / AI
The one-year full stack is fail-closed unless exact point-in-time news, disclosure, and AI-version evidence is bound. Current public benchmark does not fabricate it:
- newsScoreImpact=0
- disclosureScoreImpact=0
- aiScoreImpact=0
- full-stack result status=BLOCKED_DATA

## Truth boundary
Observed history only. Not pristine OOS. Not Genuine Forward. No profitability promotion. economicSampleCredit=0. executionAuthority=NONE. No private APIs, orders, deployment, DB/Secret/Env changes, or Replit.
