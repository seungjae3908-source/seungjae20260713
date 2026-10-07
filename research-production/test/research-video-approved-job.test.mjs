import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApprovedVideoResearchJob } from '../bin/research-video-approved-job.mjs';
import { createResearchVideoSourceV1 } from '../../packages/external-research/src/video-intelligence.js';
import { prepareVideoResearch } from '../../packages/external-research/src/research-workspace-video-v7.js';
import { createResearchOneShotManifestV12 } from '../../packages/external-research/src/research-workspace-one-shot-v12.js';

const SHA = 'b'.repeat(40);
const REVIEW_DIGEST = 'c'.repeat(64);
const NOW = '2026-10-07T00:00:00.000Z';
const EXPIRES = '2026-10-07T00:30:00.000Z';
const VIDEO_ID = 'ABCDEFGHIJK';
const VIDEO_URL = 'https://www.youtube.com/watch?v=' + VIDEO_ID;

async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-video-bridge-'));
  await chmod(root, 0o700);
  const videoRoot = join(root, 'video-research');
  const inboxRoot = join(videoRoot, 'inbox');
  const inputsRoot = join(root, 'operator-approved');
  await privateDir(videoRoot);
  await privateDir(inboxRoot);
  await privateDir(inputsRoot);

  const source = createResearchVideoSourceV1({
    provider: 'YOUTUBE',
    sourceType: 'YOUTUBE_VIDEO',
    canonicalUrl: VIDEO_URL,
    videoId: VIDEO_ID,
    title: 'Reviewed public research source',
    channelOrPublisher: 'Public research channel',
    publishedAt: '2026-10-06T00:00:00.000Z',
    discoveredAt: NOW,
    language: 'en',
    durationSec: 600,
    transcriptStatus: 'UNAVAILABLE',
    transcriptSource: null,
    transcriptAuthorized: false,
    contentAccessStatus: 'AVAILABLE',
    timestampProvenance: [],
  });

  const spec = {
    schemaVersion: 'research-video-spec-v7',
    videoUrl: VIDEO_URL,
    sourceReviewId: REVIEW_DIGEST,
    publicAccessReviewed: true,
    durationSec: 600,
    clipStartSec: 0,
    clipEndSec: 60,
    model: 'gemini-3.1-flash-lite',
    acceptedReportedModels: ['gemini-3.1-flash-lite'],
    maxOutputTokens: 512,
    timeoutMs: 10_000,
  };
  const manifest = createResearchOneShotManifestV12({
    pipelineId: 'video-approval-bridge',
    createdAt: NOW,
    market: 'CRYPTO_SPOT',
    source,
    videoSpec: spec,
  });
  const plan = prepareVideoResearch(spec);
  const videoApproval = {
    schemaVersion: 'research-video-call-approval-v7',
    approvalId: 'human-video-approval',
    planDigest: plan.planDigest,
    notBefore: NOW,
    expiresAt: EXPIRES,
    maxCalls: 1,
    sourceUseApproved: true,
    freeTierReviewed: true,
    paidFallback: false,
    executionAuthority: 'NONE',
  };
  const groqApproval = {
    schemaVersion: 'research-groq-call-approval-v12',
    approvalId: 'human-groq-approval',
    orchestratorPlanDigest: manifest.orchestratorPlanDigest,
    notBefore: NOW,
    expiresAt: EXPIRES,
    maxCalls: 1,
    sourceUseApproved: true,
    freeTierReviewed: true,
    paidFallback: false,
    executionAuthority: 'NONE',
  };
  const inbox = {
    schemaVersion: 'research-video-source-review-inbox-v1',
    createdAt: NOW,
    researchSha: SHA,
    query: 'test query',
    snapshotDigest: 'd'.repeat(64),
    sourceReviewDigest: REVIEW_DIGEST,
    sourceCount: 1,
    sources: [{
      videoId: VIDEO_ID,
      canonicalUrl: VIDEO_URL,
      title: source.title,
      channelOrPublisher: source.channelOrPublisher,
      reviewStatus: 'SOURCE_REVIEW_REQUIRED',
    }],
    nextRequiredStep: 'REVIEW_SOURCE_THEN_USE_EXISTING_V7_APPROVED_ONE_SHOT',
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  };

  const paths = {
    source: join(inputsRoot, 'source.json'),
    spec: join(inputsRoot, 'spec.json'),
    manifest: join(inputsRoot, 'manifest.json'),
    videoApproval: join(inputsRoot, 'video-approval.json'),
    groqApproval: join(inputsRoot, 'groq-approval.json'),
  };
  await privateJson(join(inboxRoot, REVIEW_DIGEST + '.json'), inbox);
  await privateJson(paths.source, source);
  await privateJson(paths.spec, spec);
  await privateJson(paths.manifest, manifest);
  await privateJson(paths.videoApproval, videoApproval);
  await privateJson(paths.groqApproval, groqApproval);
  return { root, source, spec, manifest, paths };
}

