---
name: Recommendation & scan engine rules
description: Durable constraints for the rule-based recommendation engine, condition scanner, and crypto routes.
---

## Rules
- **Sample financials never drive recommendations.** `Financials.source: 'live' | 'sample'` (financial.service falls back to a deterministic sample model on provider failure). The recommendation engine only uses `source === 'live'`; without live ratios a stock cannot be an undervalued candidate. US undervalued is empty when FINNHUB_API_KEY is absent (PER/PBR unavailable) — that is correct/honest, not a bug.
  **Why:** project-wide "no fabricated data" constraint; sample ratios look plausible and would silently poison recommendations.
- **0 results ≠ error.** `/market/scan` returns 200 with `rows: []` when conditions match nothing, but `SignalService.scan` throws SCAN_PROVIDER_ERROR when ≥80% (min 10) of the pool fails data acquisition, so provider outages surface as 502 with provider context instead of "no matches".
- **Breakout category can legitimately be empty** — requires close above prior 60-day high (excl. last 5 bars) within 5 bars, volume ≥1.5× 20-bar avg, extension ≤15%, RSI <72. Verified manually against top gainers before concluding 0 is honest.
- **Crypto private endpoints stay member-gated**: `/crypto/spot/accounts`, `/crypto/futures/account`, `/crypto/futures/positions` use server-side exchange keys → `requireMember`. Public Upbit/Bitget market-data routes stay public.
- **Scan labels map 1→N**: backend LABEL_TO_KEYS maps one Korean label to multiple ScanKeys (e.g. '돌파 직전' → bollinger_squeeze + pre_breakout) by design; duplicate labels in `selected` echo are expected.
- Recommendation repeat-tracking history lives in `/tmp/reco-history.json` (best-effort, serialized atomic writes); ephemeral by design.
- Rule-based disclosure is mandatory: responses carry `analysisMode:'rule-based'`, `aiConfigured:false` — never present recommendations as LLM output.
