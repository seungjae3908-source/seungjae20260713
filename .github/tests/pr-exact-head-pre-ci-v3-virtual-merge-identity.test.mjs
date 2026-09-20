import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pre-ci virtual merge uses command-scoped identity and remains fail closed', async () => {
  const document = await readFile('.github/scripts/pre-ci-v3.mjs', 'utf8');
  assert.match(document, /VIRTUAL_MERGE_CONFLICT/u);
  assert.match(document, /READY_BASE_STALE/u);
  assert.match(document, /READY_PRODUCT_INTEGRITY_BLOCKED/u);
  assert.match(document, /git worktree add --detach/u);
  assert.match(document, /git -c user\.name=pre-ci-v3 -c user\.email=pre-ci-v3@invalid\.local merge --no-commit --no-ff/u);
  assert.doesNotMatch(document, /git config --global|--force-with-lease|push --force|git push/u);
});
