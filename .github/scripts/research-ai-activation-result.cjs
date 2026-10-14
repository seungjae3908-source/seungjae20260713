'use strict';

const REQUIRED_MARKERS = Object.freeze([
  'AI_RESEARCH_ACTIVATED=true', 'AI_RESEARCH_ISOLATED_VALIDATION_REUSED=true',
  'AI_REVIEW_ONE_SHOT=success',
  'VIDEO_DISCOVERY_ONE_SHOT=success', 'AI_REVIEW_TIMER_ENABLED=true',
  'VIDEO_DISCOVERY_TIMER_ENABLED=true', 'APPROVED_JOB_INTAKE_TIMER_ENABLED=true',
  'WORKSPACE_WORKER_ENABLED=true', 'LIVE_TRADING=false',
  'PRIVATE_TRADING_API_ALLOWED=false', 'REAL_ORDER_ENABLED=false',
  'executionAuthority=NONE', 'REAL_ORDER_SUBMITTED=false',
]);
const FAILURE_CODES = [
  'AI_RESEARCH_ISOLATED_ROOT_INVALID', 'AI_RESEARCH_ISOLATED_PROOF_MISSING',
  'AI_RESEARCH_ISOLATED_VALIDATION_INVALID', 'AI_RESEARCH_ISOLATED_VALIDATION_MARKER_UNSAFE',
  'AI_RESEARCH_ISOLATED_VALIDATION_MAX_AGE_INVALID',
  'ISOLATED_TRANSITION_STATE_ROOT_OVERLAP', 'ISOLATED_TRANSITION_SOURCE_ROOT_UNSAFE',
  'ISOLATED_TRANSITION_REVIEW_EVIDENCE_MISSING',
  'ISOLATED_TRANSITION_NATURAL_CYCLE_NOT_PROVEN', 'ISOLATED_TRANSITION_AI_REVIEW_NOT_PROVEN',
  'ISOLATED_TRANSITION_VIDEO_NOT_PROVEN', 'ISOLATED_TRANSITION_DUPLICATE_STRATEGY_SELECTED',
  'ISOLATED_TRANSITION_CLOSED_LOOP_STATE_INVALID', 'ISOLATED_TRANSITION_BACKTEST_RECORD_MISSING',
  'AI_RESEARCH_ISOLATED_RELEASE_INVALID', 'AI_RESEARCH_ISOLATED_RELEASE_SHA_MISMATCH',
  'AI_RESEARCH_CURRENT_SHA_FORWARD_REFRESH_FAILED',
  'AI_RESEARCH_CURRENT_SHA_FORWARD_EVIDENCE_MISSING',
  'AI_RESEARCH_CURRENT_SHA_EVIDENCE_JSON_INVALID',
  'AI_RESEARCH_CURRENT_SHA_EVIDENCE_INVALID',
  'AI_RESEARCH_ONE_SHOT_FAILED', 'AI_RESEARCH_ONE_SHOT_SCHEMA_INVALID',
  'AI_RESEARCH_ONE_SHOT_SHA_MISMATCH', 'AI_RESEARCH_ONE_SHOT_NOT_READY',
  'AI_RESEARCH_ONE_SHOT_PROVIDER_INVALID',
  'AI_RESEARCH_ONE_SHOT_PROVIDER_OR_CACHE_PROOF_MISSING',
  'AI_RESEARCH_ONE_SHOT_REVIEW_MISSING', 'AI_RESEARCH_ONE_SHOT_BLOCKED_PROFILE',
  'AI_RESEARCH_ONE_SHOT_STALE', 'AI_RESEARCH_ONE_SHOT_SAFETY_INVALID',
  'AI_RESEARCH_WORKSPACE_WORKER_HEARTBEAT_NOT_ACTIVE',
  'AI_RESEARCH_TIMER_STILL_ACTIVE', 'AI_RESEARCH_TIMER_STILL_ENABLED',
  'AI_RESEARCH_DAEMON_STILL_ACTIVE', 'AI_RESEARCH_DAEMON_STILL_ENABLED',
  'AI_RESEARCH_WORKLOAD_STATE_UNKNOWN', 'AI_RESEARCH_WORKLOAD_NOT_STOPPED',
  'AI_RESEARCH_CUTOVER_BUSY', 'AI_RESEARCH_SNAPSHOT_UNIT_STATE_INVALID',
  'AI_RESEARCH_SNAPSHOT_ACTIVE_STATE_INVALID', 'AI_RESEARCH_SNAPSHOT_FRAGMENT_UNSAFE',
  'AI_RESEARCH_SNAPSHOT_FRAGMENT_OWNERSHIP_INVALID', 'AI_RESEARCH_ROLLBACK_MANIFEST_MISSING',
  'AI_RESEARCH_SNAPSHOT_RELEASE_INVALID', 'AI_RESEARCH_SNAPSHOT_RESEARCH_ENV_MISSING',
  'AI_RESEARCH_SNAPSHOT_WORKING_DIRECTORY_INVALID', 'AI_RESEARCH_SNAPSHOT_ENVIRONMENT_FILE_INVALID',
  'AI_RESEARCH_SNAPSHOT_REPO_ROOT_INVALID', 'AI_RESEARCH_SNAPSHOT_CODE_SHA_INVALID',
  'AI_RESEARCH_SNAPSHOT_GIT_ROOT_INVALID', 'AI_RESEARCH_SNAPSHOT_SAFETY_INVALID',
  'AI_RESEARCH_ROLLBACK_UNIT_BACKUP_MISSING', 'AI_RESEARCH_ROLLBACK_ENV_BACKUP_MISSING',
  'AI_RESEARCH_ROLLBACK_UNIT_BACKUP_HASH_MISMATCH', 'AI_RESEARCH_ROLLBACK_WORKLOAD_BUSY',
  'AI_RESEARCH_ROLLBACK_SNAPSHOT_OWNERSHIP_INVALID',
  'AI_RESEARCH_ROLLBACK_ENABLE_VERIFY_FAILED', 'AI_RESEARCH_ROLLBACK_ACTIVE_VERIFY_FAILED',
  'AI_RESEARCH_ROLLBACK_UNIT_HASH_MISMATCH', 'AI_RESEARCH_ROLLBACK_EXEC_HASH_MISMATCH',
  'AI_RESEARCH_ROLLBACK_EXECUTION_BINDING_MISMATCH',
  'AI_RESEARCH_ROLLBACK_RELEASE_SHA_MISMATCH', 'AI_RESEARCH_INSTALLED_UNIT_MISSING',
  'AI_RESEARCH_INSTALLED_UNIT_OWNERSHIP_INVALID', 'AI_RESEARCH_INSTALLED_UNIT_SHA_MISMATCH',
  'ROLLBACK_FAILED',
  'VIDEO_DISCOVERY_ONE_SHOT_SCHEMA_INVALID', 'VIDEO_DISCOVERY_ONE_SHOT_SHA_MISMATCH',
  'VIDEO_DISCOVERY_ONE_SHOT_NOT_COMPLETE', 'VIDEO_DISCOVERY_ONE_SHOT_PROVIDER_INVALID',
  'VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING',
  'VIDEO_DISCOVERY_ONE_SHOT_SOURCE_COUNT_INVALID', 'VIDEO_DISCOVERY_ONE_SHOT_STALE',
  'VIDEO_DISCOVERY_ONE_SHOT_SAFETY_INVALID',
  'AUTONOMOUS_V2_CYCLE_EVIDENCE_MISSING', 'AUTONOMOUS_V2_CYCLE_SCHEMA_INVALID',
  'AUTONOMOUS_V2_CYCLE_SHA_MISMATCH', 'AUTONOMOUS_V2_CYCLE_STALE',
  'AUTONOMOUS_V2_CYCLE_NOT_COMPLETE', 'AUTONOMOUS_V2_NATURAL_DISCOVERY_NOT_PROVEN',
  'AUTONOMOUS_V2_DISCOVERY_EVIDENCE_MISSING', 'AUTONOMOUS_V2_DISCOVERY_EVIDENCE_INVALID',
  'AUTONOMOUS_V2_DISCOVERY_SHA_INVALID',
  'AUTONOMOUS_V2_PROVIDER_CALL_PROOF_INCOMPLETE',
  'AUTONOMOUS_V2_SOURCE_FETCH_PROOF_INCOMPLETE',
  'AUTONOMOUS_V2_CURRENT_INVOCATION_PROOF_INVALID',
  'AUTONOMOUS_V2_FORMULA_NOT_PROVEN', 'AUTONOMOUS_V2_BACKTEST_NOT_PROVEN',
  'AUTONOMOUS_V2_SELECTED_STRATEGY_MISSING', 'AUTONOMOUS_V2_SAFETY_INVALID',
];
const PROVIDER_FAILURE_CODES = new Set(['FREE_AI_TIMEOUT','FREE_AI_NETWORK_UNAVAILABLE',
  'FREE_AI_RATE_LIMITED','FREE_AI_AUTH_REJECTED','FREE_AI_REQUEST_REJECTED',
  'FREE_AI_PROVIDER_UNAVAILABLE','FREE_AI_PROVIDER_ERROR','FREE_AI_PROVIDER_RESPONSE_INVALID','FREE_AI_EMPTY_RESPONSE']);

