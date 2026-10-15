// Exports combination-search rules that passed BOTH the multiple-testing
// validation (SURVIVOR) and the one-time sealed 2026 holdout as read-only
// evidence for the Signal Intelligence V3 scanner. The scanner may only use a
// rule when the rule's exact conditions fire on the scanned symbol's latest
// closed candle. This file never grants execution authority.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { RESEARCH_LANES_V2 } from './autonomous-research-discovery-v2.mjs';
import { COMBINATION_ATOM_LIBRARY_VERSION, combinationAtomV1 } from './combination-atoms-v1.mjs';
import {
  COMBINATION_EXIT_PROFILES_V1,
  COMBINATION_POLICY_V1,
  COMBINATION_UNIVERSE_V1,
  LANE_DATA_SOURCE_V1,
  classifyLaneTrialsV1,
} from './combination-search-lane-v1.mjs';

export const COMBINATION_SIGNAL_EVIDENCE_CONTRACT_V1 = 'combination-signal-evidence/v1';
// The backtests size every trade to risk 1% of equity, so a per-trade equity
// return divided by 0.01 is the net edge in R (multiples of the stop distance).
export const COMBINATION_RISK_PER_TRADE_V1 = 0.01;

const SCANNER_TIMEFRAME = Object.freeze({ '1h': '60m', '1d': '1D' });

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export function combinationSignalEvidencePathV1(stateRoot) {
  return join(resolve(String(stateRoot)), 'latest', 'combination-signal-evidence-v1.json');
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function scannerDirection(lane) {
  if (lane.market === 'CRYPTO_FUTURES') return lane.direction;
  return lane.direction === 'LONG' ? 'BUY' : null;
}

/** Percent-unit cost policy as the research backtest modelled it (per side). */
function costPolicyFor(lane) {
  const cost = lane.cost ?? {};
  // KR single stocks pay 0.15% transaction tax; scanner cards are mostly single
  // stocks, so the KR policy always carries it (conservative for ETFs).
  const taxRate = lane.market === 'KR_STOCK' ? 0.0015 : Number(cost.taxRate ?? 0);
  return Object.freeze({
    id: `COMBINATION_${lane.market}_COST_V1`,
    market: lane.market,
    source: 'EXPLICIT_RUNTIME_POLICY',
    commissionPercent: round((Number(cost.entryFeeRate ?? 0) + Number(cost.exitFeeRate ?? 0)) * 100, 6),
    taxPercent: round(taxRate * 100, 6),
    spreadPercent: round(Number(cost.spreadRate ?? 0) * 100, 6),
    slippagePercent: round(Number(cost.slippageRate ?? 0) * 100, 6),
    // Not modelled by the research backtest; recorded as 0 and flagged below.
    fundingPercent: 0,
    latencyPercent: 0,
    liquidityImpactPercent: 0,
    partialFillImpactPercent: 0,
  });
}

/** One rule per SURVIVOR whose sealed holdout passed. */
export function combinationSignalRulesForLaneV1({ lane, laneState, policy = COMBINATION_POLICY_V1 }) {
  if (!lane || !laneState?.trials) return [];
  if (laneState.atomLibraryVersion !== COMBINATION_ATOM_LIBRARY_VERSION) return [];
  const direction = scannerDirection(lane);
  const scannerTimeframe = SCANNER_TIMEFRAME[lane.timeframe];
  if (!direction || !scannerTimeframe) return [];
  const symbols = String(laneState.symbolKey ?? '').split('|')[0].split(',').filter(Boolean);
  const classified = classifyLaneTrialsV1(laneState.trials, { symbolCount: symbols.length, baselines: laneState.baselines ?? {}, policy });
  const rules = [];
  for (const row of classified) {
    const holdout = laneState.holdout?.[row.trialId];
    if (row.finalStatus !== 'SURVIVOR' || holdout?.pass !== true) continue;
    const exit = COMBINATION_EXIT_PROFILES_V1.find((profile) => profile.id === row.exitId);
    if (!exit) continue;
    const conservativeMean = Math.min(Number(row.validation?.meanReturn), Number(holdout.result?.meanReturn));
    const edgeR = conservativeMean / COMBINATION_RISK_PER_TRADE_V1;
    if (!(Number.isFinite(edgeR) && edgeR > 0)) continue;
    const parameters = { atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION, laneId: lane.id, atoms: [...row.atoms].sort(), exitId: row.exitId };
    rules.push(Object.freeze({
      ruleId: row.trialId,
      laneId: lane.id,
      market: lane.market,
      direction,
      researchTimeframe: lane.timeframe,
      scannerTimeframe,
      atoms: Object.freeze([...row.atoms]),
      labels: Object.freeze(row.atoms.map((id) => combinationAtomV1(id).label)),
      exitId: row.exitId,
      stopAtrMultiple: exit.stopAtrMultiple,
      targetRiskMultiple: exit.targetRiskMultiple,
      horizonBars: lane.timeBars * exit.timeBarsFactor,
      strategyId: 'COMBINATION_RESEARCH',
      strategyVersion: `COMBINATION:${row.trialId}`,
      parameterHash: sha256(parameters),
      costPolicy: costPolicyFor(lane),
      fundingModelled: false,
      edgeR: round(edgeR, 6),
      sampleSize: Number(row.validation?.trades ?? 0) + Number(holdout.result?.trades ?? 0),
      qValue: row.qValue,
      validation: Object.freeze({ trades: row.validation.trades, meanReturn: row.validation.meanReturn, winRate: row.validation.winRate, profitFactor: row.validation.profitFactor }),
      holdout: Object.freeze({ trades: holdout.result.trades, meanReturn: holdout.result.meanReturn, winRate: holdout.result.winRate, period: holdout.period }),
      researchSymbols: Object.freeze(symbols),
      executionAuthority: 'NONE',
    }));
  }
  return rules;
}

export async function buildCombinationSignalEvidenceV1({ stateRoot, researchCodeSha = null, observedAt, lanes = RESEARCH_LANES_V2, policy = COMBINATION_POLICY_V1 }) {
  const root = resolve(String(stateRoot));
  const rules = [];
  for (const lane of lanes) {
    if (!LANE_DATA_SOURCE_V1[lane.id] || !COMBINATION_UNIVERSE_V1[LANE_DATA_SOURCE_V1[lane.id]]) continue;
    const laneState = await readJson(join(root, 'combination-research', 'lanes', lane.id, 'state.json'));
    rules.push(...combinationSignalRulesForLaneV1({ lane, laneState, policy }));
  }
  return Object.freeze({
    schemaVersion: 1,
    contract: COMBINATION_SIGNAL_EVIDENCE_CONTRACT_V1,
    generatedAt: observedAt,
    researchCodeSha: /^[0-9a-f]{40}$/u.test(String(researchCodeSha ?? '')) ? researchCodeSha : null,
    atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
    riskPerTrade: COMBINATION_RISK_PER_TRADE_V1,
    rules: Object.freeze(rules),
    safety: Object.freeze({ researchEvidenceOnly: true, liveTrading: false, realOrder: false, executionAuthority: 'NONE' }),
  });
}

export async function writeCombinationSignalEvidenceV1(stateRoot, evidence) {
  const path = combinationSignalEvidencePathV1(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