test('human-reviewed discovery inbox creates exactly one validated durable dual-review job', async () => {
  const x = await fixture();
  try {
    const result = await createApprovedVideoResearchJob({
      stateRoot: x.root,
      researchSha: SHA,
      sourceReviewDigest: REVIEW_DIGEST,
      sourcePath: x.paths.source,
      specPath: x.paths.spec,
      manifestPath: x.paths.manifest,
      videoApprovalPath: x.paths.videoApproval,
      groqApprovalPath: x.paths.groqApproval,
      clock: () => NOW,
    });
    assert.equal(result.status, 'APPROVED_JOB_CREATED');
    assert.equal(result.automaticApproval, false);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.match(result.jobDigest, /^[a-f0-9]{64}$/u);

    const jobPath = join(x.root, 'video-research', 'approved-jobs', result.jobId + '.json');
    const job = JSON.parse(await readFile(jobPath, 'utf8'));
    assert.equal(job.schemaVersion, 'research-worker-job-v9');
    assert.equal(job.maxAttempts, 1);
    assert.equal(job.task.kind, 'VIDEO_DUAL_REVIEW_APPROVED');
    assert.equal(job.task.runner, 'RESEARCH_ONE_SHOT_V12');
    assert.equal(job.task.networkMode, 'APPROVED_ONE_SHOT');
    assert.deepEqual(job.task.argv.slice(0, 10), [
      '--source', x.paths.source,
      '--spec', x.paths.spec,
      '--manifest', x.paths.manifest,
      '--video-approval', x.paths.videoApproval,
      '--groq-approval', x.paths.groqApproval,
    ]);
    assert.equal(job.task.argv[10], '--output-root');
    assert.equal(job.task.argv[11], join(x.root, 'video-research', 'executions'));
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test('bridge fails closed when the explicit source-review binding is not approved', async () => {
  const x = await fixture();
  try {
    await privateJson(x.paths.spec, { ...x.spec, publicAccessReviewed: false });
    await assert.rejects(
      createApprovedVideoResearchJob({
        stateRoot: x.root,
        researchSha: SHA,
        sourceReviewDigest: REVIEW_DIGEST,
        sourcePath: x.paths.source,
        specPath: x.paths.spec,
        manifestPath: x.paths.manifest,
        videoApprovalPath: x.paths.videoApproval,
        groqApprovalPath: x.paths.groqApproval,
        clock: () => NOW,
      }),
      /VIDEO_APPROVAL_BRIDGE_SOURCE_REVIEW_NOT_BOUND/,
    );
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});

test('bridge is idempotency-safe and never silently replaces an already approved job', async () => {
  const x = await fixture();
  try {
    const input = {
      stateRoot: x.root,
      researchSha: SHA,
      sourceReviewDigest: REVIEW_DIGEST,
      sourcePath: x.paths.source,
      specPath: x.paths.spec,
      manifestPath: x.paths.manifest,
      videoApprovalPath: x.paths.videoApproval,
      groqApprovalPath: x.paths.groqApproval,
      clock: () => NOW,
    };
    await createApprovedVideoResearchJob(input);
    await assert.rejects(createApprovedVideoResearchJob(input), /VIDEO_APPROVAL_BRIDGE_JOB_ALREADY_EXISTS/);
  } finally {
    await rm(x.root, { recursive: true, force: true });
  }
});
