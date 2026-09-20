#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildResearchCanonicalComponentManifestV1,
  registerResearchCanonicalComponentV1,
} from '../src/services/research-canonical-component-store.service.ts';

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : null;
}

try {
  const mode = String(process.argv[2] ?? '');
  const inputRoot = resolve(requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT'));
  const researchCodeSha = requiredEnv('RESEARCH_CODE_SHA');
  if (mode === 'register') {
    const sourceRoot = resolve(requiredEnv('RESEARCH_COMPONENT_SOURCE_ROOT'));
    const componentKey = arg('--key');
    const ownerRef = arg('--owner');
    const sourcePath = arg('--source');
    if (!componentKey || !ownerRef || !sourcePath) throw new Error('REGISTER_ARGUMENTS_REQUIRED');
    const result = await registerResearchCanonicalComponentV1({
      sourceRoot,
      inputRoot,
      researchCodeSha,
      componentKey,
      ownerRef,
      sourcePath: resolve(sourcePath),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (mode === 'manifest') {
    const specPath = arg('--selection');
    const selected = specPath
      ? JSON.parse(await readFile(resolve(specPath), 'utf8'))
      : {};
    const result = await buildResearchCanonicalComponentManifestV1({
      inputRoot,
      researchCodeSha,
      selectedComponentDigests: selected,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    throw new Error('MODE_MUST_BE_REGISTER_OR_MANIFEST');
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    contract: 'research-canonical-component-store/v1',
    status: 'failed_closed',
    error: String((error as Error)?.message ?? error).replace(/[\r\n]/g, '_').slice(0, 500),
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}
