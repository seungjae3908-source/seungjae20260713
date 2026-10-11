import {createHash} from 'node:crypto';
import type {AdminPaperMarket,FourMarketPaperWalletRole} from './admin-four-market-paper-capital.service';
import {
  assessPaperResearchRound,type PaperRoundSnapshot,
} from './paper-research-round-lifecycle.service';
import {
  samePaperRoundProposalEvidence,type PaperRoundProposalRow,
} from './paper-research-round-proposal-store.service';
import {getSupabase,hasSupabaseServerKey} from '../lib/supabase';

export const AUTOMATIC_PAPER_ROUND_EPOCH_V3='automatic-paper-v3-epoch-draft' as const;
const hex64=/^[0-9a-f]{64}$/u;
const SHA=(s:string)=>createHash('sha256').update(s).digest('hex');
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
export type AutomaticPaperV3Epoch=Readonly<{
  epoch_id:string;
  proposal_id:string;
  user_id:string;
  owner_role:FourMarketPaperWalletRole;
  market:AdminPaperMarket;
  mode:'automatic';
  source_epoch_id:string;
  previous_settlement_digest_sha256:string;
  next_round_number:number;
  virtual_seed_krw:1000000;
  operating_balance_seed_krw:1000000;
  locked_reserve_seed_krw:0;
  previous_locked_reserve_krw:number;
  previous_residual_operating_krw:number;
  ending_cause:'ZERO_EQUITY'|'BELOW_VERIFIED_MINIMUM';
  activation_state:'STAGED_NOT_ACTIVE';
  execution_authority:'NONE';
  real_order_enabled:false;
  previous_history_preserved:true;
  actual_paper_worker_attached:false;
  created_from_verified_receipt:true;
}>;
export type AutoRoundStaging=Readonly<{
  status:'BLOCKED'|'STAGED_IN_MEMORY';
  blockers:readonly string[];
  candidate:AutomaticPaperV3Epoch|null;
  newActiveWalletCreated:false;
  actualPaperWorkerAttached:false;
  providerCalls:0;
  realOrders:0;
  reserveTransferKrw:0;
  executionAuthority:'NONE';
}>;
const empty=(blockers:string[]):AutoRoundStaging=>Object.freeze({
  status:'BLOCKED',blockers:Object.freeze([...new Set(blockers)]),
  candidate:null,newActiveWalletCreated:false,actualPaperWorkerAttached:false,
  providerCalls:0,realOrders:0,reserveTransferKrw:0,executionAuthority:'NONE',
});

/**
 * Build the only permitted V3 prospective 1m *virtual* seed envelope from a
 * trusted same-owner/same-market EXACT immutable Paper proposal + completed
 * end-of-epoch readback. Never accept client-provided proposal or balances.
 * Does not write the wallet, admit a signal, or activate a worker.
 */
