import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { buildPumpProspectivePolicyV1 } from "../src/crypto-pump-reversal-prospective-policy-v1.js";

const installPath = new URL("../../ops/install-pump-reversal-prospective-schedule.sh", import.meta.url);
const disablePath = new URL("../../ops/disable-pump-reversal-prospective-schedule.sh", import.meta.url);

test("Pump installer is isolated, minute-cadence, exact-SHA and Paper-only", async () => {
  const source = await readFile(installPath, "utf8");
  for (const expected of [
    "/opt/stock-app-data/pump-reversal-v1",
    'TAG="# stock-app-pump-reversal-v1"',
    'CRON_EXPRESSION="* * * * *"',
    "PUMP_PROSPECTIVE_SCHEDULE_ACTIVE='true'",
    "PUMP_PROSPECTIVE_POLICY_PATH",
    "PUMP_PAPER_STATE_SNAPSHOT_PATH",
    "PUMP_SUPPLEMENTAL_COST_EVIDENCE_PATH",
    "LIVE_TRADING='false'",
    "AUTO_TRADING='false'",
    "REAL_ORDER_ENABLED='false'",
    "PRIVATE_ACCOUNT_ACCESS='false'",
    "PRIVATE_TRADING_API_ALLOWED='false'",
    "ACTIVE_WAITING_FOR_24H_FUTURE_BOUNDARY",
    "rawProspectiveCreditBeforeEligibleAfterMs: 0",
    "missingEconomicEvidenceMayBecomeZero: false",
    "executionAuthority: 'NONE'",
    "productionAppDeployPerformed: false",
    "existing Pump policy strategy identity mismatch; refusing retry",
    "cross-SHA Pump policy reuse requires verified operational-only retry",
    "cross-SHA Pump retry requires prior frozen runtime bundle",
    "cross-SHA Pump runtime bundle changed; refusing frozen policy reuse",
    "SOURCE_PARAMETER_HASH",
    "EXISTING_PARAMETER_HASH",
    "PUMP_ALLOWED_POLICY_RESEARCH_SHA",
    "PUMP_OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED",
    '[[ ! -e "\\$STATE_ROOT/DISABLED" ]]',
    'exec >>"\\$LOG_FILE" 2>&1',
    'HOME="\\${HOME:-/tmp}"',
  ]) assert.ok(source.includes(expected), expected);
  for (const forbidden of [
    'cmp -s "$POLICY_SOURCE" "$POLICY_PATH"',
    '[[ ! -e "$STATE_ROOT/DISABLED" ]]',
    'exec >>"$LOG_FILE" 2>&1',
    'HOME="${HOME:-/tmp}"',
    "deploy-production.sh",
    "pm2 restart",
    "pm2 reload",
    "supabase db",
    "psql -c",
    "/api/v2/mix/order/",
    "/api/v2/mix/account/",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("Pump installer rejects a corrupted frozen policy before cron mutation", async () => {
  const source = await readFile(installPath, "utf8");
  const block = /(policy_summary_for_path\(\) \{\n[\s\S]*?\n\})\n\nSOURCE_POLICY_SUMMARY=/u.exec(source)?.[1];
  assert.ok(block, "policy_summary_for_path block");

  const root = await mkdtemp(join(tmpdir(), "pump-policy-preflight-"));
  try {
    const validPath = join(root, "valid.json");
    const corruptPath = join(root, "corrupt.json");
    const policy = buildPumpProspectivePolicyV1({
      researchCodeSha: "a".repeat(40),
      policyFrozenAtMs: 1_800_000_000_000,
    });
    await writeFile(validPath, JSON.stringify(policy));
    await writeFile(corruptPath, JSON.stringify({ ...policy, policyDigest: "0".repeat(64) }));

    const shell = ["set -Eeuo pipefail", block, 'policy_summary_for_path "$1" >/dev/null'].join("\n");
    await execFileAsync("bash", ["-c", shell, "pump-policy-test", validPath]);
    await assert.rejects(
      () => execFileAsync("bash", ["-c", shell, "pump-policy-test", corruptPath]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pump wrapper generation defers runtime variables under set -u", async () => {
  const source = await readFile(installPath, "utf8");
  const block = /cat > "\$TEMP_WRAPPER" <<WRAPPER\n[\s\S]*?\nWRAPPER/u.exec(source)?.[0];
  assert.ok(block, "wrapper heredoc block");

  const root = await mkdtemp(join(tmpdir(), "pump-wrapper-"));
  try {
    const wrapper = join(root, "wrapper");
    const shell = [
      "set -Eeuo pipefail",
      `TEMP_WRAPPER="${wrapper}"`,
      `STATE_ROOT="${root}/state"`,
      `LOG_DIR="${root}/logs"`,
      `RUNTIME_STATE_ROOT="${root}/runtime-state"`,
      `POLICY_PATH="${root}/policy.json"`,
      `PAPER_STATE_SNAPSHOT_PATH="${root}/paper.json"`,
      `SUPPLEMENTAL_COST_EVIDENCE_PATH="${root}/cost.json"`,
      `TARGET_SHA="${"a".repeat(40)}"`,
      'NODE_BIN="/usr/bin/node"',
      `RUNTIME_BUNDLE="${root}/runtime.mjs"`,
      block,
    ].join("\n");
    await execFileAsync("bash", ["-c", shell], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    });
    const rendered = await readFile(wrapper, "utf8");
    assert.ok(rendered.includes('[[ ! -e "$STATE_ROOT/DISABLED" ]]'));
    assert.ok(rendered.includes('if [[ -f "$LOG_FILE" && "$(wc -c < "$LOG_FILE")" -gt 5242880 ]]'));
    assert.ok(rendered.includes('exec >>"$LOG_FILE" 2>&1'));
    assert.ok(rendered.includes('"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'));
    assert.ok(rendered.includes('HOME="${HOME:-/tmp}"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pump disable removes only its managed cron and leaves execution authority at NONE", async () => {
  const source = await readFile(disablePath, "utf8");
  assert.ok(source.includes("# stock-app-pump-reversal-v1"));
  assert.ok(source.includes("DISABLED"));
  assert.ok(source.includes('"executionAuthority":"NONE"'));
  assert.ok(source.includes('"realOrderCount":0'));
});
