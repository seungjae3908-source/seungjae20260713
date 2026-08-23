import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PAPER_FORWARD_READONLY_DIAGNOSTIC_VERSION =
  "paper-forward-readonly-diagnostic-v1";

export const PAPER_FORWARD_CANONICAL_STATE_ROOT =
  "/opt/stock-app-data/paper-forward-v1";

const MANAGED_CRON_TAG = "# stock-app-paper-forward-v1";
const SNAPSHOT_RELATIVE_PATH = join("publisher", "paper-state-v2.json");
const EPSILON = 1e-8;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function sha40(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function sha64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestState(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeReadText(path, io) {
  try {
    if (!io.exists(path)) return { present: false, readable: false, text: null };
    return { present: true, readable: true, text: io.read(path) };
  } catch {
    return { present: true, readable: false, text: null };
  }
}

function safeReadJson(path, io) {
  const text = safeReadText(path, io);
  if (!text.present || !text.readable) {
    return { ...text, parseable: false, value: null };
  }
  try {
    return { ...text, parseable: true, value: JSON.parse(text.text) };
  } catch {
    return { ...text, parseable: false, value: null };
  }
}

function safeReadJsonl(path, io) {
  const text = safeReadText(path, io);
  if (!text.present || !text.readable) {
    return { ...text, parseable: false, rows: [], invalidRows: null };
  }
  const lines = text.text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const rows = [];
  let invalidRows = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value);
      else invalidRows += 1;
    } catch {
      invalidRows += 1;
    }
  }
  return { ...text, parseable: invalidRows === 0, rows, invalidRows };
}

function safeFileMetadata(path, io) {
  try {
    if (!io.exists(path)) {
      return { present: false, readable: false, sizeBytes: null, modifiedAtMs: null };
    }
    const stat = io.stat(path);
    return {
      present: true,
      readable: true,
      sizeBytes: finite(stat?.size) ? stat.size : null,
      modifiedAtMs: finite(stat?.mtimeMs) ? Math.trunc(stat.mtimeMs) : null,
    };
  } catch {
    return { present: true, readable: false, sizeBytes: null, modifiedAtMs: null };
  }
}

function scheduleVerdict({
  disabledRoot,
  disabledRuntime,
  disabledJson,
  activation,
  runtimeStatus,
  crontabReadable,
  managedCronCount,
}) {
  const disabledEvidence = disabledRoot
    || disabledRuntime
    || (disabledJson.parseable && disabledJson.value?.scheduleActive === false);

  if (disabledEvidence) {
    if (crontabReadable && managedCronCount === 0) return "DISABLED";
    if (crontabReadable && managedCronCount !== 0) return "INCONSISTENT";
    return "DISABLED_UNVERIFIED_CRONTAB";
  }

  const activationSaysActive = activation.parseable && activation.value?.scheduleActive === true;
  const runtimeSaysActive = runtimeStatus.parseable
    ? runtimeStatus.value?.scheduleActive === true
    : null;

  if (activationSaysActive) {
    if (!crontabReadable) return "UNKNOWN";
    if (managedCronCount !== 1) return "INCONSISTENT";
    if (runtimeSaysActive === false) return "INCONSISTENT";
    return "ACTIVE";
  }

  if (activation.parseable && activation.value?.scheduleActive === false) {
    if (crontabReadable && managedCronCount === 0) return "DISABLED";
    return "INCONSISTENT";
  }

  if (crontabReadable && managedCronCount > 0) return "INCONSISTENT";
  return "UNKNOWN";
}

