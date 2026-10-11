import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPaperResearchRound, summarizePaperResearchRounds,
  type PaperRoundSnapshot } from './paper-research-round-lifecycle.service';

const T = Date.parse('2026-10-11T05:00:00Z');
const EVIDENCE = 'a'.repeat(64);
const fixture = (changes: Partial<PaperRoundSnapshot> = {}): PaperRoundSnapshot => ({
  ownerId:'11111111-1111-1111-1111-111111111111',
  market:'crypto_futures',mode:'automatic',roundNumber:1,
  currentEpochId:'wallet-v2:crypto_futures:1',previousRoundReceiptSha256:null,
  settlementDigestSha256:EVIDENCE,ledgerReadbackReady:true,
  costsAndFxVerified:true,positionCount:0,pendingOrderCount:0,unreconciledFillCount:0,
  operatingCapitalKrw:1_000_000,reserveKrw:0,availableToTradeKrw:1_000_000,
  verifiedMinimumEntryKrw:10_000,minimumEntryObservedAtMs:T,nowMs:T+5000,
  alreadyCreatedNextRound:false,
  ...changes,
});
test('a funded Paper market stays in same round after any number of losses', () => {
  const state=assessPaperResearchRound(fixture({operatingCapitalKrw:300_000,availableToTradeKrw:290_000}));
  assert.equal(state.status,'ACTIVE');
  assert.equal(state.nextSeedKrw,null);
  assert.equal(state.financialMutationAllowed,false);
});
test('a fully consumed 4-market Paper round proposes a new unique automatic round without touching reserve', () => {
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const) {
    const expired=assessPaperResearchRound(fixture({
      market,operatingCapitalKrw:0,availableToTradeKrw:0,reserveKrw:60_000,
      verifiedMinimumEntryKrw:null,minimumEntryObservedAtMs:null,
    }));
    assert.equal(expired.status,'EXHAUSTED');
    assert.equal(expired.eligibleForNewRound,true);
    assert.equal(expired.endingCause,'ZERO_EQUITY');
    assert.equal(expired.nextAction,'AUTO_RESEARCH_ROUND_PROPOSAL');
    assert.equal(expired.nextSeedKrw,1_000_000);
    assert.equal(expired.mayUsePriorReserve,false);
    assert.equal(expired.financialMutationAllowed,false);
    assert.match(expired.proposedRoundId!,/^paper-round-v1:[0-9a-f]{64}$/);
    assert.deepEqual(expired,assessPaperResearchRound(fixture({
      market,operatingCapitalKrw:0,availableToTradeKrw:0,reserveKrw:60_000,
      verifiedMinimumEntryKrw:null,minimumEntryObservedAtMs:null,
    })), 'same snapshot must never mint a different round identity');
  }
});
test('manual bankruptcy only recommends a button, never auto-creates capital', () => {
  const expired=assessPaperResearchRound(fixture({
    mode:'manual',operatingCapitalKrw:50,availableToTradeKrw:50,
    verifiedMinimumEntryKrw:10_000,
  }));
  assert.equal(expired.status,'EXHAUSTED');
  assert.equal(expired.endingCause,'BELOW_VERIFIED_MINIMUM');
  assert.equal(expired.nextAction,'MANUAL_OWNER_CONFIRMATION');
  assert.equal(expired.financialMutationAllowed,false);
});
test('unknown settlement, missing minimum and existing exposure all fail-closed', () => {
  for(const changes of [
    {ledgerReadbackReady:false},
    {costsAndFxVerified:false},
    {settlementDigestSha256:'forged'},
    {operatingCapitalKrw:-1},
    {reserveKrw:-1},
    {availableToTradeKrw:1_500_000},
    {alreadyCreatedNextRound:true},
  ]) {
    assert.equal(assessPaperResearchRound(fixture({
      ...changes, operatingCapitalKrw:changes.operatingCapitalKrw??0,
      availableToTradeKrw:changes.availableToTradeKrw??0,
    })).eligibleForNewRound,false,JSON.stringify(changes));
  }
  for(const changes of [{positionCount:1},{pendingOrderCount:1},{unreconciledFillCount:1}]) {
    assert.equal(assessPaperResearchRound(fixture({
      ...changes,operatingCapitalKrw:0,availableToTradeKrw:0,
    })).status,'OPEN_EXPOSURE');
  }
  assert.equal(assessPaperResearchRound(fixture({
    operatingCapitalKrw:100,availableToTradeKrw:100,
    verifiedMinimumEntryKrw:null,minimumEntryObservedAtMs:null,
  })).status,'BLOCKED_EVIDENCE');
  assert.equal(assessPaperResearchRound(fixture({
    operatingCapitalKrw:100,availableToTradeKrw:100,
    minimumEntryObservedAtMs:T-90_000,
  })).status,'BLOCKED_EVIDENCE');
});
test('nonzero equity cannot be falsely declared bankrupt because available margin is locked', () => {
  const full=assessPaperResearchRound(fixture({
    operatingCapitalKrw:100_000,availableToTradeKrw:0,
  }));
  assert.equal(full.status,'BLOCKED_EVIDENCE');
  assert.ok(full.blockers.includes('PAPER_ROUND_POSITIVE_EQUITY_WITH_NO_AVAILABLE_CASH'));
  const partial=assessPaperResearchRound(fixture({
    operatingCapitalKrw:100_000,availableToTradeKrw:1_000,
    verifiedMinimumEntryKrw:10_000,
  }));
  assert.equal(partial.status,'BLOCKED_EVIDENCE');
  assert.ok(partial.blockers.includes('PAPER_ROUND_LOCKED_CAPITAL_NOT_BANKRUPTCY'));
});

