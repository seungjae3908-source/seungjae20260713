'use strict';

const REQUIRED_PRODUCTION_STATUSES = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);

const ALLOWED_APPLICATION_CI_EVENTS = Object.freeze(['push', 'workflow_dispatch']);
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_URL_RE = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;

function failure(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left?.created_at ?? '') || 0;
  const rightTime = Date.parse(right?.created_at ?? '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return Number(right?.id ?? 0) - Number(left?.id ?? 0);
}

function latestRequiredStatuses(statuses) {
  const latest = new Map();
  for (const status of [...(statuses ?? [])].sort(newestFirst)) {
    if (REQUIRED_PRODUCTION_STATUSES.includes(status?.context) && !latest.has(status.context)) {
      latest.set(status.context, status);
    }
  }
  return latest;
}

function inspectRequiredStatusEvidence(statuses) {
  const latest = latestRequiredStatuses(statuses);
  const missing = REQUIRED_PRODUCTION_STATUSES.filter((name) => !latest.has(name));
  if (missing.length) return failure('required_status_missing', { missing, waitable: true, latest });

  const failed = REQUIRED_PRODUCTION_STATUSES.filter((name) => ['failure', 'error'].includes(latest.get(name)?.state));
  if (failed.length) return failure('required_status_failed', { failed, waitable: false, latest });

  const incomplete = REQUIRED_PRODUCTION_STATUSES.filter((name) => latest.get(name)?.state !== 'success');
  if (incomplete.length) return failure('required_status_not_success', { incomplete, waitable: true, latest });

  const runIds = new Set();
  for (const name of REQUIRED_PRODUCTION_STATUSES) {
    const targetUrl = String(latest.get(name)?.target_url ?? '');
    const match = RUN_URL_RE.exec(targetUrl);
    if (!match) return failure('required_status_missing_run_provenance', { context: name, waitable: false, latest });
    runIds.add(match[1]);
  }
  if (runIds.size !== 1) {
    return failure('required_statuses_do_not_share_one_run', { runIds: [...runIds], waitable: false, latest });
  }

  return { ok: true, runId: Number([...runIds][0]), latest };
}

function evaluateProductionCiProvenance({ targetSha, currentMainSha, statuses, run }) {
  if (!SHA_RE.test(String(targetSha ?? ''))) return failure('invalid_target_sha');
  if (!SHA_RE.test(String(currentMainSha ?? ''))) return failure('invalid_current_main_sha');
  if (targetSha !== currentMainSha) return failure('target_is_not_current_main');

  const evidence = inspectRequiredStatusEvidence(statuses);
  if (!evidence.ok) return evidence;
  if (!run) return failure('application_ci_run_missing', { runId: evidence.runId });
  if (Number(run.id) !== evidence.runId) return failure('application_ci_run_id_mismatch', { runId: evidence.runId });
  if (run.name !== 'Application CI') return failure('application_ci_name_mismatch');
  if (run.path !== '.github/workflows/futures-public-network-smoke.yml') return failure('application_ci_workflow_mismatch');
  if (run.head_sha !== targetSha) return failure('application_ci_sha_mismatch');
  if (run.head_branch !== 'main') return failure('application_ci_branch_mismatch');
  if (!ALLOWED_APPLICATION_CI_EVENTS.includes(run.event)) return failure('application_ci_event_not_allowed');
  if (run.status !== 'completed') return failure('application_ci_not_completed');
  if (run.conclusion !== 'success') return failure('application_ci_not_successful');

  return { ok: true, runId: evidence.runId, event: run.event };
}

module.exports = {
  ALLOWED_APPLICATION_CI_EVENTS,
  REQUIRED_PRODUCTION_STATUSES,
  evaluateProductionCiProvenance,
  inspectRequiredStatusEvidence,
  latestRequiredStatuses,
};
