# Product Integrity Audit

Generated: 2026-09-17T03:17:59.628Z

> STATIC/CONTRACT proof is not runtime, E2E, staging, production, or profitability proof.
> MISSING != ZERO. UNKNOWN != SUCCESS.

Capabilities: 31/31 statically proven
Identity contracts: 1/3 statically proven (executed contract proof tracked separately)
Golden journeys: 6/13 statically proven
Open P0/P1 ledger: 0/10

## Capability Inventory

| ID | Capability | Severity | Status | Evidence level |
|---|---|---|---|---|
| CAP001 | Stock Scanner | P1 | PROVEN | STATIC_PROVEN |
| CAP002 | Signal Scanner | P1 | PROVEN | STATIC_PROVEN |
| CAP003 | AI Chart | P1 | PROVEN | STATIC_PROVEN |
| CAP004 | AI Chat | P2 | PROVEN | STATIC_PROVEN |
| CAP005 | Research Center Workspace | P1 | PROVEN | STATIC_PROVEN |
| CAP006 | Research Center Canonical Evidence | P1 | PROVEN | STATIC_PROVEN |
| CAP007 | AI Research Copilot | P2 | PROVEN | STATIC_PROVEN |
| CAP008 | Research Video | P2 | PROVEN | STATIC_PROVEN |
| CAP009 | Backtester | P1 | PROVEN | STATIC_PROVEN |
| CAP010 | Strategy Promotion | P1 | PROVEN | STATIC_PROVEN |
| CAP011 | Paper Trading | P1 | PROVEN | STATIC_PROVEN |
| CAP012 | Auto Trading UI | P1 | PROVEN | STATIC_PROVEN |
| CAP013 | Portfolio | P1 | PROVEN | STATIC_PROVEN |
| CAP014 | Position / Holdings | P1 | PROVEN | STATIC_PROVEN |
| CAP015 | Broker Read-only Accounts | P1 | PROVEN | STATIC_PROVEN |
| CAP016 | Account | P1 | PROVEN | STATIC_PROVEN |
| CAP017 | Alerts | P2 | PROVEN | STATIC_PROVEN |
| CAP018 | Watchlist | P2 | PROVEN | STATIC_PROVEN |
| CAP019 | Recommendations | P2 | PROVEN | STATIC_PROVEN |
| CAP020 | Market Overview | P2 | PROVEN | STATIC_PROVEN |
| CAP021 | Market Information | P2 | PROVEN | STATIC_PROVEN |
| CAP022 | Technical Workspace | P1 | PROVEN | STATIC_PROVEN |
| CAP023 | Admin | P1 | PROVEN | STATIC_PROVEN |
| CAP024 | Agent Hub | P2 | PROVEN | STATIC_PROVEN |
| CAP025 | Member Access Contract | P1 | PROVEN | STATIC_PROVEN |
| CAP026 | Forward / OOS Evidence | P1 | PROVEN | STATIC_PROVEN |
| CAP027 | Shadow Evidence | P1 | PROVEN | STATIC_PROVEN |
| CAP028 | Settlement Evidence | P1 | PROVEN | STATIC_PROVEN |
| CAP029 | Full Cost Evidence | P1 | PROVEN | STATIC_PROVEN |
| CAP030 | Full Staging Gate | RELEASE_GATE | PROVEN | STATIC_PROVEN |
| CAP031 | Telegram Delivery | P2 | PROVEN | STATIC_PROVEN |

## Identity Continuity

| ID | Contract | Status | Evidence level |
|---|---|---|---|
| ID001 | Scanner → AI analysis selection | PROVEN | STATIC_PROVEN |
| ID002 | Backtest → Paper same-candidate identity | PARTIAL | NOT_PROVEN |
| ID003 | Scanner → Paper approval identity | PARTIAL | NOT_PROVEN |

## Golden Journey Matrix

| ID | Journey | Static status | Runtime | E2E | Production |
|---|---|---|---|---|---|
| GJ001 | Scanner → AI Chart → AI Chat | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ002 | KR Scanner → Paper → Settlement → Full Cost → OOS | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ003 | US Scanner → Paper → Settlement → Full Cost → OOS | MISSING | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ004 | Crypto Spot Scanner → Paper → Settlement → OOS | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ005 | Crypto Futures LONG/SHORT → Paper → Settlement → OOS | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ006 | Backtest → Same Candidate Paper → Settlement → OOS | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ007 | Read-only Accounts → Portfolio → Chart Overlay | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ008 | Research Center → Canonical Research Evidence | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ009 | Authenticated Candidate → Full Staging | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ010 | In-app Alerts → Telegram | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ011 | Research → Candidate → Backtest → Forward / Shadow / Paper evidence readback | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ012 | Portfolio → AI Analysis | PROVEN | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |
| GJ013 | Scanner → Alert → Telegram / Member routing | PARTIAL | NOT_PROVEN | NOT_PROVEN | NOT_PROVEN |

