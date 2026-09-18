# PR #1085 Product Integrity Repair — Draft checkpoint

Historical checkpoint for the earlier repair train. Current owner reconciliation, the subsequent AI selection repair and latest P0/P1 status supersede its counts: see `pr-1085-scope-reconciliation-20260917.md` and the regenerated companion Product Integrity audit. This document preserves earlier evidence/history, not current exact-head acceptance.

## Acceptance verdict

**DRAFT_NOT_COMPLETE.** This is a verified repair checkpoint, not final Draft acceptance or release approval. Eleven P1 graph/identity findings remain OPEN. No automatic conversion of missing implementation into a proven blocker is permitted. Ready, Merge, Staging, Production, schedules, secrets, DB mutation and private/live trading remain outside this task.

Repository: `seungjae3908-source/seungjae20260713`. CURRENT_MAIN verified through the GitHub API: `a4c97988eec5ff9a2c534e3e52cf7ba971cce6f6`. Initial PR HEAD: `b65e8e54fbb952da673796770573e96648241e7a`. Implementation/audit checkpoint: `0cd7ac838c477818ec37ae349537b6f78a3c9725`. PR remained OPEN, DRAFT=true, mergeable=true, with zero unresolved review threads. This document does not self-certify a future HEAD; its exact-head checks must be read from GitHub.

## Repairs actually implemented

1. Backtest server results now export canonical candidate/strategy/parameter references using the existing canonical strategy resolver and `strategyCandidateId` algorithm. The accepted request, consumed closed-candle dataset, effective risk/cost/exit policies, leverage, market, symbol, timeframe and explicit LONG/SHORT are bound to each result. Missing immutable research SHA or mismatched dataset keeps candidateId=null with explicit blockers. No edited UI form is substituted for the completed result.
2. Strict shared URL transport and an isolated Paper reference screen preserve eleven identity/policy dimensions. Duplicate, malformed, unsafe or oversized handoffs stay invalid; missing fields remain MISSING. Imported references never mount the BTC-default manual execution panel or journal tools. REFERENCE_ONLY, evidenceCredit=0, executionAuthority=NONE, privateTradingApiAllowed=false, orderSubmitted=false remain fixed. **This is not same-strategy Paper execution**, so EL-CG007 and EL-ID002 remain OPEN.
3. Research Copilot now calls the already-existing server-owned `/prewire-same-candidate` reader after durable READBACK_VERIFIED publication. The response is checked against the selected bundle/artifact/strategy/model/features/dataset/policies/SHA. Caller-supplied runtime stages are not sent. User/DSL/bundle changes clear prior results; cancelled requests cannot publish a new result. Missing stage evidence and identity mismatch are displayed without economic or execution credit. This closes the UI reader omission at the static/read-contract layer only.
4. Backend TypeScript compiler dependency is declared explicitly; frozen pnpm 9 installation and backend typecheck work. No dependency version, permission threshold or test exclusion was weakened.
5. A type-only refinement to the reused canonical candidate hash function changed the authoritative runtime source digest. The source manifest was refreshed from an exact local rebuild; bundle bytes and bundle SHA-256 remained unchanged (`ee070f3d764a034cb1a7c8e40b34a5fa158fdfd9da48c54dcd1d6a2fed37d198`). No runtime package was deployed or activated.

## Auditor changes and current-main comparison

The same strengthened auditor was run against an archive of immutable CURRENT_MAIN and the Draft branch. Capability inventory means static source presence, not usable/runtime-complete features. Generic test/document tokens cannot satisfy executable prefix probes. Contract source tokens no longer imply an executed CONTRACT_PROVEN result. Manual Paper accounting, canonical eight-component Full Cost, Natural Paper and Genuine OOS cannot be joined by unrelated file/workflow presence.

| Measure | CURRENT_MAIN with corrected auditor | Draft checkpoint |
|---|---:|---:|
| Capability static presence | 31/31 | 31/31 |
| Connection edges | 30 | 30 |
| PROVEN / PARTIAL / MISSING / UNKNOWN | 18 / 11 / 1 / 0 | 19 / 10 / 1 / 0 |
| Critical identity continuity static proof | 0/3 | 0/3 |
| Golden Journeys static proof | 4/13 | 5/13 |
| Open P0 / P1 source-contract findings | 0 / 12 | 0 / 11 |
| Orphan page review candidates | 1 | 1 |

