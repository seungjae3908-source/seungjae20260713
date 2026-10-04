'use strict';

const fs = require('node:fs');
const {
  assertProductionDeployExecutionProvenance,
  assertProductionRuntimeIdentity,
} = require('./production-deploy-provenance.cjs');

const [runFile, healthFile, targetSha, productionDeployRunId, mode, currentRunId] = process.argv.slice(2);
if (!runFile || !healthFile || !targetSha || !productionDeployRunId || !mode) {
  throw new Error('Usage: verify-production-deploy-execution.cjs <run-json> <health-json> <sha> <run-id> <completed|inline> [current-run-id]');
}

const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
assertProductionDeployExecutionProvenance(run, {
  targetSha,
  productionDeployRunId,
  mode,
  currentRunId,
});
assertProductionRuntimeIdentity(health, targetSha);
process.stdout.write(JSON.stringify({
  ok: true,
  targetSha: String(targetSha).toLowerCase(),
  productionDeployRunId: Number(productionDeployRunId),
  mode,
  identityMatch: true,
}) + '\n');
