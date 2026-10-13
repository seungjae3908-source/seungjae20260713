'use strict';
// Runner/GitHub metadata only. Never approve, retarget, deploy or touch a host.
const fs = require('node:fs');
const path = require('node:path');
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const OWNER = 'seungjae3908-source';
const WORKFLOW = '.github/workflows/research-isolated-release.yml';
const HOST_JOB = 'Protected read-only Research host audit — no deployment or activation';
const SHA = /^[a-f0-9]{40}$/u;
const positive = x => /^[1-9][0-9]*$/u.test(String(x)) && Number.isSafeInteger(Number(x));
const check = (ok, code) => { if (!ok) throw new Error('RESEARCH_ISOLATED_' + code); };
const params = Object.freeze({ owner: OWNER, repo: 'seungjae20260713' });

function isStaleWaitingAudit(run, currentMainSha) {
  return SHA.test(currentMainSha ?? '') && positive(run?.id)
    && run.path === WORKFLOW && run.event === 'issue_comment'
    && run.head_branch === 'main' && run.status === 'waiting' && run.conclusion === null
    && SHA.test(run.head_sha ?? '') && run.head_sha !== currentMainSha
    && run.repository?.full_name === REPOSITORY
    && run.head_repository?.full_name === REPOSITORY && run.actor?.login === OWNER
    && positive(run.run_attempt);
}

async function cancelStaleWaitingAudits({ github, context }) {
  check(context.eventName === 'push' && context.ref === 'refs/heads/main'
    && `${context.repo?.owner}/${context.repo?.repo}` === REPOSITORY
    && SHA.test(context.sha ?? ''), 'SWEEP_CONTEXT_INVALID');
  const report = { schemaVersion: 'research-audit-stale-approval-sweep-v1',
    eventSha: context.sha, observedMainSha: null, status: 'CHECKING', inspected: 0,
    cancellations: [], errors: [], approvals: 0, retargets: 0, hostAccesses: 0,
    executionAuthority: 'NONE' };
  const readMain = async () => {
    const value = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data.commit.sha;
    check(SHA.test(value ?? ''), 'SWEEP_MAIN_INVALID');
    report.observedMainSha = value;
    return value;
  };
  if (await readMain() !== context.sha) { report.status = 'SUPERSEDED_PUSH_NO_ACTION'; return report; }
  // Paginate completely. Never infer absence from one page or a failed request.
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
    { ...params, status: 'waiting', per_page: 100 });
  check(Array.isArray(runs) && runs.length <= 5000, 'SWEEP_LOOKUP_INCOMPLETE');
  const ids = [...new Set(runs.filter(run => isStaleWaitingAudit(run, context.sha)).map(run => run.id))];
  for (const id of ids) {
    report.inspected++;
    try {
      if (await readMain() !== context.sha) { report.status = 'MAIN_MOVED_NO_FURTHER_ACTION'; return report; }
      const run = (await github.rest.actions.getWorkflowRun({ ...params, run_id: id })).data;
      check(run?.id === id, 'SWEEP_RUN_ID_MISMATCH');
      if (!isStaleWaitingAudit(run, context.sha)) continue;
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun,
        { ...params, run_id: id, filter: 'latest', per_page: 100 });
      check(Array.isArray(jobs) && jobs.length <= 1000
        && jobs.every(job => job.run_id === id), 'SWEEP_JOBS_INCOMPLETE');
      // Do not cancel an observed running audit, or an unrelated waiting job.
      if (jobs.some(job => job.status === 'in_progress')
        || !jobs.some(job => job.name === HOST_JOB && job.status === 'waiting')) continue;
      if (await readMain() !== context.sha) { report.status = 'MAIN_MOVED_NO_FURTHER_ACTION'; return report; }
      const fresh = (await github.rest.actions.getWorkflowRun({ ...params, run_id: id })).data;
      check(fresh?.id === id, 'SWEEP_RUN_ID_MISMATCH');
      if (!isStaleWaitingAudit(fresh, context.sha) || fresh.head_sha !== run.head_sha
        || fresh.run_attempt !== run.run_attempt) continue;
      // A 202 requests cancellation; it is NOT a terminal cancelled receipt.
      const response = await github.rest.actions.cancelWorkflowRun({ ...params, run_id: id });
      check(response.status === 202, 'SWEEP_CANCEL_NOT_ACCEPTED');
      report.cancellations.push({ runId: id, targetSha: fresh.head_sha, status: 'CANCELLATION_REQUESTED' });
    } catch (error) {
      // Never log raw API responses, credentials or untrusted error messages.
      report.errors.push({ runId: id, code: 'CANCELLATION_NOT_CONFIRMED',
        httpStatus: Number.isSafeInteger(error?.status) ? error.status : null });
    }
  }
  report.status = report.errors.length ? 'INCOMPLETE' : 'COMPLETE';
  return report;
}

