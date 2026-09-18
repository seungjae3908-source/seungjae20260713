# #1085 CI/Paper owner scope reconciliation — Draft only

Current-chat authority: scope coordination, actual product wiring repairs, tests and Fast CI only. Ready, canonical Full CI dispatch, Merge, Staging, Production, DB/Secret/Env mutation, schedules, private/live trading and real financial operations remain forbidden.

## Current main and history

REAL GitHub main moved from `a4c97988eec5ff9a2c534e3e52cf7ba971cce6f6` to `2b96802a86c9d19f4c8620b71252af2f9184633d` through #1086. Its only changed path is `.github/workflows/agent-hub-processor-window-recovery.yml`, with no #1085 scope collision. History-preserving non-force merge: `08faab0ccea602f88dfdab2a0ace93b9b1ca7905`.

Implementation checkpoint: `e952a579` (resolve full exact final HEAD/CI from GitHub after publishing this document; this document does not self-certify its future HEAD).

## Responsibilities and all eleven original P1 findings

#1085 owns Product Integrity/Connection Graph/Golden Journey and real product wiring. The existing Paper owner retains Paper-only safety/admission/execution contracts, bounded-diff controls and activation/runtime policies. Classification is not status: EXISTING_OWNER does not close an implementation defect, imply accepted handoff, or make it BLOCKED. None of the eleven original P1s is reclassified as a safety-only/runtime-only finding or false positive.

| Original P1 | Reconciled classification | Current status | Primary owner | Canonical dependency/root cause |
|---|---|---|---|---|
| EL-CG003 | #1085_REAL_GAP | OPEN | #1085 KR Scanner wiring | Actual scanner server route and canonical Paper consumer absent; existing Paper admission/adapter owner #999/#1001 |
| EL-CG004 | #1085_REAL_GAP | OPEN | #1085 US Scanner wiring | US Paper route/adapter semantics absent; UI protection retained, but it does not hide implementation absence |
| EL-CG005 | #1085_REAL_GAP | OPEN | #1085 Crypto Spot wiring | KR-only composer, missing scanner server route/consumer; existing Scanner #719/Paper #999 contracts preserved |
| EL-CG006 | #1085_REAL_GAP | OPEN | #1085 Crypto Futures LONG/SHORT wiring | Explicit direction lost; scanner server route/consumer absent; existing directional Paper admission contracts preserved |
| EL-CG007 | #1085_REAL_GAP | OPEN | #1085 Backtest-to-Paper wiring | Preview transports identity but real same-strategy Paper consumer absent; existing Paper identity/execution #999/#1019/#1021 |
| EL-CG011 | EXISTING_OWNER | OPEN | Existing Paper Full Cost #1001/#891 | Manual settlement does not consume measured canonical eight-component cost; missing values cannot be zero |
| EL-CG012 | EXISTING_OWNER | OPEN | Existing Paper settlement/Net PnL #1001/#891 | Manual Net PnL does not preserve complete canonical cost evidence |
| EL-CG013 | EXISTING_OWNER | OPEN | Existing Paper #1001 and open validation #547 | Genuine same-candidate validation receipt consumer absent; refusing fake manual/replay OOS credit is not implementation completion |
| EL-ID001 | #1085_REAL_GAP | CLOSED — source/contract scope | #1085 AI selection wiring | Shared selection now reaches real backend validation/publicContext/provider prompt/response echo; stale/cancelled replies isolated; timeframe OHLCV absence explicit |
| EL-ID002 | #1085_REAL_GAP | OPEN | #1085 same-candidate continuity | All-eight-field reference is insufficient without canonical real Paper execution route and position consumer |
| EL-ID003 | #1085_REAL_GAP | OPEN | #1085 Scanner identity wiring | Real server route → canonical identity → Paper consumer absent; button presence alone insufficient |

Original distribution: eight #1085 real gaps, three existing-owner implementation gaps. After actual AI repair: P0 OPEN=0, P1 OPEN=10, comprising seven #1085 real gaps and three existing-owner gaps. Edge/identity findings overlap; ten findings are not ten independent features. Product acceptance remains NOT_COMPLETE.

## Actual AI root-cause repair and evidence

Commit `eae4cf0a` reuses the existing AnalysisSelection contract and URL pattern. The request carries market, symbol/ticker, timeframe, action and selectedAt. The backend validates known timeframe/direction and market compatibility, rejects invalid/future selection scope before outbound work, and preserves the scope in publicContext, the actual provider prompt, the single-flight prompt key and the response echo. Unknown direction/timeframe stays null, not BUY/LONG/daily.

The chat conversation is keyed to the exact selection identity. A new market/symbol/timeframe/action/selectedAt mounts isolated state; unmount aborts the prior request. Even a matching response after cancellation is rejected, and a mismatched/missing server echo cannot attach to the current selection. URL handoff now preserves bounded action. The React review skill informed primitive-key isolation and cancellation/identity guards.

Selected-timeframe OHLCV is not supplied by the existing quote/24h reader; the actual response and provider data disclosure state that missing data explicitly. No new provider/private API or synthetic chart evidence was introduced. This closes identity transport/consumer wiring, not authenticated browser behavior, complete technical analysis, E2E, Production or profitability.

