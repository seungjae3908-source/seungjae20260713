import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(apiRoot, '..');
const outputRoot = resolve(
  process.argv[2] ?? join(repositoryRoot, 'market-prediction-lab', 'runtime', 'authoritative-paper-runtime-v1'),
);
const bundlePath = join(outputRoot, 'authoritative-paper-runtime-v1.mjs');
const manifestPath = join(outputRoot, 'authoritative-paper-runtime-v1.manifest.json');

const CANONICAL_PRODUCER_SOURCE_COMMIT_SHA = '3f85003368830fb570c05b3b2060da39f515696d';
const CANONICAL_PRODUCER_SOURCE_GIT_BLOB_SHA = 'e4fe2e7c8cd0ec279cda8d696b4ae935bef86a4b';
const CANONICAL_PRODUCER_SOURCE_SHA256 = 'e699e00ba64040aefec24b5b4992b4975531fdf88c1e4b2b164038ebed57dad7';
const PRODUCER_SOURCE = 'src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts';
const ALLOWED_INPUTS = Object.freeze([
  'src/services/authoritative-paper-runtime-package.entry.ts',
  'src/services/paper-trading-core.service.ts',
  'src/services/paper-trading-state-snapshot.service.ts',
  'src/services/scanner-crypto-futures-paper-admission-composer.service.ts',
  'src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts',
  'src/services/scanner-paper-admission-evidence-bundle.service.ts',
  'src/services/scanner-profit-cost-evidence-adapter.service.ts',
  'src/services/trade-paper-market-contract.service.ts',
  'src/services/trading-risk-engine.service.ts',
].sort());

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceSha256(value) {
  return sha256(value.toString('utf8').replace(/\r\n/gu, '\n'));
}

function portable(value) {
  return value.split(sep).join('/');
}

await mkdir(outputRoot, { recursive: true });
const result = await build({
  absWorkingDir: apiRoot,
  entryPoints: ['src/services/authoritative-paper-runtime-package.entry.ts'],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  legalComments: 'none',
  charset: 'utf8',
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'silent',
});

const actualInputs = Object.keys(result.metafile.inputs).map(portable).sort();
if (JSON.stringify(actualInputs) !== JSON.stringify(ALLOWED_INPUTS)) {
  throw new Error(`AUTHORITATIVE_PAPER_RUNTIME_INPUT_ALLOWLIST_MISMATCH:${actualInputs.join(',')}`);
}
if (actualInputs.some((path) => /(private|credential|secret|order-execution|account-readonly|supabase)/iu.test(path))) {
  throw new Error('AUTHORITATIVE_PAPER_RUNTIME_PRIVATE_AUTHORITY_INCLUDED');
}

const sourceDigests = {};
for (const source of actualInputs) {
  sourceDigests[source] = sourceSha256(await readFile(join(apiRoot, source)));
}
if (sourceDigests[PRODUCER_SOURCE] !== CANONICAL_PRODUCER_SOURCE_SHA256) {
  throw new Error('CANONICAL_PAPER_PRODUCER_SOURCE_SHA_MISMATCH');
}
const sourceGraphSha256 = sha256(actualInputs.map((path) => `${path}\0${sourceDigests[path]}\n`).join(''));
const bundle = await readFile(bundlePath);
const bundleSha256 = sha256(bundle);
const manifest = {
  schemaVersion: 'authoritative-paper-runtime-package-manifest-v1',
  artifactFile: portable(relative(outputRoot, bundlePath)),
  canonicalProducer: {
    version: 'scanner-crypto-futures-paper-admission-evidence-producer-v1',
    sourceFile: `api-server/${PRODUCER_SOURCE}`,
    sourceCommitSha: CANONICAL_PRODUCER_SOURCE_COMMIT_SHA,
    sourceGitBlobSha: CANONICAL_PRODUCER_SOURCE_GIT_BLOB_SHA,
    sourceSha256: CANONICAL_PRODUCER_SOURCE_SHA256,
  },
  sourceGraphSha256,
  sourceFiles: actualInputs.map((path) => `api-server/${path}`),
  sourceFileSha256: Object.fromEntries(actualInputs.map((path) => [`api-server/${path}`, sourceDigests[path]])),
  bundleSha256,
  admissionBundleSchemaVersion: 'scanner-paper-admission-evidence-bundle-v1',
  paperStateSnapshotSchemaVersion: 'paper-trading-state-snapshot-v1',
  costPolicyVersion: null,
  costPolicyVersionBinding: {
    status: 'RUNTIME_EXACT_REQUIRED',
    candidateField: 'candidate.signal.strategyIdentity.costPolicyVersion',
    bundleField: 'bundle.executionEvidence.costPolicy.version',
    unknownIsZero: false,
  },
  exports: [
    'AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY',
    'PAPER_TRADING_STATE_SNAPSHOT_VERSION',
    'SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION',
    'createImmutablePaperTradingStateSnapshot',
    'createScannerCryptoFuturesPaperAdmissionEvidenceProducer',
    'validateImmutablePaperTradingStateSnapshot',
  ],
  safety: {
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ bundlePath, manifestPath, bundleSha256, sourceGraphSha256 })}\n`);