## Orphan Page Candidates

- stock-analyzer/src/pages/detail-legacy.tsx — NO_STATIC_IMPORT_REFERENCE_FOUND (Review candidate only; dynamic routing or intentional legacy retention may be valid.)

## Error Ledger — P0/P1 only

| ID | Severity | Area | Status | Evidence | Reason |
|---|---|---|---|---|---|
| EL-CG003 | P1 | Stock Scanner KR → Approval Paper Plan | OPEN | NOT_PROVEN | scanner-paper-server-route:MISSING, scanner-canonical-paper-server-consumer:MISSING |
| EL-CG004 | P1 | Stock Scanner US → Approval Paper Plan | OPEN | NOT_PROVEN | us-paper-composer-contract:MISSING, scanner-canonical-paper-server-consumer:MISSING, explicit-us-adapter-block:BLOCKER_PRESENT |
| EL-CG005 | P1 | Crypto Spot Scanner → Approval Paper Plan | OPEN | NOT_PROVEN | spot-paper-supported-composer:MISSING, scanner-paper-server-route:MISSING, scanner-canonical-paper-server-consumer:MISSING |
| EL-CG006 | P1 | Crypto Futures LONG/SHORT Scanner → Approval Paper Plan | OPEN | NOT_PROVEN | futures-paper-supported-composer:MISSING, scanner-paper-server-route:MISSING, scanner-canonical-paper-server-consumer:MISSING |
| EL-CG007 | P1 | Backtest Result → Paper Trading Candidate | OPEN | NOT_PROVEN | canonical-strategy-paper-execution-consumer:MISSING, same-candidate-paper-position-consumer:MISSING, accepted-backtest-paper-execution-route:MISSING |
| EL-CG011 | P1 | Settlement → Full Cost | OPEN | NOT_PROVEN | manual-paper-full-eight-component-cost-contract:MISSING |
| EL-CG012 | P1 | Full Cost → Net PnL | OPEN | NOT_PROVEN | full-cost-components-preserved:MISSING |
| EL-CG013 | P1 | Net PnL → Validation / Genuine OOS | OPEN | NOT_PROVEN | same-candidate-manual-paper-validation-consumer:MISSING |
| EL-ID002 | P1 | Backtest → Paper same-candidate identity | OPEN | NOT_PROVEN | same-strategy-paper-consumer:MISSING, same-candidate-paper-position-consumer:MISSING, accepted-backtest-paper-execution-route:MISSING |
| EL-ID003 | P1 | Scanner → Paper approval identity | OPEN | NOT_PROVEN | candidateId:MISSING, strategyId:PARTIAL, parameterHash:MISSING, timeframe:PARTIAL, side:PARTIAL, leverage:PARTIAL, scanner-canonical-server-consumer:MISSING |

### EL-CG003