`detail-legacy.tsx` is a P2 static import-review candidate, not a proven critical orphan. Service/consumer absence is not covered exhaustively by the page detector. No claim of universal false-positive elimination or complete runtime orphan coverage is made.

The generated companion audit contains capability inventory, all 30 edges, all 13 journeys, identity dimensions and the full OPEN P0/P1 Error Ledger with Domain, Producer, Consumer, Status, Evidence Level, Current Proof, Root Cause, Owner, Repair, Tests and Remaining Runtime Proof. OPEN is distinct from wiring PARTIAL/MISSING. A blocker token alone cannot close an item or grant BLOCKED_WITH_PROVEN_REASON.

## Closed auditor false-positive history

All entries below close auditor sub-findings only. They do not close unrelated execution or runtime findings.

### EL-CAP025 / EL-PI004

- Severity / Domain: P1 / member-access and auth-product auditor.
- Producer → Consumer: canonical member-access package → capability inventory / protected-route graph.
- Status / Classification / Evidence: CLOSED / AUDITOR_FALSE_POSITIVE / STATIC_PROVEN.
- Current Proof: `packages/member-access/src/index.js` and `index.d.ts` exist and expose the canonical capability contract; the old probe looked for fictional `index.ts`.
- Root Cause: wrong package entry path, not missing membership implementation.
- Owner / Repair: #1085 auditor; locate existing JS/d.ts instead of creating competing member authority.
- Tests: member-path regression plus auditor suite PASS.
- Remaining Runtime Proof: login/logout/refresh/expiry/disabled member/admin/regular member journeys NOT_PROVEN.

### EL-CG015

- Severity / Domain: P1 / account-portfolio auditor.
- Producer → Consumer: read-only account response → authorizedFetch → portfolio.
- Status / Classification / Evidence: CLOSED / AUDITOR_FALSE_POSITIVE / STATIC_PROVEN.
- Current Proof: existing `account-readonly-response.ts` uses uppercase UNAVAILABLE and strict safety/null checks; `auth-fetch.ts` applies `requireAccountReadonlySnapshotResponse` to cloned JSON.
- Root Cause: case/path/token mismatch in the old probe.
- Owner / Repair: #1085 auditor; recognize and verify the existing consumer, without adding order/private authority.
- Tests: canonical uppercase response and enforcement-consumer regression PASS.
- Remaining Runtime Proof: real Toss/Upbit/Bitget account availability, identity, stale data and overlay behavior NOT_PROVEN.

### EL-FP-CRYPTO-MOUNT (sub-finding of EL-CG005 / EL-CG006)

- Severity / Domain: P1 / scanner-paper auditor.
- Producer → Consumer: Signal Scanner selection → mounted ScannerApprovalComposer.
- Status / Classification / Evidence: CLOSED / AUDITOR_FALSE_POSITIVE / STATIC_PROVEN.
- Current Proof: CURRENT_MAIN `signal-scanner.tsx` already mounts the composer in desktop/mobile order preparation. Actual composer supports KR only; scanner server route is absent.
- Root Cause: old auditor searched the wrong workspace for the UI action.
- Owner / Repair: #1085 auditor; probe the actual mounted action and separately require supported market/direction plus backend route.
- Tests: frontend-only KR endpoint cannot prove backend regression PASS.
- Remaining Runtime Proof: Spot/Futures same-candidate Paper admission NOT_PROVEN. EL-CG005/006 remain OPEN.

### EL-FP-ECONOMIC-JOIN / EL-FP-CONTRACT-LEVEL

- Severity / Domain: P1 / proof semantics.
- Producer → Consumer: unrelated workflow/service tokens → graph and identity summaries.
- Status / Classification / Evidence: CLOSED / AUDITOR_FALSE_POSITIVE / STATIC_PROVEN.
- Current Proof: broad prefix probes previously matched tests and independent Natural Paper services; source-only identity dimensions were labelled CONTRACT_PROVEN. Corrected probes expose missing manual Full Cost and validation lineage, and cap source scanning at STATIC_PROVEN.
- Root Cause: generic token co-presence was stronger than the evidence actually supported.
- Owner / Repair: #1085 auditor; explicit consumers, test/document exclusion, executable-contract proof tracked separately.
- Tests: unrelated Natural Paper tokens cannot prove manual Full Cost/OOS; complete reference cannot prove Paper execution; blocker token cannot close P1 — PASS.
- Remaining Runtime Proof: every runtime/E2E/production journey remains NOT_PROVEN.

