import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { ingestPublicForwardPartialFillCalibrationCapture } from '../services/public-forward-partial-fill-calibration-capture-ingest.service';

function usage(): string {
  return [
    'Usage:',
    '  ingest-public-forward-partial-fill-calibration-capture',
    '    --capture-receipt <path>',
    '    --artifact-receipt <path>',
    '    --state-root <absolute-existing-research-state-root>',
    '    --research-repo-root <absolute-research-repo-root>',
    '    --expected-sha <40-char-current-main-sha>',
    '    --expected-repository <owner/repo>',
    '    --expected-artifact-id <github-artifact-id>',
    '    --expected-artifact-digest <github-artifact-sha256>',
    '    [--output <path>]',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: 'true' };
    if (!key.startsWith('--')) throw new Error(`UNKNOWN_ARGUMENT:${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE:${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(usage());
    return;
  }
  const capturePath = args['capture-receipt'];
  const artifactPath = args['artifact-receipt'];
  const stateRoot = args['state-root'];
  const researchRepoRoot = args['research-repo-root'];
  const expectedMainSha = args['expected-sha'];
  const expectedRepository = args['expected-repository'];
  const expectedArtifactId = args['expected-artifact-id'];
  const expectedArtifactDigest = args['expected-artifact-digest'];
  if (!capturePath || !artifactPath || !stateRoot || !researchRepoRoot || !expectedMainSha || !expectedRepository || !expectedArtifactId || !expectedArtifactDigest) {
    throw new Error(`REQUIRED_ARGUMENT_MISSING\n${usage()}`);
  }
  if (!isAbsolute(stateRoot)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(researchRepoRoot)) throw new Error('RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE');

  const captureReceipt = JSON.parse(await readFile(capturePath, 'utf8')) as unknown;
  const artifactReceipt = JSON.parse(await readFile(artifactPath, 'utf8')) as unknown;
  const result = await ingestPublicForwardPartialFillCalibrationCapture({
    stateRoot,
    researchRepoRoot,
    expectedMainSha,
    expectedRepository,
    expectedArtifactId,
    expectedArtifactDigest,
    captureReceipt,
    artifactReceipt,
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) await writeFile(args.output, serialized, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(serialized);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
