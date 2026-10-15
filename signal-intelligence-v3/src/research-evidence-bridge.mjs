// Research-backed profit evidence for Signal Intelligence V3.
//
// The research center exports only combination rules that survived
// multiple-testing validation AND a one-time sealed 2026 holdout
// (research-production/src/combination-signal-evidence-v1.mjs). A scanner card
// receives profit evidence from such a rule only when ALL of the rule's
// conditions are true on the card symbol's latest CLOSED candle, in the same
// market, direction and timeframe. The tier stays RESEARCH_CANDIDATE (it is not
// forward/paper validated) and execution authority is always NONE.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { computeCombinationAtomsV1 } from '../../research-production/src/combination-atoms-v1.mjs';
import { collectYahooStockHistory } from '../../market-prediction-lab/src/yahoo-stock-history.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';

export const RESEARCH_EVIDENCE_CONTRACT = 'combination-signal-evidence/v1';
export const RESEARCH_EVIDENCE_MAX_AGE_MS = 6 * 3_600_000;
export const DEFAULT_RESEARCH_EVIDENCE_FILE = '/var/lib/investment-research-production/latest/combination-signal-evidence-v1.json';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const COST_FIELDS = Object.freeze(['commissionPercent', 'taxPercent', 'spreadPercent', 'slippagePercent',
  'fundingPercent', 'latencyPercent', 'liquidityImpactPercent', 'partialFillImpactPercent']);

