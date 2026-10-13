'use strict';
// GitHub metadata only. Reuse canonical code proofs; never mint statuses,
// approve environments, dispatch jobs, access a host or grant trading authority.
const { createHash } = require('node:crypto');
const { authorize: authorizeCanonical, assertOwnerContext } = require('./research-isolated-release.cjs');
const { REQUIRED_PRODUCTION_STATUSES, evaluateProductionCiProvenance,
  inspectRequiredStatusEvidence } = require('../../api-server/scripts/production-ci-provenance.cjs');
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const APPLICATION = '.github/workflows/futures-public-network-smoke.yml';
const SHA = /^[a-f0-9]{40}$/u;
const MODES = ['EXACT_CURRENT_MAIN_SIX', 'CANONICAL_PREMERGE_SIX_AND_IDENTICAL_MERGED_TREE'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const check = (ok, code) => { if (!ok) throw Error('RESEARCH_TARGET_CI_' + code); };
const bounded = (rows, limit) => {
  check(Array.isArray(rows) && rows.length <= limit, 'LOOKUP_INCOMPLETE'); return rows;
};
function directRuns(rows, targetSha) {
  return bounded(rows, 5000).filter(run => run.path === APPLICATION && run.head_sha === targetSha
    && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event))
    .sort((a,b) => Number(b.id) - Number(a.id));
}
function statusSignature(rows) {
  return JSON.stringify(bounded(rows, 10000).filter(row =>
    REQUIRED_PRODUCTION_STATUSES.includes(row.context) || row.context === 'post-merge-provenance/verified')
    .map(row => [row.id, row.context, row.state, row.target_url, row.created_at])
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function runSignature(rows, targetSha) {
  return JSON.stringify(directRuns(rows, targetSha).map(run =>
    [run.id, run.run_attempt, run.status, run.conclusion, run.head_sha]));
}
function validateProof(proof) {
  check(proof?.schemaVersion === 'research-activation-target-code-proof-v1'
    && SHA.test(proof.targetSha ?? '') && SHA.test(proof.targetTreeSha ?? '')
    && SHA.test(proof.testedHeadSha ?? '') && positive(proof.requiredCiRunId)
    && MODES.includes(proof.proofMode) && proof.executionAuthority === 'NONE', 'PROOF_INVALID');
  if (proof.proofMode === MODES[0]) {
    check(proof.testedHeadSha === proof.targetSha && proof.postMergeRunId === null
      && proof.sourcePullRequest === null, 'DIRECT_PROOF_INVALID');
  } else {
    check(positive(proof.postMergeRunId) && positive(proof.sourcePullRequest), 'CANONICAL_PROOF_INVALID');
  }
  return proof;
}
function proofDigest(proof) {
  validateProof(proof);
  const keys = ['schemaVersion','targetSha','targetTreeSha','testedHeadSha','requiredCiRunId',
    'postMergeRunId','sourcePullRequest','proofMode','executionAuthority'];
  check(Object.keys(proof).length === keys.length && keys.every(key => Object.hasOwn(proof,key)), 'PROOF_FIELDS_INVALID');
  return createHash('sha256').update(JSON.stringify(keys.map(key => [key,proof[key]]))).digest('hex');
}
function assertSameCodeProof(actual, expected) {
  check(proofDigest(actual) === proofDigest(expected), 'APPROVED_PROOF_CHANGED');
  return actual;
}
async function resolveResearchTargetCi({ github, context, targetSha }) {
  try {
    assertOwnerContext(context, targetSha);
    const command = /^\/(?:activate-research-production|repair-research-production) ([a-f0-9]{40})$/u
      .exec(String(context.payload?.comment?.body ?? '').trim());
    check(command?.[1] === targetSha && SHA.test(targetSha ?? ''), 'ACTIVATION_COMMAND_REQUIRED');
    const params = {owner:'seungjae3908-source', repo:'seungjae20260713'};
    const readMain = async () => (await github.rest.repos.getBranch({...params,branch:'main'})).data.commit.sha;
    const readRuns = async () => bounded(await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
      {...params,head_sha:targetSha,per_page:100}),5000);
    const readStatuses = async () => bounded(await github.paginate(github.rest.repos.listCommitStatusesForRef,
      {...params,ref:targetSha,per_page:100}),10000);
    check(await readMain() === targetSha,'CURRENT_MAIN_MOVED');
    const beforeRuns = await readRuns(), statuses = await readStatuses();
    const direct = directRuns(beforeRuns,targetSha);
    let proof;
    if (direct.length) {
      // A failed, pending, cancelled or incoherent newer main run is a blocker,
      // never a reason to downgrade to an older canonical success.
      const newest = direct[0];
      check(positive(newest.id),'RUN_ID_INVALID');
      const run = (await github.rest.actions.getWorkflowRun({...params,run_id:newest.id})).data;
      const result = evaluateProductionCiProvenance({targetSha,currentMainSha:targetSha,statuses,run});
      check(result.ok && run.id === newest.id && result.runId === newest.id,'DIRECT_MAIN_NOT_VERIFIED');
      check(run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,'RUN_REPOSITORY_INVALID');
      const evidence = inspectRequiredStatusEvidence(statuses);
      for (const name of REQUIRED_PRODUCTION_STATUSES) {
        check(evidence.latest.get(name)?.target_url === `https://github.com/${REPOSITORY}/actions/runs/${run.id}`,'STATUS_ORIGIN_INVALID');
      }
      const commit = (await github.rest.repos.getCommit({...params,ref:targetSha})).data;
      check(commit?.sha === targetSha && SHA.test(commit.commit?.tree?.sha ?? ''),'COMMIT_IDENTITY_INVALID');
      proof = {schemaVersion:'research-activation-target-code-proof-v1',targetSha,
        targetTreeSha:commit.commit.tree.sha,testedHeadSha:targetSha,requiredCiRunId:run.id,
        postMergeRunId:null,sourcePullRequest:null,proofMode:MODES[0],executionAuthority:'NONE'};
    } else {
      check(!statuses.some(row => REQUIRED_PRODUCTION_STATUSES.includes(row.context)),'ORPHAN_TARGET_STATUSES');
      const canonical = await authorizeCanonical({github,context,targetSha});
      check(canonical.schemaVersion === 'research-isolated-code-provenance-v1'
        && canonical.targetSha === targetSha && canonical.proofMode === MODES[1]
        && canonical.executionAuthority === 'NONE','CANONICAL_PROOF_INVALID');
      proof = {schemaVersion:'research-activation-target-code-proof-v1',targetSha,
        targetTreeSha:canonical.targetTreeSha,testedHeadSha:canonical.testedHeadSha,
        requiredCiRunId:canonical.requiredCiRunId,postMergeRunId:canonical.postMergeRunId,
        sourcePullRequest:canonical.sourcePullRequest,proofMode:canonical.proofMode,executionAuthority:'NONE'};
    }
    validateProof(proof);
    check(runSignature(await readRuns(),targetSha) === runSignature(beforeRuns,targetSha),'TARGET_RUNS_CHANGED');
    check(statusSignature(await readStatuses()) === statusSignature(statuses),'TARGET_STATUSES_CHANGED');
    check(await readMain() === targetSha,'CURRENT_MAIN_MOVED');
    return proof;
  } catch (error) {
    const code = /^(?:RESEARCH_TARGET_CI_[A-Z0-9_]+|RESEARCH_ISOLATED_[A-Za-z0-9_]+)$/u.test(error?.message ?? '')
      ? error.message : 'RESEARCH_TARGET_CI_METADATA_UNAVAILABLE';
    throw Error(code);
  }
}
module.exports = {resolveResearchTargetCi,validateProof,proofDigest,assertSameCodeProof};
