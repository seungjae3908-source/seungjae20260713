import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  createResearchBundleFileStore,
  publishResearchCanonicalBundleSource,
  type ResearchCanonicalBundlePublication,
} from './research-bundle-file-store.service.ts';
import { ResearchBundleService } from './research-bundle.service.ts';
import { sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import {
  createCanonicalBundleOfflinePublicationReceiptV1,
  validateCanonicalBundlePublicationV1,
} from '../../../market-prediction-lab/src/adaptive-runtime-owner-capabilities-v1.js';

export const RESEARCH_CANONICAL_BUNDLE_OFFLINE_PUBLICATION_RECORD_V1 =
  'research-canonical-bundle-offline-publication-record-v1';

type Row = Record<string, unknown>;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;

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
async function safeDirectory(pathValue: string, name: string): Promise<string> {
  if (!isAbsolute(pathValue)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  const normalized = resolve(pathValue);
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name}_UNSAFE`);
  if (resolve(await realpath(normalized)) !== normalized) throw new Error(`${name}_UNSAFE`);
  return normalized;
}
async function safeInputFile(root: string, pathValue: string, name: string): Promise<unknown> {
  const absolute = resolve(pathValue);
  const rel = relative(root, absolute);
  if (!isAbsolute(absolute) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${name}_OUTSIDE_INPUT_ROOT`);
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_INPUT_BYTES) {
    throw new Error(`${name}_FILE_INVALID`);
  }
  if (resolve(await realpath(absolute)) !== absolute) throw new Error(`${name}_PATH_UNSAFE`);
  return JSON.parse(await readFile(absolute, 'utf8'));
}
function rawPublicationValid(value: unknown): value is ResearchCanonicalBundlePublication {
  const r = row(value);
  return r.schemaVersion === 'research-canonical-bundle-publication-v1'
    && typeof r.dslDigest === 'string' && DIGEST.test(r.dslDigest)
    && typeof r.bundleDigest === 'string' && DIGEST.test(r.bundleDigest)
    && r.publicationStatus === 'READBACK_VERIFIED'
    && r.evidenceCredit === 0
    && r.profitabilityProven === false
    && r.executionAuthority === 'NONE';
}
function exactResearchSha(value: unknown): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new Error('RESEARCH_CODE_SHA_INVALID');
  return sha;
}
function bundleResearchSha(value: unknown): string {
  const strategy = row(row(value).strategy);
  const sha = exactResearchSha(strategy.researchCodeSha);
  return sha;
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishWriteOnce(directoryPath: string, fileName: string, value: unknown) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const finalPath = join(directoryPath, basename(fileName));
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_INPUT_BYTES) throw new Error('PUBLICATION_RECORD_TOO_LARGE');
  const temporary = join(directoryPath, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, finalPath);
    await syncDirectory(directoryPath);
    return Object.freeze({ status: 'created' as const, path: finalPath });
  } catch (error) {
    const code = row(error).code;
    if (code !== 'EEXIST') throw error;
    const info = await lstat(finalPath);
    if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(finalPath)) !== finalPath) {
      throw new Error('PUBLICATION_RECEIPT_PATH_UNSAFE');
    }
    const existing = JSON.parse(await readFile(finalPath, 'utf8'));
    if (digest(existing) !== digest(value)) throw new Error('PUBLICATION_RECEIPT_CONFLICT');
    return Object.freeze({ status: 'already_present' as const, path: finalPath });
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

async function verifyExistingCatalog(
  stateRoot: string,
  dsl: unknown,
  bundle: unknown,
  now?: () => number,
): Promise<ResearchCanonicalBundlePublication> {
  const storage = createResearchBundleFileStore(stateRoot);
  const service = new ResearchBundleService({ ...storage, now });
  const resolution = await service.resolve(dsl);
  if (!resolution.dslValid
    || !DIGEST.test(String(resolution.dslDigest ?? ''))
    || !DIGEST.test(String(resolution.bundleDigest ?? ''))
    || !resolution.researchBundleReady
    || !resolution.backtestExecutable
    || resolution.blockers.length !== 0
    || resolution.components.some((component) => component.status !== 'READY')
    || resolution.evidenceCredit !== 0
    || resolution.profitabilityProven !== false
    || resolution.executionAuthority !== 'NONE') {
    throw new Error('EXISTING_CANONICAL_CATALOG_READBACK_INVALID');
  }
  const readback = await storage.readCanonicalBundle(resolution.dslDigest!);
  if (hash(readback) !== resolution.bundleDigest || hash(bundle) !== resolution.bundleDigest) {
    throw new Error('EXISTING_CANONICAL_CATALOG_INPUT_MISMATCH');
  }
  return Object.freeze({
    schemaVersion: 'research-canonical-bundle-publication-v1',
    dslDigest: resolution.dslDigest!,
    bundleDigest: resolution.bundleDigest!,
    publicationStatus: 'READBACK_VERIFIED',
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  });
}

