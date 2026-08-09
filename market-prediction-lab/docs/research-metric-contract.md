# Research metric contract v1

## Canonical success rate

From this metric-contract version onward, `successRatePercent` means **TP-before-SL on barrier-resolved trades**.

- TP hit: `take_profit`, `take_profit_gap`
- SL hit: `stop_loss`, `stop_loss_gap`, `stop_loss_same_bar`
- `end_of_data`/timeout/manual end: censored and excluded from the TP-before-SL denominator
- same-bar TP+SL ambiguity remains conservative: SL first

A separate `netProfitableTradeRatePercent` records the share of trades whose `netPnl > 0` after fees, spread, slippage, latency approximation, tax where applicable, and futures funding.

Historical V1-V6 reports created before this contract used `successRatePercent` as the net-positive-trade rate. Those artifacts are immutable evidence and are **not retroactively relabeled**. New calculations expose both metrics explicitly.

## Standard result columns

Every new research result should expose at least:

- total return
- TP-before-SL success rate
- net-profitable trade rate
- profit factor
- maximum drawdown
- expectancy
- total trades
- barrier-resolved trades / TP hits / SL hits / censored exits
- baseline execution costs
- 1.5x and 2x execution-cost stress
- regime breakdown when regime labels are available

## ETH futures Long V6 Forward Paper/Shadow promotion policy v1

This policy is preregistered before additional ETH V6 forward outcomes are observed and is **scoped only to `eth-futures-long-v6`**. It must not be silently reused for stock, spot, short, scalping, swing, or a future strategy version; those require their own preregistered policy.

- candidate: `eth-futures-long-v6`
- minimum settled trades: 30
- minimum elapsed forward period: 28 days
- TP-before-SL success rate: at least 40%
- total net return: > 0%
- profit factor: >= 1.30
- maximum drawdown: <= 10%
- expectancy: > 0
- 1.5x execution-cost stress total return: > 0%
- frozen candidate only
- no parameter retuning after holdout
- no real orders
- no private account access
- Live remains blocked even when all research gates pass

Passing all checks produces only `promotion_candidate` / manual review. It never enables Live automatically.

## Cost stress

Baseline trade PnL already includes the configured execution-cost model. Stress testing adds the incremental cost `(multiplier - 1) * baseline total execution cost` to each trade. This avoids pretending the original backtest was cost-free and avoids double-counting the baseline cost.
