import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { optimizeKrMomentumExposureOverlay } from "../src/kr-momentum-exposure-overlay.js";
import {
  KR_MOMENTUM_SIGNAL_CANDIDATE,
  KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
} from "../src/kr-momentum-risk-overlay-candidate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 12) : [],
  };
}

async function collect(symbols, startTime, endTime) {
  const datasets = [];
  for (const symbol of symbols) {
    const history = await collectYahooStockHistory({ market: "KR_STOCK", symbol, startTime, endTime });
    datasets.push(Object.freeze({
      symbol,
      candles: history.candles,
      report: Object.freeze({
        symbol,
        providerSymbol: history.providerSymbol,
        candleCount: history.candleCount,
        firstTimestamp: history.firstTimestamp,
        lastTimestamp: history.lastTimestamp,
        source: history.source,
      }),
    }));
  }
  return Object.freeze(datasets);
}

const output = resolve(process.argv[2] ?? "docs/kr-momentum-exposure-overlay-suite-result.json");
const endTime = Date.now();
const startTime = endTime - 3650 * DAY_MS;
let report;

try {
  const designDatasets = await collect(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols, startTime, endTime);
  const holdoutDatasets = await collect(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols, startTime, endTime);
  const result = optimizeKrMomentumExposureOverlay({
    designDatasets,
    holdoutDatasets,
    costRatePerSide: 0.0025,
    stressMultiplier: 1.5,
  });
  report = Object.freeze({
    schemaVersion: 1,
    status: "pass",
    researchOnly: true,
    market: "KR_STOCK",
    family: "cross_sectional_relative_strength_with_cash_reserve",
    candidateId: KR_MOMENTUM_SIGNAL_CANDIDATE.id,
    candidateManifestSha256: KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
    result,
    datasets: Object.freeze({
      design: designDatasets.map((row) => row.report),
      holdout: holdoutDatasets.map((row) => row.report),
    }),
    provenance: Object.freeze({
      signalParametersFrozenFromPriorResearch: true,
      sourceResearchSha: KR_MOMENTUM_SIGNAL_CANDIDATE.sourceResearchSha,
      sourceArtifactDigest: KR_MOMENTUM_SIGNAL_CANDIDATE.sourceArtifactDigest,
      previousResearchSymbolsExcluded: true,
      searchedDimension: "grossExposureFraction_only",
      sourceHoldoutUsedForOverlaySelection: false,
      overlayHoldoutUsedForSelection: false,
      publicDataOnly: true,
    }),
    safeguards: Object.freeze({
      actualOrders: 0,
      privateAccountRequests: 0,
      liveExecutionAllowed: false,
      mainMergePerformed: false,
    }),
  });
} catch (error) {
  report = Object.freeze({
    schemaVersion: 1,
    status: "fail",
    researchOnly: true,
    market: "KR_STOCK",
    candidateId: KR_MOMENTUM_SIGNAL_CANDIDATE.id,
    candidateManifestSha256: KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
    error: serializeError(error),
    safeguards: Object.freeze({ actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false }),
  });
  process.exitCode = 1;
}

await save(output, report);
console.log(JSON.stringify(report, null, 2));
