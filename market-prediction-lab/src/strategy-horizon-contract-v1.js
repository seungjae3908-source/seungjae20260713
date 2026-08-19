const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const HORIZONS = Object.freeze({
  SCALPING: Object.freeze([
    Object.freeze({ key: "5M", offsetMs: 5 * MINUTE }),
    Object.freeze({ key: "15M", offsetMs: 15 * MINUTE }),
    Object.freeze({ key: "30M", offsetMs: 30 * MINUTE }),
    Object.freeze({ key: "60M", offsetMs: 60 * MINUTE }),
    Object.freeze({ key: "1D", offsetMs: DAY }),
  ]),
  SWING: Object.freeze([
    Object.freeze({ key: "1D", offsetMs: DAY }),
    Object.freeze({ key: "3D", offsetMs: 3 * DAY }),
    Object.freeze({ key: "5D", offsetMs: 5 * DAY }),
  ]),
  MID_LONG: Object.freeze([
    Object.freeze({ key: "30D", offsetMs: 30 * DAY }),
    Object.freeze({ key: "90D", offsetMs: 90 * DAY }),
    Object.freeze({ key: "180D", offsetMs: 180 * DAY }),
  ]),
});

function normalizeMode(value) {
  const mode = String(value ?? "").trim().toUpperCase().replaceAll("-", "_");
  if (mode === "POSITION" || mode === "MIDLONG") return "MID_LONG";
  if (mode === "SHORT_TERM" || mode === "DAY" || mode === "INTRADAY") return "SCALPING";
  if (mode === "SCALPING" || mode === "SWING" || mode === "MID_LONG") return mode;
  throw new TypeError("strategy mode must be SCALPING, SWING or MID_LONG/POSITION");
}

export function resolveStrategyHorizon(mode) {
  const strategyMode = normalizeMode(mode);
  const checkpoints = HORIZONS[strategyMode];
  return Object.freeze({
    schemaVersion: "strategy-horizon-contract-v1",
    strategyMode,
    basis: "ELAPSED_TIME_V1",
    checkpoints,
    primaryHorizonKey: strategyMode === "SCALPING" ? "1D" : strategyMode === "SWING" ? "5D" : "180D",
    maxHorizonMs: checkpoints.at(-1).offsetMs,
    exchangeSessionCalendarRequiredForTradingDayClaims: true,
  });
}

export function buildStrategySettlementSchedule({ mode, signalAtMs } = {}) {
  if (!Number.isFinite(signalAtMs) || signalAtMs <= 0) throw new TypeError("positive signalAtMs is required");
  const horizon = resolveStrategyHorizon(mode);
  return Object.freeze({
    ...horizon,
    signalAtMs,
    targets: Object.freeze(horizon.checkpoints.map((checkpoint) => Object.freeze({
      ...checkpoint,
      settleAtMs: signalAtMs + checkpoint.offsetMs,
    }))),
  });
}
