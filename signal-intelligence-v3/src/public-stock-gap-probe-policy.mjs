/** V3-only public Yahoo lower-bar probe: OFF unless explicitly enabled.
 * Observed 2026-10-12 GitHub public cycle made 28 additional 5m/15m
 * calls with 0 reconstructed bars. Do not spend free API budget by default.
 * An opt-in diagnostic may examine at most two symbols per lane per cycle.
 */
export const MAX_V3_LOWER_BAR_PROBES_PER_LANE=2;
export function shouldProbeV3StockGap({
  enabled=false,market,timeframe,hasBlockingGap,attempted=0,
}={}){
  if(enabled!==true||market!=='US_STOCK'
    ||!['15m','60m'].includes(timeframe)||hasBlockingGap!==true)
    return false;
  if(!Number.isSafeInteger(attempted)||attempted<0)
    return false;
  return attempted<MAX_V3_LOWER_BAR_PROBES_PER_LANE;
}
