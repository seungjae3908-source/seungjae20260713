import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATIC_PAPER_JOURNAL_MIRROR_VERSION,
  reconcileCanonicalPaperJournalMirrors,
  reconcileScopedExternalJournalHistory,
} from './automatic-paper-journal-mirror.service';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import { createPaperJournalRouter } from '../routes/paper-journal';

function canonical(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, recordType: 'unified_trade_order',
    source: 'APP_PAPER', broker: 'UPBIT', market: 'CRYPTO_SPOT',
    symbol: 'BTC', side: 'BUY', positionSide: 'LONG',
    positionEffect: 'OPEN', currency: 'KRW',
    brokerOrderId: 'external-or-paper-provider-' + id,
    clientOrderId: 'client-' + id, canonicalOrderId: id,
    canonicalLineage: { orderIds: [id] },
    filledQuantity: 1, averageFillPrice: 100,
    status: 'FILLED', filledAt:'2026-10-11T00:10:00.000Z',
    accountIdMasked: 'UPBIT-****-owner-hash',
    ...overrides,
  };
}
function mirror(id: string, overrides: Record<string, unknown> = {}) {
  const { canonicalOrderId: _key, canonicalLineage: _lineage, ...other } = canonical(id);
  return {
    ...other, brokerOrderId: id, clientOrderId: id,
    accountIdMasked: 'UPBIT-****-UNAVAILABLE',
    ...overrides,
  };
}

test('15 persisted auto Paper mirrors are suppressed by exact internal ID; unmatched canonical orders remain visible', () => {
  const projected = Array.from({ length: 17 }, (_, i) => canonical('paper-' + i));
  const stored = Array.from({ length: 15 }, (_, i) => mirror('paper-' + i));
  const result = reconcileCanonicalPaperJournalMirrors(stored, projected);
  assert.equal(result.payloads.length, 17);
  assert.equal(result.audit.contract, AUTOMATIC_PAPER_JOURNAL_MIRROR_VERSION);
  assert.equal(result.audit.persistedMirrorsSuppressed, 15);
  assert.equal(result.audit.canonicalOrdersWithoutPersistedMirror, 2);
  assert.equal(result.audit.unmatchedPersistedPaperRows, 0);
  assert.equal(result.audit.financialMutationCount, 0);
  assert.equal(result.audit.independentSettlementVerified, false);
  assert.equal(result.audit.executionAuthority, 'NONE');
  assert.equal(result.payloads[0], projected[0]);
});
test('other markets, futures LONG/SHORT and live rows retain independent source scope', () => {
  const projected = [
    canonical('kr', {broker:'TOSS',market:'KR_STOCK',symbol:'005930'}),
    canonical('us', {broker:'KIWOOM',market:'US_STOCK',symbol:'AAPL',currency:'USD'}),
    canonical('short', {broker:'BITGET',market:'CRYPTO_FUTURES',symbol:'BTCUSDT',
      currency:'USDT',side:'SELL',positionSide:'SHORT'}),
    canonical('long', {broker:'BITGET',market:'CRYPTO_FUTURES',symbol:'ETHUSDT',
      currency:'USDT',side:'BUY',positionSide:'LONG'}),
  ];
  const stored = [
    ...projected.map((p, i) => mirror(['kr','us','short','long'][i], {
      broker:p.broker,market:p.market,symbol:p.symbol,currency:p.currency,
      side:p.side,positionSide:p.positionSide,
    })),
    {recordType:'unified_trade_order',source:'APP_AUTO',brokerOrderId:'live-1'},
    mirror('historical-not-in-current-ledger'),
  ];
  const result = reconcileCanonicalPaperJournalMirrors(stored, projected);
  assert.equal(result.audit.persistedMirrorsSuppressed, 4);
  assert.equal(result.audit.unmatchedPersistedPaperRows, 1);
  assert.equal(result.payloads.length, 6);
  assert.ok(result.payloads.some(p => p.source==='APP_AUTO'));
});
test('tampered stored side/market/quantity/price never hides a canonical Paper conflict', () => {
  const projected = [canonical('fixed')];
  for (const extra of [
    {market:'CRYPTO_FUTURES'}, {side:'SELL'},
    {positionSide:'SHORT'}, {symbol:'ETH'},
    {filledQuantity:2}, {averageFillPrice:200},
    {status:'REJECTED'},
  ]) {
    assert.throws(
      () => reconcileCanonicalPaperJournalMirrors([mirror('fixed', extra)], projected),
      /PAPER_JOURNAL_MIRROR_CANONICAL_CONFLICT/,
    );
  }
});
test('canonical identity is attested by its own order lineage and never inferred from symbol/time', () => {
  assert.throws(() => reconcileCanonicalPaperJournalMirrors([], [
    canonical('one', {canonicalOrderId:'two'}),
  ]), /PAPER_JOURNAL_CANONICAL_ORDER_REFERENCE_REQUIRED/);
  assert.throws(() => reconcileCanonicalPaperJournalMirrors([], [
    canonical('one'),canonical('one'),
  ]), /PAPER_JOURNAL_CANONICAL_ORDER_COLLISION/);
  const x = reconcileCanonicalPaperJournalMirrors([
    mirror('not-same-order'),
  ], [canonical('same-symbol-and-time')]);
  assert.equal(x.audit.persistedMirrorsSuppressed,0);
  assert.equal(x.audit.unmatchedPersistedPaperRows,1);
  assert.equal(x.payloads.length,2);
});
test('partial fill mirror does not manufacture a second fill when canonical order closes', () => {
  const row = mirror('partial', {status:'PARTIALLY_FILLED',filledQuantity:0.5,averageFillPrice:101});
  const actual = reconcileCanonicalPaperJournalMirrors([row],[canonical('partial')]);
  assert.equal(actual.payloads.length,1);
  assert.equal(actual.audit.persistedMirrorsSuppressed,1);
});

