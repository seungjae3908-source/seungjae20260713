import { createHash } from "node:crypto";

import {
  assertFormulaCandidateV1,
  canonicalSerializeStrategyFormulaV1,
} from "./autonomous-strategy-formula-generator-v1.js";

export const EVIDENCE_BACKED_FORMULA_ENTRY_EVALUATOR_VERSION = 1;

const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const SUPPORTED_INDICATORS = new Set(["EMA", "ADX", "ROC", "RVOL", "BREAKOUT", "RSI"]);
const SUPPORTED_OPERATORS = new Set(["GT", "LT", "CROSSOVER"]);
const REQUIRED_EXIT_TYPES = Object.freeze(["ATR_STOP", "TARGET", "TIME_EXIT"]);
const HASH64 = /^[0-9a-f]{64}$/u;

export class FormulaEntryEvaluatorError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "FormulaEntryEvaluatorError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details = {}) {
  throw new FormulaEntryEvaluatorError(code, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function finite(value, code, details = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, { ...details, value });
  return value;
}

function positiveInteger(value, code, details = {}) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, { ...details, value });
  return value;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parameterIdentity(formulaHash, selectedParameters) {
  return createHash("sha256")
    .update(canonicalSerializeStrategyFormulaV1({ formulaHash, selectedParameters }), "utf8")
    .digest("hex");
}

function validateSelectedParameters(formulaCandidate, generatedCandidate) {
  if (!generatedCandidate || generatedCandidate.formulaCandidateId !== formulaCandidate.candidateId
    || generatedCandidate.formulaHash !== formulaCandidate.formulaHash
    || !HASH64.test(generatedCandidate.parameterIdentity ?? "")) {
    fail("GENERATED_CANDIDATE_IDENTITY_INVALID");
  }
  if (generatedCandidate.safety?.executionAuthority !== "NONE") fail("GENERATED_CANDIDATE_EXECUTION_AUTHORITY_INVALID");
  const selected = generatedCandidate.selectedParameters;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) fail("SELECTED_PARAMETERS_REQUIRED");
  const schema = new Map(formulaCandidate.parameterSpace.map((row) => [row.name, row]));
  const names = Object.keys(selected).sort();
  const expected = [...schema.keys()].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail("SELECTED_PARAMETER_SHAPE_MISMATCH", { names, expected });
  }
  for (const [name, value] of Object.entries(selected)) {
    const spec = schema.get(name);
    finite(value, "SELECTED_PARAMETER_NON_FINITE", { name });
    if (value < spec.min || value > spec.max) fail("SELECTED_PARAMETER_OUT_OF_BOUNDS", { name, value });
    const steps = (value - spec.min) / spec.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-8) fail("SELECTED_PARAMETER_OFF_GRID", { name, value });
    if (spec.valueType === "INTEGER" && !Number.isSafeInteger(value)) fail("SELECTED_PARAMETER_INTEGER_REQUIRED", { name, value });
  }
  const frozen = Object.freeze({ ...selected });
  const expectedIdentity = parameterIdentity(formulaCandidate.formulaHash, frozen);
  if (generatedCandidate.parameterIdentity !== expectedIdentity) {
    fail("PARAMETER_IDENTITY_MISMATCH", {
      expectedParameterIdentity: expectedIdentity,
      actualParameterIdentity: generatedCandidate.parameterIdentity,
    });
  }
  return frozen;
}

function validateFormulaScope(formulaCandidate) {
  assertFormulaCandidateV1(formulaCandidate);
  if (!CASH_MARKETS.has(formulaCandidate.market)) {
    fail("DERIVATIVES_FORMULA_EVALUATOR_NOT_ENABLED", { market: formulaCandidate.market });
  }
  if (formulaCandidate.direction !== "LONG" || formulaCandidate.entryDsl?.action !== "LONG") {
    fail("READY_CASH_FORMULA_MUST_BE_LONG_ONLY", { direction: formulaCandidate.direction });
  }
  if (formulaCandidate.safety?.executionAuthority !== "NONE") fail("FORMULA_EXECUTION_AUTHORITY_INVALID");
  return formulaCandidate;
}

