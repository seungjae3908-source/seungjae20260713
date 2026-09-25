# Independent Discovery V3 — bounded exploratory research

Owner: #1350. Central Hub: #1102. Draft only; #1349 remains paused.

## Evidence identity

Window: 2026-03-25 through 2026-09-24. This interval has already been inspected.
The experiment is POST_SELECTION_EXPLORATORY, not a pristine OOS test and not a complete implementation of the proposed AI/theme/news system.

Only V2 artifact 10842828161, run 36084429479, snapshot SHA256
`fabcae6eabe257f0e02bfd1af1f9dabb0b5e1e79494768dd08cb589166a13702`
is used. No current-market recollection or fallback input is allowed. Artifact expiration is a hard input failure, not permission to substitute new market data.

The original V1/V2 scripts and recorded results remain unchanged. The new Python harness does not import or invoke application, trading, Telegram, provider, or database code.

## Predeclared comparison

Policy hash: `5f2fd9a733208da31eb11fef2816dec9c12ac7f813925fc87794679dad1f6a03`.
Three families: prior-20-bar breakout, first retest of a prior breakout, and price/volume explosion followed by continuation. All use completed-bar discovery and next observed bar opening execution. No candidate generator knows the portfolio's future exit. Each family and theme-filter arm has an independent portfolio and re-entry history.

KR, US and crypto each compare three families with/without one theme-breadth condition. A separate US explosion daily proxy compares only its continuation family with/without that condition: 20 fixed comparisons, not a return-driven grid. The same source universe, costs and risk model are used. This is a wider independent scan of the archived bounded source set, NOT an all-market historical universe. The US base scan includes unclassified names already present in the frozen source set.

The theme condition uses static curated groups, a lexicographically fixed primary theme, breadth >=60%, observed coverage >=80% and >=3 members. Missing classification/coverage is a separate blocker. It must not be interpreted as evidence that an economic theme is bad.

## Cash, fills and costs

Per-trade risk 0.5% (US explosion 0.25%); total original risk <=2%; symbol notional <=20% (explosion 10%); every assigned theme <=40%; no borrowing; up to5 positions (explosion3). Full original-risk reservation decreases proportionally when units are sold. A five-bar structural stop buffered by0.25ATR, minimum1ATR distance, cannot be tightened to force an8% stock/10% crypto stop cap to pass. Entry gap >1ATR is rejected.

Stocks buy and sell integer units, with floor(initial quantity/3) for each of the first two profit-taking tranches; the final exit sells all remaining units. A one-share position may have no partial exit. Stops beyond opening gaps execute at the worse opening price. Same-bar ambiguity is stop-first. Trailing stops only become effective on later bars.

Fixed-position stress reprices the exact accepted fills and quantities with1.5x modeled costs. Its return cannot improve, and it is NOT represented as a feasible rebalanced account. A separate resized stress reruns the allocation policy; that can change quantities/admission and may make losses smaller by investing less.

Native-currency model capitals: KR and crypto KRW10m each; US and US explosion USD10k each. No combined FX return is calculated. These are experiment assumptions, not the user's capital or a suitability recommendation.

## Diagnosis

Every causal candidate is recorded before outcome labels. First failing stage is recorded for plan, theme filter, position capacity, sizing, or acceptance. Failed and winning candidates remain in the evidence. Radar events include new highs, >=5% moves or RVOL>=2, with a fixed5-bar episode cooldown. Detection is classified as same-bar, delayed1..5bars, absent, or boundary-censored. Twenty-bar close returns and high excursions are ex-post diagnostic labels only and never feed discovery/ranking/sizing. Overlapping windows are NOT independent samples and high excursions are NOT captured trading returns.

## Validation and limitations

Deterministic tests cover source corruption, causal prefix invariance, first retest, delayed explosion entry, integer partial exits, adverse gaps, stop-first, next-bar trailing, cash conservation, position-slot timing, risk-lot reasons, cost repricing, and end-window censoring. CI checks every generated JSON file for byte-identical replay on the same pinned snapshot.

Unresolved: point-in-time membership and delisted names; historical news/float/dilution; actual bid/ask/depth and partial fills; halted/price-limit execution; fees/taxes by actual broker; cash settlement lag; precise tick sizes; half-day stock calendars; FX and common cross-market allocation. Stocks assume6.5h regular bars; crypto uses4h. This is bar-sampled mark-to-market drawdown, not intrabar maximum. Crypto missing source pairs remain missing.

No profit promotion, calibrated probability, future EV, Paper activation, Telegram delivery, live orders, private APIs, operational changes, Ready/Merge/deploy, or Replit is authorized.