function validateBinding(binding, expectedSourceSha, expectedSnapshotPath) {
  if (!binding.parseable) {
    return {
      present: binding.present,
      parseable: binding.parseable,
      contractValid: false,
      sourceShaExact: null,
      accountDigestConfigured: false,
      snapshotPathExact: null,
      safetyContractValid: false,
    };
  }
  const value = binding.value;
  const contractValid = value?.schemaVersion === "paper-state-publisher-runtime-binding-v1"
    && sha40(value?.paperRuntimeSourceSha)
    && sha64(value?.publisherAccountIdSha256)
    && value?.immutable === true
    && value?.executionAuthority === "NONE"
    && value?.privateApiAllowed === false
    && value?.liveTrading === false
    && value?.financialMutationAllowed === false;
  return {
    present: true,
    parseable: true,
    contractValid,
    sourceShaExact: sha40(expectedSourceSha)
      ? value?.paperRuntimeSourceSha === expectedSourceSha
      : null,
    accountDigestConfigured: sha64(value?.publisherAccountIdSha256),
    snapshotPathExact: typeof value?.snapshotPath === "string"
      ? resolve(value.snapshotPath) === resolve(expectedSnapshotPath)
      : false,
    safetyContractValid: value?.executionAuthority === "NONE"
      && value?.privateApiAllowed === false
      && value?.liveTrading === false
      && value?.financialMutationAllowed === false,
  };
}

function paperStateCollectionsValid(state) {
  return state?.schemaVersion === 1
    && state?.account
    && Array.isArray(state.orders)
    && Array.isArray(state.positions)
    && Array.isArray(state.fills)
    && Array.isArray(state.journal)
    && Array.isArray(state.processedEventIds)
    && state.riskState;
}

function currentOpenPositions(state) {
  if (!Array.isArray(state?.positions)) return null;
  return state.positions.filter((position) => position?.status !== "closed").length;
}

function pendingOrders(state) {
  if (!Array.isArray(state?.orders)) return null;
  return state.orders.filter((order) => order?.status === "pending").length;
}

function snapshotDiagnostics(snapshot, bindingValue, expectedSourceSha, nowMs) {
  if (!snapshot.parseable) {
    return {
      present: snapshot.present,
      parseable: snapshot.parseable,
      schemaVersion: null,
      contractValid: false,
      sourceShaExact: null,
      publisherAccountBound: null,
      integrityValid: false,
      freshnessValid: false,
      flatSeed: null,
      openPositionCount: null,
      pendingOrderCount: null,
      blockers: snapshot.present
        ? ["SNAPSHOT_UNREADABLE_OR_MALFORMED"]
        : ["SNAPSHOT_MISSING"],
    };
  }

  const value = snapshot.value;
  const state = value?.state;
  const blockers = [];
  const contractValid = value?.schemaVersion === "paper-trading-state-snapshot-v2"
    && value?.paperStateSchemaVersion === 1
    && sha40(value?.sourceSha)
    && sha64(value?.publisherAccountIdSha256)
    && value?.market === "CRYPTO_FUTURES"
    && value?.currency === "USDT"
    && value?.immutable === true
    && value?.executionAuthority === "NONE"
    && value?.privateApiAllowed === false
    && value?.liveTrading === false
    && value?.financialMutationAllowed === false
    && paperStateCollectionsValid(state);

  if (!contractValid) blockers.push("SNAPSHOT_CONTRACT_INVALID");

  const sourceShaExact = sha40(expectedSourceSha)
    ? value?.sourceSha === expectedSourceSha
    : null;
  if (sourceShaExact === false) blockers.push("SOURCE_SHA_MISMATCH");

  const publisherAccountBound = sha64(bindingValue?.publisherAccountIdSha256)
    && sha64(value?.publisherAccountIdSha256)
      ? bindingValue.publisherAccountIdSha256 === value.publisherAccountIdSha256
      : null;
  if (publisherAccountBound === false) blockers.push("ACCOUNT_BINDING_MISMATCH");

  const openCount = currentOpenPositions(state);
  const pendingCount = pendingOrders(state);
  const usedMargin = state?.account?.usedMargin;
  const unrealizedPnl = state?.account?.unrealizedPnl;
  const flatSeed = Number.isInteger(openCount)
    && Number.isInteger(pendingCount)
    && finite(usedMargin)
    && finite(unrealizedPnl)
    ? openCount === 0
      && pendingCount === 0
      && Math.abs(usedMargin) <= EPSILON
      && Math.abs(unrealizedPnl) <= EPSILON
    : null;
  if (flatSeed === false) blockers.push("AUTHORITATIVE_NATURAL_PAPER_SEED_NOT_FLAT");

  const computedDigest = paperStateCollectionsValid(state) ? digestState(state) : null;
  const integrityValid = contractValid
    && sha64(value?.stateDigestSha256)
    && value.stateDigestSha256 === computedDigest
    && value.paperStateSchemaVersion === state.schemaVersion
    && value.accountId === state.account.id
    && finite(value.equity)
    && value.equity === state.account.equity
    && Number.isInteger(value.openPositionCount)
    && value.openPositionCount >= 0
    && value.openPositionCount === openCount;
  if (contractValid && !integrityValid) blockers.push("SNAPSHOT_INTEGRITY_MISMATCH");

  const freshnessValid = positive(nowMs)
    && positive(value?.observedAtMs)
    && positive(value?.stateUpdatedAtMs)
    && positive(value?.maximumAgeMs)
    && value.stateUpdatedAtMs <= value.observedAtMs
    && value.observedAtMs <= nowMs
    && nowMs - value.stateUpdatedAtMs <= value.maximumAgeMs;
  if (contractValid && !freshnessValid) blockers.push("SNAPSHOT_STALE_OR_INVALID");

  return {
    present: true,
    parseable: true,
    schemaVersion: typeof value?.schemaVersion === "string" ? value.schemaVersion : null,
    contractValid,
    sourceShaExact,
    publisherAccountBound,
    integrityValid,
    freshnessValid,
    flatSeed,
    openPositionCount: openCount,
    pendingOrderCount: pendingCount,
    blockers: [...new Set(blockers)],
  };
}