function validateCandle(candle, index, previous = null) {
  if (!candle || typeof candle !== "object") fail("CANDLE_INVALID", { index });
  const timestamp = candle.timestamp;
  if (!Number.isSafeInteger(timestamp)) fail("CANDLE_TIMESTAMP_INVALID", { index, timestamp });
  for (const field of ["open", "high", "low", "close", "volume"]) finite(candle[field], "CANDLE_NON_FINITE", { index, field });
  if (!(candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0) || candle.volume < 0) {
    fail("CANDLE_VALUE_INVALID", { index });
  }
  if (candle.high < candle.low || candle.open > candle.high || candle.open < candle.low || candle.close > candle.high || candle.close < candle.low) {
    fail("CANDLE_OHLC_INCONSISTENT", { index });
  }
  if (previous && timestamp <= previous.timestamp) fail("CANDLE_TIMESTAMP_NOT_STRICTLY_ASCENDING", { index, timestamp });
}

function parameterValue(node, selectedParameters) {
  if (node?.kind !== "PARAMETER" || typeof node.name !== "string" || !Object.hasOwn(selectedParameters, node.name)) {
    fail("PARAMETER_NODE_INVALID", { node });
  }
  return selectedParameters[node.name];
}

function indicatorPeriod(node, selectedParameters) {
  const name = node?.parameters?.period;
  if (typeof name !== "string" || !Object.hasOwn(selectedParameters, name)) fail("INDICATOR_PERIOD_PARAMETER_INVALID", { indicator: node?.name });
  return positiveInteger(selectedParameters[name], "INDICATOR_PERIOD_INVALID", { indicator: node?.name, parameter: name });
}

function rsiValue(averageGain, averageLoss) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function newSeriesState(name, period) {
  return {
    name,
    period,
    values: [],
    builtThrough: -1,
    emaCurrent: null,
    emaSeedSum: 0,
    rsiGainSum: 0,
    rsiLossSum: 0,
    rsiAverageGain: null,
    rsiAverageLoss: null,
    adxTrSmooth: 0,
    adxPlusSmooth: 0,
    adxMinusSmooth: 0,
    adxDxSeed: [],
    adxCurrent: null,
  };
}

function directionalComponents(candles, index) {
  const current = candles[index];
  const previous = candles[index - 1];
  const trueRange = Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
  const upMove = current.high - previous.high;
  const downMove = previous.low - current.low;
  return {
    trueRange,
    plusDm: upMove > downMove && upMove > 0 ? upMove : 0,
    minusDm: downMove > upMove && downMove > 0 ? downMove : 0,
  };
}

function adxDx(tr, plus, minus) {
  if (!(tr > 0)) return 0;
  const plusDi = 100 * (plus / tr);
  const minusDi = 100 * (minus / tr);
  const denominator = plusDi + minusDi;
  return denominator === 0 ? 0 : 100 * (Math.abs(plusDi - minusDi) / denominator);
}