// Only timeframes that the research actually tested are joinable.
const SUPPORTED = Object.freeze({
  KR_STOCK: Object.freeze(['1D']),
  US_STOCK: Object.freeze(['1D']),
  CRYPTO_FUTURES: Object.freeze(['60m']),
  CRYPTO_SPOT: Object.freeze([]), // research is Upbit 1h; the spot scanner lanes are 15m/4H/1D.
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function researchMarketForCard(card) {
  const assetClass = String(card?.assetClass ?? '').toLowerCase();
  const market = String(card?.market ?? '').toUpperCase();
  if (assetClass === 'stock' && market === 'KR') return 'KR_STOCK';
  if (assetClass === 'stock' && market === 'US') return 'US_STOCK';
  if (assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return null;
}

export function researchDirectionForCard(card, market) {
  const action = String(card?.action ?? '').toUpperCase();
  const direction = String(card?.direction ?? '').toUpperCase();
  if (market !== 'CRYPTO_FUTURES') return action === 'BUY' ? 'BUY' : null;
  if (action === 'LONG' || action === 'SHORT') return action;
  return direction === 'LONG' || direction === 'SHORT' ? direction : null;
}

function validRule(rule) {
  return rule && nonEmpty(rule.ruleId) && nonEmpty(rule.strategyId) && nonEmpty(rule.strategyVersion)
    && nonEmpty(rule.parameterHash) && Array.isArray(rule.atoms) && rule.atoms.length > 0
    && finite(rule.edgeR) && rule.edgeR > 0
    && finite(rule.stopAtrMultiple) && rule.stopAtrMultiple > 0
    && finite(rule.targetRiskMultiple) && rule.targetRiskMultiple >= 1
    && Number.isInteger(rule.horizonBars) && rule.horizonBars > 0
    && Number.isInteger(rule.sampleSize) && rule.sampleSize > 0
    && rule.executionAuthority === 'NONE'
    && rule.costPolicy?.source === 'EXPLICIT_RUNTIME_POLICY' && nonEmpty(rule.costPolicy?.id)
    && rule.costPolicy.market === rule.market
    && COST_FIELDS.every((field) => finite(rule.costPolicy[field]) && rule.costPolicy[field] >= 0)
    && (SUPPORTED[rule.market] ?? []).includes(rule.scannerTimeframe);
}

/** Fail-closed validation of the research export. */
export function validateResearchEvidence(value, nowMs, maximumAgeMs = RESEARCH_EVIDENCE_MAX_AGE_MS) {
  if (value?.contract !== RESEARCH_EVIDENCE_CONTRACT || value?.schemaVersion !== 1) {
    return Object.freeze({ status: 'BLOCKED_DATA', blocker: 'RESEARCH_EVIDENCE_CONTRACT_INVALID', rules: Object.freeze([]) });
  }
  if (value?.safety?.executionAuthority !== 'NONE' || value?.safety?.realOrder !== false) {
    return Object.freeze({ status: 'BLOCKED_DATA', blocker: 'RESEARCH_EVIDENCE_SAFETY_INVALID', rules: Object.freeze([]) });
  }
  if (!/^[0-9a-f]{40}$/u.test(String(value.researchCodeSha ?? ''))) {
    return Object.freeze({ status: 'BLOCKED_DATA', blocker: 'RESEARCH_EVIDENCE_SHA_INVALID', rules: Object.freeze([]) });
  }
  const generatedAtMs = Date.parse(String(value.generatedAt ?? ''));
  if (!finite(generatedAtMs) || generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > maximumAgeMs) {
    return Object.freeze({ status: 'BLOCKED_DATA', blocker: 'RESEARCH_EVIDENCE_STALE', rules: Object.freeze([]) });
  }
  const rules = (Array.isArray(value.rules) ? value.rules : []).filter(validRule)
    .map((rule) => Object.freeze({ ...rule, researchCodeSha: value.researchCodeSha }));
  return Object.freeze({ status: 'READY', blocker: null, rules: Object.freeze(rules), generatedAt: value.generatedAt });
}

export async function readResearchEvidence(file, nowMs) {
  if (!nonEmpty(file)) return Object.freeze({ status: 'DISABLED', blocker: null, rules: Object.freeze([]) });
  try {
    return validateResearchEvidence(JSON.parse(await readFile(path.resolve(file), 'utf8')), nowMs);
  } catch (error) {
    const blocker = error?.code === 'ENOENT' ? 'RESEARCH_EVIDENCE_MISSING'
      : error?.code === 'EACCES' ? 'RESEARCH_EVIDENCE_UNREADABLE' : 'RESEARCH_EVIDENCE_INVALID';
    return Object.freeze({ status: 'BLOCKED_DATA', blocker, rules: Object.freeze([]) });
  }
}

export function researchRulesFor(evidence, market, timeframe) {
  if (evidence?.status !== 'READY') return [];
  return evidence.rules.filter((rule) => rule.market === market && rule.scannerTimeframe === timeframe);
}

/** Drop an in-progress candle. Daily bars are stamped at the session open. */
export function closedCandles(candles, timeframe, nowMs) {
  const closeAfter = timeframe === '1D' ? (6.5 * HOUR) + (10 * 60_000) : HOUR;
  return candles.filter((row) => row.timestamp + closeAfter <= nowMs);
}

function lastBarFresh(candles, timeframe, nowMs) {
  const last = candles.at(-1)?.timestamp;
  if (!finite(last)) return false;
  return timeframe === '1D' ? nowMs - last <= 5 * DAY : nowMs - last <= 2 * HOUR + (10 * 60_000);
}

function atr14(candles) {
  if (candles.length < 15) return null;
  let value = null;
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1].close;
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev));
    if (i < 14) continue;
    if (value == null) {
      let sum = 0;
      for (let j = 1; j <= 14; j += 1) {
        const p = candles[j - 1].close;
        sum += Math.max(candles[j].high - candles[j].low, Math.abs(candles[j].high - p), Math.abs(candles[j].low - p));
      }
      value = sum / 14;
    } else {
      value = ((value * 13) + tr) / 14;
    }
  }
  return value;
}

