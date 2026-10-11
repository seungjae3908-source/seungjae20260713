import {getSupabase,hasSupabaseServerKey} from '../lib/supabase';
import {
  assessPaperResearchRound, type PaperRoundSnapshot, type PaperResearchMode,
} from './paper-research-round-lifecycle.service';
import type {AdminPaperMarket,FourMarketPaperWalletRole}
  from './admin-four-market-paper-capital.service';

export const MANUAL_RESEARCH_ROUND_OWNER_CONFIRMATION =
  'CONFIRM_NEW_MANUAL_PAPER_RESEARCH_ROUND_PRESERVE_BANKRUPTCY' as const;

/** One immutable PROPOSAL_ONLY row. No account value may be reset by this API. */
export type PaperRoundProposalRow = Readonly<{
  proposal_id:string;
  user_id:string;
  owner_role:FourMarketPaperWalletRole;
  trading_mode:PaperResearchMode;
  market:AdminPaperMarket;
  current_epoch_id:string;
  next_round_number:number;
  previous_settlement_digest_sha256:string;
  proposed_seed_krw:1000000;
  ending_cause:'ZERO_EQUITY'|'BELOW_VERIFIED_MINIMUM';
  previous_operating_capital_krw:number;
  previous_locked_reserve_krw:number;
  minimum_entry_krw:number|null;
  observed_at:string;
  status:'PROPOSAL_ONLY';
  execution_authority:'NONE';
  financial_mutation_allowed:false;
  reserve_transfer_allowed:false;
  historical_record_deletion_allowed:false;
}>;

export type PaperRoundProposalStatus = Readonly<{
  status:'DISABLED'|'BLOCKED'|'PROPOSAL_RECORDED'|'ALREADY_PROPOSED';
  proposalId:string|null;
  blockers:readonly string[];
  newWalletCreated:false;
  nextRoundTradingEnabled:false;
  realOrders:0;
  simulatedFills:0;
  reserveTransferred:false;
  executionAuthority:'NONE';
}>;

type PaperRoundProposalInput = Readonly<{
  ownerId:string;
  ownerRole:FourMarketPaperWalletRole;
  market:AdminPaperMarket;
  mode:PaperResearchMode;
  confirmation?:string;
}>;

type Dependencies = Readonly<{
  enabled:()=>boolean;
  readProtectedSnapshot:(input:PaperRoundProposalInput)=>Promise<PaperRoundSnapshot>;
  appendProposal:(receipt:PaperRoundProposalRow)=>Promise<'INSERTED'|'DUPLICATE'>;
}>;
const OWNER=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blank=(status:PaperRoundProposalStatus['status'],blockers:string[]=[],
  proposalId:string|null=null):PaperRoundProposalStatus=>Object.freeze({
    status,proposalId,blockers:Object.freeze(blockers),
    newWalletCreated:false as const,nextRoundTradingEnabled:false as const,
    realOrders:0 as const,simulatedFills:0 as const,reserveTransferred:false as const,
    executionAuthority:'NONE' as const,
  });

/** Requires an explicitly injected trusted server ledger reader. Never call
 * this with user-posted snapshots or model-generated cost evidence. Until a
 * verified reader and wallet V3 consumer exist, it can only store audit
 * proposals and must not restart the Trading worker.
 */
