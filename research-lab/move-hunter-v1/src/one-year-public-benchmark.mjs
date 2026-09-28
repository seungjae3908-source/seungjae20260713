import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-point-in-time-v2.js';
import {
  buildAdaptiveMultiEvidenceMarketFeaturesV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-market-features-v2.js';
import {
  classifyCanonicalIndicatorRunnerState,
  INDICATOR_RUNNER_STATES,
} from './indicator-policy.mjs';
import {
  RUNNER_RESEARCH_PRESETS,
  simulateRunner,
  summarizeRunnerTrials,
} from './engine.mjs';

export const ONE_YEAR_BENCHMARK_START_MS = Date.parse('2025-09-28T00:00:00.000Z');
export const ONE_YEAR_BENCHMARK_END_MS = Date.parse('2026-09-28T00:00:00.000Z') - 1;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const ONE_YEAR_PRICE_FORMULA_POLICY_V1 = Object.freeze({
  schemaVersion: 'move-hunter-one-year-price-formula-policy/v1',
  minimumBars: 80,
  allowAcceleration: true,
  allowStructuredNormal: true,
  minimumNormalAdx: 18,
  minimumNormalRelativeVolume: 1.0,
  indicatorForcedExitEnabled: false,
  runnerPreset: 'LONG_RUNNER_3ATR',
  observedHistoryMayCountAsOos: false,
  economicSampleCredit: 0,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
});

export const ONE_YEAR_FULL_STACK_GATE_V1 = Object.freeze({
  schemaVersion: 'move-hunter-one-year-full-stack-gate/v1',
  status: 'BLOCKED_DATA',
  blocker: 'POINT_IN_TIME_NEWS_DISCLOSURE_AI_HISTORY_NOT_BOUND',
  priceFormulaReplayAllowed: true,
  newsScoreImpact: 0,
  disclosureScoreImpact: 0,
  aiScoreImpact: 0,
  observedHistoryMayCountAsOos: false,
  economicSampleCredit: 0,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
});

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}
function direction(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'LONG' || raw === 'BUY') return 'LONG';
  if (raw === 'SHORT' || raw === 'SELL') return 'SHORT';
  throw new TypeError('direction must be LONG/BUY or SHORT/SELL');
}
function sourceIdentity(raw = {}) {
  const sourceId = String(raw.sourceId ?? '').trim();
  const originalSourceId = String(raw.originalSourceId ?? sourceId).trim();
  const sourceType = String(raw.sourceType ?? 'PUBLIC_MARKET_OHLCV').trim();
  const sourceUrl = String(raw.sourceUrl ?? '').trim();
  if (!sourceId || !originalSourceId || !sourceType || !sourceUrl) throw new TypeError('public source identity is incomplete');
  return Object.freeze({sourceId, originalSourceId, sourceType, sourceUrl});
}
function iso(ms) { return new Date(ms).toISOString(); }

export function normalizeResearchCandles(rawCandles, {intervalMs = ONE_DAY_MS} = {}) {
  if (!Array.isArray(rawCandles)) throw new TypeError('rawCandles must be an array');
  finite(intervalMs, 'intervalMs');
  if (!(intervalMs > 0)) throw new RangeError('intervalMs must be positive');
  const rows = rawCandles.map((row, index) => {
    const ts = finite(row?.ts ?? row?.timestamp, `candles[${index}].timestamp`);
    const open = finite(row?.open, `candles[${index}].open`);
    const high = finite(row?.high, `candles[${index}].high`);
    const low = finite(row?.low, `candles[${index}].low`);
    const close = finite(row?.close, `candles[${index}].close`);
    const volume = finite(row?.volume ?? 0, `candles[${index}].volume`);
    if (!(ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0)) throw new RangeError('invalid OHLCV');
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new RangeError('invalid OHLC relationship');
    return Object.freeze({ts, open, high, low, close, volume});
  }).sort((a,b)=>a.ts-b.ts);
  for (let i=1;i<rows.length;i+=1) if (!(rows[i].ts > rows[i-1].ts)) throw new RangeError('candles must have unique ascending timestamps');
  return Object.freeze(rows);
}

function evidenceCandles(rows, intervalMs) {
  return rows.map((row) => {
    const availableAt = row.ts + intervalMs - 1;
    return Object.freeze({
      isClosed: true,
      eventTime: iso(row.ts),
      publishedAt: iso(availableAt),
      availableAt: iso(availableAt),
      observedAt: iso(availableAt),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
    });
  });
}

