import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ResearchBundleService } from './research-bundle.service.ts';

export const RESEARCH_CANONICAL_BUNDLE_ASSEMBLY_RECORD_V1 =
  'research-canonical-bundle-assembly-record-v1';

const SHA40 = /^[0-9a-f]{40}$/u;
const DIGEST64 = /^[0-9a-f]{64}$/u;
const MAX_COMPONENT_BYTES = 64 * 1024 * 1024;

export const RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1 = Object.freeze([
  'dsl',
  'formulaCandidate',
  'generatedCandidate',
  'strategy',
  'dataset',
  'splitPolicy',
  'splitReceipt',
  'riskPolicy',
  'riskSizingInput',
  'costPolicy',
  'oosPolicy',
  'wfPolicy',
  'holdoutPolicy',
  'backtest',
  'modelReference',
] as const);

type ComponentKey = typeof RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1[number];
type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const r = row(value);
  if (Object.keys(r).length === 0) return value;
  return Object.fromEntries(Object.keys(r).sort().map((key) => [key, canonical(r[key])]));
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function exactSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('RESEARCH_CODE_SHA_INVALID');
  return sha;
}
async function safeDirectory(pathValue: string, name: string): Promise<string> {
  if (!isAbsolute(pathValue)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  const normalized = resolve(pathValue);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name}_UNSAFE`);
  if (resolve(await realpath(normalized)) !== normalized) throw new Error(`${name}_UNSAFE`);
  return normalized;
}
async function safeJsonFile(root: string, pathValue: string, name: string): Promise<unknown> {
  const absolute = resolve(pathValue);
  const rel = relative(root, absolute);
  if (!isAbsolute(absolute) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${name}_OUTSIDE_INPUT_ROOT`);
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_COMPONENT_BYTES) {
    throw new Error(`${name}_FILE_INVALID`);
  }
  if (resolve(await realpath(absolute)) !== absolute) throw new Error(`${name}_PATH_UNSAFE`);
  return JSON.parse(await readFile(absolute, 'utf8'));
}
function exactComponentPaths(value: unknown): Record<ComponentKey, string> {
  const input = row(value);
  const actual = Object.keys(input).sort();
  const expected = [...RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('CANONICAL_BUNDLE_COMPONENT_SET_INVALID');
  }
  return Object.fromEntries(RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1.map((key) => {
    const path = String(input[key] ?? '').trim();
    if (!path) throw new Error(`CANONICAL_BUNDLE_COMPONENT_PATH_MISSING:${key}`);
    return [key, path];
  })) as Record<ComponentKey, string>;
}
async function publishWriteOnce(directoryPath: string, fileName: string, value: unknown) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const finalPath = join(directoryPath, basename(fileName));
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_COMPONENT_BYTES) throw new Error('ASSEMBLED_BUNDLE_RECORD_TOO_LARGE');
  const temporary = join(directoryPath, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, finalPath);
    if (process.platform !== 'win32') {
      const dir = await open(directoryPath, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return Object.freeze({ status: 'created' as const, path: finalPath });
  } catch (error) {
    if (row(error).code !== 'EEXIST') throw error;
    const info = await lstat(finalPath);
    if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(finalPath)) !== finalPath) {
      throw new Error('ASSEMBLED_BUNDLE_EXISTING_PATH_UNSAFE');
    }
    const existing = JSON.parse(await readFile(finalPath, 'utf8'));
    if (digest(existing) !== digest(value)) throw new Error('ASSEMBLED_BUNDLE_CONTENT_CONFLICT');
    return Object.freeze({ status: 'already_present' as const, path: finalPath });
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

