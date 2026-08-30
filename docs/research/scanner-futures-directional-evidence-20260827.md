# Crypto Futures Directional Scanner — Evidence Contract

Date: 2026-08-28 KST
Status: research/runtime foundation only
Production authority: none

## Goal

Keep crypto-futures LONG and SHORT as independent hypotheses. A SHORT score must not be implemented as `100 - LONG`, a negative LONG score, or a sign-flipped copy of a single combined score.

Each direction independently owns condition matching, score breakdown, confidence, risk, Entry / Stop / Targets, evidence, and validation/backtest lineage. Pair-level terminal state remains one of `LONG`, `SHORT`, `NO_TRADE`, or `SIGNAL_CONFLICT`.

No validated directional-advantage margin currently exists. Therefore when LONG and SHORT independently qualify at the same time, runtime deliberately returns `SIGNAL_CONFLICT` instead of inventing a tie-break threshold. A future stronger-direction selection is allowed only after its directional-advantage rule is independently validated; until then conflict is the fail-closed outcome.

## Public derivatives evidence

The repository already owns the public-only Bitget futures market-data layer. The directional runtime reuses that layer and adds a bounded current position-tier evidence adapter; it does not create a second market-data engine and does not ask AI to invent numeric market state.

Required final derivatives evidence:

1. `MARK_PRICE`
   - Bitget public `GET /api/v2/mix/market/symbol-price`
2. `INDEX_PRICE`
   - Bitget public `GET /api/v2/mix/market/symbol-price`
3. `FUNDING`
   - Bitget public `GET /api/v2/mix/market/current-fund-rate`
4. `OPEN_INTEREST`
   - Bitget public `GET /api/v2/mix/market/open-interest`
5. `BASIS`
   - deterministically recomputed as `markPrice - indexPrice`; percent is recomputed from index price and inconsistent provenance blocks readiness
6. `LIQUIDATION_RISK` structure evidence
   - Bitget public `GET /api/v3/market/position-tier?category=USDT-FUTURES&symbol=...`
   - tier / minTierValue / maxTierValue / leverage / MMR are validated, bound to symbol/request time, and SHA-256 fingerprinted
   - canonical liquidation-model owner remains `market-prediction-lab/src/crypto-futures-isolated-liquidation-model-v1.js` (#740 lineage)

### Liquidation truth boundary

Scanner does **not** call Bitget private position endpoints and does **not** read an account liquidation price. It also does not fabricate a position-specific liquidation price before Risk/Sizing exists.

Current public tier/MMR evidence proves the current liquidation structure needed by the canonical model. Actual position-specific liquidation price/risk remains `N/A` until canonical Risk/Sizing supplies position size, margin, fee and funding context. Historical tier coverage is not backfilled from the current endpoint; #740 historical blockers remain authoritative.

If current tier/MMR evidence is missing, stale, malformed, future-dated, discontinuous, or otherwise unverifiable, final promotion is blocked as `BLOCKED_DERIVATIVES_EVIDENCE`.

## Bounded runtime enrichment

Broad Universe work remains light:

`public ticker -> closed candles -> independent preliminary LONG/SHORT evaluation`

Only symbols that preliminarily satisfy an independent directional strong-signal condition request detailed derivatives evidence:

`symbol-price + funding + OI + basis + public position-tier/MMR`

The final emitted card then passes through the six-part derivatives hard gate. Missing detailed evidence never becomes zero, never becomes READY, and never produces an actionable Candidate. Blocked cards use `WATCHING`, `action=NONE`, and hide Entry/Stop/Targets until the required derivatives evidence is verified.

## Formula separation rule

LONG and SHORT may share raw observations, but interpretation is direction-specific.

Examples:

- LONG trend evidence: price above MA20 and MA5 > MA20.
- SHORT trend evidence: price below MA20 and MA5 < MA20.
- LONG volume confirmation requires direction-aligned bullish expansion.
- SHORT volume confirmation requires direction-aligned bearish expansion.
- Positive funding crowding may strengthen a SHORT contrarian hypothesis while penalizing LONG crowding risk.
- Negative funding crowding may strengthen a LONG contrarian hypothesis while penalizing SHORT crowding risk.

No rule above is a profitability claim. Candidate formula weights remain subject to OOS / walk-forward / cost-stress / untouched-holdout validation before promotion.

## Fail-closed rules

- still-forming candle is excluded before deterministic evaluation
- stale evidence caps eligibility
- missing spread / funding / OI remains explicit
- insufficient candles cannot become a strong signal
- price-plan generation requires ATR/structure evidence
- missing final six-part derivatives evidence => `BLOCKED_DERIVATIVES_EVIDENCE`, `WATCHING`, `action=NONE`, Price Plan N/A
- no qualifying direction => `NO_TRADE`
- both independently qualifying directions => `SIGNAL_CONFLICT` until a separately validated advantage policy exists
- current position-tier evidence never proves historical tier coverage

## AI boundary

AI is advisory only for narrative/news/disclosure/context work. It does not author price, RSI, ATR, funding, OI, basis, tier/MMR, Entry, Stop, Target, win rate, EV, PF, MDD, liquidation price, leverage, or promotion authority.

## Remaining integration steps

1. fresh exact-head typecheck / Required CI 6/6
2. UI migration to independent futures lanes and explicit blocked derivatives evidence state
3. connect full cost / Profit-First / canonical Risk-Sizing so actual position-specific liquidation risk can be evaluated before Paper Entry
4. connect direction-specific OOS/WF/backtest/holdout evidence
5. integrate Shadow / Paper / Settlement / Strategy Health evidence

Until those steps are proven, this is not `PROFITABILITY_PROVEN`, not `SIGNAL_SCANNER_100_SCORE=true`, and not live-trading authorization.