export async function loadResearchCandles({ market, symbol, timeframe, nowMs = Date.now(), fetchImpl = globalThis.fetch }) {
  let rows;
  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    if (timeframe !== '1D') throw new Error('RESEARCH_TIMEFRAME_UNSUPPORTED');
    const history = await collectYahooStockHistory({ market, symbol, startTime: nowMs - (420 * DAY), endTime: nowMs, fetchImpl, timeoutMs: 8_000 });
    rows = history.candles;
  } else if (market === 'CRYPTO_FUTURES') {
    if (timeframe !== '60m') throw new Error('RESEARCH_TIMEFRAME_UNSUPPORTED');
    const history = await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl }), market, symbol, timeframe: '1h',
      startTime: Math.floor(nowMs - (420 * HOUR)), endTime: Math.floor(nowMs), maxCandles: 600, productType: 'usdt-futures' });
    rows = history.candles;
  } else {
    throw new Error('RESEARCH_MARKET_UNSUPPORTED');
  }
  return (rows ?? []).map((row) => ({ timestamp: Number(row.timestamp), open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? row.baseVolume ?? 0) }))
    .filter((row) => [row.timestamp, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) && row.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Which rules fire on the latest closed candle. Returns the research exit plan
 * (ATR stop, R-multiple target) priced from that candle.
 */
export function matchResearchRules(rules, rawCandles, { timeframe, nowMs }) {
  const candles = closedCandles(rawCandles, timeframe, nowMs);
  if (candles.length < 220) return Object.freeze({ status: 'INSUFFICIENT_CANDLES', matches: Object.freeze([]) });
  if (!lastBarFresh(candles, timeframe, nowMs)) return Object.freeze({ status: 'STALE_CANDLES', matches: Object.freeze([]) });
  const atoms = computeCombinationAtomsV1(candles, { timeframe: timeframe === '1D' ? '1d' : '1h' });
  const index = candles.length - 1;
  const close = candles[index].close;
  const atr = atr14(candles);
  if (!finite(atr) || atr <= 0) return Object.freeze({ status: 'ATR_UNAVAILABLE', matches: Object.freeze([]) });
  const matches = [];
  for (const rule of rules) {
    const fired = rule.atoms.every((id) => atoms.get(id)?.[index] === 1);
    if (!fired) continue;
    const stopDistance = atr * rule.stopAtrMultiple;
    const short = rule.direction === 'SHORT';
    matches.push(Object.freeze({
      rule,
      barTime: new Date(candles[index].timestamp).toISOString(),
      reference: close,
      stopPercent: (stopDistance / close) * 100,
      plan: Object.freeze({
        stopLoss: short ? close + stopDistance : close - stopDistance,
        target: short ? close - (stopDistance * rule.targetRiskMultiple) : close + (stopDistance * rule.targetRiskMultiple),
        horizonBars: rule.horizonBars,
      }),
    }));
  }
  // Highest edge first, deterministic.
  matches.sort((a, b) => (b.rule.edgeR - a.rule.edgeR) || a.rule.ruleId.localeCompare(b.rule.ruleId));
  return Object.freeze({ status: 'EVALUATED', matches: Object.freeze(matches) });
}

/** Canonical-adapter input backed by a matched research rule. */
export function researchAdapterInputForCard(card, timeframe, match) {
  const market = researchMarketForCard(card);
  const direction = market ? researchDirectionForCard(card, market) : null;
  const rule = match?.rule;
  if (!market || !direction || !rule || rule.market !== market || rule.direction !== direction || rule.scannerTimeframe !== timeframe) return null;
  if (!nonEmpty(card?.signalId)) return null;
  // Net edge in price percent under the research exits. KR tax is subtracted
  // once more on top of the modelled cost (conservative).
  const extraTax = market === 'KR_STOCK' ? rule.costPolicy.taxPercent : 0;
  const edgePercent = (rule.edgeR * match.stopPercent) - extraTax;
  if (!(finite(edgePercent) && edgePercent > 0)) return null;
  const costPolicy = Object.freeze(Object.fromEntries([
    ['id', rule.costPolicy.id], ['market', market], ['source', 'EXPLICIT_RUNTIME_POLICY'],
    ...COST_FIELDS.map((field) => [field, rule.costPolicy[field]]),
  ]));
  return Object.freeze({
    card,
    timeframe,
    paperIdentity: Object.freeze({
      signalId: card.signalId,
      strategyId: rule.strategyId,
      strategyVersion: rule.strategyVersion,
      parameterHash: rule.parameterHash,
      market,
      symbol: String(card.symbol).toUpperCase(),
      timeframe,
      horizon: rule.horizonBars,
      direction,
      costPolicyVersion: rule.costPolicy.id,
      researchCodeSha: rule.researchCodeSha,
      executionAuthority: 'NONE',
    }),
    profitEvidence: Object.freeze({
      status: 'READY',
      market,
      timeframe,
      direction,
      strategyVersion: rule.strategyVersion,
      costPolicyId: rule.costPolicy.id,
      expectedNetEdge: Number(edgePercent.toFixed(6)),
      expectedNetReturn: Number(edgePercent.toFixed(6)),
      riskRewardRatio: rule.targetRiskMultiple,
      sampleSize: rule.sampleSize,
      executionAuthority: 'NONE',
    }),
    costPolicy,
    validationTier: 'RESEARCH_CANDIDATE',
    researchEvidence: researchEvidenceSummary(match, edgePercent),
  });
}

/** Plain facts for the app/Telegram 근거 block. Ratios are decimals. */
export function researchEvidenceSummary(match, edgePercent) {
  const rule = match.rule;
  return Object.freeze({
    source: 'RESEARCH_COMBINATION_HOLDOUT_PASSED',
    ruleId: rule.ruleId,
    labels: Object.freeze([...(rule.labels ?? rule.atoms)]),
    barTime: match.barTime,
    expectedNetEdgePercent: Number(edgePercent.toFixed(4)),
    edgeR: rule.edgeR,
    validation: rule.validation ?? null,
    holdout: rule.holdout ?? null,
    sampleSize: rule.sampleSize,
    qValue: rule.qValue ?? null,
    researchSymbols: Object.freeze([...(rule.researchSymbols ?? [])]),
    plan: match.plan,
    fundingModelled: rule.fundingModelled !== false,
    researchCodeSha: rule.researchCodeSha,
  });
}

/**
 * Evaluate research rules for a batch of scanner cards. Only cards whose grade
 * is in `grades` are fetched (bounded by `maximumFetches`). Diagnostics count
 * matches per grade so the owner can see how often S-grade overlaps research.
 */
export async function researchInputsForCards(cards, { market, timeframe, evidence, nowMs = Date.now(), grades = ['S', 'A'],
  maximumFetches = 8, candleLoader = loadResearchCandles } = {}) {
  const rules = researchRulesFor(evidence, market, timeframe);
  const diagnostics = { status: evidence?.status ?? 'MISSING', blocker: evidence?.blocker ?? null, rules: rules.length,
    evaluated: 0, fetchFailures: 0, matchedByGrade: {}, skippedBudget: 0 };
  const inputs = new Map();
  if (rules.length === 0) return Object.freeze({ inputs, diagnostics: Object.freeze(diagnostics) });
  const candidates = (Array.isArray(cards) ? cards : [])
    .filter((card) => grades.includes(String(card?.signalGrade ?? '').toUpperCase()))
    .filter((card) => researchMarketForCard(card) === market)
    .sort((a, b) => String(a.signalGrade).localeCompare(String(b.signalGrade)));
  for (const card of candidates) {
    const direction = researchDirectionForCard(card, market);
    const own = rules.filter((rule) => rule.direction === direction);
    if (!own.length) continue;
    if (diagnostics.evaluated >= maximumFetches) { diagnostics.skippedBudget += 1; continue; }
    diagnostics.evaluated += 1;
    let candles;
    try { candles = await candleLoader({ market, symbol: card.symbol, timeframe, nowMs }); }
    catch { diagnostics.fetchFailures += 1; continue; }
    const result = matchResearchRules(own, candles, { timeframe, nowMs });
    const input = result.matches.map((match) => researchAdapterInputForCard(card, timeframe, match)).find(Boolean);
    if (!input) continue;
    const grade = String(card.signalGrade).toUpperCase();
    diagnostics.matchedByGrade[grade] = (diagnostics.matchedByGrade[grade] ?? 0) + 1;
    inputs.set(card.signalId, input);
  }
  return Object.freeze({ inputs, diagnostics: Object.freeze(diagnostics) });
}