Executed local evidence: Phase 9 848/848 PASS, including the actual HTTP route contract, backend invalid-scope rejection, KR/US/Spot/Futures refusal identity echo, real public-context/provider payload assertions and frontend mismatch/cancellation/key isolation. Both frontend/backend typechecks PASS. Auditor/exact-head contracts 39/39 PASS. Remote exact-head Fast CI remains to be checked after the final push. No failed assertion was retried without a source repair; the esbuild sandbox access denial was an execution-boundary failure, not a test assertion, and execution was authorized normally without test/gate changes.

## Stronger proof conditions — no preview credit

Backtest continuity requires candidateId, strategyId, parameterHash, market, symbol, timeframe, side and leverage through the actual canonical execution route and Paper position consumer. All reference fields/types and a rendered preview cannot prove it. Scanner KR/US/Spot/Futures require the actual scanner server route, Paper envelope validation, canonical identity/admission and a concrete existing Paper consumer. The audit now references verified existing `runRecurringPaperCycle` and `applyPaperTradingAction` exports; declaration-only/preview-only fixtures remain PARTIAL. These are declared source-chain probes, not runtime execution certificates; any future delegated implementation must be inspected and tested as a real chain, not penalized for not calling a delegate directly.

## Paper bounded-diff control — unchanged, rejection preserved

`.github/workflows/paper-forward-schedule-validation.yml` blob on both latest main and #1085 is `e6a49f7cdb505120f2294d69500dd0cf642bac64`. Activation/no-deploy workflow diffs are empty. Timeout, trigger/check range, bounded paths, thresholds and fail-closed rejection are unchanged. No allowlist expansion/error allowlist, test skip, rerun/retry-to-pass, timeout increase or fake success is authorized or performed.

The prior exact-head run [35175830159](https://github.com/seungjae3908-source/seungjae20260713/actions/runs/35175830159) failed `Require bounded non-UI diff`: `unexpected path: .github/scripts/connection-graph-auditor.mjs`. This is an actual safety-policy rejection, not permission to weaken it. Final exact-head result must be read separately after synchronization, not inherited as success. The owner must reconcile the cross-product PR scope with the existing bounded Paper owner train while keeping the guard intact. #1085 must not absorb activation authority or manufacture a new bypass workflow.

## Existing owner provenance and coordination

REAL GitHub verified merged owner history (authorship is repository owner `seungjae3908-source`):

- #999: frozen canonical candidate lifecycle; merge `78bd576e9961998c51798107019f05532efbde48`.
- #1001: identity-bound exit execution/settlement/Full Cost; merge `1f3fa8261d9904c34d3d494e34c9914fb233b3a7`.
- #1019/#1021: exact Phase3 candidate namespace through Natural lifecycle and recurring entry; merges `4a2163301d8a5c606e2bdf32b8d3a3e4df14950f` / `6256e6b9520cfd810478fc6fc089e5dda0bd32e9`.
- #891: genuine liquidity-impact evidence producer, not fabricated measured-zero or Full Cost readiness; merge `0c213562ee901f067ab80346a29954634f78a506`.
- #1073: existing Paper no-deploy certification/activation authority; merge `ccd2761bb0c4c946f64024c935f41fbe1187b797`.
- #1084: latest Paper risk-policy transport owner/control chain; merge `a4c97988eec5ff9a2c534e3e52cf7ba971cce6f6`.
- #719 is merged Scanner forward adapter. #547 remains OPEN/Draft validation owner; its files were not changed.

Historical Issue #838 ledger is continuity context, not a fresh active lease or runtime proof. Latest open PR enumeration identified sixteen other open PRs and no active open Paper-policy PR/writer. **Owner acceptance is NOT_CONFIRMED**. [A narrowly scoped reconciliation request](https://github.com/seungjae3908-source/seungjae20260713/pull/1084#issuecomment-5707884450) was posted to the existing Paper owner PR, asking for active-owner confirmation and scope/dependency disposition only. It contains no activation/control command. Missing contracts and #1085 wiring findings stay OPEN pending real implementation and evidence.

## Owner collision

Latest open-owner file lists were refreshed. #1041 head `3039039e0fb0df3b934885a2a2fa328f82a6ad98` shares only `api-server/test.mjs`: owner adds two Agent Hub smoke tests, while #1085's previous change adds one Phase5 Backtest test. A read-only `git apply --check` of the verified #1041 test hunk against current #1085 PASSed. No #1041 hunk was applied, removed or absorbed, and the test registration file was not changed in this reconciliation turn. Preserve both additive hunks during future authorized integration. Exact-path collision does not prove semantic collision absence.

#1042 Video runtime/UI/index/E2E, #1072 precache, #1039 authoritative source, #1020 Required CI bridge and all other owner files remain untouched. #1086 is now merged and preserved through main alignment.

## Next decision / stop line

Next coordination dependency: the existing Paper owner must confirm the active contract/policy responsibility and an owner-preserving scope disposition with the bounded gate intact. That acknowledgement is not received and is not inferred from a posted request. Continue real product root-cause repairs only against verified canonical consumer contracts; do not close findings through preview/scope reassignment. No Ready request at this stage. No release/activation/DB/secrets/env/private/live authority is implied.