function naturalCycleDiagnostics({
  invocations,
  activationAtMs,
  runtimeStatus,
  state,
  scheduleVerdictValue,
}) {
  if (!finite(activationAtMs) || activationAtMs <= 0) {
    return {
      verdict: "UNKNOWN",
      invocationObserved: false,
      invokedAtMs: null,
      completedAtMs: null,
      status: null,
      failedChecks: ["ACTIVATION_TIME_MISSING"],
      providerLaneCount: null,
      providerReadyCount: null,
      mutationCount: null,
      privateRequestCount: null,
      financialMutationCount: null,
      orderCount: null,
      liveTrading: null,
      orderAuthority: null,
    };
  }

  const qualifying = invocations.rows
    .filter((row) => row?.triggerSource === "cron"
      && finite(row?.invokedAtMs)
      && row.invokedAtMs >= activationAtMs)
    .sort((a, b) => a.invokedAtMs - b.invokedAtMs);
  const invocation = qualifying.at(-1);

  if (!invocation) {
    return {
      verdict: scheduleVerdictValue.startsWith("DISABLED")
        ? "NOT_VERIFIED_DISABLED"
        : "NOT_OBSERVED",
      invocationObserved: false,
      invokedAtMs: null,
      completedAtMs: null,
      status: null,
      failedChecks: [],
      providerLaneCount: null,
      providerReadyCount: null,
      mutationCount: null,
      privateRequestCount: null,
      financialMutationCount: null,
      orderCount: null,
      liveTrading: null,
      orderAuthority: null,
    };
  }

  const lanes = Array.isArray(invocation.providerLanes) ? invocation.providerLanes : [];
  const readyLanes = lanes.filter((lane) => lane?.status === "READY").length;
  const stateCycles = Array.isArray(state.value?.cycles) ? state.value.cycles.length : null;
  const stateArraysValid = Array.isArray(state.value?.positions)
    && Array.isArray(state.value?.settlements);
  const checks = {
    naturalScheduleInvocation: invocation.naturalScheduleInvocation === true,
    completed: invocation.status === "COMPLETED",
    oneMutation: invocation.mutationCount === 1,
    accumulating: invocation.publicForwardEvidenceAccumulating === true,
    outcomeModeEnabled: invocation.paperTradeOutcomeAccumulationEnabled === true,
    simulatedAdaptersEnabled: runtimeStatus.value?.simulatedFinancialAdaptersEnabled === true,
    externalFinancialMutationOff: runtimeStatus.value?.externalFinancialMutationAllowed === false,
    fourReadyProviders: lanes.length === 4 && readyLanes === 4,
    runtimeScheduleActive: runtimeStatus.value?.scheduleActive === true,
    stateCyclePersisted: Number.isInteger(stateCycles) && stateCycles >= 1,
    stateArraysValid,
    noPrivate: invocation.privateRequestCount === 0,
    noFinancialMutation: invocation.financialMutationCount === 0,
    noOrders: invocation.orderCount === 0,
    liveOff: invocation.liveTrading === false,
    orderAuthorityOff: invocation.orderAuthority === false,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);

  return {
    verdict: failedChecks.length === 0 ? "VERIFIED" : "FAILED_EVIDENCE",
    invocationObserved: true,
    invokedAtMs: finite(invocation.invokedAtMs) ? invocation.invokedAtMs : null,
    completedAtMs: finite(invocation.completedAtMs) ? invocation.completedAtMs : null,
    status: typeof invocation.status === "string" ? invocation.status : null,
    failedChecks,
    providerLaneCount: lanes.length,
    providerReadyCount: readyLanes,
    mutationCount: finite(invocation.mutationCount) ? invocation.mutationCount : null,
    privateRequestCount: finite(invocation.privateRequestCount)
      ? invocation.privateRequestCount
      : null,
    financialMutationCount: finite(invocation.financialMutationCount)
      ? invocation.financialMutationCount
      : null,
    orderCount: finite(invocation.orderCount) ? invocation.orderCount : null,
    liveTrading: typeof invocation.liveTrading === "boolean" ? invocation.liveTrading : null,
    orderAuthority: typeof invocation.orderAuthority === "boolean"
      ? invocation.orderAuthority
      : null,
  };
}

