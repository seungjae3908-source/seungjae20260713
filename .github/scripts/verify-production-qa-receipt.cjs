'use strict';

const fs = require('node:fs');
const {
  assertAccountReceipt,
  assertComprehensiveReceipt,
  assertCredentialReceipt,
  assertMemberReceipt,
} = require('./production-postdeploy-qa-evidence.cjs');

const [mode, file, targetSha, productionDeployRunId] = process.argv.slice(2);
if (!mode || !file || !targetSha || !productionDeployRunId) {
  throw new Error('Usage: verify-production-qa-receipt.cjs <comprehensive|account|credential|member> <file> <sha> <run-id>');
}
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const context = { targetSha, productionDeployRunId };
if (mode === 'comprehensive') assertComprehensiveReceipt(value, context);
else if (mode === 'account') assertAccountReceipt(value, context);
else if (mode === 'credential') assertCredentialReceipt(value, context);
else if (mode === 'member') assertMemberReceipt(value, context);
else throw new Error('PRODUCTION_QA_RECEIPT_MODE_INVALID');
process.stdout.write(JSON.stringify({ ok: true, mode, targetSha: String(targetSha).toLowerCase() }) + '\n');
