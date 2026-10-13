'use strict';

const {
  evaluatePostMergeStatusProvenance,
  inspectPostMergeStatusEvidence,
} = require('../../api-server/scripts/release-candidate-provenance.cjs');

const REQUIRED = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);

function latestByContext(statuses) {
  const latest = new Map();
  for (const status of [...statuses].sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0))) {
    const context = String(status?.context ?? '');
    if (context && !latest.has(context)) latest.set(context, status);
  }
  return latest;
}

function runId(status) {
  const match = /\/actions\/runs\/(\d+)(?:[/?#]|$)/u.exec(String(status?.target_url ?? ''));
  return match ? Number(match[1]) : null;
}

async function inspectCurrentMainCiProvenance({ github, context, targetSha }) {
  const target = String(targetSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(target)) throw new Error('CURRENT_MAIN_CI_TARGET_INVALID');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const main = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha;
  if (main !== target) throw new Error(`CURRENT_MAIN_CI_STALE:${target}!=${main}`);

  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    ...repo, ref: target, per_page: 100,
  });
  const latest = latestByContext(statuses);
  const direct = REQUIRED.map((name) => latest.get(name));
  if (direct.every((status) => status?.state === 'success')) {
    const ids = new Set(direct.map(runId));
    if (ids.size !== 1 || ids.has(null)) throw new Error('CURRENT_MAIN_CI_DIRECT_PROVENANCE_INCOHERENT');
    const directRunId = [...ids][0];
    const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: directRunId })).data;
    if (run.head_sha !== target || run.status !== 'completed' || run.conclusion !== 'success') {
      throw new Error('CURRENT_MAIN_CI_DIRECT_RUN_REJECTED');
    }
    return { mode: 'DIRECT_6_OF_6', runId: directRunId, statuses };
  }

  const evidence = inspectPostMergeStatusEvidence(statuses);
  if (!evidence.ok) throw new Error(`CURRENT_MAIN_CI_POSTMERGE_UNAVAILABLE:${evidence.reason}`);
  const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: evidence.runId })).data;
  const verified = evaluatePostMergeStatusProvenance({
    targetSha: target,
    currentMainSha: main,
    statuses,
    run,
  });
  if (!verified.ok) throw new Error(`CURRENT_MAIN_CI_POSTMERGE_REJECTED:${verified.reason}`);
  return { mode: 'POST_MERGE_PROVENANCE', runId: verified.runId, statuses };
}

module.exports = {
  REQUIRED,
  inspectCurrentMainCiProvenance,
};