test('external history is deduped only with exact real broker, account, market, ID and economic evidence', () => {
  const cached=canonical('live',{source:'APP_AUTO',broker:'UPBIT',accountIdMasked:'UPBIT-****-ABC'});
  const provider={...cached,source:'UPBIT_API'};
  const result=reconcileScopedExternalJournalHistory([cached],[provider]);
  assert.equal(result.payloads.length,0);
  assert.equal(result.audit.suppressedVerifiedDuplicateCount,1);
  assert.equal(result.audit.financialMutationCount,0);
  assert.equal(result.audit.executionAuthority,'NONE');
});

test('broker collisions, account boundaries and simulated orders never erase provider history', () => {
  const row=canonical('same',{source:'APP_AUTO',broker:'UPBIT',accountIdMasked:'UPBIT-****-ABC'});
  const foreign=[
    {...row,source:'KIWOOM_API',broker:'KIWOOM'},
    {...row,source:'UPBIT_API',market:'US_STOCK'},
    {...row,source:'UPBIT_API',accountIdMasked:'UPBIT-****-DIFFERENT'},
    {...row,source:'UPBIT_API',accountIdMasked:'UPBIT-****-UNAVAILABLE'},
  ];
  const a=reconcileScopedExternalJournalHistory([row],foreign);
  assert.equal(a.payloads.length,4);
  const paper=canonical('same',{source:'APP_PAPER',broker:'UPBIT',accountIdMasked:'UPBIT-****-ABC'});
  const b=reconcileScopedExternalJournalHistory([paper],[{...row,source:'UPBIT_API'}]);
  assert.equal(b.payloads.length,1);
});

test('external final fill or new cost evidence cannot be hidden by older cached trade', () => {
  const row=canonical('refresh',{source:'APP_AUTO',accountIdMasked:'UPBIT-****-ABC',
    status:'PARTIALLY_FILLED',filledQuantity:0.5,fees:null,tax:null});
  const provider={...row,source:'UPBIT_API',status:'FILLED',filledQuantity:1,fees:0.1,tax:0};
  const next=reconcileScopedExternalJournalHistory([row],[provider]);
  assert.equal(next.payloads.length,1);
  assert.equal(next.audit.suppressedVerifiedDuplicateCount,0);
  const sameState={...row,source:'UPBIT_API',fees:0.1,tax:0};
  assert.equal(reconcileScopedExternalJournalHistory([row],[sameState]).payloads.length,1);
});

test('conflicting symbol or trade side within exact provider account and order scope blocks display', () => {
  const row=canonical('conflict',{source:'APP_AUTO',accountIdMasked:'UPBIT-****-ABC'});
  for(const changed of [{symbol:'ETH'},{side:'SELL'},{currency:'USD'}]) {
    assert.throws(()=>reconcileScopedExternalJournalHistory(
      [row],[{...row,...changed,source:'UPBIT_API'}]),
      /JOURNAL_EXTERNAL_SCOPE_IDENTITY_CONFLICT/,
    );
  }
});