export function buildCanonicalFeatureAt({
  market, symbol, side='LONG', timeframe='1D', candles, index,
  intervalMs=ONE_DAY_MS, source,
} = {}) {
  const normalized = normalizeResearchCandles(candles, {intervalMs});
  if (!Number.isInteger(index) || index < 0 || index >= normalized.length) throw new RangeError('index is outside candles');
  const availableAt = normalized[index].ts + intervalMs - 1;
  return buildAdaptiveMultiEvidenceMarketFeaturesV2({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    market,
    symbol,
    timeframe,
    side: direction(side),
    decisionTime: iso(availableAt),
    source: sourceIdentity(source),
    candles: evidenceCandles(normalized.slice(0,index+1), intervalMs),
    higherTimeframeEvidence: [],
    benchmark: null,
  });
}

function directionalPositive(value, tradeSide) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  return tradeSide === 'LONG' ? number > 0 : number < 0;
}
function expectedTrend(tradeSide) { return tradeSide === 'LONG' ? 'BULLISH' : 'BEARISH'; }
function expectedDirection(tradeSide) { return tradeSide === 'LONG' ? 'UP' : 'DOWN'; }

export function priceFormulaEntryDecision(snapshot, {side='LONG'} = {}) {
  const tradeSide = direction(side);
  if (!snapshot || !['READY_FOR_SPECIALIST_RESEARCH_ONLY','PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
    return Object.freeze({eligible:false,reason:'CANONICAL_FEATURES_NOT_READY',control:null});
  }
  const control = classifyCanonicalIndicatorRunnerState(snapshot, {direction:tradeSide});
  const {trend, momentum, volume, volatility, priceAction} = snapshot.features;
  const expected = expectedDirection(tradeSide);
  const expectedStructure = expectedTrend(tradeSide);
  const structureAligned = priceAction.structureTrend === expectedStructure
    || priceAction.structureEventDirection === expected
    || priceAction.structureTrend == null;
  const structureTrigger = priceAction.structureEventDirection === expected
    && ['BREAKOUT_UNRETESTED','RETEST_HELD'].includes(priceAction.structureEvent);
  const momentumAligned = directionalPositive(momentum.roc, tradeSide)
    && directionalPositive(momentum.macdHistogramPct, tradeSide)
    && (tradeSide === 'LONG'
      ? Number(momentum.rsi) >= 50 && Number(momentum.rsi) < 82
      : Number(momentum.rsi) <= 50 && Number(momentum.rsi) > 18);
  const trendAligned = trend.emaDirection === expected
    && (trend.adxDirection === expected || Number(trend.adx) < 18);
  const volumeAligned = Number(volume.relativeVolume) >= ONE_YEAR_PRICE_FORMULA_POLICY_V1.minimumNormalRelativeVolume;
  const volatilityAllowed = volatility.abnormalVolatility !== true;
  const acceleration = ONE_YEAR_PRICE_FORMULA_POLICY_V1.allowAcceleration
    && control.state === INDICATOR_RUNNER_STATES.ACCELERATION
    && structureAligned
    && volatilityAllowed;
  const structuredNormal = ONE_YEAR_PRICE_FORMULA_POLICY_V1.allowStructuredNormal
    && control.state === INDICATOR_RUNNER_STATES.NORMAL
    && structureTrigger
    && trendAligned
    && momentumAligned
    && volumeAligned
    && Number(trend.adx) >= ONE_YEAR_PRICE_FORMULA_POLICY_V1.minimumNormalAdx
    && volatilityAllowed;
  return Object.freeze({
    eligible: acceleration || structuredNormal,
    reason: acceleration ? 'ACCELERATION' : structuredNormal ? 'STRUCTURED_NORMAL' : 'FILTERED',
    control,
    diagnostics: Object.freeze({structureAligned,structureTrigger,momentumAligned,trendAligned,volumeAligned,volatilityAllowed}),
  });
}

export function buildOneYearCandidateTimeline({
  market, symbol, side='LONG', timeframe='1D', candles, intervalMs=ONE_DAY_MS, source,
  startTime=ONE_YEAR_BENCHMARK_START_MS, endTime=ONE_YEAR_BENCHMARK_END_MS,
} = {}) {
  const rows = normalizeResearchCandles(candles,{intervalMs});
  const candidates = [];
  const runnerControlByTs = {};
  const diagnostics = {featureReady:0,featureBlocked:0,acceleration:0,structuredNormal:0,filtered:0};
  for (let index=ONE_YEAR_PRICE_FORMULA_POLICY_V1.minimumBars; index<rows.length-1; index+=1) {
    const snapshot = buildCanonicalFeatureAt({market,symbol,side,timeframe,candles:rows,index,intervalMs,source});
    if (!['READY_FOR_SPECIALIST_RESEARCH_ONLY','PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
      diagnostics.featureBlocked += 1;
      continue;
    }
    diagnostics.featureReady += 1;
    const decision = priceFormulaEntryDecision(snapshot,{side});
    runnerControlByTs[String(rows[index].ts)] = decision.control;
    if (decision.reason === 'ACCELERATION') diagnostics.acceleration += 1;
    else if (decision.reason === 'STRUCTURED_NORMAL') diagnostics.structuredNormal += 1;
    else diagnostics.filtered += 1;
    const signalAtMs = rows[index].ts + intervalMs - 1;
    if (!decision.eligible || signalAtMs < startTime || signalAtMs > endTime) continue;
    candidates.push(Object.freeze({
      id:`${market}:${symbol}:${side}:${signalAtMs}`,
      market,symbol,direction:direction(side),signalAtMs,
      priorityScore:decision.reason==='ACCELERATION'?100:80,
      rvol:Number(snapshot.features.volume.relativeVolume)||0,
      entryReason:decision.reason,
      featureDigest:snapshot.contentDigest,
      theme:'PRICE_FORMULA_V2',
    }));
  }
  return Object.freeze({
    market,symbol,side:direction(side),timeframe,
    candidates:Object.freeze(candidates),
    runnerControlByTs:Object.freeze(runnerControlByTs),
    diagnostics:Object.freeze(diagnostics),
    fullStackGate:ONE_YEAR_FULL_STACK_GATE_V1,
  });
}

function fundingReturn(trial, records=[]) {
  const rates = records
    .filter(row => Number(row?.timestamp) > trial.entryTs && Number(row?.timestamp) <= trial.exitTs)
    .map(row => Number(row?.rate))
    .filter(Number.isFinite);
  const signed = rates.reduce((sum,rate)=>sum+rate,0);
  return trial.direction === 'LONG' ? -signed : signed;
}

export function buildSequentialRunnerTrials({
  candidates=[], candles, runnerControlByTs={}, fundingRates=[], costs={},
  presetName=ONE_YEAR_PRICE_FORMULA_POLICY_V1.runnerPreset,
  useAdaptiveTrail=true,
} = {}) {
  const preset = RUNNER_RESEARCH_PRESETS[presetName];
  if (!preset) throw new RangeError('unknown runner preset');
  const ordered = [...candidates].sort((a,b)=>a.signalAtMs-b.signalAtMs||String(a.id).localeCompare(String(b.id)));
  const trials = [];
  let occupiedUntil = -Infinity;
  for (const candidate of ordered) {
    if (candidate.signalAtMs <= occupiedUntil) continue;
    try {
      const raw = simulateRunner({
        candles,
        signalAtMs:candidate.signalAtMs,
        direction:candidate.direction,
        ...preset,
        runnerControlByTs:useAdaptiveTrail?runnerControlByTs:null,
        indicatorExitEnabled:false,
        costs,
      });
      const funding = fundingReturn(raw,fundingRates);
      const adjusted = Object.freeze({
        ...raw,
        netReturn:raw.netReturn+funding,
        netR:raw.netR + (raw.initialRiskPct>0 ? funding/raw.initialRiskPct : 0),
        fundingReturn:funding,
        sourceSignalId:candidate.id,
        entryReason:candidate.entryReason,
      });
      trials.push(adjusted);
      occupiedUntil = adjusted.exitTs;
    } catch {
      // A bounded candidate can fail if the dataset has no next bar or insufficient past bars.
    }
  }
  trials.sort((a,b)=>a.exitTs-b.exitTs||a.entryTs-b.entryTs);
  return Object.freeze({
    trials:Object.freeze(trials),
    summary:Object.freeze(summarizeRunnerTrials(trials)),
    totalFundingReturn:trials.reduce((sum,row)=>sum+(row.fundingReturn||0),0),
    useAdaptiveTrail,
    presetName,
  });
}

export function aggregateFourHourCandlesToUtcDaily(rawCandles) {
  const rows = normalizeResearchCandles(rawCandles,{intervalMs:4*60*60*1000});
  const buckets = new Map();
  for (const row of rows) {
    const day = new Date(row.ts).toISOString().slice(0,10);
    const bucket = buckets.get(day) ?? [];
    bucket.push(row);
    buckets.set(day,bucket);
  }
  const out=[];
  for (const [day,bucket] of buckets) {
    bucket.sort((a,b)=>a.ts-b.ts);
    if (bucket.length !== 6) continue;
    let complete=true;
    for(let i=1;i<bucket.length;i+=1) if(bucket[i].ts-bucket[i-1].ts!==4*60*60*1000) complete=false;
    if(!complete) continue;
    out.push(Object.freeze({
      ts:bucket[0].ts,
      open:bucket[0].open,
      high:Math.max(...bucket.map(x=>x.high)),
      low:Math.min(...bucket.map(x=>x.low)),
      close:bucket.at(-1).close,
      volume:bucket.reduce((sum,x)=>sum+x.volume,0),
    }));
  }
  return Object.freeze(out.sort((a,b)=>a.ts-b.ts));
}