export async function assembleResearchCanonicalBundleV1(input: {
  inputRoot: string;
  researchCodeSha: string;
  componentPaths: Record<ComponentKey, string>;
  /** Focused test harness only. The production CLI never passes this. */
  validationNow?: () => number;
}) {
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const researchCodeSha = exactSha(input.researchCodeSha);
  const componentPaths = exactComponentPaths(input.componentPaths);
  const components = {} as Record<ComponentKey, unknown>;
  const componentDigests = {} as Record<ComponentKey, string>;

  for (const key of RESEARCH_CANONICAL_BUNDLE_COMPONENT_KEYS_V1) {
    const value = await safeJsonFile(inputRoot, componentPaths[key], `COMPONENT_${key.toUpperCase()}`);
    components[key] = value;
    componentDigests[key] = digest(value);
  }

  const dsl = components.dsl;
  const bundle = Object.freeze({
    schemaVersion: 'research-bundle-source-v1',
    evidenceClass: 'CANONICAL',
    dsl,
    formulaCandidate: components.formulaCandidate,
    generatedCandidate: components.generatedCandidate,
    strategy: components.strategy,
    dataset: components.dataset,
    splitPolicy: components.splitPolicy,
    splitReceipt: components.splitReceipt,
    riskPolicy: components.riskPolicy,
    riskSizingInput: components.riskSizingInput,
    costPolicy: components.costPolicy,
    oosPolicy: components.oosPolicy,
    wfPolicy: components.wfPolicy,
    holdoutPolicy: components.holdoutPolicy,
    backtest: components.backtest,
    modelReference: components.modelReference,
  });

  const strategySha = exactSha(row(components.strategy).researchCodeSha);
  if (strategySha !== researchCodeSha) throw new Error('CANONICAL_BUNDLE_RESEARCH_CODE_SHA_MISMATCH');

  const service = new ResearchBundleService({
    readCanonicalBundle: async () => structuredClone(bundle),
    now: input.validationNow,
  });
  const resolution = await service.resolve(dsl);
  const assemblyOnlyBlockers = ['DURABLE_SUBMISSION_STORE_MISSING'];
  if (!resolution.dslValid
    || !DIGEST64.test(String(resolution.dslDigest ?? ''))
    || !DIGEST64.test(String(resolution.bundleDigest ?? ''))
    || !resolution.researchBundleReady
    || resolution.backtestExecutable !== false
    || resolution.backtestStatus !== 'BLOCKED_DATA'
    || JSON.stringify(resolution.blockers) !== JSON.stringify(assemblyOnlyBlockers)
    || resolution.components.some((component) => component.status !== 'READY')
    || resolution.evidenceCredit !== 0
    || resolution.profitabilityProven !== false
    || resolution.promotionEligible !== false
    || resolution.champion !== null
    || resolution.executionAuthority !== 'NONE'
    || resolution.wfEvidencePresent !== false
    || resolution.oosEvidencePresent !== false
    || resolution.holdoutEvidencePresent !== false
    || resolution.statisticalFirewallPass !== false) {
    throw new Error(`CANONICAL_BUNDLE_ASSEMBLY_NOT_READY:${resolution.blockers.join(',') || 'VALIDATION_FAILED'}`);
  }

  const assembledDir = join(inputRoot, 'assembled');
  const recordDir = join(inputRoot, 'assembly-records');
  const bundleWrite = await publishWriteOnce(
    assembledDir,
    `${resolution.dslDigest}.json`,
    bundle,
  );

  const recordCore = Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_CANONICAL_BUNDLE_ASSEMBLY_RECORD_V1,
    researchCodeSha,
    dslDigest: resolution.dslDigest,
    bundleDigest: resolution.bundleDigest,
    componentDigests: Object.freeze({ ...componentDigests }),
    evidenceClass: 'CANONICAL' as const,
    researchBundleReady: true as const,
    componentReadinessVerified: true as const,
    backtestExecutableAtAssembly: false as const,
    durableSubmissionStoreRequired: true as const,
    evidenceCredit: 0 as const,
    profitabilityProven: false as const,
    promotionEligible: false as const,
    executionAuthority: 'NONE' as const,
  });
  const record = Object.freeze({ ...recordCore, recordDigest: digest(recordCore) });
  const recordWrite = await publishWriteOnce(
    recordDir,
    `${resolution.dslDigest}.json`,
    record,
  );

  return Object.freeze({
    schemaVersion: 1,
    contract: 'research-canonical-bundle-assembler/v1',
    status: bundleWrite.status === 'created' || recordWrite.status === 'created'
      ? 'assembled'
      : 'already_present',
    researchCodeSha,
    dslDigest: resolution.dslDigest,
    bundleDigest: resolution.bundleDigest,
    bundlePath: bundleWrite.path,
    recordPath: recordWrite.path,
    componentDigests: record.componentDigests,
    recordDigest: record.recordDigest,
    safety: Object.freeze({
      componentAssemblyOnly: true,
      publisherRevalidationRequired: true,
      durableSubmissionStoreBypassed: false,
      generatedEvidence: false,
      allowTestEvidence: false,
      syntheticBundleAllowed: false,
      evidenceCredit: 0,
      profitabilityProven: false,
      promotionEligible: false,
      runtimeActivationAllowed: false,
      liveTrading: false,
      privateTradingApi: false,
      realOrder: false,
      executionAuthority: 'NONE' as const,
    }),
  });
}
