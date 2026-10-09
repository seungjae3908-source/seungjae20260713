import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceBackedAutoStrategyCatalog,
  RULE_PACK_PILOT_PROFILE,
} from './evidence-backed-auto-strategy-catalog.service';
import {
  evaluateFormulaAiAutoRehearsal,
  runFormulaAiPaperRehearsalProbe,
} from './formula-ai-auto-rehearsal.service';

const ready = {
  deterministicRuleReady: true,
  aiDecision: 'PASS' as const,
  providersReady: true,
  credentialReuseReady: true,
  paperAutoReady: true,
  paperFillReady: true,
  journalReady: true,
  telegramReady: true,
};

test('six formula+AI strategy packs reach ACTIVE_REHEARSAL without OOS/promotion authority', () => {
  const cases = [
    ['TREND_PULLBACK_REACCEL_V1', 'KR_STOCK', 'BUY'],
    ['US_EVENT_RVOL_FIRST_PULLBACK_V1', 'US_STOCK', 'BUY'],
    ['US_STOCKS_IN_PLAY_ORB_RETEST_V1', 'US_STOCK', 'BUY'],
    ['KR_PRESSURE_BREAKOUT_V1', 'KR_STOCK', 'BUY'],
    ['CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', 'CRYPTO_SPOT', 'BUY'],
    ['CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', 'CRYPTO_FUTURES', 'LONG'],
  ] as const;

  assert.equal(evidenceBackedAutoStrategyCatalog().length, 6);
  assert.equal(RULE_PACK_PILOT_PROFILE.initialOperatingCapitalKrw, 1_000_000);
  assert.equal(RULE_PACK_PILOT_PROFILE.profitCompoundShare, 0.5);
  assert.equal(RULE_PACK_PILOT_PROFILE.profitReserveShare, 0.5);
  assert.equal(RULE_PACK_PILOT_PROFILE.futuresMaxLeverage, 7);

  for (const [strategyId, market, direction] of cases) {
    const result = evaluateFormulaAiAutoRehearsal({
      strategyId,
      market,
      direction,
      ...ready,
      ...(market === 'CRYPTO_FUTURES'
        ? { futuresMarginMode: 'isolated' as const, futuresLeverage: 7 }
        : {}),
    });
    assert.equal(result.status, 'ACTIVE_REHEARSAL', strategyId);
    assert.equal(result.exceptionPolicyApplied, true, strategyId);
    assert.equal(result.oosRequiredForRehearsal, false, strategyId);
    assert.equal(result.profitabilityPromotionRequiredForRehearsal, false, strategyId);
    assert.equal(result.wouldActivateLiveAuto, true, strategyId);
    assert.equal(result.executionAuthority, 'NONE', strategyId);
    assert.equal(result.realOrderSubmitted, false, strategyId);
    assert.equal(result.productionMutationAllowed, false, strategyId);
    assert.deepEqual(result.blockers, [], strategyId);
  }
});

test('formula+AI rehearsal allows futures SHORT only with isolated margin and leverage at or below 7', () => {
  const pass = evaluateFormulaAiAutoRehearsal({
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    market: 'CRYPTO_FUTURES',
    direction: 'SHORT',
    ...ready,
    futuresMarginMode: 'isolated',
    futuresLeverage: 7,
  });
  assert.equal(pass.status, 'ACTIVE_REHEARSAL');

  const crossed = evaluateFormulaAiAutoRehearsal({
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    market: 'CRYPTO_FUTURES',
    direction: 'LONG',
    ...ready,
    futuresMarginMode: 'crossed',
    futuresLeverage: 7,
  });
  assert.equal(crossed.status, 'BLOCKED_REHEARSAL');
  assert.ok(crossed.blockers.includes('FORMULA_AI_FUTURES_ISOLATED_REQUIRED'));

  const over = evaluateFormulaAiAutoRehearsal({
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    market: 'CRYPTO_FUTURES',
    direction: 'LONG',
    ...ready,
    futuresMarginMode: 'isolated',
    futuresLeverage: 8,
  });
  assert.equal(over.status, 'BLOCKED_REHEARSAL');
  assert.ok(over.blockers.includes('FORMULA_AI_FUTURES_LEVERAGE_LIMIT'));
});

test('AI veto, cash-market short, missing provider chain, and unknown strategy fail closed', () => {
  const veto = evaluateFormulaAiAutoRehearsal({
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    market: 'KR_STOCK',
    direction: 'BUY',
    ...ready,
    aiDecision: 'VETO',
  });
  assert.equal(veto.status, 'BLOCKED_REHEARSAL');
  assert.ok(veto.blockers.includes('FORMULA_AI_AI_PASS_REQUIRED'));

  const cashShort = evaluateFormulaAiAutoRehearsal({
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    market: 'CRYPTO_SPOT',
    direction: 'SHORT',
    ...ready,
  });
  assert.equal(cashShort.status, 'BLOCKED_REHEARSAL');
  assert.ok(cashShort.blockers.includes('FORMULA_AI_DIRECTION_FORBIDDEN'));

  const providerBlocked = evaluateFormulaAiAutoRehearsal({
    strategyId: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
    market: 'US_STOCK',
    direction: 'BUY',
    ...ready,
    credentialReuseReady: false,
  });
  assert.equal(providerBlocked.status, 'BLOCKED_REHEARSAL');
  assert.ok(providerBlocked.blockers.includes('FORMULA_AI_CREDENTIAL_REUSE_NOT_READY'));

  const unknown = evaluateFormulaAiAutoRehearsal({
    strategyId: 'UNAPPROVED_STRATEGY',
    market: 'KR_STOCK',
    direction: 'BUY',
    ...ready,
  });
  assert.equal(unknown.status, 'BLOCKED_REHEARSAL');
  assert.ok(unknown.blockers.includes('FORMULA_AI_STRATEGY_NOT_ALLOWLISTED'));
});


test('rehearsal executes the real Paper engine through fill and journal projection with zero live authority', () => {
  const probe = runFormulaAiPaperRehearsalProbe(new Date('2026-10-07T01:00:00.000Z'));
  assert.equal(probe.paperAutoReady, true);
  assert.equal(probe.paperFillReady, true);
  assert.equal(probe.journalReady, true);
  assert.equal(probe.riskReady, true);
  assert.equal(probe.orderState, 'filled');
  assert.ok(probe.fillCount >= 1);
  assert.ok(probe.journalEntryCount >= 1);
  assert.equal(probe.executionAuthority, 'NONE');
  assert.equal(probe.realOrderSubmitted, false);
  assert.equal(probe.exchangeRequestSent, false);
  assert.equal(probe.providerMutationRequests, 0);
  assert.equal(probe.productionMutationAllowed, false);
});