// Diagnostics can contain both pretty JSON and compact JSON. Scan once rather
// than treating nested lines or arbitrary stderr as provider failure evidence.
function jsonRecords(lines) {
  const records = [];
  let invalid = false;
  let buffer = '', depth = 0, quoted = false, escaped = false;
  for (const line of lines) {
    if (!buffer && !line.startsWith('{')) continue;
    buffer += line + '\n';
    for (const char of line) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth <= 0 && !quoted) {
      try { records.push(JSON.parse(buffer)); } catch { invalid = true; }
      buffer = ''; depth = 0; escaped = false;
    }
  }
  return {records, invalid: invalid || buffer.length !== 0};
}

function validOneShot(value, targetSha) {
  const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  return value?.schemaVersion === 'research-ai-one-shot-proof-v1'
    && value.targetSha === targetSha && value.credentialValuesExposed === false
    && value.executionAuthority === 'NONE'
    && ['COMPLETE', 'PARTIAL_COVERAGE_COMPLETE'].includes(value.ai?.status)
    && ['gemini', 'groq'].includes(value.ai?.provider)
    && integer(value.ai.providerNetworkCalls, 0, 3) && integer(value.ai.cacheHits, 0, 3)
    && value.ai.providerNetworkCalls + value.ai.cacheHits >= 1
    && integer(value.ai.reviewCount, 1, 3)
    && value.video?.status === 'COMPLETE'
    && integer(value.video.providerNetworkCalls, 1, 2)
    && integer(value.video.sourceCount, 0, Number.MAX_SAFE_INTEGER);
}