function stateCounts(state) {
  if (!state.parseable) {
    return { cycleCount: null, positionCount: null, settlementCount: null, arraysValid: false };
  }
  return {
    cycleCount: Array.isArray(state.value?.cycles) ? state.value.cycles.length : null,
    positionCount: Array.isArray(state.value?.positions) ? state.value.positions.length : null,
    settlementCount: Array.isArray(state.value?.settlements)
      ? state.value.settlements.length
      : null,
    arraysValid: Array.isArray(state.value?.cycles)
      && Array.isArray(state.value?.positions)
      && Array.isArray(state.value?.settlements),
  };
}

function activationProjection(activation) {
  if (!activation.parseable) {
    return {
      present: activation.present,
      parseable: activation.parseable,
      schemaVersion: null,
      status: null,
      targetSha: null,
      paperRuntimeSourceSha: null,
      activationAtMs: null,
      scheduleActive: null,
      productionAppDeployPerformed: null,
      productionAppMutationAllowed: null,
      liveTrading: null,
      privateAccountAccess: null,
      orderAuthority: null,
    };
  }
  const value = activation.value;
  return {
    present: true,
    parseable: true,
    schemaVersion: typeof value?.schemaVersion === "string" ? value.schemaVersion : null,
    status: typeof value?.status === "string" ? value.status : null,
    targetSha: sha40(value?.targetSha) ? value.targetSha : null,
    paperRuntimeSourceSha: sha40(value?.paperRuntimeSourceSha)
      ? value.paperRuntimeSourceSha
      : sha40(value?.targetSha)
        ? value.targetSha
        : sha40(value?.deployedSha)
          ? value.deployedSha
          : null,
    activationAtMs: finite(value?.activationAtMs) ? value.activationAtMs : null,
    scheduleActive: typeof value?.scheduleActive === "boolean" ? value.scheduleActive : null,
    productionAppDeployPerformed: typeof value?.productionAppDeployPerformed === "boolean"
      ? value.productionAppDeployPerformed
      : null,
    productionAppMutationAllowed: typeof value?.productionAppMutationAllowed === "boolean"
      ? value.productionAppMutationAllowed
      : null,
    liveTrading: typeof value?.liveTrading === "boolean" ? value.liveTrading : null,
    privateAccountAccess: typeof value?.privateAccountAccess === "boolean"
      ? value.privateAccountAccess
      : null,
    orderAuthority: typeof value?.orderAuthority === "boolean" ? value.orderAuthority : null,
  };
}

