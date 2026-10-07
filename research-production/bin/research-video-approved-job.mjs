#!/usr/bin/env node
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertResearchVideoSourceV1 } from '../../packages/external-research/src/video-intelligence.js';
import { prepareVideoResearch, verifyVideoCallApproval } from '../../packages/external-research/src/research-workspace-video-v7.js';
import {
  createResearchOneShotManifestV12,
  researchOneShotDigestV12,
  verifyGroqCallApprovalV12,
} from '../../packages/external-research/src/research-workspace-one-shot-v12.js';
import { researchWorkerJobDigest } from '../../packages/external-research/src/research-workspace-worker-v9.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const DIGEST = /^[a-f0-9]{64}$/u;

async function secureDir(path, { create = false } = {}) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = await h.stat();
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())
      || (st.mode & 0o077) || await realpath(path) !== path) fail('VIDEO_APPROVAL_BRIDGE_DIR_UNSAFE');
  } finally {
    await h.close();
  }
  return path;
}

async function readPrivateJson(path, maxBytes = 256 * 1024) {
  if (!isAbsolute(path)) fail('VIDEO_APPROVAL_BRIDGE_PATH_INVALID');
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size <= 0 || st.size > maxBytes
      || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077)) {
      fail('VIDEO_APPROVAL_BRIDGE_FILE_UNSAFE');
    }
    const bytes = Buffer.alloc(st.size);
    let n = 0;
    while (n < bytes.length) {
      const read = await h.read(bytes, n, bytes.length - n, n);
      if (!read.bytesRead) break;
      n += read.bytesRead;
    }
    if (n !== st.size) fail('VIDEO_APPROVAL_BRIDGE_FILE_CHANGED');
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { fail('VIDEO_APPROVAL_BRIDGE_JSON_INVALID'); }
  } finally {
    await h.close();
  }
}

async function writeExclusiveJson(path, value) {
  const h = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(JSON.stringify(value) + '\n');
    await h.sync();
  } finally {
    await h.close();
  }
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set([
    '--state-root', '--research-sha', '--source-review-digest',
    '--source', '--spec', '--manifest', '--video-approval', '--groq-approval',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!allowed.has(key) || Object.hasOwn(out, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      fail('VIDEO_APPROVAL_BRIDGE_ARGUMENTS_INVALID');
    }
    out[key] = argv[++i];
  }
  for (const key of allowed) if (!out[key]) fail('VIDEO_APPROVAL_BRIDGE_ARGUMENTS_INVALID');
  return out;
}

