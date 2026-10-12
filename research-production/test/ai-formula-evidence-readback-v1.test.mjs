import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runResearchAiReviewScan } from '../src/research-ai-review-worker.mjs';
import {
  AI_FORMULA_READBACK_CONTRACT_V1,
  inspectAiFormulaResearchEvidenceV1,
} from '../src/ai-formula-evidence-readback-v1.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.UTC(2026, 9, 12, 12, 35);
const CYCLE_TIME = NOW - 10 * 60_000;
const SECRET = 'TEST_ONLY_NEVER_STORE_AI_PROVIDER_KEY';

async function privateFolder(root, name) {
  await mkdir(join(root, name), { recursive: true, mode: 0o700 });
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}

function cycle(profile) {
  return {
    schemaVersion: 'research-production-cycle-v1',
    cycleId: 'TEST_ONLY_' + profile,
    profile, researchSha: SHA,
    generatedAt: CYCLE_TIME,
    status: 'complete',
    results: [
      { id: profile + '-first', status: 'success', timedOut: false },
      { id: profile + '-second', status: 'blocked_data', timedOut: false },
    ],
    liveTrading: false, privateApi: false, orderAuthority: false,
  };
}

const REPLY = JSON.stringify({
  summary: 'Research evidence needs verified review.',
  findings: ['Source continuity should be independently checked.'],
  hypotheses: [{
    hypothesisId: 'BoundedVolume',
    thesis: 'A bounded source-aware volume model may be worth researching.',
    requiredEvidence: ['Independent licensed TRAIN bars and verified market membership'],
    falsification: 'Reject if source gaps invalidate the finding.',
    intendedRegime: 'Trends with verified liquidity',
    independenceRationale: 'Holdout is reserved for a separate evaluator.',
  }],
  risks: ['Sources are incomplete until independently verified.'],
  disposition: 'RESEARCH_PROPOSAL_ONLY',
});

async function fixture(profiles, fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-readback-provenance-'));
  try {
    await privateFolder(root, 'latest');
    for (const profile of profiles) await privateJson(join(root, 'latest', profile + '.json'), cycle(profile));
    const input = {
      repoRoot: '/TEST_ONLY/repo', stateRoot: root, researchSha: SHA,
      env: {
        RESEARCH_AI_FREE_TIER_CONFIRMED: 'true',
        AI_CHAT_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET,
      },
      verifyGitHead: false,
      preflight: async ({ researchSha }) => ({ researchSha, stateRoot: resolve(root) }),
      invoke: async ({ policy }) => ({ provider: policy.provider, model: policy.model, answer: REPLY }),
      now: () => NOW,
    };
    const scan = await runResearchAiReviewScan(input);
    return await fn({ root, scan });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function probe(root, extra = {}) {
  return inspectAiFormulaResearchEvidenceV1({ stateRoot: root, researchSha: SHA, now: NOW, ...extra });
}

test('genuine forward-only CRITIC remains WAITING, not self-developing formula readiness', async () => {
  await fixture(['forward'], async ({ root, scan }) => {
    assert.equal(scan.reviews.length, 1);
    assert.equal(scan.reviews[0].role, 'CRITIC');
    const before = await stat(join(root, 'ai-review', 'latest.json'));
    const report = await probe(root);
    assert.equal(report.contract, AI_FORMULA_READBACK_CONTRACT_V1);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].status, 'VERIFIED_AI_REVIEW');
    assert.equal(report.rows[0].role, 'CRITIC');
    assert.equal(report.counts.CRITIC, 1);
    assert.equal(report.counts.PROPOSAL_ONLY, 0);
    assert.equal(report.status, 'WAITING_HISTORICAL_PROPOSER_EVIDENCE');
    assert.equal(report.automaticFormulaGeneration, false);
    assert.equal(report.canonicalFormulaBound, false);
    assert.equal(report.originalTrainSourceVerified, false);
    assert.equal(report.paperAdmissionAllowed, false);
    assert.equal(report.externalProviderCalls, 0);
    assert.equal(report.storageMutationCount, 0);
    assert.equal(report.executionAuthority, 'NONE');
    const after = await stat(join(root, 'ai-review', 'latest.json'));
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual((await readdir(root)).sort(), ['ai-review', 'latest']);
    assert.ok(!JSON.stringify(report).includes(SECRET));
  });
});

test('both historical PROPOSER reviews can be verified against genuine canonical cycles but cannot run formulas without a separately approved source', async () => {
  await fixture(['forward', 'fast-historical', 'long-history'], async ({ root, scan }) => {
    assert.equal(scan.status, 'COMPLETE');
    const report = await probe(root);
    assert.equal(report.counts.CRITIC, 1);
    assert.equal(report.counts.PROPOSER, 2);
    assert.equal(report.counts.PROPOSAL_ONLY, 2);
    assert.equal(report.historicalProposerReady, true);
    assert.equal(report.status, 'REVIEWED_PROPOSAL_AWAITING_APPROVED_FORMULA_AND_TRAIN_SOURCE');
    assert.equal(report.blockerCodes.length, 0);
    assert.equal(report.rows.length, 3);
    assert.equal(report.rows.every((r) => r.status === 'VERIFIED_AI_REVIEW'), true);
    assert.equal(report.originalTrainSourceVerified, false);
    assert.equal(report.independentOosVerified, false);
    assert.equal(report.fullCostVerified, false);
    assert.equal(report.executionAuthority, 'NONE');
  });
});

