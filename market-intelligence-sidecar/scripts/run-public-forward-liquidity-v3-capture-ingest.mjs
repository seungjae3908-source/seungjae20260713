import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { canonicalJson } from '../src/public-forward-liquidity-calibration.mjs';
import { ingestPublicForwardLiquidityV3Capture } from '../src/public-forward-liquidity-v3-capture-ingest.mjs';

function value(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`MISSING_ARGUMENT:${flag}`);
  return args[index + 1];
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function receiptOutputInsideStateRoot(stateRoot, receiptOutput) {
  if (!isAbsolute(stateRoot) || !isAbsolute(receiptOutput)) throw new Error('RECEIPT_OUTPUT_MUST_BE_ABSOLUTE');
  const root = resolve(stateRoot);
  const output = resolve(receiptOutput);
  const rel = relative(root, output);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('RECEIPT_OUTPUT_OUTSIDE_STATE_ROOT');
  }
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write([
      'Usage: run-public-forward-liquidity-v3-capture-ingest.mjs',
      '  --state-root <absolute ephemeral root>',
      '  --research-repo-root <absolute checkout>',
      '  --expected-main-sha <source capture exact main sha>',
      '  --expected-repository <owner/repo>',
      '  --expected-artifact-id <raw slot artifact id>',
      '  --expected-artifact-digest <raw slot artifact sha256>',
      '  --raw-batch <raw-batch.json>',
      '  --capture-receipt <capture-receipt.json>',
      '  --artifact-receipt <artifact-receipt.json>',
      '  --receipt-output <absolute path inside state root>',
      'No network request or persistent Research mutation is performed by this runner.',
      '',
    ].join('\n'));
    return;
  }
  const stateRoot = value(args, '--state-root');
  const receiptOutput = receiptOutputInsideStateRoot(
    stateRoot,
    value(args, '--receipt-output'),
  );

  await mkdir(dirname(receiptOutput), { recursive: true, mode: 0o750 });
  let receiptHandle;
  try {
    receiptHandle = await open(receiptOutput, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('RECEIPT_OUTPUT_EXISTS');
    throw error;
  }

  try {
    const result = await ingestPublicForwardLiquidityV3Capture({
      stateRoot,
      researchRepoRoot: value(args, '--research-repo-root'),
      expectedMainSha: value(args, '--expected-main-sha'),
      expectedRepository: value(args, '--expected-repository'),
      expectedArtifactId: value(args, '--expected-artifact-id'),
      expectedArtifactDigest: value(args, '--expected-artifact-digest'),
      rawBatch: await jsonFile(value(args, '--raw-batch')),
      captureReceipt: await jsonFile(value(args, '--capture-receipt')),
      artifactReceipt: await jsonFile(value(args, '--artifact-receipt')),
    });
    await receiptHandle.writeFile(`${canonicalJson(result)}\n`, 'utf8');
    await receiptHandle.sync();
    process.stdout.write(`${canonicalJson({
      status: 'PRESENT',
      receiptOutput,
      receiptDigest: result.receiptDigest,
      datasetDigest: result.datasetDigest,
      predecessorDatasetDigest: result.predecessorDatasetDigest,
      collectorCodeSha: result.collectorCodeSha,
      slotIndex: result.sourceV3Lineage.slotIndex,
      split: result.sourceV3Lineage.split,
      insertedObservationCount: result.insertedObservationCount,
      duplicateObservationCount: result.duplicateObservationCount,
      independentSampleCredit: 0,
      fullCostReady: false,
    })}\n`);
  } catch (error) {
    await receiptHandle.close().catch(() => {});
    receiptHandle = null;
    await rm(receiptOutput, { force: true }).catch(() => {});
    throw error;
  } finally {
    await receiptHandle?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