function validOperationalTransition(value, targetSha) {
  const natural = value?.actualNaturalCycle;
  const longHistory = value?.longHistory;
  return value?.schemaVersion === 'research-ai-operational-transition-v2'
    && value.status === 'PASS' && value.targetSha === targetSha
    && value.executionAuthority === 'NONE'
    && value.liveTrading === false && value.privateTradingApiAllowed === false
    && value.realOrderEnabled === false
    && natural?.status === 'NATURAL_CYCLE_PROVEN'
    && natural.directiveConsumed === true
    && natural.discoveryEvidenceStatus === 'DOSSIER_STAGED'
    && ((natural.discoveryStatus === 'DOSSIER_STAGED' && natural.discoveryExecution === 'FRESH_THIS_INVOCATION')
      || (natural.discoveryStatus === 'ALREADY_DISCOVERED' && natural.discoveryExecution === 'RESUMED_EXACT_SHA'))
    && natural.providerCalls?.attempted === 2 && natural.providerCalls?.succeeded === 2
    && natural.providerCalls?.failed === 0
    && natural.sourceFetches?.attempted === 3 && natural.sourceFetches?.succeeded === 3
    && natural.sourceFetches?.failed === 0
    && Number.isSafeInteger(natural.formulaGeneratedCount) && natural.formulaGeneratedCount >= 1
    && Number.isSafeInteger(natural.actualBacktestCount) && natural.actualBacktestCount >= 1
    && natural.paperActivated === false && natural.executionAuthority === 'NONE'
    && ['CURRENT_SHA_EVIDENCE', 'STALE_RELEASE_EVIDENCE_PRESERVED', 'MISSING_CURRENT_EVIDENCE'].includes(longHistory?.state)
    && longHistory?.treatedAsFailure === false;
}

