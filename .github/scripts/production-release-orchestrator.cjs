'use strict';

const normalizeSha = (value) => String(value ?? '').trim().toLowerCase();

function githubReadFailureCode(error) {
  const status = Number(error?.status ?? error?.response?.status ?? 0);
  if (status === 429) return 'RATE_LIMITED';
  if ([500, 502, 503, 504].includes(status)) return `HTTP_${status}`;
  const code = String(error?.code ?? '').trim().toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) return code;
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (message.includes('unexpected end of json input')
    || message.includes('unexpected end of json')
    || message.includes('invalid json response body')) return 'EMPTY_OR_INVALID_JSON';
  if (message.includes('fetch failed') || message.includes('socket hang up')) return 'READ_TRANSPORT_FAILED';
  return null;
}

async function retryGithubRead(operation, {
  label = 'github-read',
  attempts = 3,
  baseDelayMs = 1_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof operation !== 'function') throw new Error('GITHUB_READ_OPERATION_REQUIRED');
  if (!/^[a-z0-9-]{1,64}$/u.test(label)) throw new Error('GITHUB_READ_LABEL_INVALID');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('GITHUB_READ_ATTEMPTS_INVALID');
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 30_000) {
    throw new Error('GITHUB_READ_DELAY_INVALID');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = githubReadFailureCode(error);
      if (!code) throw error;
      if (attempt === attempts) throw new Error(`GITHUB_READ_RETRY_EXHAUSTED:${label}:${code}`);
      await sleep(baseDelayMs * attempt);
    }
  }
  throw new Error(`GITHUB_READ_RETRY_EXHAUSTED:${label}:UNKNOWN`);
}

function activeRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.status !== 'completed')
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function selectReusableExactStagingRun(runs, targetSha) {
  const target = normalizeSha(targetSha);
  if (!/^[0-9a-f]{40}$/u.test(target)) throw new Error('STAGING_RELEASE_TARGET_SHA_INVALID');
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run
      && run.event === 'workflow_dispatch'
      && run.head_branch === 'main'
      && normalizeSha(run.head_sha) === target
      && (run.status !== 'completed' || run.conclusion === 'success'))
    .sort((left, right) => Number(right.id) - Number(left.id))[0] ?? null;
}

function stagingArtifactAccepted(artifacts, { targetSha, runId }) {
  const target = normalizeSha(targetSha);
  const expectedName = `staging-verdict-${target}`;
  return (Array.isArray(artifacts) ? artifacts : []).some((artifact) => artifact
    && artifact.name === expectedName
    && artifact.expired !== true
    && Number(artifact.workflow_run?.id ?? runId) === Number(runId)
    && normalizeSha(artifact.workflow_run?.head_sha ?? target) === target);
}

module.exports = {
  activeRuns,
  githubReadFailureCode,
  retryGithubRead,
  selectReusableExactStagingRun,
  stagingArtifactAccepted,
};
