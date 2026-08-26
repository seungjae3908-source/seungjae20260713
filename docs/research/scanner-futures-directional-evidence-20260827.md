# Crypto Futures Directional Scanner — Evidence Contract

Date: 2026-08-27 KST
Status: research/runtime foundation only
Production authority: none

## Goal

Keep crypto-futures LONG and SHORT as independent hypotheses. A SHORT score must not be implemented as `100 - LONG`, a negative LONG score, or a sign-flipped copy of a single combined score.

Each direction must independently own:

- condition matching
- score breakdown
- confidence
- risk
- Entry / Stop / Targets
- evidence
- validation / backtest lineage

The pair-level terminal state is one of:

- `LONG`
- `SHORT`
- `NO_TRADE`
- `SIGNAL_CONFLICT`

## Public derivatives evidence

The current repository already has a public-only Bitget futures market-data layer. The directional formula foundation is designed to consume that deterministic evidence rather than asking an LLM to invent numeric market state.

Official Bitget public endpoints verified for this contract:

- All futures tickers: `GET /api/v2/mix/market/tickers`
  - https://www.bitget.com/api-doc/classic/contract/market/Get-All-Symbol-Ticker
- Futures candles: `GET /api/v2/mix/market/candles`
  - https://www.bitget.com/api-doc/classic/contract/market/Get-Candle-Data
- Current funding rate: `GET /api/v2/mix/market/current-fund-rate`
  - https://www.bitget.com/api-doc/classic/contract/market/Get-Current-Funding-Rate
- Historical funding rate: `GET /api/v2/mix/market/history-fund-rate`
  - https://www.bitget.com/api-doc/classic/contract/market/Get-History-Funding-Rate
- Open interest: `GET /api/v2/mix/market/open-interest`
  - https://www.bitget.com/api-doc/classic/contract/market/Get-Open-Interest

The official API documentation describes these as public market-data endpoints and documents rate limits. Runtime callers must remain bounded/cached and must not convert provider gaps into fabricated evidence.

## Formula separation rule

LONG and SHORT may share raw observations, but interpretation is direction-specific.

Examples:

- LONG trend evidence: price above MA20 and MA5 > MA20.
- SHORT trend evidence: price below MA20 and MA5 < MA20.
- LONG volume confirmation requires direction-aligned bullish expansion.
- SHORT volume confirmation requires direction-aligned bearish expansion.
- Positive funding crowding may strengthen a SHORT contrarian hypothesis while penalizing LONG crowding risk.
- Negative funding crowding may strengthen a LONG contrarian hypothesis while penalizing SHORT crowding risk.

No rule above is a profitability claim. Candidate formula weights remain subject to OOS / walk-forward / cost-stress / holdout validation before promotion.

## Fail-closed rules

- stale evidence caps eligibility
- missing spread / funding / OI lowers evidence quality
- insufficient candles cannot become a strong signal
- price-plan generation requires ATR/structure evidence
- no qualifying direction => `NO_TRADE`
- both directions independently qualifying => `SIGNAL_CONFLICT`, not arbitrary tie-breaking

## AI boundary

AI is advisory only for narrative/news/disclosure/context work. It does not author price, RSI, ATR, funding, OI, Entry, Stop, Target, win rate, EV, PF, MDD, or promotion authority.

## Next integration steps

1. exact-head typecheck / phase9 validation
2. wire independent directional formula outputs into the futures scanner runtime without changing KR/US/spot BUY-only behavior
3. expose explicit futures direction selection to API/UI
4. attach direction-specific ranking and formula versioning
5. connect direction-specific OOS/WF/backtest evidence
6. integrate Shadow/Paper/Settlement/Strategy Health evidence

Until those steps are proven, this is not `PROFITABILITY_PROVEN` and not a live-trading authorization.
