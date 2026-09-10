import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeDecisionGates,
  summarizeDecisionGateAttribution,
  type DecisionGateEvidence,
} from './decision-gate-attribution.service';

const NOW = '2026-08-22T04:58:00.000Z';

function gate(
  gateId: string,
  state: DecisionGateEvidence['state'],
  order: number,
  reasonCodes: readonly string[] = [`${gateId}_REASON`],
): DecisionGateEvidence {
  return { gateId, state, order, reasonCodes, evaluatedAt: NOW };
}

test('a single blocking gate receives resolved avoided-loss attribution with zero execution authority', () => {
  const result = attributeDecisionGates({
    observation: {
      signalId: 'sig-loss', decision: 'REJECT', resolved: true, netReturnPercent: -4, reasonCodes: ['RISK_BLOCK'],
    },
    gateDecisions: [gate('RISK', 'VETO', 10)],
    minimumMeaningfulReturnPercent: 0.1,
  });

  assert.equal(result.classification, 'BAD_TRADE_AVOIDED');
  assert.equal(result.attributionStatus, 'ATTRIBUTED_RESOLVED');
  assert.equal(result.primaryGateId, 'RISK');
  assert.equal(result.shares.length, 1);
  assert.equal(result.shares[0]?.attributionWeight, 1);
  assert.equal(result.totalAvoidedLossPercent, 4);
  assert.equal(result.totalMissedUpsidePercent, 0);
  assert.equal(result.totalNetDecisionValuePercent, 4);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.equal(result.safety.promotionAuthority, false);
  assert.equal(result.safety.liveTradingAuthority, false);
});

test('a good trade rejected by a gate is recorded as missed upside, never as avoided loss', () => {
  const result = attributeDecisionGates({
    observation: {
      signalId: 'sig-upside', decision: 'WAIT', resolved: true, netReturnPercent: 6, reasonCodes: ['ALPHA_TOO_LOW'],
    },
    gateDecisions: [gate('NET_ALPHA', 'BLOCKED', 20)],
    minimumMeaningfulReturnPercent: 0.1,
  });

  assert.equal(result.classification, 'GOOD_TRADE_MISSED');
  assert.equal(result.totalAvoidedLossPercent, 0);
  assert.equal(result.totalMissedUpsidePercent, 6);
  assert.equal(result.totalNetDecisionValuePercent, -6);
});

test('multiple blocking gates split economic credit so total impact is not double counted', () => {
  const result = attributeDecisionGates({
    observation: {
      signalId: 'sig-shared', decision: 'REJECT', resolved: true, netReturnPercent: -8, reasonCodes: ['MULTI_BLOCK'],
    },
    gateDecisions: [
      gate('PORTFOLIO', 'VETO', 30),
      gate('REGIME', 'VETO', 10),
      gate('PROFIT', 'PASS', 5),
    ],
    minimumMeaningfulReturnPercent: 0.1,
  });

  assert.deepEqual(result.blockingGateIds, ['REGIME', 'PORTFOLIO']);
  assert.equal(result.primaryGateId, 'REGIME');
  assert.equal(result.shares.length, 2);
  assert.equal(result.shares[0]?.attributionWeight, 0.5);
  assert.equal(result.shares[1]?.attributionWeight, 0.5);
  assert.equal(result.shares[0]?.avoidedLossPercent, 4);
  assert.equal(result.shares[1]?.avoidedLossPercent, 4);
  assert.equal(result.shares.reduce((sum, share) => sum + (share.avoidedLossPercent ?? 0), 0), 8);
  assert.equal(result.shares.some((share) => share.gateId === 'PROFIT'), false);
});

test('PASS gates never receive causal credit and a non-blocked TAKE remains outside blocker attribution', () => {
  const result = attributeDecisionGates({
    observation: {
      signalId: 'sig-taken', decision: 'TAKE', resolved: true, netReturnPercent: 5, reasonCodes: ['TAKE'],
    },
    gateDecisions: [gate('RISK', 'PASS', 10), gate('REGIME', 'PASS', 20)],
    minimumMeaningfulReturnPercent: 0.1,
  });

  assert.equal(result.classification, 'GOOD_TRADE_TAKEN');
  assert.equal(result.attributionStatus, 'NOT_BLOCKED');
  assert.equal(result.primaryGateId, null);
  assert.deepEqual(result.shares, []);
  assert.equal(result.totalNetDecisionValuePercent, null);
});

