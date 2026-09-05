#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C

TARGET_RESEARCH_SHA="${TARGET_RESEARCH_SHA:-}"
[[ "$TARGET_RESEARCH_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'TARGET_RESEARCH_SHA must be an exact lowercase 40-character SHA' >&2
  exit 64
}

ROOT=/opt/investment-research
STATE=/var/lib/investment-research-production
EXPECTED_RELEASE="$ROOT/releases/$TARGET_RESEARCH_SHA"
CURRENT="$ROOT/current"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo -n)
  "${SUDO[@]}" true
fi

current_release="$("${SUDO[@]}" readlink -f -- "$CURRENT" 2>/dev/null || true)"
[[ "$current_release" == "$EXPECTED_RELEASE" ]] || {
  echo 'Research Production release identity mismatch' >&2
  exit 65
}

printf '%s\n' \
  'NATURAL_PAPER_OBSERVABILITY_PROBE_BEGIN' \
  "target_research_sha=$TARGET_RESEARCH_SHA" \
  'server_files_written=0' \
  'server_files_deleted=0' \
  'server_processes_restarted=0' \
  'runtime_mutations=0' \
  'database_mutations=0' \
  'private_api=0' \
  'live_trading=false' \
  'execution_authority=NONE' \
  'real_order_count=0'

"${SUDO[@]}" node - "$STATE" "$TARGET_RESEARCH_SHA" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { isAbsolute, join, resolve, sep } = require('node:path');

const stateRoot = resolve(process.argv[2]);
const expectedSha = process.argv[3];
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const digestValue = (value) => typeof value === 'string' && value.length > 0 ? hash(value) : null;
const exactSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const finiteTimestamp = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const observationDigests = (values) => Array.isArray(values)
  ? values.map((value) => typeof value === 'string' && value.length > 0 ? hash(value) : null)
  : [];
const sanitizedIdentity = (value = {}) => ({
  cycleId: typeof value.cycleId === 'string' ? value.cycleId.slice(0, 256) : null,
  strategySha: exactSha(value.strategySha),
  runtimeSha: exactSha(value.runtimeSha),
  datasetIdentityDigest: digestValue(value.datasetIdentity),
  triggerSource: typeof value.triggerSource === 'string' ? value.triggerSource.slice(0, 80) : null,
  observationIdDigest: typeof value.observationId === 'string' ? hash(value.observationId) : null,
});
const sanitizedStage = (value = {}) => ({
  stage: typeof value.stage === 'string' ? value.stage.slice(0, 100) : null,
  name: typeof value.name === 'string' ? value.name.slice(0, 100) : null,
  field: typeof value.field === 'string' ? value.field.slice(0, 100) : null,
  status: typeof value.status === 'string' ? value.status.slice(0, 80) : null,
  count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : null,
  blocker: typeof value.blocker === 'string' ? value.blocker.slice(0, 240) : null,
  provenance: typeof value.provenance === 'string' ? value.provenance.slice(0, 320) : null,
  observedAt: finiteTimestamp(value.observedAt),
  observedAtMs: finiteTimestamp(value.observedAtMs),
  measuredAtMs: finiteTimestamp(value.measuredAtMs),
  observationIdDigests: observationDigests(value.observationIds),
  identity: sanitizedIdentity(value.identity ?? value),
  naturalCredit: value.naturalCredit,
  replayCredit: value.replayCredit,
  duplicateCredit: value.duplicateCredit,
});
const sanitizedReason = (value = {}) => ({
  sourceStage: typeof value.sourceStage === 'string' ? value.sourceStage.slice(0, 100) : null,
  sourceCode: typeof value.sourceCode === 'string' ? value.sourceCode.slice(0, 240) : null,
  sourceReason: typeof value.sourceReason === 'string' ? value.sourceReason.slice(0, 240) : null,
  canonicalReason: typeof value.canonicalReason === 'string' ? value.canonicalReason.slice(0, 100) : null,
  reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode.slice(0, 240) : null,
  authoritative: value.authoritative === true,
  freshness: typeof value.freshness === 'string' ? value.freshness.slice(0, 40) : null,
  lossless: value.lossless === true,
  provenance: typeof value.provenance === 'string' ? value.provenance.slice(0, 320) : null,
  observedAt: finiteTimestamp(value.observedAt),
  observedAtMs: finiteTimestamp(value.observedAtMs),
  measuredAtMs: finiteTimestamp(value.measuredAtMs),
  identity: sanitizedIdentity(value.identity),
  observationIdDigests: observationDigests(value.observationIds),
  naturalCredit: value.naturalCredit,
  replayCredit: value.replayCredit,
  duplicateCredit: value.duplicateCredit,
  historicalCredit: value.historicalCredit,
});

