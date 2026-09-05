import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareResearchProductionIdentityCutover,
  resolveOutcomeAccumulationEnabled,
} from "../scripts/run-paper-forward-schedule.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const NOW = Date.UTC(2026, 7, 18, 0, 0, 0);

async function writeState(root, { researchCodeSha = OLD_SHA, strategyId = "paper-forward-public-evidence-v1" } = {}) {
  const path = join(root, "state", "recurring-paper-loop.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ identity: { researchCodeSha, strategyId } }, null, 2)}\n`);
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(join(root, "status", "marker.txt"), "preserve-me\n");
  return path;
}

test("Research Production enables simulated Paper outcome accumulation without external authority", () => {
  assert.equal(resolveOutcomeAccumulationEnabled({ RESEARCH_PRODUCTION: "true" }), true);
  assert.equal(resolveOutcomeAccumulationEnabled({ RESEARCH_PRODUCTION: "true", PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED: "false" }), true);
  assert.equal(resolveOutcomeAccumulationEnabled({ PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED: "true" }), true);
  assert.equal(resolveOutcomeAccumulationEnabled({}), false);
});

test("Paper installer binds outcome accumulation mode to Research Production inside the isolated cron environment", async () => {
  const installer = await readFile(new URL("../../ops/install-paper-forward-schedule.sh", import.meta.url), "utf8");
  const outcomeBinding = "PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='$OUTCOME_ACCUMULATION_ENABLED'";
  const researchBinding = "RESEARCH_PRODUCTION='$OUTCOME_ACCUMULATION_ENABLED'";
  assert.match(
    installer,
    /OUTCOME_ACCUMULATION_ENABLED="\$\{PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED:-false\}"/,
  );
  assert.ok(installer.includes(outcomeBinding));
  assert.ok(installer.includes(researchBinding));
  assert.ok(installer.indexOf(researchBinding) > installer.indexOf(outcomeBinding));
  assert.doesNotMatch(installer, /RESEARCH_PRODUCTION='true'/);
});

test("Paper installer requires authenticated target-SHA seed before identity cutover and cron mutation", async () => {
  const installer = await readFile(new URL("../../ops/install-paper-forward-schedule.sh", import.meta.url), "utf8");
  assert.ok(installer.includes('PUBLISHER_BINDING_PATH="$STATE_ROOT/publisher-binding.json"'));
  assert.ok(installer.includes('PAPER_STATE_SNAPSHOT_PATH="$PUBLISHER_DIR/paper-state-v2.json"'));
  assert.ok(installer.includes("paper-state-publisher-runtime-binding-v1"));
  assert.ok(installer.includes("validateAuthoritativeNaturalPaperLedger"));
  assert.ok(installer.includes("createAuthoritativeNaturalPaperLedgerFromSnapshot"));
  assert.ok(installer.includes("PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED"));
  assert.ok(installer.includes("PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH='$PAPER_STATE_SNAPSHOT_PATH'"));
  assert.ok(installer.includes("PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256='$PUBLISHER_ACCOUNT_ID_SHA256'"));
  assert.ok(installer.includes("LIVE_TRADING='false'"));
  assert.ok(installer.includes("PRIVATE_TRADING_API_ALLOWED='false'"));
  assert.ok(installer.includes("REAL_ORDER_ENABLED='false'"));

  const seedPreflightIndex = installer.indexOf("createAuthoritativeNaturalPaperLedgerFromSnapshot");
  const cutoverIndex = installer.indexOf('IDENTITY_CUTOVER="false"');
  const cronMutationIndex = installer.indexOf('CRON_LINE="$CRON_EXPRESSION');
  assert.ok(seedPreflightIndex >= 0);
  assert.ok(cutoverIndex > seedPreflightIndex);
  assert.ok(cronMutationIndex > cutoverIndex);
});

test("no-deploy activation passes only a protected lowercase publisher SHA-256 binding without disclosure", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/paper-forward-schedule-no-deploy-activation.yml", import.meta.url),
    "utf8",
  );
  const stepStart = workflow.indexOf("      - name: Install isolated exact-SHA Paper runtime and cron without application deployment");
  const stepEnd = workflow.indexOf("      - name: Verify Production application identity remained unchanged", stepStart);
  const installStep = workflow.slice(stepStart, stepEnd);

  assert.ok(stepStart >= 0);
  assert.ok(stepEnd > stepStart);
  assert.ok(installStep.includes(
    "PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: ${{ secrets.PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256 }}",
  ));
  assert.equal(
    (installStep.match(/\^\[0-9a-f\]\{64\}\$/gu) ?? []).length,
    2,
    "the protected binding must fail closed before SSH and again on the remote host",
  );
  assert.ok(installStep.includes("exit 14"));
  assert.match(
    installStep,
    /PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256=%q bash -s'[\s\S]*"\$PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256"/u,
  );
  assert.ok(installStep.includes(
    'PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256="$PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256" \\',
  ));

  const bindingContract = /^[0-9a-f]{64}$/u;
  assert.equal(bindingContract.test("a".repeat(64)), true);
  for (const invalid of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), ` ${"a".repeat(64)}`]) {
    assert.equal(bindingContract.test(invalid), false);
  }

  assert.doesNotMatch(
    installStep,
    /(?:echo|printf\s+['"]%s\\n['"])\s+"\$PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256"/u,
  );
  assert.doesNotMatch(installStep, /publisherAccountIdSha256/u);
  assert.doesNotMatch(
    installStep,
    /EVIDENCE_DIR[^\n]*PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256|PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256[^\n]*EVIDENCE_DIR/u,
  );
});

