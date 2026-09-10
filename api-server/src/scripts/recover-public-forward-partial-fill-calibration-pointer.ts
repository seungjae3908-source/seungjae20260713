import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { recoverPublicForwardPartialFillCalibrationDatasetPointer } from '../services/public-forward-partial-fill-calibration-pointer-recovery.service';

const HELP = `Usage:
  recover-public-forward-partial-fill-calibration-pointer \\
    --state-root <absolute-path> \\
    --research-repo-root <absolute-path> \\
    --ingest-receipt-file <path>

This command only recovers an immutable dataset snapshot + pointer from a finalized canonical ingest receipt.
It does not re-ingest observations, publish a release binding, deploy, activate runtime bindings, or grant trading authority.
`;

function parseArgs(argv: readonly string[]): Readonly<Record<string, string>> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (!token.startsWith('--')) throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE:${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return Object.freeze(args);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateRoot = String(args['state-root'] ?? '').trim();
  const researchRepoRoot = String(args['research-repo-root'] ?? '').trim();
  const ingestReceiptFile = String(args['ingest-receipt-file'] ?? '').trim();

  if (!stateRoot || !isAbsolute(stateRoot)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  if (!researchRepoRoot || !isAbsolute(researchRepoRoot)) throw new Error('RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE');
  if (!ingestReceiptFile) throw new Error('INGEST_RECEIPT_FILE_REQUIRED');

  let ingestReceipt: unknown;
  try {
    ingestReceipt = JSON.parse(await readFile(ingestReceiptFile, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('INGEST_RECEIPT_FILE_INVALID_JSON');
    throw error;
  }

  const result = await recoverPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot,
    researchRepoRoot,
    ingestReceipt,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
