// Browser-only schema projection. Never import server hashing/FS code into React.
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x, n = 4000) => typeof x === 'string' && x.length <= n;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const id = x => str(x,120) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(x);
const hash = x => str(x,64) && /^[a-f0-9]{64}$/.test(x);
const iso = x => str(x,30) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
export const WORKSPACE_MARKETS = Object.freeze(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const require = yes => { if (!yes) throw new Error('INVALID_RESEARCH_WORKSPACE_RESPONSE'); };
export function parseResearchWorkspaceResponse(raw) {
  require(object(raw));
  if (raw.available === false) return { available:false, reason:'WORKSPACE_UNAVAILABLE' };
  const v = raw.workspace;
  require(raw.available === true && object(v) && v.schemaVersion === 'research-workspace-v1');
  require(['MISSING','INVALID','STALE','MEASURED'].includes(v.sourceState) && ['MISSING','BLOCKED','INVALID','READABLE','UNAVAILABLE'].includes(v.registryState));
  require(object(v.authority) && v.authority.executionAuthority === 'NONE' && v.authority.actualOrders === 0
    && v.authority.economicEvidenceCredit === 0 && v.authority.profitabilityCredit === 0 && v.authority.canonicalSampleDelta === 0
    && v.authority.paidFallback === false && v.authority.automaticAdoption === false && v.authority.providerInvoked === false && v.workerState === 'UNVERIFIED');
  require(v.sourceCount === null || Number.isSafeInteger(v.sourceCount) && v.sourceCount >= 0 && v.sourceCount <= 5);
  require(Array.isArray(v.sources) && v.sources.length <= 5 && Array.isArray(v.strategies) && v.strategies.length <= 200);
  require(v.sourceState === 'MEASURED' ? v.sourceCount === v.sources.length : v.sourceCount === null && v.sources.length === 0);
  require(v.registryState === 'READABLE' || v.strategies.length === 0);
  const sourceIds = new Set();
  const sources = v.sources.map(s => {
    require(object(s) && str(s.videoId,120) && s.sourceId === `youtube:${s.videoId}` && !sourceIds.has(s.sourceId));
    sourceIds.add(s.sourceId);
    require(s.url === `https://www.youtube.com/watch?v=${encodeURIComponent(s.videoId)}` && str(s.title,500));
    return {sourceId:s.sourceId, title:s.title, url:s.url};
  });
  const identities = new Set();
  const strategies = v.strategies.map(s => {
    require(object(s) && id(s.strategyId) && id(s.version) && s.id === `${s.strategyId}@${s.version}` && !identities.has(s.id));
    identities.add(s.id);
    require(sourceIds.has(s.sourceId) && WORKSPACE_MARKETS.includes(s.market) && ['1m','5m','15m','30m','1h','4h','1D'].includes(s.timeframe) && hash(s.strategyDigest));
    require(['BACKTEST_RECORDED','RULES_INCOMPLETE','COMPILER_REVIEW_REQUIRED'].includes(s.state));
    require(object(s.actions) && s.actions.scannerApply === false && s.actions.paperApply === false && s.actions.liveApply === false);
    require(Array.isArray(s.missingRules) && s.missingRules.every(x => str(x,80)) && Array.isArray(s.rules) && s.rules.length <= 60);
    const rules = s.rules.map(r => {
      require(object(r) && id(r.id) && str(r.kind,80) && str(r.text,1000) && ['SOURCE_RULE','AI_ASSUMPTION'].includes(r.origin));
      require(r.rationale === null || str(r.rationale,500));
      require(Array.isArray(r.evidence) && r.evidence.length <= 20 && r.evidence.every(e => object(e) && finite(e.startSec) && finite(e.endSec) && e.startSec >= 0 && e.endSec > e.startSec && str(e.excerpt,600)));
      return {id:r.id,kind:r.kind,text:r.text,origin:r.origin,rationale:r.rationale,evidence:r.evidence.map(e => ({startSec:e.startSec,endSec:e.endSec,excerpt:e.excerpt}))};
    });
    let run = null;
    if (s.run !== null) {
      const r = s.run;
      require(object(r) && id(r.runId) && finite(r.netReturn) && r.netReturn >= -1 && finite(r.maxDrawdown) && r.maxDrawdown >= 0 && r.maxDrawdown <= 1
        && Number.isSafeInteger(r.tradeCount) && r.tradeCount >= 0 && iso(r.startAt) && iso(r.endAt) && r.startAt < r.endAt
        && r.costsIncluded === true && r.independentlyVerified === false && r.dayTargetStatus === 'NOT_EVALUATED' && r.dailyReturn === null && r.winProbability === null);
      require(r.tradeCount !== 0 || r.netReturn === 0 && r.maxDrawdown === 0);
      run = {runId:r.runId,netReturn:r.netReturn,maxDrawdown:r.maxDrawdown,tradeCount:r.tradeCount,startAt:r.startAt,endAt:r.endAt};
    }
    require(s.state === 'BACKTEST_RECORDED' ? run !== null && s.missingRules.length === 0 : run === null);
    return {id:s.id,strategyId:s.strategyId,version:s.version,market:s.market,timeframe:s.timeframe,sourceId:s.sourceId,strategyDigest:s.strategyDigest,state:s.state,rules,missingRules:[...s.missingRules],run};
  });
  return {available:true,sourceState:v.sourceState,registryState:v.registryState,sourceCount:v.sourceCount,sources,strategies};
}
export function filterResearchStrategies(rows, group, market) {
  require(['ALL','STOCK','CRYPTO'].includes(group) && (market === 'ALL' || WORKSPACE_MARKETS.includes(market)));
  return rows.filter(s => (group === 'ALL' || (group === 'STOCK' ? s.market.endsWith('_STOCK') : s.market.startsWith('CRYPTO_'))) && (market === 'ALL' || s.market === market));
}