test('idempotent new-round proposals cannot double-inject or merge different markets', () => {
  const prior=assessPaperResearchRound(fixture({operatingCapitalKrw:0,availableToTradeKrw:0}));
  const next=assessPaperResearchRound(fixture({
    operatingCapitalKrw:0,availableToTradeKrw:0,market:'us_stock',
  }));
  assert.notEqual(prior.proposedRoundId,next.proposedRoundId);
  const duplicate=assessPaperResearchRound(fixture({
    operatingCapitalKrw:0,availableToTradeKrw:0,alreadyCreatedNextRound:true,
  }));
  assert.equal(duplicate.eligibleForNewRound,false);
});
test('multi-round loss and bankruptcy history remains visible instead of reporting only winning round', () => {
  const summary=summarizePaperResearchRounds([
    {market:'crypto_spot',mode:'automatic',initialKrw:1_000_000,realizedNetPnlKrw:-1_000_000,
      exhausted:true,bankrupt:true,finalOperatingCapitalKrw:0},
    {market:'crypto_spot',mode:'automatic',initialKrw:1_000_000,realizedNetPnlKrw:200_000,
      exhausted:false,bankrupt:false,finalOperatingCapitalKrw:1_100_000},
    {market:'us_stock',mode:'automatic',initialKrw:1_000_000,realizedNetPnlKrw:700_000,
      exhausted:false,bankrupt:false,finalOperatingCapitalKrw:1_350_000},
  ],'crypto_spot','automatic');
  assert.equal(summary.totalSeedKrw,2_000_000);
  assert.equal(summary.totalNetPnlKrw,-800_000);
  assert.equal(summary.bankruptcies,1);
  assert.equal(summary.netReturnOnAllIssuedSeedPercent,-40);
  assert.equal(summary.reserveTransfers,0);
});

test('round with small verified residual is not misreported as bankrupt',()=>{
  const partial=summarizePaperResearchRounds([{
    market:'crypto_spot',mode:'manual',initialKrw:1_000_000,
    realizedNetPnlKrw:-999_000,exhausted:true,
    bankrupt:false,finalOperatingCapitalKrw:1_000,
  }],'crypto_spot','manual');
  assert.equal(partial.bankruptcies,0);
  assert.equal(partial.exhaustedRounds,1);
  assert.equal(partial.retainedFinalCapitalKrw,1000);
  assert.equal(partial.totalNetPnlKrw,-999000);
  assert.throws(()=>summarizePaperResearchRounds([{
    market:'crypto_spot',mode:'manual',initialKrw:1_000_000,
    realizedNetPnlKrw:-999_000,exhausted:true,
    bankrupt:true,finalOperatingCapitalKrw:1_000,
  }],'crypto_spot','manual'),/INVALID/);
});