- Severity / Domain: P1 / scanner-paper
- Producer: Stock Scanner KR
- Consumer: Approval Paper Plan
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"kr-paper-composer-contract","state":"PROVEN","matchedFiles":["stock-analyzer/src/components/scanner-approval-composer.tsx"]},{"id":"composer-mounted-outside-definition","state":"PROVEN","matchedFiles":["stock-analyzer/src/pages/signal-scanner.tsx","stock-analyzer/src/pages/technical-workspace.tsx"]},{"id":"scanner-paper-server-route","state":"MISSING","matchedFiles":[]},{"id":"scanner-canonical-paper-server-consumer","state":"MISSING","matchedFiles":[]}]
- Root Cause: KR composer calls an absent /scanner/plans backend route; frontend URL text was a false-positive connection proof.
- Owner: #1085 scanner KR server/canonical consumer wiring
- Dependency Owner: Existing Paper admission/adapter owner (#999/#1001); policy owner (#1073/#1084)
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Implement a server-revalidated Paper-only seam before enabling the UI; do not forward to generic live-capable /plans.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG004

- Severity / Domain: P1 / scanner-paper
- Producer: Stock Scanner US
- Consumer: Approval Paper Plan
- Status / Wiring / Classification: OPEN / MISSING / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"us-paper-composer-contract","state":"MISSING","matchedFiles":[]},{"id":"scanner-paper-endpoint","state":"PROVEN","matchedFiles":["stock-analyzer/src/components/scanner-approval-composer.tsx"]},{"id":"scanner-canonical-paper-server-consumer","state":"MISSING","matchedFiles":[]},{"id":"explicit-us-adapter-block","state":"PROVEN","matchedFiles":["stock-analyzer/src/components/scanner-approval-composer.tsx"]}]
- Root Cause: US Paper server route/adapter semantics are unimplemented. The protective UI blocker does not turn that implementation gap into a safety-only finding.
- Owner: #1085 scanner US server/canonical consumer wiring
- Dependency Owner: Existing Paper adapter/admission owner (#999/#1001); retain US UI protection
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Keep the protective UI blocker while implementing verified Paper-only wiring; coordinate adapter/admission contracts with the existing Paper owner.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG005

- Severity / Domain: P1 / scanner-paper
- Producer: Crypto Spot Scanner
- Consumer: Approval Paper Plan
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"crypto-workspace-paper-handoff","state":"PROVEN","matchedFiles":["stock-analyzer/src/pages/signal-scanner.tsx"]},{"id":"spot-paper-supported-composer","state":"MISSING","matchedFiles":[]},{"id":"scanner-paper-server-route","state":"MISSING","matchedFiles":[]},{"id":"scanner-paper-bridge-contract","state":"PROVEN","matchedFiles":[".github/workflows/scanner-paper-bridge.yml"]},{"id":"scanner-canonical-paper-server-consumer","state":"MISSING","matchedFiles":[]}]
- Root Cause: Signal Scanner mounts the composer, but the composer supports KR only and its scanner backend route is absent.
- Owner: #1085 Crypto Spot server/canonical consumer wiring
- Dependency Owner: Existing Scanner #719 and Paper admission owner #999; no private adapter
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Preserve existing admission workflows; connect an independently verified Spot Paper-only server consumer.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG006

- Severity / Domain: P1 / scanner-paper
- Producer: Crypto Futures LONG/SHORT Scanner
- Consumer: Approval Paper Plan
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"futures-ui-paper-handoff","state":"PROVEN","matchedFiles":["stock-analyzer/src/pages/signal-scanner.tsx"]},{"id":"futures-paper-supported-composer","state":"MISSING","matchedFiles":[]},{"id":"scanner-paper-server-route","state":"MISSING","matchedFiles":[]},{"id":"futures-paper-admission-contract","state":"PROVEN","matchedFiles":[".github/workflows/scanner-crypto-futures-paper-admission-composer.yml"]},{"id":"direction-paper-validation","state":"PROVEN","matchedFiles":[".github/workflows/signal-direction-paper-bridge-validation.yml"]},{"id":"scanner-canonical-paper-server-consumer","state":"MISSING","matchedFiles":[]}]
- Root Cause: Futures UI action exists, but KR-only composer drops explicit LONG/SHORT and has no server scanner route.
- Owner: #1085 Crypto Futures LONG/SHORT server/canonical consumer wiring
- Dependency Owner: Existing Scanner #719 and Paper admission owner #999; preserve directional safety
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Preserve LONG/SHORT separately and reject NO_TRADE/SIGNAL_CONFLICT at the server boundary before Paper admission.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG007

- Severity / Domain: P1 / candidate-identity
- Producer: Backtest Result
- Consumer: Paper Trading Candidate
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"backtest-paper-navigation","state":"PROVEN","matchedFiles":["stock-analyzer/src/pages/backtests.tsx"]},{"id":"backtest-identity-export","state":"PROVEN","matchedFiles":["api-server/src/services/backtest-paper-handoff.service.ts"]},{"id":"paper-identity-import","state":"PROVEN","matchedFiles":["stock-analyzer/src/pages/paper-trading.tsx"]},{"id":"identity-dimensions","state":"PROVEN","matchedFiles":["packages/strategy-hypothesis/src/backtest-paper-handoff.d.ts"]},{"id":"result-bound-url-handoff","state":"PROVEN","matchedFiles":["stock-analyzer/src/components/backtest-research-panel.tsx"]},{"id":"canonical-strategy-paper-execution-consumer","state":"MISSING","matchedFiles":[]},{"id":"same-candidate-paper-position-consumer","state":"MISSING","matchedFiles":[]},{"id":"accepted-backtest-paper-execution-route","state":"MISSING","matchedFiles":[]}]
- Root Cause: Backtest result references now reach isolated Paper preview, but the manual Paper engine has no canonical same-strategy consumer.
- Owner: #1085 Backtest-to-canonical-Paper consumer wiring
- Dependency Owner: Existing Paper strategy execution/identity contract owner #999/#1019/#1021; preview is not completion
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Implement canonical strategy execution with the same policies; never credit reference preview or manual orders as Natural Paper.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG011

