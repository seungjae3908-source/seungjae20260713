# Frozen V3 transfer V4 — research only

Owner #1350 / Hub #1102. V1/V2/V3 source and artifacts are preserved.
Reference engine HEAD `0e49f9da1eeece33d94d42c6eeec9ee5b6cafcb2`, git blob `8245eb79ab18c955eb7c9a80d314e94b286e3c05`.

## Predeclared experiment

All three V3 families and theme OFF/ON are retained. No best-arm promotion,
parameter search, new selection priority, changed risk cap or modified exits.
Only the evaluated window is parameterized in a separately imported module.
Monthly reporting is computed from existing equity curves for the correct year;
V3's original hardcoded monthly display is not reused for 2025.

New historical evaluation: 2025-03-25 inclusive to 2026-03-25 exclusive UTC.
Also evaluate 2025-03-25..2025-09-24 and 2025-09-25..2026-03-24 separately.
Each starts flat at KRW10m. Full and subperiods overlap; neither sample counts
nor percentage returns may be summed as independent observations.
30 calendar days of warmup are requested. All 25 original crypto symbols are
requested, including previously missing symbols. No replacement symbol is used.

This is **HISTORICAL_TRANSFER_EXPLORATORY**, not forward validation. Earlier
history is not future OOS for a rule devised using later history. Prior research
exposure cannot be certified; current/static theme and survivor selection bias
remain. Probability, future EV, profitability proof and prospective credit are
not created. The contract rejects relabeling this interval as pristine OOS.

## Data and causality

Public Upbit KRW 240-minute GET endpoint only. No account credentials.
Rules are written before first request. Raw pages, requests, UTC candle opening
boundaries and checksums are saved. Pagination uses exclusive `to`, at most
200 rows/page and 20 pages/symbol; globally paced at least 140ms/request.
Only bounded retries for 429/5xx. Missing/invalid/history-short series are
blocked separately per window. Missing no-trade candles are never synthesized.
Later bars do not decide whether an earlier subwindow is eligible.

Official API: https://docs.upbit.com/kr/reference/list-candles-minutes

## Stock diagnostic (original pinned snapshot)

Decompose each next-open candidate's stop distance into recent five-bar-low
plus ATR buffer versus one-ATR floor. Preserve all rejections and limits.
Test uniform price-scale invariance. Screen discontinuities but never infer
corporate-action correctness merely from no large gap. No stock prices or
strategy limits are repaired/tightened/widened to improve prior returns.

## Remaining boundary

Candle-only fills, static universe, missing PIT news/listings/float/dilution,
exchange tick/minimum notional/halts, settlement and intra-bar maximum drawdown
remain unresolved. Historical positive returns are not profitability proof.
No Ready/Merge/deploy, Paper activation, Telegram send, schedule, real order,
private trading API, operational mutation, or Replit is authorized/performed.
