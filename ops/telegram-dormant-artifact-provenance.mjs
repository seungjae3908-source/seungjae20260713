/** Exact-main, post-merge GitHub Actions artifact provenance. Pure and offline testable. */
export const TELEGRAM_DORMANT_WORKFLOW =
  '.github/workflows/telegram-isolated-dormant-package.yml';
export const TELEGRAM_DORMANT_WORKFLOW_NAME =
  'Telegram Isolated Dormant Package QA (No Deployment)';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const fail = code => Object.freeze({ok:false,code});

/** Never allow a PR, workflow_dispatch, stale commit or rerun-to-green artifact. */
export function attestTelegramDormantArtifact({
  targetSha, currentMainSha, repository, run, artifacts,
}) {
  if (!SHA.test(String(targetSha)) || targetSha !== currentMainSha
      || typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(repository))
    return fail('TELEGRAM_ARTIFACT_STALE_OR_INVALID_MAIN');
  if (!run || run.name !== TELEGRAM_DORMANT_WORKFLOW_NAME
      || run.path !== TELEGRAM_DORMANT_WORKFLOW
      || run.event !== 'push' || run.head_branch !== 'main'
      || run.head_sha !== targetSha
      || run.head_repository?.full_name !== repository
      || run.repository?.full_name !== repository
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.run_attempt !== 1
      || !Number.isSafeInteger(run.id) || run.id < 1)
    return fail('TELEGRAM_ARTIFACT_RUN_PROVENANCE_INVALID');
  if (!Array.isArray(artifacts))
    return fail('TELEGRAM_ARTIFACT_LIST_INVALID');
  const matches = artifacts.filter(a => a?.name === 'telegram-dormant-package-' + targetSha);
  if (matches.length !== 1) return fail('TELEGRAM_ARTIFACT_NOT_UNIQUE');
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1
      || artifact.expired !== false
      || !DIGEST.test(String(artifact.digest))
      || artifact.workflow_run?.head_sha !== targetSha
      || !Number.isSafeInteger(artifact.size_in_bytes)
      || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 16 * 1024 * 1024)
    return fail('TELEGRAM_ARTIFACT_METADATA_INVALID');
  return Object.freeze({
    ok:true,code:'TELEGRAM_ARTIFACT_PROVENANCE_VALID',
    sha:targetSha,runId:run.id,artifactId:artifact.id,digest:artifact.digest,
  });
}
