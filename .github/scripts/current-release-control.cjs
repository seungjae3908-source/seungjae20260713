'use strict';

const RELEASE_CONTROL_LABEL = 'release-control';
const RELEASE_CONTROL_TITLE_PREFIX = 'Staging Readiness Control';
const RELEASE_CONTROL_CANONICAL_MARKER = '<!-- release-control-canonical:v2 -->';

function canonicalCandidates(issues, owner) {
  return issues
    .filter((issue) =>
      !issue?.pull_request
      && issue?.state === 'open'
      && issue?.user?.login === owner
      && String(issue?.title ?? '').startsWith(RELEASE_CONTROL_TITLE_PREFIX)
      && String(issue?.body ?? '').includes(RELEASE_CONTROL_CANONICAL_MARKER)
      && Array.isArray(issue?.labels)
      && issue.labels.some((label) =>
        (typeof label === 'string' ? label : label?.name) === RELEASE_CONTROL_LABEL))
    .sort((left, right) => Number(right?.number ?? 0) - Number(left?.number ?? 0));
}

async function resolveCurrentReleaseControl({ github, context }) {
  if (!context?.repo?.owner || !context?.repo?.repo) {
    throw new Error('RELEASE_CONTROL_REPOSITORY_CONTEXT_INVALID');
  }
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'open',
    labels: RELEASE_CONTROL_LABEL,
    per_page: 100,
  });
  const candidates = canonicalCandidates(issues, context.repo.owner);
  const current = candidates[0];
  if (!current || !Number.isSafeInteger(Number(current.number)) || Number(current.number) <= 0) {
    throw new Error('CURRENT_RELEASE_CONTROL_NOT_FOUND');
  }
  return Object.freeze({
    issueNumber: Number(current.number),
    issueTitle: String(current.title),
    marker: RELEASE_CONTROL_CANONICAL_MARKER,
  });
}

async function assertCurrentReleaseControl({ github, context, issueNumber, issueTitle }) {
  const current = await resolveCurrentReleaseControl({ github, context });
  if (Number(issueNumber) !== current.issueNumber || String(issueTitle ?? '') !== current.issueTitle) {
    throw new Error(
      `RELEASE_CONTROL_NOT_CANONICAL:actual=${issueNumber}:${String(issueTitle ?? '')}:expected=${current.issueNumber}:${current.issueTitle}`,
    );
  }
  return current;
}

module.exports = {
  RELEASE_CONTROL_CANONICAL_MARKER,
  RELEASE_CONTROL_LABEL,
  RELEASE_CONTROL_TITLE_PREFIX,
  assertCurrentReleaseControl,
  canonicalCandidates,
  resolveCurrentReleaseControl,
};
