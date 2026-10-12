'use strict';

const REQUIRED_MARKERS = Object.freeze([
  'AI_RESEARCH_ACTIVATED=true', 'AI_REVIEW_ONE_SHOT=success',
  'VIDEO_DISCOVERY_ONE_SHOT=success', 'AI_REVIEW_TIMER_ENABLED=true',
  'VIDEO_DISCOVERY_TIMER_ENABLED=true', 'APPROVED_JOB_INTAKE_TIMER_ENABLED=true',
  'WORKSPACE_WORKER_ENABLED=true', 'LIVE_TRADING=false',
  'PRIVATE_TRADING_API_ALLOWED=false', 'REAL_ORDER_ENABLED=false',
  'executionAuthority=NONE', 'REAL_ORDER_SUBMITTED=false',
]);
const FAILURE_CODES = [
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
  'VIDEO_DISCOVERY_ONE_SHOT_SCHEMA_INVALID', 'VIDEO_DISCOVERY_ONE_SHOT_SHA_MISMATCH',
  'VIDEO_DISCOVERY_ONE_SHOT_NOT_COMPLETE', 'VIDEO_DISCOVERY_ONE_SHOT_PROVIDER_INVALID',
  'VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING',
  'VIDEO_DISCOVERY_ONE_SHOT_SOURCE_COUNT_INVALID', 'VIDEO_DISCOVERY_ONE_SHOT_STALE',
  'VIDEO_DISCOVERY_ONE_SHOT_SAFETY_INVALID',
];

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

function evaluateAiActivationResult({ diagnostics, targetSha, remoteExitCode, captureExitCode }) {
  const validExit = n => Number.isSafeInteger(n) && n >= 0 && n <= 255;
  const bounded = typeof diagnostics === 'string' && diagnostics.length <= 1024 * 1024;
  const validInput = bounded && /^[a-f0-9]{40}$/u.test(targetSha ?? '')
    && validExit(remoteExitCode) && validExit(captureExitCode);
  const lines = bounded ? diagnostics.split(/\r?\n/u).map(x => x.trim()) : [];
  const markers = new Map(lines.filter(x => /^[A-Za-z_]+=/u.test(x)).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)];
  }));
  const proofs = lines.filter(x => x.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const oneShots = proofs.filter(x => x?.schemaVersion === 'research-ai-one-shot-proof-v1');
  const safetyMarkers = REQUIRED_MARKERS.slice(7);
  const safetyConflict = safetyMarkers.some(marker => {
    const key = marker.slice(0, marker.indexOf('='));
    return lines.some(line => line.startsWith(key + '=') && line !== marker);
  });
  const completionEvidenceObserved = validInput && !safetyConflict
    && REQUIRED_MARKERS.every(x => {
      const i = x.indexOf('='); return markers.get(x.slice(0, i)) === x.slice(i + 1);
    })
    && markers.get('TARGET_SHA') === targetSha
    && validOneShot(oneShots.at(-1), targetSha);
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
  return { schemaVersion: 'research-ai-activation-result-v1',
    activationSucceeded: failureReason === null, failureReason,
    completionEvidenceObserved,
    runtimeRecheckRequired: validInput && failureReason !== null,
    grantsExecutionAuthority: false };
}

module.exports = { evaluateAiActivationResult, REQUIRED_MARKERS };
