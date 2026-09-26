const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalizeSha(value, label) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(formatFailure("INVALID_SHA", `${label} must be one exact 40-character commit SHA`));
  }
  return sha;
}

export function formatFailure(code, detail) {
  return `[${code}] ${detail}`;
}

export function resolveTestedSha({
  eventName,
  pullRequestHeadSha = "",
  dispatchSha = "",
  eventSha = "",
}) {
  let candidate;
  if (eventName === "pull_request") {
    candidate = pullRequestHeadSha;
  } else if (eventName === "workflow_dispatch") {
    candidate = dispatchSha || eventSha;
  } else if (eventName === "push") {
    candidate = eventSha;
  } else {
    throw new Error(formatFailure("UNSUPPORTED_EVENT", `event ${eventName || "<empty>"} is not allowed`));
  }
  return normalizeSha(candidate, "tested SHA");
}

export function assertExactCheckout({ testedSha, headSha, branchName = "" }) {
  const expected = normalizeSha(testedSha, "tested SHA");
  const actual = normalizeSha(headSha, "checkout HEAD");
  const branch = String(branchName ?? "").trim();

  if (branch) {
    throw new Error(formatFailure("UNEXPECTED_BRANCH", `checkout must be detached, found ${branch}`));
  }
  if (actual !== expected) {
    throw new Error(formatFailure("HEAD_SHA_MISMATCH", `tested ${expected}, checked out ${actual}`));
  }

  return Object.freeze({ testedSha: expected, headSha: actual, checkoutMode: "DETACHED" });
}

const LONG_HISTORY_PATHS = new Set([
  "market-prediction-lab/src/historical-backtest-data.js",
  "market-prediction-lab/src/binance-futures-history.js",
  "market-prediction-lab/src/binance-vision-futures-archive.js",
  "market-prediction-lab/src/multi-market-backtest-engine.js",
  "market-prediction-lab/src/independent-strategy-backtest.js",
  "market-prediction-lab/src/v2-market-optimizer.js",
  "market-prediction-lab/src/v3-market-filter-optimizer.js",
  "market-prediction-lab/src/v4-momentum-regime-optimizer.js",
  "market-prediction-lab/src/v5-price-structure-optimizer.js",
  "market-prediction-lab/src/v6-independent-breakout-retest-optimizer.js",
  "market-prediction-lab/scripts/run-long-history-v1.js",
  "market-prediction-lab/scripts/run-v3-history.js",
  "market-prediction-lab/scripts/run-v4-history.js",
  "market-prediction-lab/scripts/run-v5-history.js",
  "market-prediction-lab/scripts/run-v6-history.js",
]);

const PR_LANE_WORKFLOW_PATHS = new Set([
  ".github/workflows/futures-public-network-smoke.yml",
  ".github/workflows/prediction-lab-52d-validation.yml",
  ".github/workflows/prediction-lab-long-history-v1.yml",
  ".github/workflows/prediction-lab-pr-head-unit.yml",
]);

export function selectValidationLanes(changedPaths) {
  const paths = [...new Set((changedPaths ?? []).map((path) => String(path).replaceAll("\\", "/")))];
  const predictionLabChanged = paths.some((path) => path.startsWith("market-prediction-lab/"));
  const ciContractChanged = paths.some((path) =>
    path === ".github/scripts/pr-exact-head-contract.mjs"
    || path.startsWith(".github/tests/pr-exact-head-")
    || PR_LANE_WORKFLOW_PATHS.has(path));
  const multiMarket = paths.some((path) =>
    path === ".github/workflows/prediction-lab-52d-validation.yml"
    || path === "market-prediction-lab/package.json"
    || path.startsWith("market-prediction-lab/src/")
    || path.startsWith("market-prediction-lab/scripts/")
    || path.startsWith("market-prediction-lab/tests/"));
  const longHistory = paths.some((path) =>
    path === ".github/workflows/prediction-lab-long-history-v1.yml"
    || path === "market-prediction-lab/package.json"
    || path.startsWith("market-prediction-lab/tests/")
    || LONG_HISTORY_PATHS.has(path));

  return Object.freeze({
    application: true,
    researchTests: predictionLabChanged || ciContractChanged,
    multiMarket,
    longHistory,
  });
}
