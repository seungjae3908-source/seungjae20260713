'use strict';

const {
  REQUIRED_PRODUCTION_STATUSES,
  inspectRequiredStatusEvidence,
} = require('./production-ci-provenance.cjs');

const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_URL_RE = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;
const POST_MERGE_CONTEXT = 'post-merge-provenance/verified';
const POST_MERGE_WORKFLOW_PATH = '.github/workflows/post-merge-release-provenance.yml';
const ALLOWED_PREMERGE_EVENTS = Object.freeze(['workflow_dispatch', 'pull_request']);

function failure(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left?.created_at ?? '') || 0;
  const rightTime = Date.parse(right?.created_at ?? '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return Number(right?.id ?? 0) - Number(left?.id ?? 0);
}

function inspectPostMergeStatusEvidence(statuses) {
  const latest = [...(statuses ?? [])]
    .filter((status) => status?.context === POST_MERGE_CONTEXT)
    .sort(newestFirst)[0];

  if (!latest) return failure('post_merge_status_missing', { waitable: true });
  if (['failure', 'error'].includes(latest.state)) {
    return failure('post_merge_status_failed', { waitable: false, latest });
  }
  if (latest.state !== 'success') {
    return failure('post_merge_status_not_success', { waitable: true, latest });
  }
  const match = RUN_URL_RE.exec(String(latest.target_url ?? ''));
  if (!match) return failure('post_merge_status_missing_run_provenance', { waitable: false, latest });
  return { ok: true, runId: Number(match[1]), latest };
}

function evaluatePostMergeStatusProvenance({ targetSha, currentMainSha, statuses, run }) {
  if (!SHA_RE.test(String(targetSha ?? ''))) return failure('invalid_target_sha');
  if (!SHA_RE.test(String(currentMainSha ?? ''))) return failure('invalid_current_main_sha');
  if (targetSha !== currentMainSha) return failure('target_is_not_current_main');

  const evidence = inspectPostMergeStatusEvidence(statuses);
  if (!evidence.ok) return evidence;
  if (!run) return failure('post_merge_run_missing', { runId: evidence.runId });
  if (Number(run.id) !== evidence.runId) return failure('post_merge_run_id_mismatch', { runId: evidence.runId });
  if (run.name !== 'Post-Merge Release Provenance') return failure('post_merge_run_name_mismatch');
  if (run.path !== POST_MERGE_WORKFLOW_PATH) return failure('post_merge_workflow_mismatch');
  if (run.head_sha !== targetSha) return failure('post_merge_run_sha_mismatch');
  if (run.head_branch !== 'main') return failure('post_merge_run_branch_mismatch');
  if (run.event !== 'push') return failure('post_merge_run_event_mismatch');
  if (run.status !== 'completed') return failure('post_merge_run_not_completed');
  if (run.conclusion !== 'success') return failure('post_merge_run_not_successful');
  return { ok: true, runId: evidence.runId };
}

function evaluatePremergeCi({ headSha, expectedHeadRef, statuses, run, mergedAt }) {
  if (!SHA_RE.test(String(headSha ?? ''))) return failure('invalid_head_sha');

  const evidence = inspectRequiredStatusEvidence(statuses);
  if (!evidence.ok) return evidence;
  if (!run) return failure('application_ci_run_missing', { runId: evidence.runId });
  if (Number(run.id) !== evidence.runId) return failure('application_ci_run_id_mismatch', { runId: evidence.runId });
  if (run.name !== 'Application CI') return failure('application_ci_name_mismatch');
  if (run.path !== '.github/workflows/futures-public-network-smoke.yml') return failure('application_ci_workflow_mismatch');
  if (String(run.head_sha ?? '').toLowerCase() !== headSha) return failure('application_ci_sha_mismatch');
  if (expectedHeadRef && run.head_branch !== expectedHeadRef) return failure('application_ci_branch_mismatch');
  if (!ALLOWED_PREMERGE_EVENTS.includes(run.event)) return failure('application_ci_event_not_allowed');
  if (run.status !== 'completed') return failure('application_ci_not_completed');
  if (run.conclusion !== 'success') return failure('application_ci_not_successful');

  if (mergedAt) {
    const mergedAtMs = Date.parse(mergedAt);
    const completedAtMs = Date.parse(run.updated_at ?? run.created_at ?? '');
    if (!Number.isFinite(mergedAtMs) || !Number.isFinite(completedAtMs)) {
      return failure('release_timestamps_invalid');
    }
    if (completedAtMs > mergedAtMs) return failure('application_ci_completed_after_merge');
  }

  return { ok: true, runId: evidence.runId };
}

function evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha,
  targetTreeSha,
  pr,
  headTreeSha,
  statuses,
  run,
}) {
  if (!SHA_RE.test(String(targetSha ?? ''))) return failure('invalid_target_sha');
  if (!SHA_RE.test(String(currentMainSha ?? ''))) return failure('invalid_current_main_sha');
  if (targetSha !== currentMainSha) return failure('target_is_not_current_main');
  if (!SHA_RE.test(String(targetTreeSha ?? ''))) return failure('invalid_target_tree_sha');
  if (!SHA_RE.test(String(headTreeSha ?? ''))) return failure('invalid_head_tree_sha');
  if (!pr || !Number.isInteger(Number(pr.number)) || Number(pr.number) <= 0) return failure('pull_request_missing');
  if (!pr.merged_at) return failure('pull_request_not_merged');
  if (pr.base?.ref !== 'main') return failure('pull_request_base_not_main');

  const headSha = String(pr.head?.sha ?? '').toLowerCase();
  if (!SHA_RE.test(headSha)) return failure('pull_request_head_sha_invalid');
  if (targetTreeSha !== headTreeSha) {
    return failure('merged_tree_differs_from_tested_head', { targetTreeSha, headTreeSha });
  }

  const premerge = evaluatePremergeCi({
    headSha,
    expectedHeadRef: pr.head?.ref,
    statuses,
    run,
    mergedAt: pr.merged_at,
  });
  if (!premerge.ok) return premerge;

  return {
    ok: true,
    prNumber: Number(pr.number),
    headSha,
    runId: premerge.runId,
    targetTreeSha,
  };
}

module.exports = {
  ALLOWED_PREMERGE_EVENTS,
  POST_MERGE_CONTEXT,
  POST_MERGE_WORKFLOW_PATH,
  REQUIRED_PRODUCTION_STATUSES,
  evaluatePostMergeStatusProvenance,
  evaluatePremergeCi,
  evaluateReleaseCandidateProvenance,
  inspectPostMergeStatusEvidence,
};