export async function createApprovedVideoResearchJob({
  stateRoot,
  researchSha,
  sourceReviewDigest,
  sourcePath,
  specPath,
  manifestPath,
  videoApprovalPath,
  groqApprovalPath,
  clock = () => new Date().toISOString(),
} = {}) {
  const root = resolve(String(stateRoot ?? ''));
  const sha = String(researchSha ?? '').trim().toLowerCase();
  const digest = String(sourceReviewDigest ?? '').trim().toLowerCase();
  if (!isAbsolute(root) || !/^[a-f0-9]{40}$/u.test(sha) || !DIGEST.test(digest)) {
    fail('VIDEO_APPROVAL_BRIDGE_IDENTITY_INVALID');
  }

  await secureDir(root);
  const videoRoot = await secureDir(join(root, 'video-research'), { create: true });
  const inboxRoot = await secureDir(join(videoRoot, 'inbox'), { create: true });
  const approvedJobsRoot = await secureDir(join(videoRoot, 'approved-jobs'), { create: true });
  const outputRoot = await secureDir(join(videoRoot, 'executions'), { create: true });

  const inbox = await readPrivateJson(join(inboxRoot, digest + '.json'));
  if (inbox?.schemaVersion !== 'research-video-source-review-inbox-v1'
    || String(inbox?.researchSha ?? '').toLowerCase() !== sha
    || inbox?.sourceReviewDigest !== digest
    || !Array.isArray(inbox?.sources)
    || inbox.sources.length < 1) {
    fail('VIDEO_APPROVAL_BRIDGE_INBOX_MISMATCH');
  }

  const [source, spec, manifest, videoApproval, groqApproval] = await Promise.all([
    readPrivateJson(sourcePath),
    readPrivateJson(specPath),
    readPrivateJson(manifestPath),
    readPrivateJson(videoApprovalPath, 64 * 1024),
    readPrivateJson(groqApprovalPath, 64 * 1024),
  ]);

  assertResearchVideoSourceV1(source);
  if (spec?.schemaVersion !== 'research-video-spec-v7' || spec?.sourceReviewId !== digest || spec?.publicAccessReviewed !== true) {
    fail('VIDEO_APPROVAL_BRIDGE_SOURCE_REVIEW_NOT_BOUND');
  }
  const inboxSource = inbox.sources.find((row) => row?.videoId === source.videoId && row?.canonicalUrl === source.canonicalUrl);
  if (!inboxSource || spec.videoUrl !== source.canonicalUrl) fail('VIDEO_APPROVAL_BRIDGE_SOURCE_NOT_DISCOVERED');
  if (source.provider !== 'YOUTUBE' || source.sourceType !== 'YOUTUBE_VIDEO') {
    fail('VIDEO_APPROVAL_BRIDGE_SOURCE_PROVIDER_MISMATCH');
  }
  const sameNullable = (left, right) => (left ?? null) === (right ?? null);
  const metadataMatches = inboxSource.title === source.title
    && inboxSource.channelOrPublisher === source.channelOrPublisher
    && sameNullable(inboxSource.publishedAt, source.publishedAt)
    && sameNullable(inboxSource.language, source.language)
    && sameNullable(inboxSource.durationSec, source.durationSec)
    && inboxSource.transcriptStatus === source.transcriptStatus
    && inboxSource.contentAccessStatus === source.contentAccessStatus;
  if (!metadataMatches) fail('VIDEO_APPROVAL_BRIDGE_SOURCE_METADATA_MISMATCH');
  if (source.durationSec != null && spec.durationSec !== source.durationSec) {
    fail('VIDEO_APPROVAL_BRIDGE_DURATION_MISMATCH');
  }

  const plan = prepareVideoResearch(spec);
  const recomputed = createResearchOneShotManifestV12({
    pipelineId: manifest?.pipelineId,
    createdAt: manifest?.createdAt,
    market: manifest?.market,
    source,
    videoSpec: spec,
  });
  if (researchOneShotDigestV12(manifest) !== researchOneShotDigestV12(recomputed)
    || manifest?.manifestDigest !== recomputed.manifestDigest) {
    fail('VIDEO_APPROVAL_BRIDGE_MANIFEST_MISMATCH');
  }

  const now = clock();
  verifyVideoCallApproval(videoApproval, plan, now);
  verifyGroqCallApprovalV12(groqApproval, recomputed, now);

  const job = Object.freeze({
    schemaVersion: 'research-worker-job-v9',
    jobId: 'video-dual-' + recomputed.manifestDigest.slice(0, 32),
    createdAt: now,
    notBefore: now,
    maxAttempts: 1,
    task: Object.freeze({
      kind: 'VIDEO_DUAL_REVIEW_APPROVED',
      runner: 'RESEARCH_ONE_SHOT_V12',
      networkMode: 'APPROVED_ONE_SHOT',
      argv: Object.freeze([
        '--source', sourcePath,
        '--spec', specPath,
        '--manifest', manifestPath,
        '--video-approval', videoApprovalPath,
        '--groq-approval', groqApprovalPath,
        '--output-root', outputRoot,
      ]),
    }),
  });
  const jobDigest = researchWorkerJobDigest(job);
  try {
    await writeExclusiveJson(join(approvedJobsRoot, job.jobId + '.json'), job);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('VIDEO_APPROVAL_BRIDGE_JOB_ALREADY_EXISTS');
    throw error;
  }

  return Object.freeze({
    schemaVersion: 'research-video-approved-job-bridge-v1',
    status: 'APPROVED_JOB_CREATED',
    researchSha: sha,
    sourceReviewDigest: digest,
    jobId: job.jobId,
    jobDigest,
    automaticApproval: false,
    providerCalls: 0,
    executionAuthority: 'NONE',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await createApprovedVideoResearchJob({
      stateRoot: args['--state-root'],
      researchSha: args['--research-sha'],
      sourceReviewDigest: args['--source-review-digest'],
      sourcePath: args['--source'],
      specPath: args['--spec'],
      manifestPath: args['--manifest'],
      videoApprovalPath: args['--video-approval'],
      groqApprovalPath: args['--groq-approval'],
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? 'VIDEO_APPROVAL_BRIDGE_FAILED')
      .replace(/[^A-Z0-9_]/giu, '_').slice(0, 120);
    process.stderr.write(JSON.stringify({
      status: 'FAILED_CLOSED',
      reason: code,
      automaticApproval: false,
      providerCalls: 0,
      executionAuthority: 'NONE',
    }) + '\n');
    process.exitCode = 1;
  }
}