## Error-first CI ledger

Final probe review also corrected a Telegram auditor sub-finding: the holdings producer delegates to `deliverMemberHoldingTelegramAlert`, which then calls `deliverPersonalTelegramAlert`. Requiring a fictional direct producer call was an AUDITOR_FALSE_POSITIVE, now CLOSED at STATIC_PROVEN with a two-hop delegate regression test. The actual Scanner UI alert source is `signal-scanner.tsx`, not the unrelated crypto workspace. Central notification history lineage is still deliberately PARTIAL.

### EL-CI-MANIFEST

- Severity / Domain: P1 / immutable runtime package integrity.
- Producer → Consumer: `strategy-promotion.service.ts` source → authoritative package manifest.
- Status / Classification / Evidence: CLOSED / REAL_PRODUCT_GAP / CONTRACT_PROVEN at verified checkpoint.
- Current Proof: run 35174588434 failed at exact-source rebuild diff; type-only source digest was stale. Bundle executable bytes were unchanged. Source manifest now exactly matches rebuilt output. Corrected-head run 35175205274 succeeded.
- Root Cause / Owner / Repair: #1085 type refinement changed source hashes; #1085 refreshed only the two digest fields. Canonical producer version/source pins were preserved.
- Tests: exact rebuilt bundle and manifest comparison PASS; Authoritative Paper Runtime Factory SUCCESS.
- Remaining Runtime Proof: actual deployed runtime package/consumer not checked or activated.

### EL-CI-BOUNDED-DIFF

- Severity / Domain: P1 / release-authority policy.
- Producer → Consumer: #1085 whole PR diff → Paper Forward Schedule Activation Validation.
- Status / Classification / Evidence: BLOCKED_WITH_PROVEN_REASON / INTENTIONAL_SAFETY_BLOCK / CONTRACT_PROVEN (rejection, not readiness).
- Current Proof: runs 35174588376 and 35175205323 fail `Require bounded non-UI diff`, first rejected path `.github/scripts/connection-graph-auditor.mjs`. The workflow requires every changed path to be on its bounded activation-train list and forbids `stock-analyzer/*`.
- Root Cause: a Paper source/type change triggers an activation-specific validator whose whole-PR policy is incompatible with this explicitly authorized cross-product UI/auditor repair train.
- Owner: existing CI/Paper release authority; #1085 must not absorb activation authority.
- Repair: requires an explicit owner/control decision on PR scope versus validation policy. No path/error allowlist expansion, threshold weakening, test skip, rerun or activation was performed. This is a proven CI acceptance blocker, not proof that unfinished product gaps are blocked.
- Tests: trigger coverage PASS, bounded-diff rejection reproduced from exact-head GitHub logs. Subsequent checks SKIPPED, not success.
- Remaining Runtime Proof: all activation/scheduler runtime checks in this failed lane are NOT_PROVEN.

Fast CI runs 35174588372, 35175205270 and 35175565275 succeeded on their respective exact heads. No run was rerun to pass. Local smoke initially found a new HTTP 500 because parsed optional trailing-stop fields contained undefined; normalization to the actual engine defaults plus a regression test fixed the cause before the next test run. Smoke then passed 109/109; Phase 5 passed 87/87. Frontend/backend typecheck and builds passed. Auditor/exact-head workflow tests passed 35/35; rendered Paper/Research contract tests passed 2/2. SSR tests are not authenticated browser E2E.

## Full audit-scope findings

