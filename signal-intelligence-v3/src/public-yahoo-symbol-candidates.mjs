/** Read-only V3 Yahoo symbols. Known KOSPI/KOSDAQ names never cross
 * to the other exchange on a temporary data absence; unknown listing
 * boards may be probed in two places and both remain quality-gated.
 */
export function publicYahooProviderCandidates(market,ticker,entry){
  const clean=String(ticker??'').trim().toUpperCase();
  if(!clean)return [];
  if(market==='KR_STOCK'&&/^\d{6}$/u.test(clean)){
    const exchange=String(entry?.exchange??'').trim().toUpperCase();
    if(/KOSDAQ|코스닥/u.test(exchange))return [clean+'.KQ'];
    if(/KOSPI|코스피|유가증권/u.test(exchange))return [clean+'.KS'];
    return [clean+'.KS',clean+'.KQ'];
  }
  if(market==='US_STOCK'){
    const canonical=/^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean)
      ? clean.replace(/\./gu,'-'):clean;
    const options=[canonical];
    if(canonical.includes('-'))options.push(canonical.replace(/-/gu,'.'));
    return [...new Set(options)];
  }
  return [clean];
}
