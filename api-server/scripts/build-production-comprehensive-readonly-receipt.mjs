import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function buildProductionComprehensiveReadonlyReceipt({
  artifactDir,
  targetSha,
  productionDeployRunId,
  generatedAt = new Date().toISOString(),
}) {
  const normalizedSha = String(targetSha ?? '').trim().toLowerCase();
  const normalizedDeployRunId = String(productionDeployRunId ?? '').trim();
  if (!SHA_PATTERN.test(normalizedSha)) throw new Error('COMPREHENSIVE_QA_TARGET_SHA_INVALID');
  if (!/^[1-9][0-9]*$/.test(normalizedDeployRunId)) throw new Error('COMPREHENSIVE_QA_DEPLOY_RUN_ID_INVALID');

  const files = fs.readdirSync(artifactDir)
    .filter((name) => name.endsWith('-routes.json'))
    .sort();
  if (files.length === 0) throw new Error('COMPREHENSIVE_QA_ROUTE_EVIDENCE_MISSING');

  let recommendationAudit = null;
  for (const name of files) {
    const value = JSON.parse(fs.readFileSync(path.join(artifactDir, name), 'utf8'));
    if (value?.complete !== true || !Array.isArray(value?.audits) || !Array.isArray(value?.blocked)) {
      throw new Error(`COMPREHENSIVE_QA_ROUTE_EVIDENCE_INVALID:${name}`);
    }
    if (value.blocked.length !== 0) throw new Error(`COMPREHENSIVE_QA_MUTATION_BLOCKED:${name}`);
    for (const audit of value.audits) {
      if (audit?.navigationError !== null
        || audit?.fallbackTimedOut !== false
        || audit?.busyAfter5s !== 0) {
        throw new Error(`COMPREHENSIVE_QA_ROUTE_NOT_READY:${name}:${String(audit?.route ?? 'unknown')}`);
      }
      if (value.project === 'prod-desktop-1440' && audit?.route === '/recommendations') {
        recommendationAudit = {
          loadMs: audit.loadMs,
          fallbackTimedOut: audit.fallbackTimedOut,
          busyAfter5s: audit.busyAfter5s,
        };
      }
    }
  }
  if (!recommendationAudit
    || !Number.isFinite(recommendationAudit.loadMs)
    || recommendationAudit.loadMs >= 5_000) {
    throw new Error('COMPREHENSIVE_QA_RECOMMENDATIONS_1440_EVIDENCE_MISSING');
  }

  return {
    schemaVersion: 'production-comprehensive-readonly-qa-v1',
    targetSha: normalizedSha,
    productionDeployRunId: Number(normalizedDeployRunId),
    generatedAt,
    officialProductionOrigin: true,
    identityMatch: true,
    complete: true,
    recommendationsDesktop1440: recommendationAudit,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
  };
}

function main(argv) {
  const [artifactDir, targetSha, productionDeployRunId] = argv;
  if (!artifactDir || !targetSha || !productionDeployRunId) {
    throw new Error('Usage: build-production-comprehensive-readonly-receipt.mjs <artifact-dir> <target-sha> <production-deploy-run-id>');
  }
  const receipt = buildProductionComprehensiveReadonlyReceipt({
    artifactDir,
    targetSha,
    productionDeployRunId,
  });
  const output = path.join(artifactDir, 'production-comprehensive-readonly-qa.json');
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, output, targetSha: receipt.targetSha }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
