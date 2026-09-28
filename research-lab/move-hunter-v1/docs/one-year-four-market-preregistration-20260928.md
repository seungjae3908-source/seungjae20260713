# One-year four-market benchmark preregistration — 2026-09-28

## Revision provenance
V1 froze the observed-history window at **2025-09-28 through 2026-09-27**.

V2 tested a data-availability-only rule that would move the window to the newest common Binance Vision daily archive date. That attempt failed before any futures outcome was calculated because no common five-symbol daily archive was available inside the bounded lookup window. V2 was therefore abandoned.

V3 restores the original V1 window. Strategy thresholds, research baskets, costs, entry rules and exit rules remain unchanged.

## Fixed benchmark window
- benchmark: 2025-09-28T00:00:00Z through 2026-09-27T23:59:59.999Z
- warmup: 140 earlier calendar days, used only for causal indicator state construction
- primary bounded research timeframe: 1D

## Fixed research baskets
- KR_STOCK: 005930, 000660, 035420, 005380, 068270
- US_STOCK: AAPL, MSFT, NVDA, AMZN, META
- CRYPTO_SPOT: BTC, ETH, XRP, SOL, ADA
- CRYPTO_FUTURES: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT

This is a bounded research basket, not a full point-in-time market universe.

## Public-data provenance
- KR/US: Yahoo public daily history
- Crypto Spot: Upbit public 4H history, aggregated only from complete six-bar UTC days
- Crypto Futures preferred path: Binance USD-M public REST for daily candles and funding
- If Binance REST is region-blocked:
  - older daily candles: checksum-verified Binance Vision USD-M monthly archives
  - recent daily candles: Bitget public futures daily history
  - older funding: checksum-verified Binance Vision funding archives
  - recent funding: Bitget public funding history
  - the crossover is the oldest available recent Bitget daily candle and is recorded in the output
  - exact full-window daily continuity is mandatory

The Binance-Vision + Bitget path is explicitly a **cross-venue composite research dataset**. It is not represented as a single-exchange executable price history and cannot create profitability credit. A recent-only provider response (for example ~90 days) cannot masquerade as a one-year benchmark.

## Entry hypothesis frozen before benchmark outcomes
The candidate uses merged canonical Adaptive Multi-Evidence V2 features. Entry is admitted only when:
1. canonical feature state is READY/PARTIAL research-only;
2. either Indicator Runner state is ACCELERATION with non-opposing price structure, or NORMAL has a direction-aligned confirmed BREAKOUT_UNRETESTED/RETEST_HELD event;
3. NORMAL additionally requires EMA/ADX trend alignment, ROC + MACD histogram + bounded RSI momentum alignment, relative volume >= 1.0, ADX >= 18, and no abnormal-volatility flag.

No threshold grid, post-result threshold relaxation, parameter search, or retrospective rescue is permitted in this benchmark.

## Exit comparison
The same improved entries are evaluated twice:
- Fixed: LONG_RUNNER_3ATR
- Adaptive: the same Runner with canonical Indicator Runner ATR-trail state
- forced indicator exit remains OFF

## Costs
Fixed conservative research assumptions are used for fee/slippage/spread. KR includes a one-way exit-tax research assumption. Futures additionally applies historical public funding where the continuous funding evidence passes the bounded checks. These assumptions are not claimed to be the user's broker/exchange fee schedule.

## Event intelligence / AI
The one-year full stack remains fail-closed unless exact point-in-time news, disclosure, and AI-version evidence is bound. This benchmark does not fabricate historical event intelligence:
- newsScoreImpact=0
- disclosureScoreImpact=0
- aiScoreImpact=0
- full-stack status=BLOCKED_DATA
- blocker=POINT_IN_TIME_NEWS_DISCLOSURE_AI_HISTORY_NOT_BOUND

## Truth boundary
Observed history only. Not pristine OOS. Not Genuine Forward. No profitability promotion. economicSampleCredit=0. executionAuthority=NONE. No private APIs, orders, deployment, DB/Secret/Env changes, or Replit.