test('invalid provider fee or tax amounts cannot disappear through external dedup', () => {
  const known=canonical('cost',{source:'APP_AUTO',accountIdMasked:'UPBIT-****-ABC',
    fees:0.1,tax:0});
  for(const invalid of [
    {fees:-1},{tax:-1},{fees:'UNKNOWN'},{tax:'UNKNOWN'},
    {fees:NaN},{tax:Infinity},
  ]) {
    const provider={...known,source:'UPBIT_API',...invalid};
    const result=reconcileScopedExternalJournalHistory([known],[provider]);
    assert.equal(result.payloads.length,1);
    assert.equal(result.audit.suppressedVerifiedDuplicateCount,0);
  }
});

test('different canonical/vault hash casing dedups only for the verified same owner', () => {
  const owner='11111111-1111-1111-1111-111111111111';
  const hash=(value: string) =>
    createHash('sha256').update(value).digest('hex').slice(0,10);
  const appMask='UPBIT-****-'+hash('UPBIT:'+owner);
  const vaultMask='UPBIT-****-'+hash('upbit:'+owner);
  assert.notEqual(appMask,vaultMask);
  const uuid='e5ef8405-63c8-4489-9bc5-46c1a5b82f74';
  const app=canonical(uuid,{
    source:'APP_AUTO',accountIdMasked:appMask,brokerOrderId:uuid,
  });
  const external={...app,source:'UPBIT_API',accountIdMasked:vaultMask};
  assert.equal(reconcileScopedExternalJournalHistory([app],[external]).payloads.length,1);
  const valid=reconcileScopedExternalJournalHistory([app],[external],owner);
  assert.equal(valid.payloads.length,0);
  assert.equal(valid.audit.suppressedVerifiedDuplicateCount,1);
  assert.equal(reconcileScopedExternalJournalHistory(
    [app],[external],'22222222-2222-2222-2222-222222222222',
  ).payloads.length,1);
  assert.equal(reconcileScopedExternalJournalHistory(
    [app],[{...external,accountIdMasked:'UPBIT-****-FORGED'}],owner,
  ).payloads.length,1);
  assert.equal(reconcileScopedExternalJournalHistory(
    [canonical('not-a-uuid',{source:'APP_AUTO',accountIdMasked:appMask})],
    [{...external,brokerOrderId:'not-a-uuid'}],owner,
  ).payloads.length,1);

});

test('source-bound vault account aliases cannot cross brokers, dates or Toss accounts', () => {
  const owner='11111111-1111-1111-1111-111111111111';
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,10);
  const app=canonical('reuse',{
    source:'APP_AUTO',accountIdMasked:'KIWOOM-****-'+hash('KIWOOM:'+owner),
    broker:'KIWOOM',market:'US_STOCK',symbol:'AAPL',currency:'USD',
  });
  const external={...app,source:'KIWOOM_API',
    accountIdMasked:'KIWOOM-****-'+hash('kiwoom:'+owner)};
  assert.equal(reconcileScopedExternalJournalHistory([app],[external],owner).payloads.length,1);
  // A user-level Kiwoom vault is not evidence of the *actual* stock account.
  // Never suppress a stock fill on a potentially reused broker order number.
  assert.equal(reconcileScopedExternalJournalHistory(
    [app],[{...external,filledAt:'2026-10-09T00:10:00.000Z'}],owner,
  ).payloads.length,1);
  const toss=canonical('reuse',{source:'APP_AUTO',broker:'TOSS',market:'KR_STOCK',
    accountIdMasked:'TOSS-****-APP',symbol:'005930'});
  assert.equal(reconcileScopedExternalJournalHistory(
    [toss],[{...toss,source:'TOSS_API',accountIdMasked:'TOSS-****-REAL'}],owner,
  ).payloads.length,1);
});

// --- Regression: live app orders vs exchange history, and >5000 rows ---
const OWNER='11111111-1111-1111-1111-111111111111';
const ownerHash=(value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0,10);
const APP_MASK='UPBIT-****-'+ownerHash('UPBIT:'+OWNER);
const VAULT_MASK='UPBIT-****-'+ownerHash('upbit:'+OWNER);
const UUID_A='0b9c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const EXECUTION={ quantity:1, remainingQuantity:0,
  orderedAt:'2026-10-11T00:09:00.000Z', observedAt:'2026-10-11T00:11:00.000Z' };
