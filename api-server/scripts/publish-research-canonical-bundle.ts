#!/usr/bin/env node
import { resolve } from 'node:path';

import { publishResearchCanonicalBundleOfflineV1 } from '../src/services/research-canonical-bundle-offline-publisher.service.ts';

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name}_REQUIRED`);
  return String(process.argv[index + 1]);
}

try {
  const result = await publishResearchCanonicalBundleOfflineV1({
    stateRoot: resolve(requiredEnv('RESEARCH_BUNDLE_STATE_ROOT')),
    inputRoot: resolve(requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT')),
    dslPath: resolve(requiredArg('--dsl')),
    bundlePath: resolve(requiredArg('--bundle')),
    researchCodeSha: requiredEnv('RESEARCH_CODE_SHA'),
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    researchCodeSha: result.researchCodeSha,
    dslDigest: result.publication.dslDigest,
    bundleDigest: result.publication.bundleDigest,
    publicationStatus: result.publication.publicationStatus,
    receiptDigest: result.publication.receiptDigest,
    receiptPath: result.receiptPath,
    recordPath: result.recordPath,
    recoveredExistingCatalog: result.recoveredExistingCatalog,
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: 'research-canonical-bundle-offline-publisher/v1',
    status: 'failed_closed',
    error: String((error as Error)?.message ?? error).replace(/[\r\n]/g, '_').slice(0, 500),
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}
