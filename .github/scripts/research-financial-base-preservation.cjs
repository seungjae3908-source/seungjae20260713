'use strict';
// PR-scoped preservation check. Compare immutable candidate vs the real GitHub
// PR base, not an obsolete historical release snapshot. No host or write APIs.
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const OWNER = 'seungjae3908-source';
const SHA = /^[a-f0-9]{40}$/u;
const FINANCIAL_PATHS = Object.freeze([
  '.github/workflows/production-deploy.yml',
  '.github/workflows/production-automatic-trading-gate.yml',
  'api-server/src/routes/trade-automation.ts',
  'ops/production-auto-live-signal-identity.cjs',
  'ops/production-auto-live-signal-source-audit.mjs',
]);
const assert = (condition, code) => {
  if (!condition) throw new Error('RESEARCH_FINANCIAL_PRESERVATION_' + code);
};
function protectedEntries(tree, expectedTreeSha) {
  assert(SHA.test(expectedTreeSha ?? '') && tree?.sha === expectedTreeSha
    && tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 100000,
  'TREE_INCOMPLETE');
  const entries = tree.tree.filter(entry => FINANCIAL_PATHS.includes(entry.path));
  assert(entries.length === FINANCIAL_PATHS.length
    && new Set(entries.map(entry => entry.path)).size === FINANCIAL_PATHS.length,
  'PATHS_MISSING_OR_DUPLICATED');
  for (const entry of entries) assert(entry.type === 'blob' && entry.mode === '100644'
    && SHA.test(entry.sha ?? ''), 'REGULAR_FILE_REQUIRED');
  return entries;
}
function verifyFinancialPreservation({ baseSha, headSha, baseTree, headTree,
  baseTreeSha, headTreeSha }) {
  assert(SHA.test(baseSha ?? '') && SHA.test(headSha ?? ''), 'COMMIT_IDENTITY_INVALID');
  const baseline = protectedEntries(baseTree, baseTreeSha);
  const candidate = protectedEntries(headTree, headTreeSha);
  for (const original of baseline) {
    assert(candidate.find(entry => entry.path === original.path).sha === original.sha,
      'PROTECTED_PATH_CHANGED');
  }
  return { schemaVersion: 'research-pr-financial-preservation-v1', baseSha, headSha,
    baseTreeSha, headTreeSha, checkedPaths: FINANCIAL_PATHS.length,
    protectedFilesUnchanged: true, executionAuthority: 'NONE' };
}
async function authorizeResearchFinancialPreservation({ github, context, checkedOutSha }) {
  assert(context.eventName === 'pull_request'
    && `${context.repo?.owner}/${context.repo?.repo}` === REPOSITORY,
  'PR_CONTEXT_REQUIRED');
  const number = context.payload?.pull_request?.number;
  const requestedHead = context.payload?.pull_request?.head?.sha;
  assert(Number.isSafeInteger(number) && number > 0 && SHA.test(requestedHead ?? '')
    && checkedOutSha === requestedHead, 'CHECKOUT_IDENTITY_INVALID');
  const params = { owner: OWNER, repo: 'seungjae20260713' };
  const readMain = async () => (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data.commit.sha;
  const readPr = async () => (await github.rest.pulls.get({ ...params, pull_number: number })).data;
  const currentMain = await readMain();
  const pr = await readPr();
  const validPr = value => value?.number === number && value.state === 'open'
    && value.base?.ref === 'main' && value.base.repo?.full_name === REPOSITORY
    && value.head?.repo?.full_name === REPOSITORY && value.head.sha === requestedHead
    && value.base.sha === currentMain;
  assert(SHA.test(currentMain ?? '') && validPr(pr), 'CURRENT_PR_BASE_OR_HEAD_CHANGED');
  const readTree = async commitSha => {
    const commit = (await github.rest.repos.getCommit({ ...params, ref: commitSha })).data;
    assert(commit?.sha === commitSha && SHA.test(commit.commit?.tree?.sha ?? ''), 'COMMIT_LOOKUP_MISMATCH');
    const treeSha = commit.commit.tree.sha;
    const tree = (await github.rest.git.getTree({ ...params, tree_sha: treeSha, recursive: '1' })).data;
    return { treeSha, tree };
  };
  const base = await readTree(currentMain);
  const head = await readTree(requestedHead);
  const proof = verifyFinancialPreservation({ baseSha: currentMain, headSha: requestedHead,
    baseTreeSha: base.treeSha, headTreeSha: head.treeSha, baseTree: base.tree, headTree: head.tree });
  assert(await readMain() === currentMain && validPr(await readPr()), 'MAIN_OR_PR_MOVED_DURING_AUDIT');
  return proof;
}
module.exports = { FINANCIAL_PATHS, protectedEntries, verifyFinancialPreservation,
  authorizeResearchFinancialPreservation };