const forward = readJson(join(stateRoot, 'latest', 'forward.json'));
const paper = (Array.isArray(forward.results) ? forward.results : []).find((row) => row?.id === 'paper-forward');
const stdoutPath = String(paper?.stdoutPath ?? '');
const runsRoot = `${join(stateRoot, 'runs')}${sep}`;
const resolvedStdout = resolve(stdoutPath);
if (!isAbsolute(stdoutPath) || !resolvedStdout.startsWith(runsRoot) || !resolvedStdout.endsWith(`${sep}paper-forward${sep}stdout.log`)) {
  throw new Error('PAPER_FORWARD_STDOUT_PATH_INVALID');
}
const lines = readFileSync(resolvedStdout, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let runtime = null;
for (let index = lines.length - 1; index >= 0; index -= 1) {
  try {
    const candidate = JSON.parse(lines[index]);
    if (candidate?.schemaVersion === 'paper-forward-schedule-cli-v5') {
      runtime = candidate;
      break;
    }
  } catch {}
}
if (!runtime) throw new Error('PAPER_FORWARD_CLI_V5_RESULT_UNAVAILABLE');

const recurring = readJson(join(stateRoot, 'forward', 'paper', 'state', 'recurring-paper-loop.json'));
if (exactSha(recurring?.identity?.researchCodeSha) !== expectedSha) throw new Error('PAPER_RECURRING_STATE_SHA_MISMATCH');
if (exactSha(runtime.naturalRuntimeSha) !== expectedSha) throw new Error('PAPER_RUNTIME_SHA_MISMATCH');
const cycle = (Array.isArray(recurring.cycles) ? recurring.cycles : []).find((row) => row?.cycleId === runtime.cycleId);
const canonical = runtime.canonicalNaturalStageEvidence && typeof runtime.canonicalNaturalStageEvidence === 'object'
  ? runtime.canonicalNaturalStageEvidence
  : {};
const stageCounts = canonical.stageCounts && typeof canonical.stageCounts === 'object'
  ? Object.fromEntries(Object.entries(canonical.stageCounts).slice(0, 16).map(([key, value]) => [key, sanitizedStage(value)]))
  : {};
const firstZeroReasons = runtime.authoritativeFirstZeroReasonEvidenceByStage
  && typeof runtime.authoritativeFirstZeroReasonEvidenceByStage === 'object'
  ? Object.fromEntries(Object.entries(runtime.authoritativeFirstZeroReasonEvidenceByStage).slice(0, 16)
    .map(([key, value]) => [key, sanitizedReason(value)]))
  : {};
const sanitized = {
  collectionStatus: 'READY',
  schemaVersion: runtime.schemaVersion,
  status: runtime.status ?? null,
  cycleId: runtime.cycleId ?? null,
  triggerSource: runtime.naturalScheduleInvocation === true ? 'cron' : null,
  naturalScheduleInvocation: runtime.naturalScheduleInvocation === true,
  evidenceClass: runtime.naturalScheduleInvocation === true && runtime.status !== 'REPLAYED' ? 'NATURAL' : 'NON_NATURAL',
  expectedCodeSha: expectedSha,
  exactCodeSha: exactSha(recurring.identity.researchCodeSha),
  naturalStrategySha: exactSha(runtime.naturalStrategySha),
  naturalRuntimeSha: exactSha(runtime.naturalRuntimeSha),
  naturalDatasetIdentityDigest: digestValue(runtime.naturalDatasetIdentity),
  strategyIdentity: {
    strategyId: typeof recurring.identity.strategyId === 'string' ? recurring.identity.strategyId.slice(0, 160) : null,
    strategyVersion: typeof recurring.identity.strategyVersion === 'string' ? recurring.identity.strategyVersion.slice(0, 80) : null,
    parameterHash: typeof recurring.identity.parameterHash === 'string' ? recurring.identity.parameterHash : null,
    researchCodeSha: exactSha(recurring.identity.researchCodeSha),
    costPolicyVersion: typeof recurring.identity.costPolicyVersion === 'string' ? recurring.identity.costPolicyVersion.slice(0, 160) : null,
    executionPolicyVersion: typeof recurring.identity.executionPolicyVersion === 'string' ? recurring.identity.executionPolicyVersion.slice(0, 160) : null,
  },
  cycleEvaluatedAtMs: finiteTimestamp(cycle?.evaluatedAtMs),
  recurringStateUpdatedAtMs: finiteTimestamp(recurring.updatedAtMs),
  naturalFunnelMeasurements: Array.isArray(runtime.naturalFunnelMeasurements)
    ? runtime.naturalFunnelMeasurements.slice(0, 20).map(sanitizedStage)
    : [],
  canonicalNaturalStageEvidence: {
    schemaVersion: canonical.schemaVersion ?? null,
    identity: sanitizedIdentity(canonical.identity),
    stageCounts,
    reasonObservations: Array.isArray(canonical.reasonObservations)
      ? canonical.reasonObservations.slice(0, 500).map(sanitizedReason)
      : [],
    naturalCredit: canonical.naturalCredit,
    replayCredit: canonical.replayCredit,
    duplicateCredit: canonical.duplicateCredit,
    historicalCredit: canonical.historicalCredit,
  },
  authoritativeFirstZeroReasonEvidenceByStage: firstZeroReasons,
  testOnly: false,
  synthetic: false,
  historical: false,
  replay: runtime.status === 'REPLAYED',
  duplicateReplay: false,
  externalFinancialMutationAllowed: runtime.externalFinancialMutationAllowed,
  privateRequestCount: runtime.privateRequestCount,
  financialMutationCount: runtime.financialMutationCount,
  orderCount: runtime.orderCount,
  liveTrading: runtime.liveTrading,
  orderAuthority: runtime.orderAuthority,
};
const probeDigest = hash(JSON.stringify(sanitized));
const payload = Buffer.from(JSON.stringify({ ...sanitized, probeDigest }), 'utf8').toString('base64url');
if (Buffer.byteLength(payload, 'utf8') > 128 * 1024) throw new Error('SANITIZED_OBSERVABILITY_INPUT_TOO_LARGE');
process.stdout.write(`NATURAL_PAPER_OBSERVABILITY_INPUT_BASE64=${payload}\n`);
NODE

printf '%s\n' 'NATURAL_PAPER_OBSERVABILITY_PROBE_END'
