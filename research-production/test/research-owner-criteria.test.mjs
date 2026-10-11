import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { researchOwnerMarketCriteria, researchOwnerExposureBounds } from '../src/research-owner-criteria.mjs';

test('owner scope permits only 1x LONG in stocks and spot, and 7x LONG/SHORT in futures', () => {
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) {
    const c = researchOwnerMarketCriteria(market, 'LONG');
    assert.equal(c.requestedLeverage, 1); assert.equal(c.maximumLeverage, 1);
    assert.throws(() => researchOwnerMarketCriteria(market, 'SHORT'), /NOT_APPROVED/);
  }
  for (const direction of ['LONG', 'SHORT']) {
    const c = researchOwnerMarketCriteria('CRYPTO_FUTURES', direction);
    assert.equal(c.requestedLeverage, 7); assert.equal(c.maximumLeverage, 7);
    assert.equal(c.entryOperator, direction === 'SHORT' ? 'CROSSUNDER' : 'CROSSOVER');
    assert.equal(c.executionAuthority, 'NONE'); assert.equal(c.orderAllowed, false);
    assert.equal(c.fastEmaPeriod, 20); assert.equal(c.slowEmaPeriod, 60); assert.equal(c.timeExitBars, 4);
  }
  assert.throws(() => researchOwnerMarketCriteria('UNKNOWN', 'LONG'));
  assert.throws(() => researchOwnerMarketCriteria('CRYPTO_FUTURES', 'BUY'));
});

test('7x never expands exposure beyond the approved 0.5% capital risk bound', () => {
  const bounds = researchOwnerExposureBounds('CRYPTO_FUTURES', 'SHORT', 1_000_000);
  assert.equal(bounds.maximumRiskKrw, 5_000);
  assert.equal(bounds.maximumNotionalKrw, 500_000);
  assert.equal(bounds.maximumMarginKrw, 500_000 / 7);
  assert.equal(bounds.isExecutableSizingReceipt, false);
  assert.equal(bounds.feesAndSlippageNotIncluded, true);
  assert.equal(researchOwnerExposureBounds('KR_STOCK', 'LONG', 1_000_000).maximumNotionalKrw, 250_000);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => researchOwnerExposureBounds('CRYPTO_FUTURES', 'LONG', value));
});

test('approval artifact matches market rules but grants no fabricated runtime evidence', () => {
  const p = JSON.parse(readFileSync(new URL('../../docs/research-center-criteria-draft.json', import.meta.url)));
  assert.equal(p.approval.channel, 'DIRECT_HUMAN_CONVERSATION');
  assert.equal(p.runtimeActivationAllowed, false); assert.equal(p.evidenceCredit, 0);
  assert.equal(p.approval.githubApprovalCommentId, null);
  for (const [market, rule] of Object.entries(p.proposedPaperRisk.marketRules)) {
    for (const direction of rule.directions) {
      const c = researchOwnerMarketCriteria(market, direction);
      assert.equal(rule.requestedLeverage, c.requestedLeverage);
      assert.equal(rule.maximumLeverage, c.maximumLeverage);
    }
  }
});