test('rewritten canonical cycle identity cannot inherit an AI review from the prior immutable cycle', async () => {
  await fixture(['fast-historical'], async ({ root }) => {
    const path = join(root, 'latest', 'fast-historical.json');
    const modified = JSON.parse(await readFile(path, 'utf8'));
    modified.results[0].id = 'different-cycle-task';
    await privateJson(path, modified);
    const report = await probe(root);
    assert.equal(report.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(report.blockerCodes, ['CURRENT_CYCLE_AI_DIGEST_MISMATCH']);
    assert.equal(report.rows[0].status, 'CYCLE_REVIEW_DIGEST_MISMATCH');
    assert.equal(report.counts.PROPOSER, 0);
  });
});

test('AI artifact role, source-cycle identity and pinned model cannot be forged', async () => {
  for (const mutate of [
    (a) => { a.role = 'CRITIC'; },
    (a) => { a.sourceCycleId = 'another-cycle'; },
    (a) => { a.model = 'UNAPPROVED'; },
    (a) => { a.observedAt = CYCLE_TIME - 60_000; },
  ]) {
    await fixture(['fast-historical'], async ({ root, scan }) => {
      const path = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
      const artifact = JSON.parse(await readFile(path, 'utf8'));
      mutate(artifact);
      await privateJson(path, artifact);
      const report = await probe(root);
      assert.equal(report.status, 'BLOCKED_EVIDENCE');
      assert.deepEqual(report.blockerCodes, ['AI_ARTIFACT_PROVENANCE_MISMATCH']);
      assert.equal(report.counts.PROPOSER, 0);
    });
  }
});

test('additional AI authority fails even when scan digest and cycle remain exact', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const path = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    artifact.safety.orderAllowed = true;
    await privateJson(path, artifact);
    const report = await probe(root);
    assert.equal(report.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(report.blockerCodes, ['AI_ARTIFACT_REVIEW_INVALID']);
    assert.equal(report.rows[0].status, 'INVALID_AI_REVIEW');
  });
});

test('symlink source file and malformed provider snapshot fail closed, never following private arbitrary paths', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    await writeFile(latest, '{ "unfinished":', { mode: 0o600 });
    await assert.rejects(probe(root), /AI_FORMULA_READBACK_JSON_INVALID/);
    const copied = JSON.parse(JSON.stringify(scan));
    await privateJson(latest, copied);
    const review = join(root, 'ai-review', 'reviews', scan.reviews[0].evidenceDigest + '.json');
    const external = join(root, 'test-secret.txt');
    await writeFile(external, SECRET);
    await unlink(review);
    await symlink(external, review);
    await assert.rejects(probe(root), /AI_FORMULA_READBACK_FILE_UNSAFE|ELOOP/);
  });
});

test('stale-release AI snapshots and outdated historical cycles never appear eligible', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    await privateJson(latest, { ...scan, researchSha: 'b'.repeat(40) });
    const stale = await probe(root);
    assert.equal(stale.scanStatus, 'STALE_RELEASE');
    assert.equal(stale.historicalProposerReady, false);
    assert.deepEqual(stale.blockerCodes, ['AI_SCAN_STALE_RELEASE']);
    await privateJson(latest, scan);
    const c = join(root, 'latest', 'fast-historical.json');
    await privateJson(c, { ...cycle('fast-historical'), researchSha: 'b'.repeat(40) });
    const staleCycle = await probe(root);
    assert.equal(staleCycle.status, 'BLOCKED_EVIDENCE');
    assert.deepEqual(staleCycle.blockerCodes, ['CURRENT_CYCLE_STALE_RELEASE']);
  });
});

test('scan duplicate review, unsupported policy and future scan timestamps are strict failures', async () => {
  await fixture(['fast-historical'], async ({ root, scan }) => {
    const latest = join(root, 'ai-review', 'latest.json');
    for (const corrupt of [
      { ...scan, reviews: [scan.reviews[0], scan.reviews[0]] },
      { ...scan, safety: { ...scan.safety, paidFallback: true } },
      { ...scan, observedAt: NOW + 60_000 },
      { ...scan, evidenceCredit: 1 },
    ]) {
      await privateJson(latest, corrupt);
      await assert.rejects(probe(root), /AI_FORMULA_READBACK_SCAN_REVIEW_INVALID|AI_FORMULA_READBACK_SCAN_INVALID/);
    }
  });
});

test('missing AI scan produces bounded truthful blocker and never writes a new directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-readback-missing-'));
  try {
    const report = await probe(root);
    assert.equal(report.scanStatus, 'MISSING');
    assert.equal(report.historicalProposerReady, false);
    assert.deepEqual(report.blockerCodes, ['AI_SCAN_NOT_YET_RECORDED']);
    assert.equal(report.storageMutationCount, 0);
    assert.equal((await readdir(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private app storage and malformed SHA are refused before reading any files', async () => {
  await assert.rejects(probe('/var/lib/stock-app/data'), /AI_FORMULA_READBACK_APP_STORAGE_FORBIDDEN/);
  await assert.rejects(probe('/tmp', { researchSha: 'x'.repeat(40) }), /AI_FORMULA_READBACK_SHA_REQUIRED/);
});
