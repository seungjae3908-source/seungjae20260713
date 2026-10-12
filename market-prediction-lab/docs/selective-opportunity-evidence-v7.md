# V7 source register and causal hybrid research

Owner #1350 / Hub #1102. Research-only Draft. Preregistered in Hub comment5826876950.
V1–V6 source and previous artifacts remain unchanged. No Replit, deployment, orders,
Paper/provider schedule activation, secret/account access, or Telegram delivery.
Target: whole-account net monthly3–10%+, not six-month3–10%. No guarantee.

## Sources actually consulted on 2026-09-25

Access level is part of the evidence. No paper was fully reproduced, and no claim
is made to have watched video pixels/audio. Paid full text was not bypassed.
These sources motivate prototypes; their authors' returns are NOT our returns.

| ID | Primary source | Material actually read | Use and limit |
|---|---|---|---|
| P1 | Lo, Mamaysky, Wang (2000), Foundations of Technical Analysis; NBERw7613 / JFinance55 | NBER abstract | Algorithmic pattern recognition can have incremental information in their sample. Our strict confirmed-pivot rule is NOT their kernel-regression replication. |
| P2 | Marshall, Young, Rose (2006), Candlestick technical trading strategies; JBF30,2303–2323 | Publisher abstract/excerpts | Contrary evidence: no candlestick value in studied DJIA sample; does not prove every pattern useless. |
| P3 | Lu, Chen, Hsu (2015), Trend definition or holding strategy; JBF61,172–183 | Publisher abstract/section snippets | Holding-policy dependence; reported survivor exclusions and different daily-stock setting limit transfer. V7 is not its eight-pattern replication. |
| P4 | Gu, Kelly, Xiu (2020), Empirical Asset Pricing via ML; NBERw25398 | NBER abstract | Nonlinear feature interactions motivate a small tree model. Does not validate our crypto features or monthly target. |
| P5 | Jiang, Kelly, Xiu (2023), (Re-)Imag(in)ing Price Trends; JFinance78,3193–3249 | Yale author-institution summary / indexed publisher abstract | Chart-image ML motivates research; CNN NOT implemented or backtested here. |
| P6 | Sullivan, Timmermann, White (1999), Data-Snooping, Technical Trading Rule Performance, and Bootstrap | Indexed publisher abstract; direct publisher open403 | Full rule-universe/multiple-testing warning. No White Reality Check or corrected significance claimed here. |
| P7 | Shi et al. (2025), Kronos: A Foundation Model for the Language of Financial Markets | arXiv abstract | Pretrained K-line candidate located, not downloaded/run. Training overlap is unverified, so no clean-OOS claim or rankIC-to-profit conversion. |
| Y1 | SMB Training, How to Use Tape Reading to Help you Keep Your Trading Profits (2020-12-23) | Official publisher-posted video transcript | Multitimeframe flag and failed breakout/tape context. Actual order flow absent from4h OHLCV, so its tape strategy is not replicated. |
| Y2 | SMB Training, The Ultimate Trend Day Trading Course (2023-03-13) | Official embedded-video page/description only | Discovery entry; no transcript/video-content claim. Direct YouTube page fetch failed. No promoter profit assertion used as evidence. |
| D1 | Fidelity RSI guide | Official guide | RSI semantics, not proof of returns. |
| D2 | Fidelity MACD guide | Official guide | EMA12/26 plus9signal semantics, not independent evidence votes. |
| D3 | TradingView current Repainting documentation | Official current documentation | Confirmed pivots and closed higher-timeframe inputs; never backdate signals. |
| D4 | scikit-learn1.8 HistGradientBoostingClassifier documentation | Official version-matched API | Fixed tree implementation. Raw model score is NOT calibrated trading-win probability. |

Source URLs:
- P1 https://www.nber.org/papers/w7613 (DOI10.3386/w7613)
- P2 https://www.sciencedirect.com/science/article/pii/S0378426605002116 (DOI10.1016/j.jbankfin.2005.08.001)
- P3 https://www.sciencedirect.com/science/article/abs/pii/S0378426615002678 (DOI10.1016/j.jbankfin.2015.09.009)
- P4 https://www.nber.org/papers/w25398 (DOI10.3386/w25398)
- P5 https://economics.yale.edu/research/re-imagining-price-trends (DOI10.1111/jofi.13268)
- P6 https://onlinelibrary.wiley.com/doi/full/10.1111/0022-1082.00163
- P7 https://arxiv.org/abs/2508.02739
- Y1 https://www.smbtraining.com/blog/how-to-use-tape-reading-to-help-you-keep-your-trading-profits
- Y2 https://www.smbtraining.com/blog/the-ultimate-trend-day-trading-course-for-beginners-developing-traders
- D1 https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI
- D2 https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd
- D3 https://www.tradingview.com/pine-script-docs/concepts/repainting/
- D4 https://scikit-learn.org/1.8/modules/generated/sklearn.ensemble.HistGradientBoostingClassifier.html

