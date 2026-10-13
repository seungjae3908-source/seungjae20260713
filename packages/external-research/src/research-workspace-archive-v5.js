/** Server-owned, content-addressed archive adapter. Reads only; no ingestion or provider calls. */
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareWorkspacePublication } from './research-workspace-publisher-v4.js';

const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
const digest = x => createHash('sha256').update(x).digest('hex');
const fail = code => { throw Object.assign(new Error(code), {code}); };
const check = (x, code) => { if (!x) fail(code); };
const cancelled = signal => { if (signal?.aborted) fail('REVIEWED_FILE_CANCELLED'); };
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Fixed basename selected by server code; secure local parents/cooperative UID are required.
 * Exported for the approval reader so both trust inputs use identical bounded I/O rules.
 */
export function createPrivateReviewedReader(root) {
  check(process.platform === 'linux' && typeof process.geteuid === 'function', 'LINUX_PRIVATE_READER_REQUIRED');
  check(typeof root === 'string' && isAbsolute(root) && resolve(root) === root, 'PRIVATE_ROOT_REQUIRED');
  return async function read(name, limit, signal) {
    check(typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(name) && !name.includes('..'), 'FIXED_BASENAME_REQUIRED');
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 2*1024*1024, 'PRIVATE_READ_LIMIT_INVALID');
    check(signal === undefined || signal instanceof AbortSignal, 'PRIVATE_READ_SIGNAL_INVALID');
    cancelled(signal);
    let file;
    try {
      const dir = await lstat(root);
      check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.geteuid() && !(dir.mode & 0o022) && await realpath(root) === root, 'REVIEWED_DIRECTORY_UNSAFE');
      file = await open(join(root,name), READ);
      const a = await file.stat();
      check(a.isFile() && a.nlink === 1 && a.uid === process.geteuid() && !(a.mode & 0o022) && a.size > 0 && a.size <= limit, 'REVIEWED_FILE_UNSAFE');
      const buffer = Buffer.alloc(limit+1); let n = 0;
      while (n < buffer.length) {
        cancelled(signal);
        const r = await file.read(buffer,n,Math.min(65536,buffer.length-n),n);
        if (!r.bytesRead) break;
        n += r.bytesRead;
      }
      const b = await file.stat(), after = await lstat(root);
      check(n === a.size && n <= limit && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs
        && b.nlink === 1 && b.uid === a.uid && b.mode === a.mode, 'REVIEWED_FILE_CHANGED');
      check(after.isDirectory() && !after.isSymbolicLink() && dir.ino === after.ino && dir.dev === after.dev
        && after.uid === dir.uid && !(after.mode & 0o022), 'REVIEWED_DIRECTORY_CHANGED');
      cancelled(signal);
      return buffer.subarray(0,n);
    } catch(e) {
      if (e?.code?.startsWith('REVIEWED_')) throw e;
      fail('REVIEWED_FILE_UNAVAILABLE');
    } finally { if (file) await file.close(); }
  };
}

/** manifestSha256 MUST be selected by a trusted reviewer, not by a browser/video/LLM.
 * OBSERVED is reviewed producer metadata, not a semantic or consent certification.
 */
export async function openReviewedWorkspaceArchive({root,manifestSha256,now,signal}) {
  check(hash(manifestSha256) && iso(now), 'ARCHIVE_TRUST_INPUT_REQUIRED');
  const read = createPrivateReviewedReader(root);
  const bytes = await read(`manifest-${manifestSha256}.json`,128*1024,signal);
  check(digest(bytes) === manifestSha256, 'ARCHIVE_MANIFEST_HASH_MISMATCH');
  let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { fail('ARCHIVE_MANIFEST_INVALID'); }
  check(exact(m,['schemaVersion','createdAt','producerCodeSha','reviewId','artifacts'])
    && m.schemaVersion === 'research-workspace-archive-v5' && iso(m.createdAt) && m.createdAt <= now
    && sha(m.producerCodeSha) && id(m.reviewId) && Array.isArray(m.artifacts)
    && m.artifacts.length > 0 && m.artifacts.length <= 256, 'ARCHIVE_MANIFEST_INVALID');
  const entries = new Map(), identities = new Map(); let total = 0;
  for (const a of m.artifacts) {
    check(exact(a,['kind','digest','byteLength','dataClass']) && ['CONTENT_INPUT','CONTENT_OUTPUT','RESULT'].includes(a.kind)
      && hash(a.digest) && Number.isSafeInteger(a.byteLength) && a.byteLength > 0 && a.byteLength <= 2*1024*1024
      && ['OBSERVED','SYNTHETIC'].includes(a.dataClass), 'ARCHIVE_ENTRY_INVALID');
    const identity = identities.get(a.digest);
    check(!identity || identity.byteLength === a.byteLength && identity.dataClass === a.dataClass, 'ARCHIVE_CLASSIFICATION_CONFLICT');
    identities.set(a.digest,a);
    const key = `${a.kind}:${a.digest}`;
    check(!entries.has(key), 'ARCHIVE_ENTRY_DUPLICATE');
    entries.set(key,Object.freeze({...a})); total += a.byteLength;
  }
  check(total <= 32*1024*1024, 'ARCHIVE_TOTAL_TOO_LARGE');
  return Object.freeze({
    manifestSha256, producerCodeSha:m.producerCodeSha, reviewId:m.reviewId, artifactCount:entries.size,
    async loadArtifact({kind,digest:expected,signal:requestSignal}) {
      cancelled(signal); cancelled(requestSignal);
      check(typeof kind === 'string' && hash(expected), 'ARCHIVE_REFERENCE_INVALID');
      const a = entries.get(`${kind}:${expected}`);
      check(a, 'ARCHIVE_REFERENCE_NOT_REVIEWED');
      const merged = signal && requestSignal ? AbortSignal.any([signal,requestSignal]) : signal ?? requestSignal;
      const raw = await read(`artifact-${a.digest}.bin`,a.byteLength,merged);
      check(raw.length === a.byteLength && digest(raw) === a.digest, 'ARCHIVE_ARTIFACT_HASH_MISMATCH');
      return {bytes:raw,dataClass:a.dataClass};
    },
  });
}

/** Read-only preparation; uses the existing Phase4 validator and never writes policy.json. */
export async function prepareWorkspaceFromReviewedArchive({archiveRoot,manifestSha256,videoEvidence,registry,policy,signal}) {
  const archive = await openReviewedWorkspaceArchive({root:archiveRoot,manifestSha256,now:policy?.now,signal});
  const plan = await prepareWorkspacePublication({videoEvidence,registry,policy,loadArtifact:archive.loadArtifact});
  cancelled(signal);
  return Object.freeze({plan,archiveManifestSha256:archive.manifestSha256,archiveProducerCodeSha:archive.producerCodeSha,
    archiveReviewId:archive.reviewId,artifactCount:archive.artifactCount,publicationPerformed:false});
}
