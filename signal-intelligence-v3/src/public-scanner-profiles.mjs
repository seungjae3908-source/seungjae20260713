// Exact, separate read-only public QA surfaces. No trading or Paper authority.
// Twenty Bitget contract symbols can overrun the existing 12s public Scanner
// aggregate lane even with zero HTTP error/individual timeouts; ten provides
// the already empirically green member-QA bounded public request budget.
export const PUBLIC_V3_FUTURES_STAGE_TWO_LIMIT = 10;
export const PUBLIC_SCANNER_PROFILE_SETS = Object.freeze({
  RESEARCH_V3: Object.freeze([
    Object.freeze({label:'SCALPING',strategyMode:'scalping',timeframe:'15m'}),
    Object.freeze({label:'SWING',strategyMode:'swing',timeframe:'60m'}),
    Object.freeze({label:'MID_LONG',strategyMode:'position',timeframe:'1D'}),
  ]),
  MEMBER_UI: Object.freeze([
    Object.freeze({label:'SCALPING',strategyMode:'scalping',timeframe:'5m'}),
    Object.freeze({label:'SWING',strategyMode:'swing',timeframe:'4H'}),
    Object.freeze({label:'MID_LONG',strategyMode:'position',timeframe:'1D'}),
  ]),
});
export function getPublicScannerProfileSet(surface='RESEARCH_V3') {
  if (!Object.hasOwn(PUBLIC_SCANNER_PROFILE_SETS,surface))
    throw new Error('SIGNAL_INTELLIGENCE_PUBLIC_PROFILE_UNSUPPORTED');
  return PUBLIC_SCANNER_PROFILE_SETS[surface];
}
