#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { assembleResearchCanonicalBundleV1 } from '../src/services/research-canonical-bundle-assembler.service.ts';

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
  const inputRoot = resolve(requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT'));
  const spec = JSON.parse(await readFile(resolve(requiredArg('--components')), 'utf8'));
  const result = await assembleResearchCanonicalBundleV1({
    inputRoot,
    researchCodeSha: requiredEnv('RESEARCH_CODE_SHA'),
    componentPaths: spec,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    researchCodeSha: result.researchCodeSha,
    dslDigest: result.dslDigest,
    bundleDigest: result.bundleDigest,
    bundlePath: result.bundlePath,
    recordPath: result.recordPath,
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: 'research-canonical-bundle-assembler/v1',
    status: 'failed_closed',
    error: String((error as Error)?.message ?? error).replace(/[\r\n]/g, '_').slice(0, 500),
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}
