import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_PROSPECTIVE_CONTRACT,
  buildSuccessorSlotDescriptor,
  splitForSuccessorSlotIndex,
  verifySuccessorProspectiveContract,
} from '../src/public-forward-liquidity-successor-prospective-cohort.mjs';

function gitBlobSha1(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1').update(Buffer.concat([
    Buffer.from(`blob ${body.length}\0`),
    body,
  ])).digest('hex');
}

test('successor V2 policy/cohort digests are immutable and internally consistent', () => {
  const verdict = verifySuccessorProspectiveContract();
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.policyDigest, '5d91ea09ac5a2982a26d00197433142455fa6634488fadc9201e4ddf1346ed6c');
  assert.equal(verdict.cohortDigest, '9b2853a361e17dc429288cec4499fc972189b0bc2427a6d8bb2a999eff847454');
  assert.equal(
    SUCCESSOR_PROSPECTIVE_CONTRACT.cohortId,
    'PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_PROSPECTIVE_COHORT_V2_20260903_CAP1024:5d91ea09ac5a2982a26d00197433142455fa6634488fadc9201e4ddf1346ed6c',
  );
});

test('owner numeric freeze predates first eligible successor slot and binds capacity 1024', () => {
  const { authority, capacityRedesignBinding, cohort } = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore;
  assert.equal(authority.canonicalHubIssue, 838);
  assert.equal(authority.humanApprovalCommentId, 5500894175);
  assert.equal(authority.humanApprovalCreatedAt, '2026-09-01T21:49:01Z');
  assert.ok(authority.humanApprovalCreatedAtMs < cohort.startInclusiveMs);
  assert.equal(capacityRedesignBinding.designCommentId, 5500824852);
  assert.equal(capacityRedesignBinding.numericFreezeCommentId, 5500894175);
  assert.equal(capacityRedesignBinding.finalTotalSlotN, 1024);
  assert.equal(capacityRedesignBinding.finalHeadroomSlotN, 312);
  assert.equal(capacityRedesignBinding.trainValidationOosRatio, '2:1:1');
  assert.equal(capacityRedesignBinding.aiNumericAuthority, 'NONE');
  assert.equal(cohort.startInclusiveUtc, '2026-09-02T15:17:00.000Z');
  assert.equal(cohort.startInclusiveKst, '2026-09-03T00:17:00+09:00');
});

test('1024 hourly slots cover exactly 42d16h with 512/256/256 chronological splits', () => {
  const { cohort } = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore;
  assert.equal(cohort.totalSlotN, 1024);
  assert.equal(cohort.slotCadenceMs, 3_600_000);
  assert.equal(cohort.endExclusiveMs - cohort.startInclusiveMs, 1024 * 60 * 60 * 1000);
  assert.equal(cohort.endExclusiveUtc, '2026-10-15T07:17:00.000Z');
  assert.equal(cohort.endExclusiveKst, '2026-10-15T16:17:00+09:00');

  const counts = { TRAIN: 0, VALIDATION: 0, OOS: 0 };
  for (let slotIndex = 0; slotIndex < cohort.totalSlotN; slotIndex += 1) {
    counts[splitForSuccessorSlotIndex(slotIndex)] += 1;
  }
  assert.deepEqual(counts, { TRAIN: 512, VALIDATION: 256, OOS: 256 });
  assert.equal(splitForSuccessorSlotIndex(0), 'TRAIN');
  assert.equal(splitForSuccessorSlotIndex(511), 'TRAIN');
  assert.equal(splitForSuccessorSlotIndex(512), 'VALIDATION');
  assert.equal(splitForSuccessorSlotIndex(767), 'VALIDATION');
  assert.equal(splitForSuccessorSlotIndex(768), 'OOS');
  assert.equal(splitForSuccessorSlotIndex(1023), 'OOS');
  assert.throws(() => splitForSuccessorSlotIndex(1024), /SUCCESSOR_SLOT_INDEX_INVALID/u);
});

test('slot descriptors preserve minute-17 UTC cadence and approved capture window through slot 1023', () => {
  const first = buildSuccessorSlotDescriptor(0);
  const second = buildSuccessorSlotDescriptor(1);
  const last = buildSuccessorSlotDescriptor(1023);
  assert.equal(first.nominalScheduledAtMs, 1788362220000);
  assert.equal(first.allowedStartThroughMs, first.nominalScheduledAtMs + 20 * 60 * 1000);
  assert.equal(first.latestCompletionIfLatestEligibleStartMs, first.nominalScheduledAtMs + 30 * 60 * 1000);
  assert.ok(first.latestCompletionIfLatestEligibleStartMs < first.slotEndExclusiveMs);
  assert.equal(second.nominalScheduledAtMs - first.nominalScheduledAtMs, 60 * 60 * 1000);
  assert.equal(last.nominalScheduledAtMs, 1792045020000);
  assert.equal(last.slotEndExclusiveMs, 1792048620000);
  assert.equal(first.cronUtc, '17 * * * *');
});