function safetyProjection({ activation, naturalCycle, binding, snapshot }) {
  const knownFalse = (value) => value === false ? false : null;
  return {
    privateApiAllowed: binding.safetyContractValid && snapshot.contractValid ? false : null,
    liveTrading: naturalCycle.liveTrading === false
      ? false
      : activation.liveTrading === false
        ? false
        : null,
    orderAuthority: naturalCycle.orderAuthority === false
      ? false
      : activation.orderAuthority === false
        ? false
        : null,
    productionAppDeployPerformed: knownFalse(activation.productionAppDeployPerformed),
    productionAppMutationAllowed: knownFalse(activation.productionAppMutationAllowed),
    privateRequestCount: naturalCycle.privateRequestCount === 0 ? 0 : null,
    financialMutationCount: naturalCycle.financialMutationCount === 0 ? 0 : null,
    orderCount: naturalCycle.orderCount === 0 ? 0 : null,
  };
}

export function inspectPaperForwardReadonlyRuntime({
  stateRoot = PAPER_FORWARD_CANONICAL_STATE_ROOT,
  crontabText = "",
  crontabReadable = true,
  nowMs = Date.now(),
  io = {
    exists: existsSync,
    read: (path) => readFileSync(path, "utf8"),
    stat: statSync,
  },
} = {}) {
  const resolvedRoot = resolve(stateRoot);
  const paths = {
    activation: join(resolvedRoot, "activation.json"),
    disabled: join(resolvedRoot, "disabled.json"),
    disabledRoot: join(resolvedRoot, "DISABLED"),
    disabledRuntime: join(resolvedRoot, "runtime-state", "DISABLED"),
    binding: join(resolvedRoot, "publisher-binding.json"),
    snapshot: join(resolvedRoot, SNAPSHOT_RELATIVE_PATH),
    invocations: join(resolvedRoot, "runtime-state", "status", "invocations.jsonl"),
    runtimeStatus: join(resolvedRoot, "runtime-state", "status", "runtime-status.json"),
    state: join(resolvedRoot, "runtime-state", "state", "recurring-paper-loop.json"),
  };

  const activationRaw = safeReadJson(paths.activation, io);
  const disabledRaw = safeReadJson(paths.disabled, io);
  const bindingRaw = safeReadJson(paths.binding, io);
  const snapshotRaw = safeReadJson(paths.snapshot, io);
  const invocationsRaw = safeReadJsonl(paths.invocations, io);
  const runtimeStatusRaw = safeReadJson(paths.runtimeStatus, io);
  const stateRaw = safeReadJson(paths.state, io);
  const activation = activationProjection(activationRaw);
  const expectedSourceSha = activation.paperRuntimeSourceSha;
  const binding = validateBinding(bindingRaw, expectedSourceSha, paths.snapshot);
  const snapshot = snapshotDiagnostics(
    snapshotRaw,
    bindingRaw.parseable ? bindingRaw.value : null,
    expectedSourceSha,
    nowMs,
  );

  const managedCronCount = crontabReadable
    ? crontabText.split(/\r?\n/u).filter((line) => line.includes(MANAGED_CRON_TAG)).length
    : null;
  const disabledRoot = io.exists(paths.disabledRoot);
  const disabledRuntime = io.exists(paths.disabledRuntime);
  const schedule = scheduleVerdict({
    disabledRoot,
    disabledRuntime,
    disabledJson: disabledRaw,
    activation: activationRaw,
    runtimeStatus: runtimeStatusRaw,
    crontabReadable,
    managedCronCount,
  });
  const naturalCycle = naturalCycleDiagnostics({
    invocations: invocationsRaw,
    activationAtMs: activation.activationAtMs,
    runtimeStatus: runtimeStatusRaw,
    state: stateRaw,
    scheduleVerdictValue: schedule,
  });
  const counts = stateCounts(stateRaw);

  const seedBlockers = [...snapshot.blockers];
  if (!binding.present) seedBlockers.unshift("PUBLISHER_BINDING_MISSING");
  else if (!binding.parseable || !binding.contractValid) {
    seedBlockers.unshift("PUBLISHER_BINDING_INVALID");
  }
  if (binding.sourceShaExact === false) seedBlockers.push("BINDING_SOURCE_SHA_MISMATCH");
  if (binding.snapshotPathExact === false) seedBlockers.push("BINDING_SNAPSHOT_PATH_MISMATCH");
  const seedReady = binding.contractValid
    && binding.sourceShaExact !== false
    && binding.snapshotPathExact === true
    && snapshot.contractValid
    && snapshot.sourceShaExact !== false
    && snapshot.publisherAccountBound === true
    && snapshot.integrityValid
    && snapshot.freshnessValid
    && snapshot.flatSeed === true;

  const warnings = [];
  if (!activationRaw.present) warnings.push("ACTIVATION_EVIDENCE_MISSING");
  else if (!activationRaw.parseable) warnings.push("ACTIVATION_EVIDENCE_MALFORMED");
  if (!runtimeStatusRaw.present) warnings.push("RUNTIME_STATUS_MISSING");
  else if (!runtimeStatusRaw.parseable) warnings.push("RUNTIME_STATUS_MALFORMED");
  if (invocationsRaw.present && invocationsRaw.invalidRows > 0) {
    warnings.push("INVOCATION_ROWS_MALFORMED");
  }
  if (!stateRaw.present) warnings.push("RECURRING_STATE_MISSING");
  else if (!stateRaw.parseable) warnings.push("RECURRING_STATE_MALFORMED");
  if (schedule === "INCONSISTENT") warnings.push("SCHEDULE_EVIDENCE_INCONSISTENT");

  return Object.freeze({
    schemaVersion: PAPER_FORWARD_READONLY_DIAGNOSTIC_VERSION,
    readOnly: true,
    stateRootCanonical: resolvedRoot === PAPER_FORWARD_CANONICAL_STATE_ROOT,
    observedAtMs: nowMs,
    sensitiveValuesEmitted: false,
    networkAccessUsed: false,
    privateApiUsed: false,
    financialMutationPerformed: false,
    schedule: {
      verdict: schedule,
      managedCronCount,
      crontabReadable,
      disabledRootSentinel: disabledRoot,
      disabledRuntimeSentinel: disabledRuntime,
      disabledRecordPresent: disabledRaw.present,
      disabledRecordValid: disabledRaw.parseable
        && disabledRaw.value?.status === "DISABLED"
        && disabledRaw.value?.scheduleActive === false,
    },
    activation,
    publisher: {
      binding,
      snapshot: { ...snapshot, metadata: safeFileMetadata(paths.snapshot, io) },
      seedEligibility: seedReady ? "READY" : "BLOCKED_OR_UNKNOWN",
      seedBlockers: [...new Set(seedBlockers)],
    },
    naturalCycle,
    stateCounts: counts,
    firstZero: {
      stage: typeof stateRaw.value?.firstZeroStage === "string"
        ? stateRaw.value.firstZeroStage
        : "UNKNOWN",
      reason: typeof stateRaw.value?.firstZeroReason === "string"
        ? stateRaw.value.firstZeroReason
        : "UNKNOWN",
      derived: false,
    },
    safety: safetyProjection({ activation, naturalCycle, binding, snapshot }),
    warnings: [...new Set(warnings)],
  });
}
