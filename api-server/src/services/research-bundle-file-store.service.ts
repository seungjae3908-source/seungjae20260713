import { lstat, realpath, mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Canonical as hash } from '../../../market-prediction-lab/src/research-cache-provenance.js';
import type { ResearchBundleResolution, ResearchSubmissionStore } from './research-bundle.contract';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const errno = (error: unknown, code: string) => row(error).code === code;
const MAX_BYTES = 64 * 1024 * 1024;

function key(value: string): string {
  if (!digest(value)) throw new Error('RESEARCH_STORAGE_KEY_INVALID');
  return value;
}
async function directory(path: string) {
  if (!isAbsolute(path)) throw new Error('RESEARCH_STORAGE_ROOT_MUST_BE_ABSOLUTE');
  const normalized = resolve(path), info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(normalized)) !== normalized)
    throw new Error('RESEARCH_STORAGE_DIRECTORY_UNSAFE');
  return normalized;
}
async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_BYTES)
    throw new Error('RESEARCH_STORAGE_FILE_INVALID');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. File contents are
  // synced there; power-loss durability additionally requires the host volume.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishOnce(path: string, name: string, value: unknown) {
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('RESEARCH_STORAGE_RECORD_TOO_LARGE');
  const temporary = join(path, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  // A hard link publishes all synced bytes at once and cannot replace an
  // existing reservation/completion. Failed claims remain reserved forever.
  try { await link(temporary, join(path, name)); await syncDirectory(path); }
  finally { await unlink(temporary); }
}
function receiptFor(value: unknown, expectedKey: string): ResearchBundleResolution {
  const r = row(value), receipt = row(r.receipt), { requestDigest, submittedAt, ...material } = receipt;
  if (r.schemaVersion !== 'research-bundle-resolution-v1' || requestDigest !== expectedKey || hash(material) !== expectedKey ||
    typeof submittedAt !== 'number' || !Number.isSafeInteger(submittedAt) || submittedAt <= 0 ||
    r.executionAuthority !== 'NONE' || r.profitabilityProven !== false || r.promotionEligible !== false || r.champion !== null || r.evidenceCredit !== 0 ||
    r.wfEvidencePresent !== false || r.oosEvidencePresent !== false || r.holdoutEvidencePresent !== false ||
    r.statisticalFirewallPass !== false || r.statisticalFirewallStatus !== 'MISSING_EVIDENCE' ||
    r.wfStatus !== 'NOT_EVALUATED' || r.oosStatus !== 'NOT_EVALUATED' || r.holdoutStatus !== 'LOCKED' ||
    r.backtestSubmitted !== true || !['RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED_DATA'].includes(String(r.backtestStatus)) ||
    (r.backtesterCalls !== 0 && r.backtesterCalls !== 1) || r.backtestCompleted !== (r.backtestStatus === 'COMPLETED') ||
    ['strategyIdentityDigest', 'dslDigest', 'bundleDigest', 'datasetDigest', 'splitReceiptDigest', 'modelIdentityDigest', 'featureOrderDigest'].some(k => !digest(receipt[k])) ||
    ['strategyIdentityDigest', 'dslDigest', 'bundleDigest', 'modelIdentityDigest', 'featureOrderDigest', 'preprocessingVersion'].some(k => r[k] !== receipt[k]))
    throw new Error('RESEARCH_STORAGE_RECEIPT_INVALID');
  return value as ResearchBundleResolution;
}

/** Separate namespaces inside an explicitly configured, preexisting durable
 * volume. No HTTP writer, producer, synthetic catalog or implicit temp fallback. */
