import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/prediction-lab-rule0-1h-shadow-sidecar.yml", import.meta.url),
  "utf8",
);

test("Rule0 1h starts a separately versioned v6 artifact chain without weakening safety", () => {
  assert.match(workflow, /ARTIFACT_NAME: prediction-lab-rule0-1h-shadow-state-v6/);
  assert.match(workflow, /CHAIN_CONTRACT: rule0-1h-artifact-chain-v6/);
  assert.doesNotMatch(workflow, /ARTIFACT_NAME: prediction-lab-rule0-1h-shadow-state-v5/);
  assert.doesNotMatch(workflow, /CHAIN_CONTRACT: rule0-1h-artifact-chain-v5/);

  assert.match(workflow, /execution dependency changed; start a separately versioned chain/);
  assert.match(workflow, /schemaVersion: 3/);
  assert.match(workflow, /historicalBackfill !== false/);
  assert.match(workflow, /publicMarketDataOnly !== true/);
  assert.match(workflow, /actualOrders: 0/);
  assert.match(workflow, /liveOrderAllowed: false/);
  assert.match(workflow, /privateAccountRequestAllowed: false/);
});