function liveApp(source: string, overrides: Record<string, unknown> = {}) {
  // Adapter shape: brokerOrderId is the exchange UUID, lineage holds the
  // internal canonical order id.
  return canonical('internal-'+source, {
    source, canonicalOrderId:null, canonicalLineage:{orderIds:['internal-'+source]},
    accountIdMasked:APP_MASK, brokerOrderId:UUID_A, fees:0.05, tax:0,
    ...EXECUTION, ...overrides,
  });
}
function upbitHistory(overrides: Record<string, unknown> = {}) {
  const { canonicalOrderId:_c, canonicalLineage:_l, ...base } = canonical(UUID_A);
  return { ...base, source:'UPBIT_API', accountIdMasked:VAULT_MASK,
    brokerOrderId:UUID_A, fees:0.05, tax:0, ...EXECUTION, ...overrides };
}
function tradeCount(
  known: readonly Record<string, unknown>[], external: readonly Record<string, unknown>[],
) {
  const result=reconcileScopedExternalJournalHistory(known,external,OWNER);
  // Before the fix knownPayloads did not exist: every known row was kept.
  return (result.knownPayloads ?? known).length+result.payloads.length;
}

test('APP_MANUAL live order and the same Upbit history fill count once', () => {
  const app=liveApp('APP_MANUAL');
  const result=reconcileScopedExternalJournalHistory([app],[upbitHistory()],OWNER);
  assert.equal(result.payloads.length,0);
  assert.equal(result.audit.suppressedVerifiedDuplicateCount,1);
  const journal=buildUnifiedTradeJournal(
    [app,...result.payloads],{},new Date('2026-10-12T00:00:00.000Z'));
  assert.equal(journal.trades.length,1);
  assert.equal(journal.trades[0]!.totalQuantity,1);
});

test('app snapshot without fee receipt is superseded by the provider row of the same exchange order', () => {
  for (const source of ['APP_AUTO','APP_MANUAL']) {
    const app=liveApp(source,{fees:null,tax:null});
    const provider=upbitHistory({fees:0.05,tax:0});
    const result=reconcileScopedExternalJournalHistory([app],[provider],OWNER);
    assert.deepEqual(result.payloads,[provider]);
    assert.deepEqual(result.knownPayloads,[]);
    assert.equal(result.audit.supersededKnownSnapshotCount,1);
    assert.equal(tradeCount([app],[provider]),1);
  }
});

test('stale partial snapshot of one exchange order yields to the larger cumulative fill', () => {
  const partialApp=liveApp('APP_AUTO',{status:'PARTIALLY_FILLED',filledQuantity:0.4,
    averageFillPrice:99,fees:null});
  const filledProvider=upbitHistory({status:'FILLED',filledQuantity:1});
  let result=reconcileScopedExternalJournalHistory([partialApp],[filledProvider],OWNER);
  assert.deepEqual(result.knownPayloads,[]);
  assert.deepEqual(result.payloads,[filledProvider]);
  // Provider history read earlier (partial) than the app ledger (filled).
  const filledApp=liveApp('APP_AUTO');
  const partialProvider=upbitHistory({status:'PARTIALLY_FILLED',filledQuantity:0.4,
    averageFillPrice:99,fees:0.01});
  result=reconcileScopedExternalJournalHistory([filledApp],[partialProvider],OWNER);
  assert.deepEqual(result.knownPayloads,[filledApp]);
  assert.equal(result.payloads.length,0);
  assert.equal(result.audit.suppressedVerifiedDuplicateCount,1);
  // A fill completing on a later KST date of the same UUID order still binds.
  assert.equal(tradeCount([partialApp],
    [upbitHistory({filledAt:'2026-10-12T16:00:00.000Z'})]),1);
});