function evaluateAiActivationResult({ diagnostics, targetSha, remoteExitCode, captureExitCode }) {
  const validExit = n => Number.isSafeInteger(n) && n >= 0 && n <= 255;
  const bounded = typeof diagnostics === 'string' && diagnostics.length <= 1024 * 1024;
  const validInput = bounded && /^[a-f0-9]{40}$/u.test(targetSha ?? '')
    && validExit(remoteExitCode) && validExit(captureExitCode);
  const lines = bounded ? diagnostics.split(/\r?\n/u).map(x => x.trim()) : [];
  const markers = new Map(lines.filter(x => /^[A-Za-z_]+=/u.test(x)).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)];
  }));
  const parsed = jsonRecords(lines);
  const proofs = parsed.records;
  const oneShots = proofs.filter(x => x?.schemaVersion === 'research-ai-one-shot-proof-v1');
  const operationalTransitions = proofs.filter(x => x?.schemaVersion === 'research-ai-operational-transition-v2');
  const safetyMarkers = REQUIRED_MARKERS.slice(8);
  const safetyConflict = safetyMarkers.some(marker => {
    const key = marker.slice(0, marker.indexOf('='));
    return lines.some(line => line.startsWith(key + '=') && line !== marker);
  });
  const completionEvidenceObserved = validInput && !safetyConflict && !parsed.invalid
    && REQUIRED_MARKERS.every(x => {
      const i = x.indexOf('='); return markers.get(x.slice(0, i)) === x.slice(i + 1);
    })
    && markers.get('TARGET_SHA') === targetSha
    && validOneShot(oneShots.at(-1), targetSha)
    && validOperationalTransition(operationalTransitions.at(-1), targetSha);
  let failureReason = null;
  if (!validInput) failureReason = 'AI_RESEARCH_ACTIVATION_RESULT_INPUT_INVALID';
  else if (captureExitCode !== 0) failureReason = 'AI_RESEARCH_ACTIVATION_DIAGNOSTIC_CAPTURE_FAILED';
  else if (remoteExitCode !== 0) {
    if (/(?:main|bash|\/[^\r\n:]+): line [0-9]+: evidence: unbound variable/u.test(diagnostics)) {
      failureReason = 'AI_RESEARCH_ACTIVATION_CLEANUP_SCOPE_FAILED';
    } else {
      failureReason = [...lines].reverse().flatMap(line => FAILURE_CODES.filter(code =>
        new RegExp('\\b' + code + '\\b', 'u').test(line)))[0]
        ?? 'AI_RESEARCH_ACTIVATION_REMOTE_FAILED';
    }
  } else if (!completionEvidenceObserved) failureReason = 'AI_RESEARCH_ACTIVATION_PROOF_INVALID';
  const diagnostic = proofs.filter(x => x?.schemaVersion === 'research-production-ai-diagnostic-v1'
    && x.researchSha === targetSha && x.credentialValuesExposed === false && x.executionAuthority === 'NONE').at(-1);
  const providerFailureReason = validInput && remoteExitCode !== 0 && captureExitCode === 0
    && ['PARTIAL_AI_UNAVAILABLE','DEFERRED_RETRY'].includes(diagnostic?.status)
    ? [...(Array.isArray(diagnostic.blockedProfiles) ? diagnostic.blockedProfiles : []),
      ...(Array.isArray(diagnostic.deferredProfiles) ? diagnostic.deferredProfiles : [])]
      .slice(0, 6).map(x=>x?.reason).find(code=>PROVIDER_FAILURE_CODES.has(code)) ?? null : null;
  const operationalTransition = operationalTransitions.at(-1);
  const rollbackState = markers.get('ROLLBACK_FAILED') === 'true'
    ? 'ROLLBACK_FAILED'
    : markers.get('AI_RESEARCH_EXISTING_RUNTIME_UNCHANGED') === 'true'
      ? 'UNCHANGED'
    : markers.get('AI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK') === 'true'
      && markers.get('AI_RESEARCH_PREVIOUS_SERVICE_PRESERVED') === 'true'
      ? 'RESTORED'
      : remoteExitCode === 0 ? 'NOT_REQUIRED' : 'NOT_PROVEN';
  return { schemaVersion: 'research-ai-activation-result-v1',
    activationSucceeded: failureReason === null, failureReason,
    providerFailureReason,
    completionEvidenceObserved,
    naturalCycleProven: validOperationalTransition(operationalTransition, targetSha),
    longHistoryState: validOperationalTransition(operationalTransition, targetSha)
      ? operationalTransition.longHistory.state : null,
    youtubeState: validOperationalTransition(operationalTransition, targetSha)
      ? operationalTransition.youtube?.state ?? null : null,
    rollbackState,
    existingServicePreserved: ['UNCHANGED','RESTORED'].includes(rollbackState) || remoteExitCode === 0,
    runtimeRecheckRequired: validInput && failureReason !== null,
    grantsExecutionAuthority: false };
}

module.exports = { evaluateAiActivationResult, REQUIRED_MARKERS };