export async function publishResearchCanonicalBundleOfflineV1(input: {
  stateRoot: string;
  inputRoot: string;
  dslPath: string;
  bundlePath: string;
  researchCodeSha: string;
  /** Focused test harness only. The production CLI never passes this. */
  validationNow?: () => number;
}) {
  const stateRoot = await safeDirectory(input.stateRoot, 'RESEARCH_BUNDLE_STATE_ROOT');
  const inputRoot = await safeDirectory(input.inputRoot, 'RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const dsl = await safeInputFile(inputRoot, input.dslPath, 'DSL');
  const bundle = await safeInputFile(inputRoot, input.bundlePath, 'BUNDLE');
  const researchCodeSha = exactResearchSha(input.researchCodeSha);
  const embeddedResearchCodeSha = bundleResearchSha(bundle);
  if (embeddedResearchCodeSha !== researchCodeSha) {
    throw new Error('BUNDLE_RESEARCH_CODE_SHA_MISMATCH');
  }

  let rawPublication: ResearchCanonicalBundlePublication;
  let recoveredExistingCatalog = false;
  try {
    rawPublication = await publishResearchCanonicalBundleSource({
      stateRoot,
      dsl,
      bundle,
      now: input.validationNow,
    });
  } catch (error) {
    if (String(row(error).message ?? error) !== 'RESEARCH_CATALOG_ENTRY_EXISTS') throw error;
    rawPublication = await verifyExistingCatalog(stateRoot, dsl, bundle, input.validationNow);
    recoveredExistingCatalog = true;
  }
  if (!rawPublicationValid(rawPublication)) throw new Error('CANONICAL_BUNDLE_PUBLICATION_INVALID');
  const publishedAt = new Date(input.validationNow?.() ?? Date.now()).toISOString();
  const publication = createCanonicalBundleOfflinePublicationReceiptV1({
    researchCodeSha,
    publication: rawPublication,
    publishedAt,
  });
  if (!validateCanonicalBundlePublicationV1(publication, researchCodeSha)) {
    throw new Error('CANONICAL_BUNDLE_OFFLINE_PUBLICATION_RECEIPT_INVALID');
  }

  const inputDigest = digest({ dsl, bundle, researchCodeSha });
  const publicationDigest = digest(publication);
  const recordCore = Object.freeze({
    schemaVersion: 1,
    contract: RESEARCH_CANONICAL_BUNDLE_OFFLINE_PUBLICATION_RECORD_V1,
    researchCodeSha,
    dslDigest: publication.dslDigest,
    bundleDigest: publication.bundleDigest,
    inputDigest,
    publicationDigest,
    publicationStatus: publication.publicationStatus,
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE' as const,
  });
  const record = Object.freeze({ ...recordCore, recordDigest: digest(recordCore) });

  const receiptWrite = await publishWriteOnce(
    join(stateRoot, 'publication-receipts'),
    `${publication.dslDigest}.json`,
    publication,
  );
  const recordWrite = await publishWriteOnce(
    join(stateRoot, 'publication-records'),
    `${publication.dslDigest}.json`,
    record,
  );

  return Object.freeze({
    schemaVersion: 1,
    contract: 'research-canonical-bundle-offline-publisher/v1',
    status: recoveredExistingCatalog ? 'verified_existing_catalog' : 'published',
    recoveredExistingCatalog,
    researchCodeSha,
    publication,
    receiptStatus: receiptWrite.status,
    recordStatus: recordWrite.status,
    receiptPath: receiptWrite.path,
    recordPath: recordWrite.path,
    inputDigest,
    publicationDigest,
    recordDigest: record.recordDigest,
    safety: Object.freeze({
      httpWriter: false,
      allowTestEvidence: false,
      syntheticBundleAllowed: false,
      evidenceCredit: 0,
      profitabilityProven: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      liveTrading: false,
      privateTradingApi: false,
      realOrder: false,
      executionAuthority: 'NONE' as const,
    }),
  });
}