function extendSeries(state, candles, targetIndex) {
  const period = state.period;
  for (let index = state.builtThrough + 1; index <= targetIndex; index += 1) {
    let value = null;
    if (state.name === "EMA") {
      if (index < period) state.emaSeedSum += candles[index].close;
      if (index === period - 1) {
        state.emaCurrent = state.emaSeedSum / period;
        value = state.emaCurrent;
      } else if (index >= period) {
        const multiplier = 2 / (period + 1);
        state.emaCurrent = ((candles[index].close - state.emaCurrent) * multiplier) + state.emaCurrent;
        value = state.emaCurrent;
      }
    } else if (state.name === "RSI") {
      if (index > 0) {
        const delta = candles[index].close - candles[index - 1].close;
        const gain = Math.max(delta, 0);
        const loss = Math.max(-delta, 0);
        if (index <= period) {
          state.rsiGainSum += gain;
          state.rsiLossSum += loss;
          if (index === period) {
            state.rsiAverageGain = state.rsiGainSum / period;
            state.rsiAverageLoss = state.rsiLossSum / period;
            value = rsiValue(state.rsiAverageGain, state.rsiAverageLoss);
          }
        } else {
          state.rsiAverageGain = ((state.rsiAverageGain * (period - 1)) + gain) / period;
          state.rsiAverageLoss = ((state.rsiAverageLoss * (period - 1)) + loss) / period;
          value = rsiValue(state.rsiAverageGain, state.rsiAverageLoss);
        }
      }
    } else if (state.name === "ROC") {
      if (index >= period) {
        const previous = candles[index - period].close;
        value = previous === 0 ? null : (candles[index].close / previous) - 1;
      }
    } else if (state.name === "RVOL") {
      if (index >= period) {
        const priorVolumes = candles.slice(index - period, index).map((candle) => candle.volume);
        const average = mean(priorVolumes);
        value = average > 0 ? candles[index].volume / average : null;
      }
    } else if (state.name === "BREAKOUT") {
      if (index >= period) {
        const priorHighClose = Math.max(...candles.slice(index - period, index).map((candle) => candle.close));
        value = candles[index].close > priorHighClose ? 1 : 0;
      }
    } else if (state.name === "ADX") {
      if (index > 0) {
        const directional = directionalComponents(candles, index);
        if (index <= period) {
          state.adxTrSmooth += directional.trueRange;
          state.adxPlusSmooth += directional.plusDm;
          state.adxMinusSmooth += directional.minusDm;
          if (index === period) {
            state.adxDxSeed.push(adxDx(state.adxTrSmooth, state.adxPlusSmooth, state.adxMinusSmooth));
          }
        } else {
          state.adxTrSmooth = state.adxTrSmooth - (state.adxTrSmooth / period) + directional.trueRange;
          state.adxPlusSmooth = state.adxPlusSmooth - (state.adxPlusSmooth / period) + directional.plusDm;
          state.adxMinusSmooth = state.adxMinusSmooth - (state.adxMinusSmooth / period) + directional.minusDm;
          const dx = adxDx(state.adxTrSmooth, state.adxPlusSmooth, state.adxMinusSmooth);
          if (state.adxCurrent === null) {
            state.adxDxSeed.push(dx);
            if (state.adxDxSeed.length === period) {
              state.adxCurrent = mean(state.adxDxSeed);
              value = state.adxCurrent;
            }
          } else {
            state.adxCurrent = ((state.adxCurrent * (period - 1)) + dx) / period;
            value = state.adxCurrent;
          }
        }
      }
    } else {
      fail("INDICATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR", { indicator: state.name });
    }
    state.values[index] = Number.isFinite(value) ? value : null;
    state.builtThrough = index;
  }
}