- Severity / Domain: P1 / profitability-evidence
- Producer: Settlement
- Consumer: Full Cost
- Status / Wiring / Classification: OPEN / PARTIAL / EXISTING_OWNER
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"settlement-profitability-gate","state":"PROVEN","matchedFiles":[".github/workflows/prediction-lab-settlement-profitability-evidence-gate.yml"]},{"id":"cost-evidence-contract","state":"PROVEN","matchedFiles":["api-server/src/services/paper-trading-position.service.ts"]},{"id":"manual-paper-full-eight-component-cost-contract","state":"MISSING","matchedFiles":[]}]
- Root Cause: Manual Paper fee/slippage/funding bookkeeping is not the eight-component canonical Full Cost contract.
- Owner: Existing Paper Full Cost owner #1001/#891
- Dependency Owner: #1085 integration must consume, not redefine, measured cost contract
- Owner Acknowledgement: NOT_CONFIRMED; existing domain provenance, not accepted handoff
- Repair: Keep costs separated; integrate measured tax/latency/liquidity/partial-fill evidence without inventing zero values.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG012

- Severity / Domain: P1 / profitability-evidence
- Producer: Full Cost
- Consumer: Net PnL
- Status / Wiring / Classification: OPEN / PARTIAL / EXISTING_OWNER
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"full-cost-source","state":"PROVEN","matchedFiles":["api-server/src/services/paper-trading-position.service.ts"]},{"id":"net-pnl-source","state":"PROVEN","matchedFiles":["api-server/src/services/paper-trading-position.service.ts"]},{"id":"full-cost-components-preserved","state":"MISSING","matchedFiles":[]}]
- Root Cause: Manual Paper Net PnL does not preserve all eight canonical Full Cost components.
- Owner: Existing Paper settlement/Full Cost Net PnL owner #1001/#891
- Dependency Owner: #1085 integration must preserve all cost evidence, not default missing costs to zero
- Owner Acknowledgement: NOT_CONFIRMED; existing domain provenance, not accepted handoff
- Repair: Preserve full measured cost lineage before claiming canonical full-cost Net PnL.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-CG013

- Severity / Domain: P1 / profitability-evidence
- Producer: Net PnL
- Consumer: Validation / Genuine OOS
- Status / Wiring / Classification: OPEN / PARTIAL / EXISTING_OWNER
- Evidence Level: NOT_PROVEN
- Current Proof: [{"id":"oos-validation-workflow","state":"PROVEN","matchedFiles":[".github/workflows/public-forward-liquidity-calibration-oos-validation.yml"]},{"id":"final-holdout-workflow","state":"PROVEN","matchedFiles":[".github/workflows/prediction-lab-final-holdout.yml"]},{"id":"net-pnl-evidence-source","state":"PROVEN","matchedFiles":["api-server/src/services/paper-trading-position.service.ts"]},{"id":"same-candidate-manual-paper-validation-consumer","state":"MISSING","matchedFiles":[]}]
- Root Cause: Manual Paper journal has no same-candidate validation-receipt consumer. Refusing false OOS credit is correct, but the missing implementation remains an open owner gap.
- Owner: Existing Paper/validation receipt owners #1001 and open #547
- Dependency Owner: #1085 wiring after canonical genuine receipt contract; missing consumer is not merely a runtime-evidence gap
- Owner Acknowledgement: NOT_CONFIRMED; existing domain provenance, not accepted handoff
- Repair: Existing Paper/validation owners must define the genuine identity-bound receipt consumer; never credit manual/replay/backfilled data.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-ID002

