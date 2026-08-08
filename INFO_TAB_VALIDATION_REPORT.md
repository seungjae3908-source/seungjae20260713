# Information Tab Validation

- Branch: `feature/stock-info-self-analysis-v1`
- Baseline main SHA: `ddc679065781e40f46dc6f13962d6039bccd4e58`
- Validated source commit: `2e3f68d0a8cc1f30c5fd2b545575913dd333fa36`
- Analysis hub validation workflow run: `30901977116`
- Frontend typecheck: passed
- Backend typecheck: passed
- Backend default/risk/phase4-9/smoke commands: 9 passed, 0 failed
- Frontend build: passed
- Backend build: passed
- Information-tab hardening Playwright scenarios: 7 passed, 0 failed
- Information analysis hub Playwright scenarios: 3 passed, 0 failed
- Full Playwright browser regression command: passed, 0 failed
- Information-tab source contract: passed
- Information analysis hub source contract: passed
- Deterministic stock analysis engine scenarios: passed
- Generated `dist`, Playwright report, test results, temporary workflow, diagnostic report, and maintenance script changes: removed from the feature diff
- Deployment, Supabase, secrets, permissions, and real-order execution: not performed

## Analysis Hub Extension

- One-glance summary: overall score, verdict, short-term outlook, risk, confidence, and one-line assessment
- Deterministic dimensions: technology, business, growth, financial, momentum, and catalyst
- Sector modules: quantum, semiconductor, biotech, AI/software, automotive, financial, and general
- Event rules: development/clinical success and failure, delays, contracts, earnings, guidance, dilution, leadership, regulation, and launches
- Official disclosures receive the highest confirmation weight; reputable news receives reduced weight; unconfirmed sources receive limited impact
- Duplicate news and disclosure evidence is normalized before scoring
- Event changes update score, risk, outlook, evidence, and local revision history without manually written company-specific prose
- Financial interpretation: revenue, operating income, cash status, and an explanatory conclusion
- Price connection: 52-week position, drawdown, recent event reason, and expectation-pricing warning
- Investor conditions: upside factors, downside factors, chase warning, observation range, and confirmation price
- Confidence: cited source names, missing data, and explicit competitor-data gaps
- Peer comparison never fabricates unavailable competitor numbers and displays `자료 필요`
- OpenAI dependency: none
- Live-order or automatic-order connection: none
