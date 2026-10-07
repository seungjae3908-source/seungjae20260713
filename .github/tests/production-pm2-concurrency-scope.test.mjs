import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

const deploy = read('.github/workflows/production-deploy.yml');
const watch = read('.github/workflows/production-pm2-watch-normalize.yml');
const repair = read('.github/workflows/production-pm2-orphan-repair.yml');

test('official Production deploy retains the shared live concurrency lock', () => {
  assert.match(deploy, /'stock-app-production-live'/);
  assert.match(deploy, /cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
});

for (const [name, workflow, command, fallback] of [
  ['watch normalization', watch, '/normalize-production-pm2-watch ', 'production-pm2-watch-normalize-validation-'],
  ['orphan repair', repair, '/repair-production-pm2-orphan ', 'production-pm2-orphan-repair-validation-'],
]) {
  test(`${name} only shares the Production lock for the exact owner command`, () => {
    assert.doesNotMatch(workflow, /concurrency:\s*\n\s*group:\s*stock-app-production-live\s*$/m);
    assert.match(workflow, /github\.event_name == 'issue_comment'/);
    assert.match(workflow, /github\.event\.issue\.number == 23/);
    assert.match(workflow, /github\.event\.comment\.user\.login == 'seungjae3908-source'/);
    assert.match(workflow, /github\.event\.comment\.author_association == 'OWNER'/);
    assert.ok(workflow.includes(`startsWith(github.event.comment.body, '${command}')`));
    assert.match(workflow, /&& 'stock-app-production-live'/);
    assert.ok(workflow.includes(`format('${fallback}{0}', github.run_id)`));
    assert.match(workflow, /cancel-in-progress:\s*false/);
  });
}