- Severity / Domain: P1 / identity-continuity
- Producer: api-server/src/services/backtest-paper-handoff.service.ts
- Consumer: stock-analyzer/src/components/backtest-paper-candidate-preview.tsx
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: {"dimensions":[{"dimension":"candidateId","source":true,"destination":true,"status":"PROVEN"},{"dimension":"strategyId","source":true,"destination":true,"status":"PROVEN"},{"dimension":"parameterHash","source":true,"destination":true,"status":"PROVEN"},{"dimension":"market","source":true,"destination":true,"status":"PROVEN"},{"dimension":"symbol","source":true,"destination":true,"status":"PROVEN"},{"dimension":"timeframe","source":true,"destination":true,"status":"PROVEN"},{"dimension":"side","source":true,"destination":true,"status":"PROVEN"},{"dimension":"leverage","source":true,"destination":true,"status":"PROVEN"},{"dimension":"riskPolicyRef","source":true,"destination":true,"status":"PROVEN"},{"dimension":"costPolicyRef","source":true,"destination":true,"status":"PROVEN"},{"dimension":"exitPolicyRef","source":true,"destination":true,"status":"PROVEN"}],"transport":{"id":"id002-transport","state":"PROVEN","matched":true,"matchedFiles":["packages/strategy-hypothesis/src/backtest-paper-handoff.js"],"reason":"STATIC_EVIDENCE_PRESENT"},"required":[{"id":"same-strategy-paper-consumer","state":"MISSING","matched":false,"matchedFiles":[],"reason":"STATIC_EVIDENCE_NOT_FOUND"},{"id":"same-candidate-paper-position-consumer","state":"MISSING","matched":false,"matchedFiles":[],"reason":"STATIC_EVIDENCE_NOT_FOUND"},{"id":"accepted-backtest-paper-execution-route","state":"MISSING","matched":false,"matchedFiles":[],"reason":"STATIC_EVIDENCE_NOT_FOUND"}]}
- Root Cause: All reference dimensions and strict URL import are present; canonical Paper execution still does not carry candidate identity.
- Owner: #1085 all-eight-field same-candidate Paper continuity
- Dependency Owner: Existing Paper execution/identity contract owner #999/#1019/#1021; no reference-only credit
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Keep REFERENCE_ONLY until the real Paper strategy consumer and position/settlement lineage preserve canonical identity.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.

### EL-ID003

- Severity / Domain: P1 / identity-continuity
- Producer: stock-analyzer/src/components/scanner-approval-composer.tsx
- Consumer: api-server/src/routes/trade-automation.ts
- Status / Wiring / Classification: OPEN / PARTIAL / #1085_REAL_GAP
- Evidence Level: NOT_PROVEN
- Current Proof: {"dimensions":[{"dimension":"candidateId","source":false,"destination":false,"status":"MISSING"},{"dimension":"strategyId","source":false,"destination":true,"status":"PARTIAL"},{"dimension":"parameterHash","source":false,"destination":false,"status":"MISSING"},{"dimension":"market","source":true,"destination":true,"status":"PROVEN"},{"dimension":"symbol","source":true,"destination":true,"status":"PROVEN"},{"dimension":"timeframe","source":true,"destination":false,"status":"PARTIAL"},{"dimension":"side","source":false,"destination":true,"status":"PARTIAL"},{"dimension":"leverage","source":false,"destination":true,"status":"PARTIAL"},{"dimension":"accountMode","source":true,"destination":true,"status":"PROVEN"}],"transport":{"id":"id003-transport","state":"PROVEN","matched":true,"matchedFiles":["stock-analyzer/src/components/scanner-approval-composer.tsx"],"reason":"STATIC_EVIDENCE_PRESENT"},"required":[{"id":"scanner-canonical-server-consumer","state":"MISSING","matched":false,"matchedFiles":[],"reason":"STATIC_EVIDENCE_NOT_FOUND"}]}
- Root Cause: Scanner composer payload omits side; scanner backend route does not exist.
- Owner: #1085 Scanner-to-canonical-Paper identity wiring
- Dependency Owner: Existing Paper admission/adapter contract owner #999/#1001
- Owner Acknowledgement: Current-chat #1085 scope authorized
- Repair: Connect explicit validated direction to a Paper-only server seam, without default BUY/LONG.
- Tests: .github/tests/connection-graph-auditor.test.mjs, .github/tests/product-integrity-auditor.test.mjs
- Remaining Runtime Proof: NOT_PROVEN: exact identity-bound runtime receipt, authenticated desktop/mobile E2E, and production evidence. No activation authorized.