function safeFailureCode(error) {
  return /^RESEARCH_ISOLATED_[A-Z0-9_]{1,100}$/u.test(error?.message ?? '')
    ? error.message : 'RESEARCH_ISOLATED_REVALIDATION_FAILED';
}
function writeJson(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, name);
  fs.writeFileSync(filename + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(filename + '.tmp', filename);
}
async function revalidateWithReceipt({ github, context, targetSha, authorize,
  attempt, evidenceDirectory = 'research-isolated-evidence' }) {
  check(SHA.test(targetSha ?? '') && positive(context.runId) && positive(attempt), 'RECEIPT_IDENTITY_INVALID');
  const receipt = { schemaVersion: 'research-audit-runner-lifecycle-v1', runId: Number(context.runId),
    runAttempt: Number(attempt), targetSha, observedMainSha: null,
    observedAt: new Date().toISOString(), status: 'AUTHORIZATION_PENDING', reasonCode: null,
    hostAuditAttempted: false, hostAuditCompleted: false, fullyFunctional: false,
    appUiDeployed: false, activationGranted: false, executionAuthority: 'NONE' };
  // Evidence exists BEFORE any call that can fail after a human approval.
  writeJson(evidenceDirectory, 'preflight-status.json', receipt);
  try {
    const proof = await authorize({ github, context, targetSha });
    check(proof?.targetSha === targetSha && proof.executionAuthority === 'NONE', 'RECEIPT_PROOF_INVALID');
    writeJson(evidenceDirectory, 'code-proof.json', proof);
    receipt.status = 'AUTHORIZED_NOT_AUDITED';
    receipt.observedMainSha = targetSha;
    writeJson(evidenceDirectory, 'preflight-status.json', receipt);
    return proof;
  } catch (error) {
    receipt.status = 'BLOCKED';
    receipt.reasonCode = safeFailureCode(error);
    if (receipt.reasonCode === 'RESEARCH_ISOLATED_CURRENT_MAIN_MOVED') {
      try {
        const main = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data.commit.sha;
        if (SHA.test(main ?? '')) receipt.observedMainSha = main;
      } catch { /* Unknown remains null, never a PASS or invented SHA. */ }
    }
    writeJson(evidenceDirectory, 'preflight-status.json', receipt);
    throw new Error(receipt.reasonCode);
  }
}
function finishReceipt({ outcomes, evidenceDirectory = 'research-isolated-evidence' }) {
  const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'preflight-status.json'), 'utf8'));
  check(receipt.schemaVersion === 'research-audit-runner-lifecycle-v1', 'RECEIPT_SCHEMA_INVALID');
  const stages = ['app_identity', 'ssh_config', 'host_audit', 'audit_receipt', 'app_after'];
  const valid = new Set(['', 'success', 'failure', 'cancelled', 'skipped']);
  check(stages.every(key => valid.has(outcomes[key] ?? '')), 'RECEIPT_OUTCOME_INVALID');
  receipt.stepOutcomes = Object.fromEntries(stages.map(key => [key, outcomes[key] ?? '']));
  receipt.hostAuditAttempted = ['success', 'failure', 'cancelled'].includes(outcomes.host_audit);
  // Retain the original authorization reason, not the subsequent skipped steps.
  if (receipt.status !== 'BLOCKED') {
    const failed = stages.find(key => outcomes[key] !== 'success');
    receipt.status = failed ? 'AUDIT_NOT_COMPLETED' : 'READONLY_AUDIT_COMPLETED';
    receipt.reasonCode = failed ? 'RESEARCH_ISOLATED_STAGE_' + failed.toUpperCase() : null;
    receipt.hostAuditCompleted = !failed;
  }
  receipt.fullyFunctional = false;
  receipt.activationGranted = false;
  receipt.executionAuthority = 'NONE';
  writeJson(evidenceDirectory, 'preflight-status.json', receipt);
  return receipt;
}
module.exports = { REPOSITORY, OWNER, WORKFLOW, HOST_JOB, isStaleWaitingAudit,
  cancelStaleWaitingAudits, safeFailureCode, revalidateWithReceipt, finishReceipt };