test('unresolved blocked outcomes keep economic impact unknown rather than fabricating zero', () => {
  const result = attributeDecisionGates({
    observation: {
      signalId: 'sig-pending', decision: 'WATCH', resolved: false, netReturnPercent: null, reasonCodes: ['WATCH'],
    },
    gateDecisions: [gate('EVENT_RISK', 'VETO', 10)],
    minimumMeaningfulReturnPercent: 0.1,
  });
  const summary = summarizeDecisionGateAttribution([result]);

  assert.equal(result.classification, 'NEUTRAL_OR_UNRESOLVED');
  assert.equal(result.attributionStatus, 'ATTRIBUTED_UNRESOLVED');
  assert.equal(result.totalAvoidedLossPercent, null);
  assert.equal(result.totalMissedUpsidePercent, null);
  assert.equal(result.totalNetDecisionValuePercent, null);
  assert.equal(result.shares[0]?.avoidedLossPercent, null);
  assert.equal(summary.resolvedBlockedSampleSize, 0);
  assert.equal(summary.unresolvedBlockedSampleSize, 1);
  assert.equal(summary.decisionQualityRatePercent, null);
  assert.equal(summary.avoidedLossPercent, null);
  assert.equal(summary.missedUpsidePercent, null);
  assert.equal(summary.netDecisionValuePercent, null);
  assert.equal(summary.gates[0]?.unresolvedMembershipCount, 1);
  assert.equal(summary.gates[0]?.decisionQualityRatePercent, null);
});

test('summary preserves weighted gate contribution and separates avoided loss from missed upside', () => {
  const avoided = attributeDecisionGates({
    observation: {
      signalId: 'sig-a', decision: 'REJECT', resolved: true, netReturnPercent: -4, reasonCodes: ['RISK'],
    },
    gateDecisions: [gate('RISK', 'VETO', 10)],
    minimumMeaningfulReturnPercent: 0.1,
  });
  const missed = attributeDecisionGates({
    observation: {
      signalId: 'sig-b', decision: 'REJECT', resolved: true, netReturnPercent: 6, reasonCodes: ['RISK'],
    },
    gateDecisions: [gate('RISK', 'VETO', 10)],
    minimumMeaningfulReturnPercent: 0.1,
  });
  const summary = summarizeDecisionGateAttribution([avoided, missed]);
  const risk = summary.gates.find((row) => row.gateId === 'RISK');

  assert.equal(summary.sampleSize, 2);
  assert.equal(summary.blockedSampleSize, 2);
  assert.equal(summary.resolvedBlockedSampleSize, 2);
  assert.equal(summary.attributedBadTradeAvoidedWeight, 1);
  assert.equal(summary.attributedGoodTradeMissedWeight, 1);
  assert.equal(summary.decisionQualityRatePercent, 50);
  assert.equal(summary.avoidedLossPercent, 4);
  assert.equal(summary.missedUpsidePercent, 6);
  assert.equal(summary.netDecisionValuePercent, -2);
  assert.equal(risk?.primaryBadTradeAvoidedCount, 1);
  assert.equal(risk?.primaryGoodTradeMissedCount, 1);
  assert.equal(risk?.decisionQualityRatePercent, 50);
  assert.equal(risk?.netDecisionValuePercent, -2);
  assert.equal(summary.safety.orderAllowed, false);
});

test('contradictory TAKE plus blocking gate fails closed', () => {
  assert.throws(() => attributeDecisionGates({
    observation: {
      signalId: 'sig-invalid', decision: 'TAKE', resolved: true, netReturnPercent: 2, reasonCodes: ['TAKE'],
    },
    gateDecisions: [gate('RISK', 'VETO', 10)],
    minimumMeaningfulReturnPercent: 0.1,
  }), /TAKE decision cannot contain a blocking gate/);
});