function createEntryRuntime({ entryDsl, selectedParameters }) {
  if (!entryDsl || entryDsl.action !== "LONG" || !Array.isArray(entryDsl.rules) || entryDsl.rules.length === 0) {
    fail("ENTRY_DSL_NOT_SUPPORTED");
  }
  let candleReference = null;
  let validatedThrough = -1;
  const series = new Map();

  function ensurePrefix(candles, index) {
    if (!Array.isArray(candles) || index < 0 || index >= candles.length) fail("EVALUATION_INDEX_INVALID", { index });
    if (candles !== candleReference) {
      candleReference = candles;
      validatedThrough = -1;
      series.clear();
    }
    for (let cursor = validatedThrough + 1; cursor <= index; cursor += 1) {
      validateCandle(candles[cursor], cursor, cursor > 0 ? candles[cursor - 1] : null);
      validatedThrough = cursor;
    }
  }

  function indicatorValue(node, candles, index) {
    if (!node || node.kind !== "INDICATOR" || !SUPPORTED_INDICATORS.has(node.name)) {
      fail("INDICATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR", { indicator: node?.name });
    }
    if (node.lag !== 1) fail("INDICATOR_SYSTEM_LAG_INVALID", { indicator: node.name, lag: node.lag });
    const period = indicatorPeriod(node, selectedParameters);
    const key = `${node.name}:${period}`;
    if (!series.has(key)) series.set(key, newSeriesState(node.name, period));
    const state = series.get(key);
    if (state.builtThrough < index) extendSeries(state, candles, index);
    return state.values[index] ?? null;
  }

  function operandValue(node, candles, index) {
    if (node?.kind === "PARAMETER") return parameterValue(node, selectedParameters);
    if (node?.kind === "INDICATOR") return indicatorValue(node, candles, index);
    fail("OPERAND_NODE_NOT_SUPPORTED", { kind: node?.kind });
  }

  function ruleValue(rule, candles, index) {
    if (!rule || rule.kind !== "OPERATOR" || !SUPPORTED_OPERATORS.has(rule.operator)) {
      fail("OPERATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR", { operator: rule?.operator });
    }
    if (!Array.isArray(rule.operands) || rule.operands.length !== 2) fail("OPERATOR_ARITY_INVALID", { operator: rule.operator });
    if (rule.operator === "CROSSOVER") {
      if (index < 1) return null;
      const leftNow = operandValue(rule.operands[0], candles, index);
      const rightNow = operandValue(rule.operands[1], candles, index);
      const leftPrevious = operandValue(rule.operands[0], candles, index - 1);
      const rightPrevious = operandValue(rule.operands[1], candles, index - 1);
      if (![leftNow, rightNow, leftPrevious, rightPrevious].every(Number.isFinite)) return null;
      return leftPrevious <= rightPrevious && leftNow > rightNow;
    }
    const left = operandValue(rule.operands[0], candles, index);
    const right = operandValue(rule.operands[1], candles, index);
    if (![left, right].every(Number.isFinite)) return null;
    if (rule.operator === "GT") return left > right;
    if (rule.operator === "LT") return left < right;
    fail("OPERATOR_NOT_SUPPORTED_BY_EVIDENCE_BACKED_EVALUATOR", { operator: rule.operator });
  }

  return Object.freeze({
    evaluate({ candles, index } = {}) {
      ensurePrefix(candles, index);
      const results = entryDsl.rules.map((rule) => ruleValue(rule, candles, index));
      if (results.some((value) => value === null)) {
        return deepFreeze({ status: "INSUFFICIENT_HISTORY", signal: false, index, timestamp: candles[index].timestamp });
      }
      return deepFreeze({ status: "EVALUATED", signal: results.every(Boolean), index, timestamp: candles[index].timestamp });
    },
  });
}

export function createEvidenceBackedFormulaEntryRuntimeV1({ entryDsl, selectedParameters } = {}) {
  if (!selectedParameters || typeof selectedParameters !== "object" || Array.isArray(selectedParameters)) fail("SELECTED_PARAMETERS_REQUIRED");
  return createEntryRuntime({ entryDsl, selectedParameters: Object.freeze({ ...selectedParameters }) });
}