export function stageAutomaticPaperV3Epoch(input:Readonly<{
  ownerId:string;
  role:FourMarketPaperWalletRole;
  proposal:PaperRoundProposalRow;
  storedProposal:Record<string,unknown>;
  protectedSnapshot:PaperRoundSnapshot;
  existingSuccessorCount:number;
  environmentReady:boolean;
}>):AutoRoundStaging{
  const blockers:string[]=[];
  const add=(c:string)=>{if(!blockers.includes(c))blockers.push(c);};
  const {ownerId,role,proposal:p,storedProposal:stored,protectedSnapshot:s}=input;
  if(!input.environmentReady)add('AUTO_PAPER_V3_STAGING_DISABLED');
  if(!p||!stored||!s)return empty([...blockers,'AUTO_PAPER_V3_EVIDENCE_REQUIRED']);
  if(s.mode!=='automatic'||p.trading_mode!=='automatic'
    ||s.ownerId!==ownerId||p.user_id!==ownerId
    ||p.owner_role!==role||p.market!==s.market
    ||p.current_epoch_id!==s.currentEpochId
    ||p.next_round_number!==s.roundNumber+1
    ||!['admin','member'].includes(role))
    add('AUTO_PAPER_V3_OWNER_MODE_EPOCH_MISMATCH');
  if(!samePaperRoundProposalEvidence(p,stored))
    add('AUTO_PAPER_V3_STORED_PROPOSAL_MISMATCH');
  if(!Number.isSafeInteger(input.existingSuccessorCount)
    ||input.existingSuccessorCount!==0)
    add('AUTO_PAPER_V3_EXISTING_OR_UNKNOWN_SUCCESSOR');
  const decision=assessPaperResearchRound(s);
  if(decision.status!=='EXHAUSTED'||!decision.eligibleForNewRound
    ||decision.nextAction!=='AUTO_RESEARCH_ROUND_PROPOSAL'
    ||decision.proposedRoundId!==p.proposal_id
    ||decision.endingCause!==p.ending_cause)
    add('AUTO_PAPER_V3_END_OF_ROUND_UNPROVEN');
  if(p.previous_settlement_digest_sha256!==s.settlementDigestSha256
    ||!hex64.test(p.previous_settlement_digest_sha256)
    ||p.proposed_seed_krw!==1_000_000
    ||p.previous_operating_capital_krw!==s.operatingCapitalKrw
    ||p.previous_locked_reserve_krw!==s.reserveKrw)
    add('AUTO_PAPER_V3_CAPITAL_PROOF_MISMATCH');
  const observed=Date.parse(p.observed_at);
  if(!Number.isFinite(observed)||!Number.isSafeInteger(s.nowMs)
    ||Math.abs(s.nowMs-observed)>30_000)
    add('AUTO_PAPER_V3_PROPOSAL_TIME_MISMATCH');
  if(blockers.length)return empty(blockers);
  const epochId='paper-v3-epoch:'+SHA([
    ownerId,role,'automatic',s.market,p.current_epoch_id,
    p.next_round_number,p.proposal_id,p.previous_settlement_digest_sha256,
  ].join('|'));
  const candidate:AutomaticPaperV3Epoch=Object.freeze({
    epoch_id:epochId,proposal_id:p.proposal_id,user_id:ownerId,
    owner_role:role,market:s.market,mode:'automatic',
    source_epoch_id:p.current_epoch_id,
    previous_settlement_digest_sha256:p.previous_settlement_digest_sha256,
    next_round_number:p.next_round_number,
    virtual_seed_krw:1000000,operating_balance_seed_krw:1000000,
    locked_reserve_seed_krw:0,
    previous_locked_reserve_krw:s.reserveKrw,
    previous_residual_operating_krw:s.operatingCapitalKrw,
    ending_cause:p.ending_cause,
    activation_state:'STAGED_NOT_ACTIVE',execution_authority:'NONE',
    real_order_enabled:false,previous_history_preserved:true,
    actual_paper_worker_attached:false,created_from_verified_receipt:true,
  });
  return Object.freeze({
    status:'STAGED_IN_MEMORY',blockers:Object.freeze([]),candidate,
    newActiveWalletCreated:false,actualPaperWorkerAttached:false,
    providerCalls:0,realOrders:0,reserveTransferKrw:0,
    executionAuthority:'NONE',
  });
}

export function sameAutomaticPaperV3Epoch(
  expected:AutomaticPaperV3Epoch,found:Record<string,unknown>,
):boolean{
  for(const [key,value] of Object.entries(expected)){
    if(typeof value==='number'){
      if(!Number.isFinite(Number(found[key]))||Number(found[key])!==value)return false;
    }else if(found[key]!==value)return false;
  }
  return true;
}

/** Server-only append of the PROTECTED UNACTIVATED epoch row. A DB credit
 * schema is deliberately absent and no worker consumes this table.
 * Explicitly OFF until RLS migration + owner-cost readback is approved.
 */
export async function appendAutomaticPaperV3StagedEpoch(
  row:AutomaticPaperV3Epoch,
):Promise<'INSERTED'|'DUPLICATE'>{
  if(process.env.AUTOMATIC_PAPER_V3_EPOCH_STAGING_ENABLED!=='true'
    ||!hasSupabaseServerKey())throw new Error('AUTO_PAPER_V3_EPOCH_STAGING_OFF');
  if(row.activation_state!=='STAGED_NOT_ACTIVE'
    ||row.execution_authority!=='NONE'||row.real_order_enabled!==false
    ||row.actual_paper_worker_attached!==false||row.previous_history_preserved!==true
    ||row.virtual_seed_krw!==1_000_000||row.locked_reserve_seed_krw!==0
    ||!hex64.test(row.previous_settlement_digest_sha256))
    throw new Error('AUTO_PAPER_V3_STAGING_CONTRACT_INVALID');
  const {data,error}=await getSupabase().from('paper_research_round_wallet_epochs')
    .insert(row).select('epoch_id').single();
  if(error?.code==='23505'){
    const {data:existing,error:lookupErr}=await getSupabase()
      .from('paper_research_round_wallet_epochs').select('*')
      .eq('user_id',row.user_id).eq('owner_role',row.owner_role)
      .eq('mode','automatic').eq('market',row.market)
      .eq('next_round_number',row.next_round_number).maybeSingle();
    if(lookupErr||!existing||!sameAutomaticPaperV3Epoch(row,existing))
      throw new Error('AUTO_PAPER_V3_SUCCESSOR_CONFLICT');
    return 'DUPLICATE';
  }
  if(error||data?.epoch_id!==row.epoch_id)throw new Error('AUTO_PAPER_V3_STAGING_WRITE_FAILED');
  return 'INSERTED';
}
