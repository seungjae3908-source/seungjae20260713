// Research-only fail-closed output projection. Listing assertions are not
// upgraded by a one-symbol Naver public candle/quote sample. This protects
// cards, signal IDs and alerts even when the ordinary scanner finds a match.
export function suppressProvisionalKrResearchSignals(result,universe){
 if(!result||!universe||!Array.isArray(result.cards)||!Array.isArray(result.alerts)
  ||!Array.isArray(universe.entries))throw Error('KR_PROVISIONAL_PROJECTION_INVALID');
 const provisional=new Set(universe.entries.filter(x=>x?.publicResearchProvisional===true)
   .map(x=>String(x.ticker??'').trim().toUpperCase()).filter(Boolean));
 const restrictedCards=result.cards.filter(card=>
   provisional.has(String(card?.symbol??card?.ticker??'').trim().toUpperCase()));
 const forbiddenIds=new Set(restrictedCards.map(x=>x?.signalId).filter(Boolean));
 const otherCards=result.cards.filter(x=>!restrictedCards.includes(x));
 const alerts=result.alerts.filter(a=>
   !forbiddenIds.has(a?.signalId)
   && !provisional.has(String(a?.symbol??a?.ticker??'').trim().toUpperCase()));
 return Object.freeze({
   ...result,cards:otherCards,alerts,
   // Keep all actual market/provider counters and the partial roster.
   // Removing unsafe signals must never turn a data deficit into a proven
   // no-trade market scan or an economic PASS.
   outcome:restrictedCards.length&&otherCards.length===0
     ? 'DATA_QUALITY_REJECT' : result.outcome,
   provisionalResearchSignalsBlocked:restrictedCards.length,
   provisionalResearchAlertsBlocked:result.alerts.length-alerts.length,
   memberOrLiveAuthority:false,
 });
}
