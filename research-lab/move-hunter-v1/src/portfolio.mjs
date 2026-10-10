import {
  DIRECTIONS,
  RUNNER_RESEARCH_PRESETS,
  simulateRunner,
} from './engine.mjs';

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}
function unit(value, name) {
  finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be within [0,1]`);
  return value;
}
function sideCostRate({ feeBps = 0, slippageBps = 0, spreadBps = 0 } = {}) {
  return (feeBps + slippageBps + (spreadBps / 2)) / 10_000;
}
function themeOf(candidate) {
  const raw = candidate?.theme?.primary ?? candidate?.theme ?? candidate?.themeId ?? 'NONE';
  return String(raw || 'NONE');
}
function symbolOf(candidate) {
  return String(candidate?.symbol ?? candidate?.ticker ?? '').trim().toUpperCase();
}
function directionOf(candidate) {
  const raw = String(candidate?.direction ?? candidate?.action ?? 'LONG').trim().toUpperCase();
  if (raw === 'LONG' || raw === 'BUY') return DIRECTIONS.LONG;
  if (raw === 'SHORT' || raw === 'SELL') return DIRECTIONS.SHORT;
  return null;
}
function signalTimeOf(candidate) {
  const value = Number(candidate?.signalAtMs ?? candidate?.signalTimestamp ?? candidate?.asOfMs);
  return Number.isFinite(value) ? value : null;
}
function priorityOf(candidate) {
  const explicit = Number(candidate?.priorityScore);
  if (Number.isFinite(explicit)) return explicit;
  const momentum = Number(candidate?.decision?.momentum?.score);
  if (Number.isFinite(momentum)) return momentum;
  const score = Number(candidate?.score);
  if (Number.isFinite(score)) return score;
  return 0;
}
function rvolOf(candidate) {
  const value = Number(candidate?.rvol ?? candidate?.features?.rvol);
  return Number.isFinite(value) ? value : 0;
}

export function replayLongCashRunnerPortfolio({
  candidates,
  candlesBySymbol,
  runnerControlBySymbol = {},
  indicatorExitEnabled = false,
  presetName = 'LONG_RUNNER_3ATR',
  costs = { feeBps: 15 },
  initialCapital = 10_000_000,
  riskFraction = 0.005,
  aggregateInitialRiskCap = 0.02,
  maxPositions = 5,
  symbolExposureCap = 0.20,
  themeExposureCap = 0.40,
  maxGrossExposure = 1.0,
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (!candlesBySymbol || typeof candlesBySymbol !== 'object') throw new TypeError('candlesBySymbol is required');
  const preset = RUNNER_RESEARCH_PRESETS[presetName];
  if (!preset) throw new RangeError('unknown Runner preset');
  positive(initialCapital, 'initialCapital');
  unit(riskFraction, 'riskFraction');
  unit(aggregateInitialRiskCap, 'aggregateInitialRiskCap');
  unit(symbolExposureCap, 'symbolExposureCap');
  unit(themeExposureCap, 'themeExposureCap');
  unit(maxGrossExposure, 'maxGrossExposure');
  if (!Number.isSafeInteger(maxPositions) || maxPositions < 1) throw new RangeError('maxPositions invalid');

  const oneSideCost = sideCostRate(costs);
  const rejectionCounts = {};
  const reject = (reason) => { rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1; };

  const planned = [];
  for (const candidate of candidates) {
    const symbol = symbolOf(candidate);
    const direction = directionOf(candidate);
    const signalAtMs = signalTimeOf(candidate);
    if (!symbol || signalAtMs === null) { reject('CANDIDATE_IDENTITY_INVALID'); continue; }
    if (direction !== DIRECTIONS.LONG) { reject('SHORT_REQUIRES_FUTURES_MARGIN_ADAPTER'); continue; }
    const candles = candlesBySymbol[symbol];
    if (!Array.isArray(candles)) { reject('CANDLES_MISSING'); continue; }
    try {
      const trial = simulateRunner({
        candles,
        signalAtMs,
        direction,
        ...preset,
        runnerControlByTs: runnerControlBySymbol?.[symbol] ?? null,
        indicatorExitEnabled,
        costs,
      });
      planned.push(Object.freeze({
        candidate,
        symbol,
        theme: themeOf(candidate),
        priority: priorityOf(candidate),
        rvol: rvolOf(candidate),
        trial,
      }));
    } catch {
      reject('RUNNER_PLAN_BLOCKED');
    }
  }

  const entries = new Map();
  for (const row of planned) {
    const bucket = entries.get(row.trial.entryTs) ?? [];
    bucket.push(row);
    entries.set(row.trial.entryTs, bucket);
  }
  for (const bucket of entries.values()) {
    bucket.sort((a, b) =>
      b.priority - a.priority
      || b.rvol - a.rvol
      || a.symbol.localeCompare(b.symbol));
  }

  const rowMaps = new Map();
  const timestamps = new Set();
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    if (!Array.isArray(candles)) continue;
    const map = new Map();
    for (const candle of candles) {
      map.set(candle.ts, candle);
      timestamps.add(candle.ts);
    }
    rowMaps.set(symbol, map);
  }
  const orderedTimes = [...timestamps].sort((a, b) => a - b);
  const lastPrice = new Map();
  const positions = new Map();
  const ledger = [];
  const equityCurve = [];
  let cash = initialCapital;
  let fees = 0;
  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  let maxGrossObserved = 0;
  let minCash = initialCapital;

  const mark = (symbol, ts, field) => rowMaps.get(symbol)?.get(ts)?.[field] ?? lastPrice.get(symbol) ?? null;
  const account = (ts, field) => {
    let equity = cash;
    let gross = 0;
    let initialRisk = 0;
    const themeGross = new Map();
    for (const [symbol, position] of positions) {
      const price = mark(symbol, ts, field) ?? position.trial.entry;
      const value = position.quantity * price;
      equity += value;
      gross += value;
      initialRisk += position.quantity * Math.abs(position.trial.entry - position.trial.initialStop);
      themeGross.set(position.theme, (themeGross.get(position.theme) ?? 0) + value);
    }
    return { equity, gross, initialRisk, themeGross };
  };

  for (const ts of orderedTimes) {
    for (const [symbol, map] of rowMaps) {
      const candle = map.get(ts);
      if (candle) lastPrice.set(symbol, candle.open);
    }

    // Conservative ordering: same-bar intrabar exits do not fund entries at this bar open.
    for (const plannedEntry of entries.get(ts) ?? []) {
      if (positions.has(plannedEntry.symbol)) { reject('SYMBOL_ALREADY_OPEN'); continue; }
      if (positions.size >= maxPositions) { reject('POSITION_CAP'); continue; }
      const state = account(ts, 'open');
      const riskPerUnit = Math.abs(plannedEntry.trial.entry - plannedEntry.trial.initialStop);
      if (!(riskPerUnit > 0)) { reject('INVALID_INITIAL_RISK'); continue; }

      const riskBudget = state.equity * riskFraction;
      const aggregateRiskRoom = Math.max(0, state.equity * aggregateInitialRiskCap - state.initialRisk);
      const symbolRoom = Math.max(0, state.equity * symbolExposureCap);
      const themeRoom = Math.max(0, state.equity * themeExposureCap - (state.themeGross.get(plannedEntry.theme) ?? 0));
      const grossRoom = Math.max(0, state.equity * maxGrossExposure - state.gross);
      const cashRoom = Math.max(0, cash / (1 + oneSideCost));
      const riskNotional = (riskBudget / riskPerUnit) * plannedEntry.trial.entry;
      const aggregateRiskNotional = (aggregateRiskRoom / riskPerUnit) * plannedEntry.trial.entry;
      const notional = Math.min(
        riskNotional,
        aggregateRiskNotional,
        symbolRoom,
        themeRoom,
        grossRoom,
        cashRoom,
      );
      if (!(notional > 0)) { reject('CAPACITY_ZERO'); continue; }

      const quantity = notional / plannedEntry.trial.entry;
      const entryFee = notional * oneSideCost;
      cash -= notional + entryFee;
      fees += entryFee;
      positions.set(plannedEntry.symbol, Object.freeze({
        ...plannedEntry,
        quantity,
        entryNotional: notional,
        entryFee,
      }));
      reject('ACCEPTED');
    }

    for (const [symbol, position] of [...positions]) {
      if (position.trial.exitTs !== ts) continue;
      const grossExit = position.quantity * position.trial.exitPrice;
      const exitFee = grossExit * oneSideCost;
      fees += exitFee;
      cash += grossExit - exitFee;
      const pnl = (grossExit - exitFee) - (position.entryNotional + position.entryFee);
      ledger.push(Object.freeze({
        symbol,
        theme: position.theme,
        sourceSignalId: position.candidate?.id ?? position.candidate?.signalId ?? null,
        entryTs: position.trial.entryTs,
        exitTs: position.trial.exitTs,
        entryPrice: position.trial.entry,
        exitPrice: position.trial.exitPrice,
        initialStop: position.trial.initialStop,
        quantity: position.quantity,
        pnl,
        netReturn: pnl / (position.entryNotional + position.entryFee),
        mfe: position.trial.mfe,
        mae: position.trial.mae,
        grossCaptureRatio: position.trial.grossCaptureRatio,
        netCaptureRatio: position.trial.netCaptureRatio,
        givebackFromPeak: position.trial.givebackFromPeak,
        exitReason: position.trial.exitReason,
      }));
      positions.delete(symbol);
    }

    for (const [symbol, map] of rowMaps) {
      const candle = map.get(ts);
      if (candle) lastPrice.set(symbol, candle.close);
    }
    const state = account(ts, 'close');
    peakEquity = Math.max(peakEquity, state.equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? 1 - (state.equity / peakEquity) : 0);
    maxGrossObserved = Math.max(maxGrossObserved, state.equity > 0 ? state.gross / state.equity : 0);
    minCash = Math.min(minCash, cash);
    equityCurve.push(Object.freeze({ ts, equity: state.equity, cash, positions: positions.size }));
  }

  const lastTs = orderedTimes.at(-1) ?? null;
  if (lastTs !== null) {
    for (const [symbol, position] of [...positions]) {
      const price = mark(symbol, lastTs, 'close') ?? position.trial.entry;
      const grossExit = position.quantity * price;
      const exitFee = grossExit * oneSideCost;
      fees += exitFee;
      cash += grossExit - exitFee;
      const pnl = (grossExit - exitFee) - (position.entryNotional + position.entryFee);
      ledger.push(Object.freeze({
        symbol,
        theme: position.theme,
        sourceSignalId: position.candidate?.id ?? position.candidate?.signalId ?? null,
        entryTs: position.trial.entryTs,
        exitTs: lastTs,
        entryPrice: position.trial.entry,
        exitPrice: price,
        initialStop: position.trial.initialStop,
        quantity: position.quantity,
        pnl,
        netReturn: pnl / (position.entryNotional + position.entryFee),
        mfe: position.trial.mfe,
        mae: position.trial.mae,
        grossCaptureRatio: position.trial.grossCaptureRatio,
        netCaptureRatio: position.trial.netCaptureRatio,
        givebackFromPeak: position.trial.givebackFromPeak,
        exitReason: 'PORTFOLIO_WINDOW_END',
      }));
      positions.delete(symbol);
    }
  }

  const wins = ledger.filter((row) => row.pnl > 0);
  const losses = ledger.filter((row) => row.pnl < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = -losses.reduce((sum, row) => sum + row.pnl, 0);
  return Object.freeze({
    schemaVersion: 'move-hunter-long-cash-portfolio-replay/v1',
    presetName,
    initialCapital,
    endingCapital: cash,
    netReturn: (cash / initialCapital) - 1,
    tradeCount: ledger.length,
    winRate: ledger.length ? wins.length / ledger.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    maxGrossObserved,
    minCash,
    fees,
    rejectionCounts: Object.freeze({ ...rejectionCounts }),
    ledger: Object.freeze(ledger),
    equityCurve: Object.freeze(equityCurve),
    assumptions: Object.freeze({
      riskFraction,
      aggregateInitialRiskCap,
      maxPositions,
      symbolExposureCap,
      themeExposureCap,
      maxGrossExposure,
      sameBarExitDoesNotFundSameOpenEntry: true,
      fractionalUnits: true,
      marginTrading: false,
      shortTrading: false,
      actualFills: false,
      indicatorAdaptiveRunnerSupported: true,
      indicatorForcedExitDefaultEnabled: false,
      historicalReplayOnly: true,
    }),
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
