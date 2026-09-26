# Phase11 reviewed runtime binding

Phase11 binds Phase10's dependency-injected compiler/backtester seams to the existing canonical video hypothesis and evidence-backed tournament modules.

It requires an exact reviewed rule digest over the Gemini observations that Groq accepted as claims. A changed/missing review digest stops before canonical compilation.

Trusted context supplies market, side, timeframe and reviewed source metadata. AI output cannot overwrite them. Existing ResearchVideoSourceV1, cross-validation, canonical hypothesis/decision, formula compiler and tournament contracts remain authoritative.

The binding never enables schedules, provider calls, adoption, Paper/live trading or order authority. A tournament result becomes a backtest record only when exactly one research survivor has historical metrics and COST_STRESS=PASS; otherwise it returns REVIEW_REQUIRED.
