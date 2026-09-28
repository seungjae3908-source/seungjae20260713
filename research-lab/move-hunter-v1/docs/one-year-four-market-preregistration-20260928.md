# One-year four-market benchmark preregistration — 2026-09-28

## Frozen window
- observed-history window: 2025-09-28T00:00:00Z through 2026-09-27T23:59:59.999Z
- warmup is permitted only before the window for indicator state construction
- primary research timeframe for this bounded first pass: 1D
- Crypto Spot public 4H candles are aggregated only from complete 6-bar UTC days

## Fixed research baskets
- KR_STOCK: 005930, 000660, 035420, 005380, 068270
- US_STOCK: AAPL, MSFT, NVDA, AMZN, META
- CRYPTO_SPOT: BTC, ETH, XRP, SOL, ADA on Upbit KRW public candles
- CRYPTO_FUTURES: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT on Binance USD-M public history

This is a bounded research basket, not a full point-in-time market universe.

## Entry hypothesis frozen before benchmark outcome
The candidate uses merged canonical adaptive-multi-evidence market features. Entry is admitted only when:
1. canonical feature state is READY/PARTIAL research-only;
2. either Indicator Runner state is ACCELERATION with non-opposing price structure, or NORMAL has a direction-aligned confirmed BREAKOUT_UNRETESTED/RETEST_HELD event;
3. NORMAL additionally requires EMA/ADX trend alignment, ROC+MACD+RSI momentum alignment, relative volume >= 1.0, ADX >= 18, and no abnormal-volatility flag.

No threshold grid or retrospective rescue is permitted in this benchmark.

## Exit comparison
Same improved entry set is evaluated twice:
- Fixed: LONG_RUNNER_3ATR
- Adaptive: same Runner with canonical Indicator Runner ATR-trail state; forced indicator exit remains OFF because prior observed-history testing did not justify it.

## Costs
Fixed conservative research assumptions are used for fee/slippage/spread. KR adds a one-way exit tax assumption. Futures additionally applies actual public historical funding records when available. These assumptions are not claimed to be a user's broker/exchange fee schedule.

## Event intelligence / AI
The one-year full stack is fail-closed unless exact point-in-time news, disclosure, and AI-version evidence is bound. Current public benchmark does not fabricate it:
- newsScoreImpact=0
- disclosureScoreImpact=0
- aiScoreImpact=0
- full-stack result status=BLOCKED_DATA

## Truth boundary
Observed history only. Not pristine OOS. Not Genuine Forward. No profitability promotion. economicSampleCredit=0. executionAuthority=NONE. No private APIs, orders, deployment, DB/Secret/Env changes, or Replit.
