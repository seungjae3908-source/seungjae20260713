import { readFile } from 'node:fs/promises';

import { ingestPublicForwardLiquidityCapture } from '../src/public-forward-liquidity-capture-ingest.mjs';

function value(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`MISSING_ARGUMENT:${flag}`);
  return args[index + 1];
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const result = await ingestPublicForwardLiquidityCapture({
    stateRoot: value(args, '--state-root'),
    researchRepoRoot: value(args, '--research-repo-root'),
    expectedMainSha: value(args, '--expected-main-sha'),
    expectedRepository: value(args, '--expected-repository'),
    expectedArtifactId: value(args, '--expected-artifact-id'),
    expectedArtifactDigest: value(args, '--expected-artifact-digest'),
    rawBatch: await jsonFile(value(args, '--raw-batch')),
    captureReceipt: await jsonFile(value(args, '--capture-receipt')),
    artifactReceipt: await jsonFile(value(args, '--artifact-receipt')),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