test('exchange-order binding never merges distinct or contradictory trades', () => {
  const app=liveApp('APP_AUTO',{fees:null});
  const keepsBoth: ReadonlyArray<readonly [Record<string, unknown>, Record<string, unknown>]>=[
    // Different exchange order UUID.
    [app, upbitHistory({brokerOrderId:'1b9c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'})],
    // Two FILLED snapshots disagreeing on quantity: not a stale partial.
    [app, upbitHistory({filledQuantity:2})],
    [liveApp('APP_AUTO',{fees:null,filledQuantity:2}), upbitHistory()],
    // Equal quantity but a different average price.
    [app, upbitHistory({averageFillPrice:120})],
    // Different position effect.
    [app, upbitHistory({positionEffect:'CLOSE'})],
    // Invalid provider cost evidence is preserved for integrity rejection.
    [app, upbitHistory({fees:-1})],
    // App row carries only its internal order id (no exchange id).
    [liveApp('APP_AUTO',{fees:null,canonicalLineage:{orderIds:[UUID_A]}}), upbitHistory()],
    // Unverified account bridge.
    [app, upbitHistory({accountIdMasked:'UPBIT-****-FORGED'})],
    // Simulated orders never bind to real fills.
    [liveApp('APP_PAPER',{fees:null}), upbitHistory()],
  ];
  for (const [known, external] of keepsBoth) {
    assert.equal(tradeCount([known],[external]),2, JSON.stringify(external));
  }
  // Wrong owner cannot verify the bridge.
  const other=reconcileScopedExternalJournalHistory([app],[upbitHistory()],
    '22222222-2222-2222-2222-222222222222');
  assert.equal((other.knownPayloads ?? [app]).length+other.payloads.length,2);
});

test('journals above 5000 rows reconcile completely instead of throwing', () => {
  const projected=Array.from({length:6001},(_,i)=>canonical('big-'+i));
  const stored=Array.from({length:6000},(_,i)=>mirror('big-'+i));
  const mirrors=reconcileCanonicalPaperJournalMirrors(stored,projected);
  assert.equal(mirrors.payloads.length,6001);
  assert.equal(mirrors.audit.persistedMirrorsSuppressed,6000);
  const external=Array.from({length:6000},(_,i)=>({...canonical('ext-'+i),
    source:'UPBIT_API',accountIdMasked:'UPBIT-****-ABC'}));
  const scoped=reconcileScopedExternalJournalHistory(mirrors.payloads,external,OWNER);
  assert.equal(scoped.knownPayloads.length,6001);
  assert.equal(scoped.payloads.length,6000);
});

test('unified ledger route answers 200 for a user with more than 5000 stored rows', async () => {
  const stored=Array.from({length:5200},(_,i)=>{
    const { canonicalOrderId:_c, canonicalLineage:_l, ...row }=canonical('route-'+i);
    return { ...row, ...EXECUTION, source:'APP_MANUAL', accountIdMasked:APP_MASK,
      brokerOrderId:'route-order-'+i, symbol:'SYM'+i,
      filledAt:new Date(Date.parse('2026-10-11T00:00:00.000Z')+i*1000).toISOString() };
  });
  const manual=liveApp('APP_MANUAL',{fees:null});
  const repository={ async listJournalPayloads() { return stored; } };
  const app=express();
  app.use('/api',(req: any,_res: unknown,next: () => void)=>{ req.member={id:OWNER}; next(); });
  app.use('/api',createPaperJournalRouter({
    repositoryFactory:()=>repository as never,
    now:()=>new Date('2026-10-12T00:00:00.000Z'),
    reviewProvider:null,
    accountHistoryReader:(async ()=>({
      payloads:[upbitHistory()], realizedEvidence:[], requestedRange:'ALL',
      effectiveDays:30, rangeCapped:false, persisted:false,
      privateProviderRequests:0, providers:[], truncated:false, safety:{},
    })) as never,
    automationJournalReader:async ()=>[manual],
  }));
  const previousSha=process.env.DEPLOY_SHA;
  delete process.env.DEPLOY_SHA;
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>((resolve)=>server.once('listening',()=>resolve()));
  try {
    const { port }=server.address() as AddressInfo;
    const response=await fetch(`http://127.0.0.1:${port}/api/paper-journal/unified-ledger?range=ALL`);
    assert.equal(response.status,200);
    const body=await response.json() as any;
    assert.equal(body.ok,true);
    // 5200 stored rows + one live order whose exchange copy counts once.
    const quantity=body.result.trades.reduce(
      (sum: number, trade: any)=>sum+trade.totalQuantity,0);
    assert.equal(quantity,5201);
    assert.equal(body.result.externalHistoryDedupAudit.supersededKnownSnapshotCount,1);
  } finally {
    await new Promise<void>((resolve)=>server.close(()=>resolve()));
    if (previousSha===undefined) delete process.env.DEPLOY_SHA;
    else process.env.DEPLOY_SHA=previousSha;
  }
});
