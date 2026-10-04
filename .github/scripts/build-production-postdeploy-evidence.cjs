'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildProductionPostdeployQaEvidence } = require('./production-postdeploy-qa-evidence.cjs');

const [directory, targetSha, productionDeployRunId] = process.argv.slice(2);
if (!directory || !targetSha || !productionDeployRunId) {
  throw new Error('Usage: build-production-postdeploy-evidence.cjs <directory> <sha> <deploy-run-id>');
}
const read = (relative) => JSON.parse(fs.readFileSync(path.join(directory, relative), 'utf8'));
const evidence = buildProductionPostdeployQaEvidence({
  targetSha,
  productionDeployRunId,
  comprehensive: read('production-comprehensive-readonly-qa.json'),
  account: read('production-account-readonly-live-qa.json'),
  credential: read('production-live-credential-reuse-qa.json'),
  context: read('production-postdeploy-context.json'),
});
const output = path.join(directory, `production-postdeploy-activation-ready-${String(targetSha).toLowerCase()}.json`);
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ ok: true, output, activationReady: evidence.activationReady }) + '\n');