export function createEvidenceBackedFormulaEvaluatorContractV1({ formulaCandidate } = {}) {
  validateFormulaScope(formulaCandidate);
  return deepFreeze({
    schemaVersion: EVIDENCE_BACKED_FORMULA_ENTRY_EVALUATOR_VERSION,
    source: "CANONICAL_SAFE_DSL_INTERPRETER",
    arbitraryExecutableCodeAllowed: false,
    formulaHash: formulaCandidate.formulaHash,
    closedCandleSignalOnly: true,
    entryUsesNextCandleOpen: true,
    indicatorLagBarsFromExecution: 1,
    supportedMarkets: [...CASH_MARKETS].sort(),
    supportedIndicators: [...SUPPORTED_INDICATORS].sort(),
    supportedOperators: [...SUPPORTED_OPERATORS].sort(),
    derivativesEnabled: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
}

export function buildEvidenceBackedFormulaExecutionParametersV1({ formulaCandidate, generatedCandidate } = {}) {
  validateFormulaScope(formulaCandidate);
  const selected = validateSelectedParameters(formulaCandidate, generatedCandidate);
  const rules = formulaCandidate.exitDsl?.rules;
  if (!Array.isArray(rules) || rules.length !== REQUIRED_EXIT_TYPES.length) fail("EXIT_DSL_NOT_SUPPORTED");
  const byType = new Map();
  for (const rule of rules) {
    if (!REQUIRED_EXIT_TYPES.includes(rule?.type) || byType.has(rule.type)) fail("EXIT_DSL_NOT_SUPPORTED", { type: rule?.type });
    byType.set(rule.type, rule);
  }
  if (REQUIRED_EXIT_TYPES.some((type) => !byType.has(type))) fail("EXIT_DSL_NOT_SUPPORTED");
  const atrStop = byType.get("ATR_STOP");
  if (atrStop.atrIndicator?.name !== "ATR" || atrStop.atrIndicator?.lag !== 1) fail("ATR_STOP_DSL_INVALID");
  const atrPeriodName = atrStop.atrIndicator?.parameters?.period;
  const atrStopName = atrStop.multiplierParameter;
  const targetName = byType.get("TARGET").distanceParameter;
  const timeBarsName = byType.get("TIME_EXIT").barsParameter;
  for (const name of [atrPeriodName, atrStopName, targetName, timeBarsName]) {
    if (typeof name !== "string" || !Object.hasOwn(selected, name)) fail("EXIT_PARAMETER_BINDING_INVALID", { name });
  }
  return deepFreeze({
    atrPeriod: positiveInteger(selected[atrPeriodName], "ATR_PERIOD_INVALID"),
    stopAtrMultiple: finite(selected[atrStopName], "ATR_STOP_MULTIPLIER_INVALID"),
    targetDistance: finite(selected[targetName], "TARGET_DISTANCE_INVALID"),
    timeBars: positiveInteger(selected[timeBarsName], "TIME_BARS_INVALID"),
  });
}

export function createEvidenceBackedFormulaSignalEvaluatorV1({ formulaCandidate, generatedCandidate } = {}) {
  validateFormulaScope(formulaCandidate);
  const selected = validateSelectedParameters(formulaCandidate, generatedCandidate);
  const runtime = createEntryRuntime({ entryDsl: formulaCandidate.entryDsl, selectedParameters: selected });
  const contract = createEvidenceBackedFormulaEvaluatorContractV1({ formulaCandidate });
  const signalEvaluator = ({ market, side, timeframe, candles, index } = {}) => {
    if (market !== formulaCandidate.market || timeframe !== formulaCandidate.timeframe || side !== "long") {
      fail("BACKTEST_CONTEXT_FORMULA_MISMATCH", { market, side, timeframe });
    }
    const result = runtime.evaluate({ candles, index });
    if (result.status !== "EVALUATED" || result.signal !== true) return null;
    return deepFreeze({
      safeDslSignal: true,
      evaluatorVersion: EVIDENCE_BACKED_FORMULA_ENTRY_EVALUATOR_VERSION,
      formulaHash: formulaCandidate.formulaHash,
      parameterIdentity: generatedCandidate.parameterIdentity,
      strategyFamily: formulaCandidate.strategyFamily,
      signalIndex: index,
      signalTimestamp: result.timestamp,
      closedCandleOnly: true,
      nextOpenExecutionExpected: true,
    });
  };
  return deepFreeze({ signalEvaluator, evaluatorContract: contract });
}