test('V1 cohort remains predecessor-only and cannot be retroactively reclassified', () => {
  const predecessor = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.supersedes;
  assert.equal(predecessor.contractVersion, 'public-forward-liquidity-successor-prospective-cohort-contract-v1');
  assert.equal(predecessor.policyDigest, '451b880a7efff4c3cbb8abe8bcda07bbf54a534f9f01baeb040547c339fa489a');
  assert.equal(predecessor.cohortDigest, '7c24f0f752c500bc7ea90df5e7975319a5c4813a23f8f0e375a1ffd0b99672bb');
  assert.equal(predecessor.retroactiveReclassificationAllowed, false);
  assert.equal(predecessor.redesignedCreditFromPriorCohort, 0);
});

test('all non-genuine or retrospective successor credit paths remain zero', () => {
  const credit = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.creditPolicy;
  assert.equal(credit.prospectiveCreditPerEligiblePresentFirstAttempt, 1);
  for (const key of [
    'oldV3ProspectiveCredit',
    'manualCredit',
    'replayCredit',
    'backfillCredit',
    'operatorSelectedCredit',
    'duplicateOrRerunCredit',
    'missedSlotCredit',
    'syntheticCredit',
  ]) assert.equal(credit[key], 0, key);
  const integrity = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.prospectiveIntegrity;
  assert.equal(integrity.randomSplitAllowed, false);
  assert.equal(integrity.retrospectiveSplitReassignmentAllowed, false);
  assert.equal(integrity.oldV3IdentityInheritanceAllowed, false);
  assert.equal(integrity.outcomeInspectionUsedForPolicySelection, false);
  assert.equal(integrity.successorGenuineRawNAtFreeze, 0);
});

test('successor contract reuses canonical collector technical identity without inventing model policy', async () => {
  const collectorPath = new URL('../src/public-forward-liquidity-calibration.mjs', import.meta.url);
  const collectorBytes = await readFile(collectorPath);
  const technical = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.technicalIdentity;
  assert.equal(gitBlobSha1(collectorBytes), technical.collectorImplementationBlobSha);
  assert.equal(technical.market, 'CRYPTO_FUTURES');
  assert.equal(technical.symbol, 'BTCUSDT');
  assert.equal(technical.publicDataSource, 'BITGET_PUBLIC_UTA_V3');
  assert.equal(technical.observationContract, 'public-forward-liquidity-calibration-observation/v1');
  assert.equal(technical.storeContract, 'research-production-state-root/forward-liquidity-calibration-v1');
  assert.equal(
    sha256(canonicalJson(technical.captureParameterPolicy)),
    'ab4193df073303568dd8b4c55caa5d6c5a2a88547857935d1db13dacb9e8154f',
  );
  assert.equal(technical.strategyIdentity.value, null);
  assert.equal(technical.modelIdentity.value, null);
  assert.equal(technical.featureOrderIdentity.value, null);
  assert.equal(technical.preprocessingIdentity.value, null);
});

test('OOS outcome horizon remains separate pre-observation authority instead of capacity retuning', () => {
  const oos = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.oosOutcomePolicy;
  assert.equal(oos.status, 'NOT_ASSIGNED_BY_THIS_APPROVAL');
  assert.equal(oos.numericOutcomeHorizonMs, null);
  assert.equal(oos.separatePreObservationFreezeRequired, true);
  assert.equal(oos.outcomeBasedSelectionAllowed, false);
});

test('capacity or split tampering fails closed', () => {
  const tamperedCapacity = structuredClone(SUCCESSOR_PROSPECTIVE_CONTRACT);
  tamperedCapacity.policyCore.cohort.totalSlotN = 712;
  const capacityVerdict = verifySuccessorProspectiveContract(tamperedCapacity);
  assert.equal(capacityVerdict.valid, false);
  assert.ok(capacityVerdict.blockers.includes('SUCCESSOR_POLICY_DIGEST_MISMATCH'));
  assert.ok(capacityVerdict.blockers.includes('SUCCESSOR_CADENCE_INVALID'));

  const tamperedSplit = structuredClone(SUCCESSOR_PROSPECTIVE_CONTRACT);
  tamperedSplit.policyCore.splits.OOS.startIndexInclusive = 767;
  const splitVerdict = verifySuccessorProspectiveContract(tamperedSplit);
  assert.equal(splitVerdict.valid, false);
  assert.ok(splitVerdict.blockers.includes('SUCCESSOR_POLICY_DIGEST_MISMATCH'));
  assert.ok(splitVerdict.blockers.includes('SUCCESSOR_OOS_SPLIT_INVALID'));
});

test('contract grants no schedule, merge, deploy, trading, or financial mutation authority', () => {
  const approvals = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.approvalBoundaries;
  assert.ok(Object.values(approvals).every((value) => value === false));
  const safety = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.safety;
  assert.equal(safety.executionAuthority, 'NONE');
  assert.equal(safety.privateTradingApiAllowed, false);
  assert.equal(safety.liveTradingAllowed, false);
  assert.equal(safety.autoTradingAllowed, false);
  assert.equal(safety.realOrderAllowed, false);
  assert.equal(safety.financialMutationAllowed, false);
  assert.equal(safety.replitAgentAllowed, false);
  assert.equal(safety.fullCostReady, false);
  assert.equal(safety.evidenceComplete, 0);
  assert.equal(safety.profitabilityProven, false);
  assert.equal(safety.currentValidatedChampion, 'NONE');
});

test('focused validation workflow contains no schedule or dispatch activation surface', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/public-forward-liquidity-successor-prospective-cohort-contract.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /^\s*schedule:/mu);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^\s*cron:/mu);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/u);
});