| Area | Verified static path / reader | Boundary or remaining gap |
|---|---|---|
| AI | Scanner selection storage/query → AI Chart; AI Chat authenticated backend route | AI Chat serializes market/symbol only; timeframe/action/strategy/candidate continuity and stale cross-selection reply prevention are not complete. EL-ID001 OPEN. |
| Research | Workspace mounts Copilot and Video; canonical Bundle resolver, durable file publication/readback, same-candidate stored stage reader, promotion truth UI | New read-only UI consumer wired. Stage files/catalog/configuration and real observations are NOT_PROVEN. Video runtime reader belongs to open #1042 and current main shows static/provider-unconfigured UI. |
| KR / US Scanner | Shared composer present | KR `/scanner/plans` route absent. US blocker explicit. Generic `/plans` is not a safe substitute; it includes live-capable automation semantics. |
| Spot / Futures Scanner | Signal Scanner actions exist; canonical admission workflow/composer/producer modules exist on main | UI composer is KR-only; payload omits explicit side; absent scanner backend consumer. LONG/SHORT and NO_TRADE/SIGNAL_CONFLICT admission must remain fail-closed. |
| Backtest | Accepted server request → canonical reference → strict URL → isolated preview | Actual candidate strategy execution/position/settlement lineage not implemented. Reference/URL data has no admission authority. Research, Scanner and AI candidates are not interchangeable backtest producers. |
| Paper economics | Manual engine opens positions, closes them, records entry/exit fee, slippage, funding and Net PnL | Eight-component Full Cost and same-candidate Genuine OOS not joined. Missing cost components are not zero. Natural Paper has independent canonical accounting/CLI/workflow evidence contracts; actual natural samples not fetched. |
| Account / Portfolio | Canonical response safety checks → auth-fetch → portfolio; holdings → chart overlay; canonical journal → Portfolio AI query | Provider account data, freshness, exact-user isolation and runtime overlay correctness remain unverified. AI advisor rejects client state authority and does not execute orders. |
| Alert / Telegram | Main has real scanner delivery calls, freshness routing, personal policy/outbox, user delivery worker, holdings/watchlist producers and startup calls; holdings uses its concrete personal-dispatch delegate | Worker startup is safety-policy gated; watchlist producer is gated. No Telegram message was sent, schedule enabled or production storage read. Scanner alerts render in Signal Scanner, but the central notification_history producer join remains partial; AI/Research/Position events are not assumed universally supported. |
| Auth / Member | Backend getUser(token), exact current profile and canonical capability checks; disabled/revoked/suspended/withdrawn checks | Session expiry/logout revocation across devices and admin/regular desktop/mobile behavior require runtime evidence. user_metadata display name is not member authority. No Auth/DB/environment settings changed. |
| PC / Mobile | Existing shared scanner selections and composers; new responsive reference/readback sections use the same parsed identity, wrapping text and minimum-height controls | Static component/layout parity only. No real desktop/mobile authenticated browser or production certification was performed. |

Additional P2 review: empty manual Paper journal currently displays a 0% win rate from zero samples (`paper-trading-panel.tsx` / `calculatePaperStatistics`). Zero trade count is measurable; win rate is unavailable. This existing display issue is not fixed or treated as performance proof in this checkpoint.

## Existing owners / collision check

Seventeen other open PR file lists were checked against #1085's exact changed paths. One shared file overlaps #1041: `api-server/test.mjs`. #1041 adds two Agent Hub tests to the smoke group; #1085 adds one Backtest handoff test to Phase 5. These are distinct additive hunks; no Agent Hub code/test registration was removed or absorbed. Both owners must preserve the other additions when eventually integrating.

#1042 retains Video UI/runtime, route index and Video E2E ownership; none of its files were modified. #1072 retains AI Chart precache startup, #1039 authoritative phase-3 research source, #1020 main Required CI bridge, #1086 owner recovery command. Other open research/observer owners had no exact changed-file overlap. Semantic coordination is still required for canonical Paper identity consumers; absence of file overlap is not proof of absence of all semantic collision.

Historical scanner approval PRs #52 and #54 are CLOSED and **unmerged**. They are not current-main implementation evidence and were not copied, reopened or activated.

## Safety / stop line

No Ready, Merge, Full CI dispatch, Staging, Production deploy, schedule activation, DB/secret/environment mutation, real order, cancel/amend, transfer/withdrawal or private trading API was performed. Automatically triggered workflows bearing Production names ran their PR contract/safety jobs only; deployment/approval jobs were skipped. Source-only scans and successful Fast CI are not six Required CI contexts or release readiness.

## Approval table

| 승인할 것 | 무슨 기능 | 경로 | 뭘 눌러야 하는지 |
|---|---|---|---|
| 지금은 없음 | Draft checkpoint 검토와 남은 P1 / CI-policy owner 조정 | GitHub PR #1085 → Conversation / Files changed / Checks | 보고서와 실패한 bounded non-UI 게이트 확인만. Ready 버튼을 누르지 않음 |
| 요청하지 않음 | Ready + canonical Full CI 6/6 | PR #1085 | P1 OPEN 및 CI acceptance blocker가 남아 있으므로 승인 요청 없음 |
| 금지 유지 | Merge / Staging / Production / Live / schedules | Release Control #23 / SSOT #838 | 어떤 실행·승인 버튼도 누르지 않음 |
