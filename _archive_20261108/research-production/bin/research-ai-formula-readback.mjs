#!/usr/bin/env node
import { inspectAiFormulaResearchEvidenceV1 } from '../src/ai-formula-evidence-readback-v1.mjs';

const fail = (reason) => {
  process.stderr.write(JSON.stringify({
    status: 'BLOCKED', reason, executionAuthority: 'NONE',
    providerNetworkCalls: 0, storageMutationCount: 0,
  }) + '\n');
  process.exitCode = 1;
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--read-only'
    || args[1] !== '--research-sha' || args[3] !== '--state-root') {
    fail('READ_ONLY_RESEARCH_ARGUMENTS_REQUIRED');
    return;
  }
  try {
    const report = await inspectAiFormulaResearchEvidenceV1({
      researchSha: args[2],
      stateRoot: args[4],
    });
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    // Never print paths, raw AI text, private keys or untrusted error strings.
    const message = String(error?.message ?? '');
    const code = /^AI_FORMULA_READBACK_[A-Z_]+$/u.test(message)
      ? message : 'AI_FORMULA_READBACK_FAILED_CLOSED';
    fail(code);
  }
}

await main();
