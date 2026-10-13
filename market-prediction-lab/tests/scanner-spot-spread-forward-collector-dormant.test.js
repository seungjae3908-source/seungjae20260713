import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "prediction-lab-scanner-spot-spread-forward-collector-dormant.yml",
);

test("spread forward collector is manual-only and has no cron schedule", async () => {
  const text = await readFile(WORKFLOW, "utf8");
  assert.match(text, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(text, /^\s+schedule:/mu);
  assert.doesNotMatch(text, /cron:/u);
  assert.match(text, /scheduleActivated=false/u);
});

test("spread forward collector rehydrates only an exact successful prior collector artifact", async () => {
  const text = await readFile(WORKFLOW, "utf8");
  assert.match(text, /previous_run_id:/u);
  assert.match(text, /run\.name !== 'Prediction Lab Scanner Spot Spread Forward Collector Dormant'/u);
  assert.match(text, /run\.event !== 'workflow_dispatch'/u);
  assert.match(text, /run\.conclusion !== 'success'/u);
  assert.match(text, /scanner-spot-spread-forward-state-\$\{runId\}/u);
  assert.match(text, /artifact\.digest/u);
  assert.match(text, /--seed-root/u);
});

test("spread forward collector remains read-only and evidence-only", async () => {
  const text = await readFile(WORKFLOW, "utf8");
  assert.match(text, /permissions:\n  actions: read\n  contents: read/u);
  assert.doesNotMatch(text, /contents:\s*write/u);
  assert.match(text, /economicSampleCredit !== 0/u);
  assert.match(text, /executionAuthority !== 'NONE'/u);
  assert.match(text, /privateTradingApiAllowed !== false/u);
  assert.match(text, /historicalBackfillAllowed !== false/u);
  assert.match(text, /syntheticSpreadAllowed !== false/u);
  assert.match(text, /currentSpreadHistoricalBackfillAllowed !== false/u);
  assert.match(text, /crossProducerShaAccumulationAllowed !== true/u);
  assert.match(text, /producerShaProvenanceRequired !== true/u);
});
