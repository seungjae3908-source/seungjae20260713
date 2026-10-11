import test from 'node:test';
import assert from 'node:assert/strict';
import { explainManualPaperTrade } from './paper-trade-review';
import type { PaperJournalEntry } from './paper-trading';

const fixture = (update: Partial<PaperJournalEntry> = {}) => ({
  status:'closed',exitReason:'take_profit',
  grossPnl:40,netPnl:35,entryFee:1,exitFee:1,slippageCost:2,fundingCost:1,
  ...update,
} as PaperJournalEntry);
test('manual Paper win explains recorded price gain and actual charges without invented signal cause', () => {
  const review=explainManualPaperTrade(fixture());
  assert.equal(review.outcome,'PROFIT');
  assert.equal(review.priceContribution,40);
  assert.equal(review.recordedCosts,5);
  assert.equal(review.netPnl,35);
  assert.match(review.exitExplanation,/익절/);
  assert.ok(review.unknownFactors.some(x=>x.includes('CVD')));
});
test('positive gross can be a net loss after actual simulated expenses', () => {
  const review=explainManualPaperTrade(fixture({
    exitReason:'manual_close',grossPnl:4,netPnl:-6,
    entryFee:1,exitFee:2,slippageCost:6,fundingCost:1,
  }));
  assert.equal(review.outcome,'LOSS');
  assert.ok(review.observedReasons.some(x=>x.includes('비용')));
});
test('liquidation and losing-price stop are labeled as execution reasons not imagined market causes', () => {
  const review=explainManualPaperTrade(fixture({
    exitReason:'liquidation',grossPnl:-50,netPnl:-55,
  }));
  assert.equal(review.outcome,'LOSS');
  assert.match(review.exitExplanation,/강제청산/);
  assert.ok(review.unknownFactors.some(x=>x.includes('호가 불균형')));
});
test('unsettled or malformed economic data cannot be described as a verified win', () => {
  assert.equal(explainManualPaperTrade(fixture({status:'partially_closed'})).outcome,'OPEN');
  assert.equal(explainManualPaperTrade(fixture({entryFee:Number.NaN})).outcome,'UNVERIFIED');
});
test('a material net/gross discrepancy is disclosed rather than invented away', () => {
  const review=explainManualPaperTrade(fixture({grossPnl:40,netPnl:50}));
  assert.ok(review.observedReasons.some(x=>x.includes('일치하지 않아')));
});
