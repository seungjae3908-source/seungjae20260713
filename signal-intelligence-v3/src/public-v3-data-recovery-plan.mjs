import { verifiedCurrentPublicV3Page } from './public-v3-current-page-gate.mjs';
/** User-visible gap recovery directions ONLY. Current-page data are not PIT
 * archives and missing original OHLCV is never synthesized/filled here.
 * Reuses twelve actual public receipts; zero new GETs or orders.
 */
const PROFILES=Object.freeze({
 KR_STOCK:{prefix:'KR',missing:'KRX_AUTHENTICATED_PIT_ROSTER_AND_LICENSED_ORIGINAL_1M',
   gap:'STOCK_SESSION_AND_NATIVE_MINUTE_GAP_BACKFILL'},
 US_STOCK:{prefix:'US',missing:'US_PIT_UNIVERSE_AND_LICENSED_INTRADAY_MINUTE_HISTORY',
   gap:'US_COMPLETE_1M_BAR_AND_SESSION_GAP_BACKFILL'},
 CRYPTO_SPOT:{prefix:'SPOT',missing:'UPBIT_PIT_LISTING_AND_ORIGINAL_1M_ARCHIVE',
   gap:'UPBIT_NATIVE_CLOSED_1M_OR_NO_TRADE_PROOF'},
 CRYPTO_FUTURES:{prefix:'FUTURES',missing:'BITGET_PIT_CONTRACT_AND_FUNDING_OI_HISTORY',
   gap:'BITGET_NATIVE_1M_FUNDING_AND_OI_BACKFILL'},
});
const SLOTS=['SCALPING_15M','SWING_60M','MID_LONG_1D'];
const integer=x=>Number.isSafeInteger(x)&&x>=0;
export function planV3FourMarketDataRecovery(coverage){
 if(!Array.isArray(coverage)||coverage.length!==12)
  throw Error('V3_RECOVERY_LANES_INVALID');
 const seen=new Set(),markets={};
 for(const [market,profile] of Object.entries(PROFILES)){
  markets[market]={market,sourceReadyPages:0,blockedPages:0,
   knownRosterExcluded:0,blockingMissingCandleCards:0,
   providerErrorPages:0,untrustedQualityPages:0,requiredHistoricalSource:profile.missing,
   gapRecoveryAction:profile.gap,historicalPITVerified:false,
   fullUniverseTraversed:false,independentOosCostPass:false,
   retryMayRequireProviderApproval:true,executionAuthority:'NONE'};
 }
 for(const row of coverage){
  const profile=PROFILES[row?.market];
  if(!profile||!SLOTS.some(slot=>row.laneId===profile.prefix+'_'+slot)
    ||seen.has(row.laneId))throw Error('V3_RECOVERY_LANE_ID_INVALID');
  seen.add(row.laneId);
  const target=markets[row.market];
  const valid=verifiedCurrentPublicV3Page(row);
  if(valid)target.sourceReadyPages++;
  else target.blockedPages++;
  if(row.universePartial===true&&integer(row.universeExplainedExcludedCount))
    target.knownRosterExcluded=Math.max(target.knownRosterExcluded,
      row.universeExplainedExcludedCount);
  const stock=row.publicStockQualityDiagnostic?.issueCounts?.['MISSING_CANDLE:blocking'];
  const crypto=row.publicCryptoQualityDiagnostic?.qualityIssues?.['MISSING_CANDLE:blocking'];
  target.blockingMissingCandleCards+=(integer(stock)?stock:0)+(integer(crypto)?crypto:0);
  if((row.providerErrors??0)>0||(row.timeouts??0)>0
    ||(row.universeProviderErrors??0)>0)target.providerErrorPages++;
  if((row.publicStockQualityDiagnostic?.stateCounts?.DATA_UNTRUSTED??0)>0
    ||(row.publicCryptoQualityDiagnostic?.qualityStates?.DATA_UNTRUSTED??0)>0)
    target.untrustedQualityPages++;
 }
 if(seen.size!==12)throw Error('V3_RECOVERY_LANE_COUNT_INVALID');
 return Object.freeze({schemaVersion:'signal-v3-four-market-source-recovery-plan-v1',
  status:'SOURCE_GAPS_REQUIRE_INDEPENDENT_ORIGINAL_DATA',
  pagesObserved:12,sourceReadyPages:Object.values(markets)
    .reduce((s,m)=>s+m.sourceReadyPages,0),
  markets:Object.freeze(Object.fromEntries(Object.entries(markets)
    .map(([m,v])=>[m,Object.freeze(v)]))),
  sourceMembershipNamesIncluded:false,OHLCVIncluded:false,
  archivedMinuteBarsDownloaded:0,addedProviderRequests:0,
  historicalFullMarketCoverageProven:false,profitabilityProven:false,
  tradingOrdersSent:0,executionAuthority:'NONE'});
}
