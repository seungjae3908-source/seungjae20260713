import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HISTORICAL_V1_CRYPTO_SPECS, BITGET_STANDARD_TAKER_RESEARCH_COSTS, buildCryptoV1Cases } from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { buildUnifiedCalibrationRow, evaluateUnifiedCandidate } from "../src/unified-candidate-evaluator.js";

const inputRoot = resolve(process.argv[2] ?? "long-history-v1");
const v1ArtifactPath = resolve(process.argv[3] ?? "artifacts/automated-research/v1-long-history.json");
const outputPath = resolve(process.argv[4] ?? "artifacts/automated-research/unified-v2-v6.json");
const calibrationPath = resolve(process.argv[5] ?? "artifacts/automated-research/gate-calibration-candidates.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA;
if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("RESEARCH_CODE_SHA must be an immutable 40-character SHA");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function v1CalibrationRows(v1) {
  const rows = [];
  for (const source of v1?.perSymbolResults ?? []) {
    for (const candidate of source?.result?.candidates ?? []) {
      const wfTradeCount = (candidate.walkForward?.windows ?? []).reduce((sum, window) => sum + (Number.isFinite(window.tradeCount) ? window.tradeCount : 0), 0);
      rows.push(Object.freeze({
        market: source.result.market,
        strategy: "V1_EMA_ATR",
        version: "V1",
        symbol: source.result.symbol,
        direction: String(source.result.side ?? "long").toUpperCase(),
        timeframe: source.result.timeframe,
        parameters: candidate.parameters,
        filter: null,
        developmentTradeCount: candidate.developmentMetrics?.tradeCount ?? null,
        oosTradeCount: candidate.oosMetrics?.tradeCount ?? null,
        wfTradeCount,
        expectancy: candidate.oosMetrics?.expectancy ?? null,
        profitFactor: candidate.oosMetrics?.profitFactor ?? null,
        totalReturn: candidate.oosMetrics?.totalReturn ?? null,
        MDD: candidate.oosMetrics?.maximumDrawdown ?? null,
        sharpe: candidate.oosMetrics?.sharpe ?? null,
        winRate: candidate.oosMetrics?.winRate ?? null,
        payoffRatio: Number.isFinite(candidate.oosMetrics?.averageWin) && Number.isFinite(candidate.oosMetrics?.averageLoss) && candidate.oosMetrics.averageLoss > 0
          ? candidate.oosMetrics.averageWin / candidate.oosMetrics.averageLoss
          : null,
        exposure: null,
        turnover: candidate.oosMetrics?.turnover ?? null,
        fees: null,
        spread: null,
        slippage: null,
        stability: candidate.walkForward?.stability?.stabilityScore ?? null,
        regimeDependency: candidate.overfitDiagnostics?.flags?.includes("regime_dependency") ?? false,
        symbolDependency: null,
        topTradeDependency: candidate.overfitDiagnostics?.flags?.includes("top_two_winner_dependency") ?? false,
        concentrationPenalty: candidate.overfitDiagnostics?.tradeConcentrationPenaltyPoints ?? 0,
        developmentToOosDegradation: candidate.overfitDiagnostics?.developmentToOosReturnRetention == null
          ? null
          : 1 - candidate.overfitDiagnostics.developmentToOosReturnRetention,
        wfWindowDispersion: candidate.walkForward?.stability?.performanceDispersion ?? null,
        sampleQuality: candidate.oosMetrics?.tradeCount < 10 ? "low_sample_research_hold" : "uncalibrated_not_a_pass",
        researchStatus: candidate.researchStatus,
        candidateId: candidate.id,
        source: "automated-v1-oos-shortlist",
      }));
    }
  }
  return rows;
}

const v1 = await readJson(v1ArtifactPath);
if (v1.researchCodeSha !== researchCodeSha) throw new Error("V1_ARTIFACT_SHA_MISMATCH");
const unified = [];
const blocked = [];
for (const spec of HISTORICAL_V1_CRYPTO_SPECS) {
  try {
    const candleBundle = await readJson(resolve(inputRoot, `${spec.id}.candles.json`));
    const fundingBundle = spec.market === "CRYPTO_FUTURES" ? await readJson(resolve(inputRoot, `${spec.id}.funding.json`)) : { records: [] };
    const cases = buildCryptoV1Cases({
      spec,
      candles: candleBundle.candles,
      fundingRates: fundingBundle.records ?? [],
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      period: {
        startTime: RESEARCH_BACKTEST_PERIOD.startTime,
        endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
        includeFinalHoldout: false,
      },
    });
    for (const backtestCase of cases) {
      const backtestInput = Object.freeze({
        ...backtestCase,
        costModel: backtestCase.costModel ?? BITGET_STANDARD_TAKER_RESEARCH_COSTS[spec.market],
      });
      for (const version of ["V2", "V3", "V4", "V5", "V6"]) {
        const optimizationPath = resolve(inputRoot, `${backtestCase.id}.${version.toLowerCase()}-optimization.json`);
        const optimization = await readJson(optimizationPath);
        const candidate = evaluateUnifiedCandidate({ version, optimization, backtestInput });
        unified.push(Object.freeze({ datasetId: spec.id, caseId: backtestCase.id, provider: spec.provider, candidate }));
      }
    }
  } catch (error) {
    blocked.push(Object.freeze({
      datasetId: spec.id,
      status: "blocked_data",
      message: String(error?.message ?? error).slice(0, 1200),
    }));
  }
}

const crossSymbol = {};
for (const row of unified) {
  const key = `${row.candidate.version}:${row.candidate.market}:${row.candidate.direction}`;
  const bucket = crossSymbol[key] ?? [];
  bucket.push(row.candidate);
  crossSymbol[key] = bucket;
}
const crossSymbolDiagnostics = Object.freeze(Object.fromEntries(Object.entries(crossSymbol).map(([key, rows]) => {
  const evaluable = rows.filter((row) => row.candidateId && row.oos);
  const positive = evaluable.filter((row) => row.oos.totalReturn > 0 && row.oos.expectancy > 0).length;
  return [key, Object.freeze({
    status: "preliminary",
    scope: "BTC_ETH_family_level_not_parameter_identical",
    symbolCount: evaluable.length,
    symbols: Object.freeze(evaluable.map((row) => row.symbol).sort()),
    positiveSymbolRatio: evaluable.length ? positive / evaluable.length : null,
    symbolDependency: evaluable.length > 1 ? positive !== evaluable.length : null,
    candidateFreezeAllowed: false,
    finalHoldoutQueueAllowed: false,
  })];
})));

const artifact = Object.freeze({
  schemaVersion: 1,
  mode: "unified-v2-v6-existing-engine-adapters",
  researchCodeSha,
  generatedAt: new Date().toISOString(),
  requestedEvaluationPeriod: Object.freeze({
    developmentStart: RESEARCH_BACKTEST_PERIOD.startTime,
    developmentEnd: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
    oosStart: RESEARCH_BACKTEST_PERIOD.validationStartTime,
    oosEnd: RESEARCH_BACKTEST_PERIOD.validationEndTime,
    finalHoldoutStart: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
  }),
  versions: Object.freeze(["V2", "V3", "V4", "V5", "V6"]),
  candidates: Object.freeze(unified),
  crossSymbolValidation: "preliminary",
  crossSymbolDiagnostics,
  finalHoldoutStatus: "LOCKED",
  finalHoldoutExecuted: false,
  finalHoldoutQueue: Object.freeze([]),
  topStrategy: "NONE",
  blocked: Object.freeze(blocked),
  safety: Object.freeze({
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
    productionMutationAllowed: false,
  }),
});
await writeJson(outputPath, artifact);

const calibrationRows = Object.freeze([
  ...v1CalibrationRows(v1),
  ...unified.map((row) => Object.freeze({
    ...buildUnifiedCalibrationRow(row.candidate),
    candidateId: row.candidate.candidateId,
    source: "legacy-engine-unified-adapter",
  })),
]);
const numericDistribution = (key) => calibrationRows.map((row) => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
const calibration = Object.freeze({
  schemaVersion: 1,
  mode: "gate-calibration-dataset",
  researchCodeSha,
  generatedAt: new Date().toISOString(),
  scope: "all currently materialized OOS/WF candidate results; no final holdout values",
  thresholdPolicy: Object.freeze({
    minTradeCountReference: 10,
    minTradeCountMeaning: "research_hold_reference_only_not_pass_threshold",
    profitFactorGate: null,
    maximumDrawdownGate: null,
    walkForwardStabilityGate: null,
    arbitraryNewHardThresholdsAllowed: false,
  }),
  rows: calibrationRows,
  distributions: Object.freeze({
    oosTradeCount: Object.freeze(numericDistribution("oosTradeCount")),
    expectancy: Object.freeze(numericDistribution("expectancy")),
    profitFactor: Object.freeze(numericDistribution("profitFactor")),
    totalReturn: Object.freeze(numericDistribution("totalReturn")),
    MDD: Object.freeze(numericDistribution("MDD")),
    stability: Object.freeze(numericDistribution("stability")),
    developmentToOosDegradation: Object.freeze(numericDistribution("developmentToOosDegradation")),
    wfWindowDispersion: Object.freeze(numericDistribution("wfWindowDispersion")),
  }),
  finalHoldoutValuesIncluded: false,
  syntheticDataIncluded: false,
  liveOrderAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
});
await writeJson(calibrationPath, calibration);
console.log(JSON.stringify({
  status: blocked.length === 0 ? "ok" : "partial",
  researchCodeSha,
  unifiedCandidates: unified.length,
  calibrationRows: calibrationRows.length,
  blocked: blocked.length,
  finalHoldoutExecuted: false,
  topStrategy: "NONE",
  privateApiAllowed: false,
  orderSubmitted: false,
}));
if (blocked.length > 0) process.exitCode = 1;
