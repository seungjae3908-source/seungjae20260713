import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import {
  ADMIN_FOUR_PAPER_MARKETS, buildAdminFourMarketPaperBootstrap,
  buildMemberFourMarketPaperBootstrap,
} from './admin-four-market-paper-capital.service';
import {
  MANUAL_FOUR_MARKET_INITIAL_KRW, MANUAL_FOUR_MARKET_TOTAL_KRW,
  buildManualFourMarketWalletSeeds, inspectManualFourMarketWallets,
  manualPaperWalletId, manualWalletCreationReadiness,isManualPaperWalletId,
  isReservedManualPaperWalletNamespace,
} from './manual-four-market-paper-wallets.service';
const NOW=new Date('2026-10-11T03:00:00Z');
function snapshot(role:'admin'|'member',offset=0):StoredPaperJournalRecord[] {
  const timestamp=new Date(NOW.getTime()+offset).toISOString();
  return buildManualFourMarketWalletSeeds(role,new Date(timestamp)).map(r=>({
    ...r,createdAt:timestamp,serverUpdatedAt:timestamp,
  }));
}
test('all four independent manual 1m markets are distinct from automatic Paper and each other',()=>{
  for (const role of ['admin','member'] as const) {
    const manual=buildManualFourMarketWalletSeeds(role,NOW);
    const automatic=role==='admin'
      ?buildAdminFourMarketPaperBootstrap(NOW):buildMemberFourMarketPaperBootstrap(NOW);
    assert.equal(manual.length,4);
    assert.equal(manual.reduce((s,r)=>s+Number(r.payload.initialBalance),0),4_000_000);
    assert.equal(MANUAL_FOUR_MARKET_TOTAL_KRW,4*MANUAL_FOUR_MARKET_INITIAL_KRW);
    assert.deepEqual(manual.map(r=>r.id),ADMIN_FOUR_PAPER_MARKETS.map(m=>manualPaperWalletId(role,m)));
    assert.ok(manual.every(r=>r.payload.mode==='manual'&&r.payload.reserveWithdrawalAutomatic===false
      &&r.payload.compoundShare===0.5&&r.payload.reserveShare===0.5&&isManualPaperWalletId(r.id)));
    for(const id of automatic.map(r=>r.id))assert.ok(!manual.some(r=>r.id===id));
    const read=inspectManualFourMarketWallets(role,snapshot(role),NOW.getTime());
    assert.equal(read.ready,true);
    assert.equal(read.manualExecutionReady,false);
    assert.equal(read.executionAuthority,'NONE');
    assert.equal(read.financialMutationAllowed,false);
    assert.equal(read.privateProviderRequests,0);
    assert.equal(manualWalletCreationReadiness(role,[],NOW.getTime()).canCreate,true);
    assert.equal(manualWalletCreationReadiness(role,snapshot(role),NOW.getTime()).canCreate,false);
  }
});
test('invalid, duplicate, missing, role-mismatched, stale and tampered wallet seeds never become tradable',()=>{
  const valid=snapshot('member');
  const corruptions:StoredPaperJournalRecord[][]=[
    valid.slice(1),
    [...valid,valid[0]],
    valid.map((r,i)=>i?r:{...r,deletedAt:NOW.toISOString()}),
    valid.map((r,i)=>i?r:{...r,payload:{...r.payload,initialBalance:500_000}}),
    valid.map((r,i)=>i?r:{...r,payload:{...r.payload,mode:'automatic'}}),
    valid.map((r,i)=>i?r:{...r,payload:{...r.payload,reserveKrw:100_000}}),
    valid.map((r,i)=>i?r:{...r,createdAt:new Date(NOW.getTime()+90_000).toISOString()}),
    [...valid,...snapshot('admin')],
  ];
  for(const rows of corruptions){
    const checked=inspectManualFourMarketWallets('member',rows,NOW.getTime());
    assert.equal(checked.ready,false);
    assert.equal(checked.manualExecutionReady,false);
    assert.equal(manualWalletCreationReadiness('member',rows,NOW.getTime()).canCreate,false);
  }
});
test('manual wallet identity must be exact, never open an unsupported market or use provider credentials',()=>{
  assert.equal(isManualPaperWalletId('manual-paper-member-v1:crypto_futures'),true);
  assert.equal(isManualPaperWalletId('manual-paper-member-v1:fake-market'),false);
  assert.equal(isManualPaperWalletId('automatic-paper-member-v2:crypto_spot'),false);
  assert.throws(()=>manualPaperWalletId('member','fake' as never),/IDENTITY_INVALID/);
  assert.throws(()=>buildManualFourMarketWalletSeeds('member',new Date('invalid')),/INPUT_INVALID/);
});

test('reserved manual market namespace blocks forged noncanonical IDs in generic journal sync',()=>{
  assert.equal(isManualPaperWalletId('manual-paper-member-v1:unknown'),false);
  assert.equal(isReservedManualPaperWalletNamespace('manual-paper-member-v1:unknown'),true);
  assert.equal(isReservedManualPaperWalletNamespace('manual-paper-admin-v1:crypto_futures'),true);
  assert.equal(isReservedManualPaperWalletNamespace('manual-paper-something-else'),true);
  assert.equal(isReservedManualPaperWalletNamespace('manual-paper-member-v2:us_stock'),true);
  assert.equal(isReservedManualPaperWalletNamespace('manual-paper-unknown-v1:us_stock'),true);
  assert.equal(isReservedManualPaperWalletNamespace('automatic-paper-member-v2:crypto_spot'),false);
  const forged=snapshot('member');
  const extra={...forged[0],id:'manual-paper-member-v1:unknown'};
  const status=manualWalletCreationReadiness('member',[extra],NOW.getTime());
  assert.equal(status.canCreate,false);
  assert.ok(status.blockers.includes('MANUAL_PAPER_PARTIAL_OR_ROLE_CONFLICT'));
  assert.equal(inspectManualFourMarketWallets('member',[...forged,extra],NOW.getTime()).ready,false);
});