test("Research Production archives predecessor Paper identity and starts the target identity from zero", async () => {
  const temp = await mkdtemp(join(tmpdir(), "research-paper-cutover-"));
  const root = join(temp, "forward", "paper");
  await writeState(root);

  const result = await prepareResearchProductionIdentityCutover({
    rootDirectory: root,
    researchCodeSha: NEW_SHA,
    outcomeAccumulationEnabled: true,
    nowMs: NOW,
  });

  assert.equal(result.identityCutover, true);
  assert.equal(result.archivedResearchSha, OLD_SHA);
  assert.equal(result.archivedStrategyId, "paper-forward-public-evidence-v1");
  assert.equal(result.targetResearchSha, NEW_SHA);
  assert.equal(result.targetStrategyId, "paper-forward-simulated-outcome-v1");
  assert.match(result.archivePath, /paper-identity-archives/);
  assert.equal(await readFile(join(result.archivePath, "status", "marker.txt"), "utf8"), "preserve-me\n");
  await assert.rejects(access(join(root, "state", "recurring-paper-loop.json")));
  await access(root);

  const manifest = JSON.parse(await readFile(join(temp, "forward", "paper-identity-cutovers", `${NEW_SHA}.json`), "utf8"));
  assert.equal(manifest.predecessorStatePreserved, true);
  assert.equal(manifest.predecessorPerformanceMixed, false);
  assert.equal(manifest.newIdentityStartsFromZero, true);
  assert.equal(manifest.paperTradeOutcomeAccumulationEnabled, true);
  assert.equal(manifest.simulatedFinancialAdaptersEnabled, true);
  assert.equal(manifest.externalFinancialMutationAllowed, false);
  assert.equal(manifest.privateRequestCount, 0);
  assert.equal(manifest.financialMutationCount, 0);
  assert.equal(manifest.orderCount, 0);
  assert.equal(manifest.liveTrading, false);
  assert.equal(manifest.privateApi, false);
  assert.equal(manifest.orderAuthority, false);
});

test("matching Research Production Paper identity is preserved without cutover", async () => {
  const temp = await mkdtemp(join(tmpdir(), "research-paper-same-"));
  const root = join(temp, "forward", "paper");
  const statePath = await writeState(root, {
    researchCodeSha: NEW_SHA,
    strategyId: "paper-forward-simulated-outcome-v1",
  });

  const result = await prepareResearchProductionIdentityCutover({
    rootDirectory: root,
    researchCodeSha: NEW_SHA,
    outcomeAccumulationEnabled: true,
    nowMs: NOW,
  });

  assert.equal(result.identityCutover, false);
  assert.equal(result.archivedResearchSha, NEW_SHA);
  await access(statePath);
});

test("disabled Research Production Paper root cannot be cut over or re-enabled", async () => {
  const temp = await mkdtemp(join(tmpdir(), "research-paper-disabled-"));
  const root = join(temp, "forward", "paper");
  const statePath = await writeState(root);
  await writeFile(join(root, "DISABLED"), "disabled\n");

  await assert.rejects(
    prepareResearchProductionIdentityCutover({
      rootDirectory: root,
      researchCodeSha: NEW_SHA,
      outcomeAccumulationEnabled: true,
      nowMs: NOW,
    }),
    (error) => error?.code === "PAPER_FORWARD_SCHEDULE_DISABLED",
  );

  await access(join(root, "DISABLED"));
  await access(statePath);
  assert.equal(await readFile(join(root, "status", "marker.txt"), "utf8"), "preserve-me\n");
  await assert.rejects(access(join(temp, "forward", "paper-identity-archives")));
});

test("invalid predecessor identity fails closed without moving Paper state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "research-paper-invalid-"));
  const root = join(temp, "forward", "paper");
  const statePath = await writeState(root, { researchCodeSha: "not-a-sha" });

  await assert.rejects(
    prepareResearchProductionIdentityCutover({
      rootDirectory: root,
      researchCodeSha: NEW_SHA,
      outcomeAccumulationEnabled: true,
      nowMs: NOW,
    }),
    /predecessor identity is invalid/,
  );
  await access(statePath);
});