export async function recordPaperResearchRoundProposal(
  input:PaperRoundProposalInput,deps:Dependencies,
):Promise<PaperRoundProposalStatus>{
  if(!deps.enabled())return blank('DISABLED',['PAPER_ROUND_PROPOSAL_FLAG_OFF']);
  if(!OWNER.test(input.ownerId)
    || !['admin','member'].includes(input.ownerRole)
    || !['automatic','manual'].includes(input.mode)
    || !['domestic_stock','us_stock','crypto_spot','crypto_futures'].includes(input.market)) {
    return blank('BLOCKED',['PAPER_ROUND_OWNER_OR_MARKET_INVALID']);
  }
  if(input.mode==='manual' && input.confirmation!==MANUAL_RESEARCH_ROUND_OWNER_CONFIRMATION) {
    return blank('BLOCKED',['MANUAL_PAPER_RESEARCH_OWNER_CONFIRMATION_REQUIRED']);
  }
  let snapshot:PaperRoundSnapshot;
  try {
    snapshot=await deps.readProtectedSnapshot(input);
  } catch {
    return blank('BLOCKED',['PAPER_ROUND_PROTECTED_LEDGER_READ_FAILED']);
  }
  if(snapshot.ownerId!==input.ownerId || snapshot.mode!==input.mode || snapshot.market!==input.market) {
    return blank('BLOCKED',['PAPER_ROUND_PROTECTED_LEDGER_SCOPE_MISMATCH']);
  }
  const decision=assessPaperResearchRound(snapshot);
  if(!decision.eligibleForNewRound || decision.proposedRoundId===null) {
    return blank('BLOCKED',[...decision.blockers,
      ...(decision.blockers.length?[]:['PAPER_ROUND_NOT_EXHAUSTED'])]);
  }
  if(snapshot.roundNumber>=100000)return blank('BLOCKED',['PAPER_ROUND_SEQUENCE_EXHAUSTED']);
  const row:PaperRoundProposalRow=Object.freeze({
    proposal_id:decision.proposedRoundId,
    user_id:input.ownerId,owner_role:input.ownerRole,
    trading_mode:input.mode,market:input.market,
    current_epoch_id:snapshot.currentEpochId,
    next_round_number:snapshot.roundNumber+1,
    previous_settlement_digest_sha256:snapshot.settlementDigestSha256,
    proposed_seed_krw:1000000,
    ending_cause:decision.endingCause!,
    previous_operating_capital_krw:snapshot.operatingCapitalKrw,
    previous_locked_reserve_krw:snapshot.reserveKrw,
    minimum_entry_krw:snapshot.verifiedMinimumEntryKrw,
    observed_at:new Date(snapshot.nowMs).toISOString(),
    status:'PROPOSAL_ONLY',execution_authority:'NONE',
    financial_mutation_allowed:false,
    reserve_transfer_allowed:false,
    historical_record_deletion_allowed:false,
  });
  try {
    const outcome=await deps.appendProposal(row);
    if(outcome!=='INSERTED'&&outcome!=='DUPLICATE')throw new Error('PAPER_ROUND_INVALID_APPEND_RESULT');
    return blank(outcome==='INSERTED'?'PROPOSAL_RECORDED':'ALREADY_PROPOSED',[],row.proposal_id);
  }catch{
    return blank('BLOCKED',['PAPER_ROUND_APPEND_NOT_VERIFIED']);
  }
}

/** The only permitted durable write is an audit-only append to the isolated
 * proposal table. Not called by a route or worker until separately approved.
 */
export async function appendPaperResearchRoundProposalWithServiceRole(
  receipt:PaperRoundProposalRow,
):Promise<'INSERTED'|'DUPLICATE'>{
  if(process.env.PAPER_RESEARCH_ROUND_PROPOSAL_WRITE_ENABLED!=='true'
    || !hasSupabaseServerKey())throw new Error('PAPER_ROUND_PROPOSAL_WRITE_OFF');
  if(receipt.status!=='PROPOSAL_ONLY'
    || receipt.execution_authority!=='NONE'
    || receipt.financial_mutation_allowed!==false
    || receipt.reserve_transfer_allowed!==false
    || receipt.historical_record_deletion_allowed!==false
    || receipt.proposed_seed_krw!==1000000
    || !['ZERO_EQUITY','BELOW_VERIFIED_MINIMUM'].includes(receipt.ending_cause)) {
    throw new Error('PAPER_ROUND_PROPOSAL_ONLY_REQUIRED');
  }
  const {data,error}=await getSupabase().from('paper_research_round_proposals')
    .insert(receipt).select('proposal_id').single();
  if(error?.code==='23505')return 'DUPLICATE';
  if(error || data?.proposal_id!==receipt.proposal_id)throw new Error('PAPER_ROUND_APPEND_FAILED');
  return 'INSERTED';
}
