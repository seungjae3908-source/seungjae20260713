import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(process.cwd(), "..");
const naturalWorkflowPath = resolve(repoRoot, ".github/workflows/natural-paper-outcome-schedule-activation.yml");
const publicWorkflowPath = resolve(repoRoot, ".github/workflows/paper-forward-schedule-activation.yml");
const installerPath = resolve(repoRoot, "ops/install-natural-paper-outcome-schedule.sh");
const verifierPath = resolve(repoRoot, "ops/verify-natural-paper-outcome-cycle.sh");

const naturalWorkflow = readFileSync(naturalWorkflowPath, "utf8");
const publicWorkflow = readFileSync(publicWorkflowPath, "utf8");
const installer = readFileSync(installerPath, "utf8");
const verifier = readFileSync(verifierPath, "utf8");

test("Natural Paper activation remains a separate exact-owner production approval lane", () => {
  assert.match(naturalWorkflow, /\/activate-natural-paper-outcome-schedule <40-character-current-main-sha>/u);
  assert.match(naturalWorkflow, /COMMENT_AUTHOR.*seungjae3908-source/su);
  assert.match(naturalWorkflow, /AUTHOR_ASSOCIATION.*OWNER/su);
  assert.match(naturalWorkflow, /environment: production/u);
  assert.match(naturalWorkflow, /Require exact current main and Required CI 6\/6/u);
  assert.match(naturalWorkflow, /PostgreSQL Auth evidence/u);
  assert.match(naturalWorkflow, /Staging Readiness evidence/u);
  assert.match(naturalWorkflow, /Require Production already deployed at exact approved SHA/u);
  assert.doesNotMatch(naturalWorkflow, /deploy-production\.sh/u);
});

test("legacy public-forward activation remains observation-only and is not silently upgraded", () => {
  assert.match(publicWorkflow, /\/activate-paper-forward-schedule <40-character-current-main-sha>/u);
  assert.match(publicWorkflow, /tradeOutcomeNotClaimed: invocation\.paperTradeOutcomeAccumulating === false/u);
  assert.match(publicWorkflow, /paperTradeOutcomeAccumulating: false/u);
  assert.doesNotMatch(publicWorkflow, /activate-natural-paper-outcome-schedule/u);
});

test("Natural Paper installer explicitly enables outcomes while hard-disabling live and private authority", () => {
  execFileSync("bash", ["-n", installerPath]);
  assert.match(installer, /PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED=true/u);
  assert.match(installer, /export LIVE_TRADING=false/u);
  assert.match(installer, /export AUTO_TRADING=false/u);
  assert.match(installer, /export REAL_ORDER_ENABLED=false/u);
  assert.match(installer, /export PRIVATE_TRADING_API_ALLOWED=false/u);
  assert.match(installer, /EXPECTED_STRATEGY_ID="paper-forward-authoritative-account-v1"/u);
  assert.match(installer, /Natural Paper mode cutover requires the prior schedule to be disabled/u);
  assert.match(installer, /predecessorStatePreserved: true/u);
  assert.match(installer, /predecessorPerformanceMixed: false/u);
  assert.match(installer, /executionAuthority: 'NONE'/u);
  assert.match(installer, /orderCount: 0/u);
});

test("installer disables a newly installed schedule and restores predecessor state if wrapper post-processing fails", () => {
  assert.match(installer, /INSTALL_SUCCEEDED=0/u);
  assert.match(installer, /if \(\( status != 0 \)\) && \[\[ "\$INSTALL_SUCCEEDED" == 1 \]\]/u);
  assert.match(installer, /bash "\$DISABLER"/u);
  assert.match(installer, /RESTORE_ARCHIVE_ON_ERROR/u);
  assert.match(installer, /mv "\$ARCHIVE_PATH" "\$RUNTIME_STATE_ROOT"/u);
});

test("first natural cycle proves outcome capability without fabricating a mandatory trade", () => {
  execFileSync("bash", ["-n", verifierPath]);
  assert.match(verifier, /outcomeCapabilityEnabled: invocation\.paperTradeOutcomeAccumulationEnabled === true/u);
  assert.match(verifier, /authoritativeAccountBound: account\?\.accountBindingVerified === true/u);
  assert.match(verifier, /authoritativeLedgerPersisted/u);
  assert.match(verifier, /fourReadyProviders/u);
  assert.match(verifier, /positionCollectionPresent/u);
  assert.match(verifier, /settlementCollectionPresent/u);
  assert.doesNotMatch(verifier, /state\.positions\.length === 0/u);
  assert.doesNotMatch(verifier, /state\.settlements\.length === 0/u);
  assert.match(verifier, /zeroOutcomeFirstCycleAllowed: true/u);
  assert.match(verifier, /profitabilityClaimed: false/u);
  assert.match(verifier, /privateRequestCount: 0/u);
  assert.match(verifier, /financialMutationCount: 0/u);
  assert.match(verifier, /orderCount: 0/u);
  assert.match(verifier, /liveTrading: false/u);
});

test("activation validation auto-disables a failed schedule and records no profitability claim", () => {
  assert.match(naturalWorkflow, /Disable schedule automatically if Natural Paper activation validation fails/u);
  assert.match(naturalWorkflow, /disable-paper-forward-schedule\.sh/u);
  assert.match(naturalWorkflow, /Zero-outcome first cycle is allowed; no fabricated trade is required\./u);
  assert.match(naturalWorkflow, /Profitability \/ Champion claim: `false`/u);
  assert.match(naturalWorkflow, /Real orders\/cancels\/amends\/transfers\/withdrawals: `0`/u);
});
