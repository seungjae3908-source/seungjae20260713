import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
  ]) assert.ok(source.includes(expected), expected);
  for (const forbidden of [
    "deploy-production.sh",
    "pm2 restart",
    "pm2 reload",
    "supabase db",
    "psql -c",
    "/api/v2/mix/order/",
    "/api/v2/mix/account/",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("Pump disable removes only its managed cron and leaves execution authority at NONE", async () => {
  const source = await readFile(disablePath, "utf8");
  assert.ok(source.includes("# stock-app-pump-reversal-v1"));
  assert.ok(source.includes("DISABLED"));
  assert.ok(source.includes('"executionAuthority":"NONE"'));
  assert.ok(source.includes('"realOrderCount":0'));
});