export function createResearchBundleFileStore(stateRoot: string): {
  readCanonicalBundle: (dslDigest: string) => Promise<unknown>;
  submissions: ResearchSubmissionStore;
} {
  async function submissionDirectory(requestKey: string, create = false) {
    const root = await directory(stateRoot), submissions = join(root, 'submissions');
    if (create) await mkdir(submissions, { recursive: true, mode: 0o700 });
    await directory(submissions);
    return join(submissions, key(requestKey));
  }
  async function completed(path: string, requestKey: string) {
    let value: unknown;
    try { value = await readJson(join(path, 'completion.json')); }
    catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
    const record = row(value), receipt = receiptFor(record.receipt, requestKey);
    if (record.schemaVersion !== 'research-submission-publication-v1' || record.requestKey !== requestKey ||
      receipt.backtestStatus === 'RUNNING' || (receipt.backtestCompleted &&
        (receipt.backtesterCalls !== 1 || !digest(receipt.resultArtifactDigest) || receipt.resultArtifactDigest !== hash(record.artifact))))
      throw new Error('RESEARCH_STORAGE_PUBLICATION_INVALID');
    return { receipt, artifact: record.artifact };
  }
  return {
    async readCanonicalBundle(dslDigest) {
      const root = await directory(stateRoot), catalog = await directory(join(root, 'catalog'));
      let value: unknown;
      try { value = await readJson(join(catalog, key(dslDigest) + '.json')); }
      catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
      const envelope = row(value);
      if (envelope.schemaVersion !== 'research-bundle-catalog-entry-v1' || envelope.dslDigest !== dslDigest ||
        !digest(envelope.bundleDigest) || envelope.bundleDigest !== hash(envelope.bundle) || row(envelope.bundle).evidenceClass !== 'CANONICAL')
        throw new Error('RESEARCH_CATALOG_BINDING_INVALID');
      return envelope.bundle;
    },
    submissions: {
      async reserve(requestKey, supplied) {
        const receipt = receiptFor(supplied, key(requestKey));
        if (receipt.backtestStatus !== 'RUNNING' || receipt.backtesterCalls !== 0 || receipt.resultArtifactDigest !== null)
          throw new Error('RESEARCH_STORAGE_RESERVATION_INVALID');
        const path = await submissionDirectory(requestKey, true);
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) {
          if (!errno(error, 'EEXIST')) throw error;
          await directory(path);
          const reservation = receiptFor(await readJson(join(path, 'reservation.json')), requestKey);
          const prior = await completed(path, requestKey);
          if (prior && hash(prior.receipt.receipt) !== hash(reservation.receipt)) throw new Error('RESEARCH_STORAGE_RESERVATION_MISMATCH');
          return { acquired: false, receipt: prior?.receipt ?? reservation };
        }
        await syncDirectory(join(path, '..'));
        await publishOnce(path, 'reservation.json', receipt);
        return { acquired: true, receipt };
      },
      async complete(requestKey, supplied, artifact) {
        const path = await directory(await submissionDirectory(requestKey));
        const reservation = receiptFor(await readJson(join(path, 'reservation.json')), requestKey), receipt = receiptFor(supplied, requestKey);
        if (hash(reservation.receipt) !== hash(receipt.receipt) || receipt.backtestStatus === 'RUNNING' ||
          (receipt.backtestCompleted ? !artifact || receipt.resultArtifactDigest !== hash(artifact) || receipt.backtesterCalls !== 1 : artifact !== undefined))
          throw new Error('RESEARCH_STORAGE_COMPLETION_INVALID');
        await publishOnce(path, 'completion.json', { schemaVersion: 'research-submission-publication-v1', requestKey, receipt, artifact: artifact ?? null });
      },
      async read(requestKey) {
        let path: string;
        try { path = await directory(await submissionDirectory(requestKey)); }
        catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
        const reservation = receiptFor(await readJson(join(path, 'reservation.json')), requestKey);
        const publication = await completed(path, requestKey);
        if (publication && hash(reservation.receipt) !== hash(publication.receipt.receipt)) throw new Error('RESEARCH_STORAGE_RESERVATION_MISMATCH');
        return publication?.receipt.backtestCompleted ? publication : null;
      },
    },
  };
}