## Fixed experiment

Three new hypotheses, two necessary controls, three previously observed six-month
windows:15rows, all retained. V5 first-retest/fullrunner is a control, not champion.
1. CANDLE_RECOVERY: bullish body engulfing OR lower-wick reversal geometry, prior
   three-bar decline, rising WilderRSI14 below55, risingclose and rvol>=1.
2. CONFIRMED_STRUCTURE_BREAK: strict2left/2right confirmed pivots; higher second
   low, intervening confirmed resistance crossed with rvol>=1.2. This is a price
   structure proxy, NOT discretionary Elliott1–5 wave labeling.
3. PAST_ONLY_ML_GATE: numerical23features combining candle geometry, pivots,
   RSI/MACD/EMA/ATR/volume, BTC-relative returns and completed daily context.
   Compare against its identical deduplicated candidate-union control.

Same V3 cash/initial-risk/position limits and V5 full-runner exit after2R. No new
risk allowance, changed stop cap, borrowed capital or higher leverage. Source
candidates differ so actual exposure and turnover are not assumed equal.

ML: histogram gradient boosting,100iterations,7leaves,minleaf25,L2=5,rate.05,
seed42,no early stopping,cutoff.55. Monthly fits use only mature labels strictly
before month-start minus one4hbar. Labels are18bar next-open-to-close returns
net of modeled costs, not actual runner outcomes. Per-symbol training label
windows do not overlap; simultaneous observations get inverse-event weights.
Minimum150training rows and40eachclass, else no prediction/trade. First months
therefore wait for training; comparisons include that idle time, not pure skill.
No random split, pretrained model, future price/label feature or calibrated-win
claim. Brier versus past training climatology is diagnostic; scored evaluation
labels may overlap, so no independent significance or certified calibration.

Archived V2/V4 public4h candles only,21/22/22of25symbols. No new market-data calls.
Daily features use6completed4hbars perUTCday;1m/5m/15m/1h are NOT reconstructed.
Stock/microcap/news/float/actual tape evidence is NOT supplied by these candles.
Static survivor/current theme membership and full-window coverage exclusions
remain biases. All2025-03-25..2026-09-24history is already observed exploratory
data, not independentOOS. Personal taxes, ticks/min-order/latency/halts/real fills,
settlement and intrabar maximum drawdown remain incomplete.

## Local outcomes (not a success claim)

| Window | V5ref | Candles | Confirmed structure | Union | Past-only ML |
|---|---:|---:|---:|---:|---:|
|2025-03-25..09-24|+12.112%|-4.701%|+18.116%|-5.452%|+6.341%|
|2025-09-25..2026-03-24|-4.456%|-28.561%|+0.144%|-24.610%|-4.464%|
|2026-03-25..09-24|+15.344%|-1.303%|+5.054%|+4.939%|+3.398%|

Structure early18.116% crosses simple18% only; geometric monthly2.814%,cost-stress
15.802%,only1/6months>=3%, so NOT monthly-target pass. Recentstructure5.054% and
ML3.398% are below priorreference. All15below monthly3% reinvested19.405% and no
all-window pass. CANDLE_RECOVERY priorH2 MDD35.480% is a failed research outcome,
not an approved loss budget or live-risk limit. All negative trials preserved.
ML Brier .3164/.2929/.2770 versus past-climatology .2726/.2484/.2631: worse in all
three periods. It is not an improved probability model despite some lower losses.

## Reproducibility and next checkpoint

120local regressions (91preserved+29new), eight outputJSON files byte-identical
across offline runs; recent frozenV5ledger/fills/audit/equity reproduced. New tests
are named test_evidence_v7.py so older workflows do not import new ML dependencies.
Dedicated V7workflow pins Python3.13.5/numpy2.3.5/scipy1.17.0/sklearn1.8.0/joblib1.5.3/
threadpoolctl3.6.0 and checks original archives, baseline, replay, source/result
hashes. CI success must be read back separately, not assumed from local success.
Result SHA25665f1beba895749b8be42d718f630c378c665979904c31f9c0746f1388894e1e0.

Next: no threshold rescue. Preserve source register and failures. Separate label
horizon/objective alignment, calibrated versus constant-score selection and idle
training/exposure effects before using AI scores. Acquire real intraday/tape/PIT
news inputs only through permitted sources before testing the video-derived
ideas; do not claim all-market or all-timeframe coverage. New hypotheses require
preregistration and genuinely unused validation reserved before outcome inspection.
profitabilityProven=false,independentOos=false,selectedChampion=null,
canonicalSampleDelta=0,executionAuthority=NONE,actualOrders=0.
