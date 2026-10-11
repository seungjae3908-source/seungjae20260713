/** V3 diagnostic-only aggregate of canonical candidate gates.
 * No symbols, input OHLC, user IDs, credentials, trades, orders or relaxed
 * admission. A scan result is NOT a profitability/OOS PASS.
 */
const MARKET=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const STATES=['CANDIDATE','ABSTAIN','NO_TRADE','BLOCKED_DATA'];
const PROOFS=[
  'PAPER_IDENTITY_REQUIRED','CANONICAL_PROFIT_EVIDENCE_REQUIRED',
  'EXPLICIT_COST_POLICY_REQUIRED',
];
function blank(){
  return {examined:0,candidate:0,noTrade:0,abstain:0,dataBlocked:0,
    dataNotReady:0,quantNotEligible:0,profitNotEligible:0,
    riskNotReady:0,utilityMissing:0,canonicalProofAbsent:0,
    identityMissing:0,costPolicyMissing:0,
    backtestEvidenceMissing:0,backtestLineageMismatch:0,
    backtestOosOrWalkForwardMissing:0,backtestFullCostIncomplete:0,
    backtestPointInTimeUnproven:0,backtestSamplesInvalid:0,
    backtestNetUnproven:0};
}
export function summarizeV3EconomicReadiness(rows){
  if(!Array.isArray(rows)||rows.length>100_000)
    throw new Error('V3_ECONOMIC_GATE_INPUT_INVALID');
  const byMarket=Object.fromEntries(MARKET.map(m=>[m,blank()]));
  for(const row of rows){
    if(!row||!MARKET.includes(row.market)||!STATES.includes(row.state))
      throw new Error('V3_ECONOMIC_GATE_ROW_INVALID');
    const target=byMarket[row.market];
    target.examined+=1;
    if(row.state==='CANDIDATE')target.candidate+=1;
    if(row.state==='NO_TRADE')target.noTrade+=1;
    if(row.state==='ABSTAIN')target.abstain+=1;
    if(row.state==='BLOCKED_DATA')target.dataBlocked+=1;
    if(row.dataStatus!=='READY')target.dataNotReady+=1;
    if(row.quantEligible!==true)target.quantNotEligible+=1;
    if(row.profitEligible!==true)target.profitNotEligible+=1;
    if(row.riskReady!==true)target.riskNotReady+=1;
    if(typeof row.utilityR!=='number'||!Number.isFinite(row.utilityR))
      target.utilityMissing+=1;
    const blockers=Array.isArray(row.provenance?.profitBlockers)
      ? row.provenance.profitBlockers : [];
    if(blockers.includes(PROOFS[0]))target.identityMissing+=1;
    if(blockers.includes(PROOFS[1]))target.canonicalProofAbsent+=1;
    if(blockers.includes(PROOFS[2]))target.costPolicyMissing+=1;
    if(blockers.includes('BACKTEST_QUALITY_VERIFICATION_REQUIRED'))
      target.backtestEvidenceMissing+=1;
    if(blockers.includes('BACKTEST_EXACT_CANDIDATE_LINEAGE_REQUIRED'))
      target.backtestLineageMismatch+=1;
    if(blockers.includes('BACKTEST_OOS_AND_WALK_FORWARD_EVIDENCE_REQUIRED'))
      target.backtestOosOrWalkForwardMissing+=1;
    if(blockers.includes('BACKTEST_ALL_IN_COST_AND_SLIPPAGE_EVIDENCE_REQUIRED'))
      target.backtestFullCostIncomplete+=1;
    if(blockers.includes('BACKTEST_PIT_AND_SURVIVORSHIP_GUARDS_REQUIRED'))
      target.backtestPointInTimeUnproven+=1;
    if(blockers.includes('BACKTEST_OOS_WALK_FORWARD_SAMPLE_EVIDENCE_REQUIRED'))
      target.backtestSamplesInvalid+=1;
    if(blockers.includes('BACKTEST_NET_ECONOMIC_EVIDENCE_REQUIRED'))
      target.backtestNetUnproven+=1;
  }
  for(const target of Object.values(byMarket))Object.freeze(target);
  return Object.freeze({
    schemaVersion:'public-v3-economic-readiness-v1',
    scope:'CURRENT_RESEARCH_ROWS_ONLY',
    totalRows:rows.length,
    byMarket:Object.freeze(byMarket),
    sourceSymbolsIncluded:false,
    oosPassProven:false,
    economicAuthority:'NONE',
  });
}
