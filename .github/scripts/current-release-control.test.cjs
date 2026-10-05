'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertCurrentReleaseControl,
  canonicalCandidates,
  resolveCurrentReleaseControl,
} = require('./current-release-control.cjs');

function issue(number, {
  title = `Staging Readiness Control — Rollover 2026-10-${String(number).slice(-2)}`,
  body = '<!-- release-control-canonical:v2 -->',
  labels = [{ name: 'release-control' }],
  state = 'open',
  user = 'owner',
  pullRequest = false,
} = {}) {
  return {
    number, title, body, labels, state,
    user: { login: user },
    ...(pullRequest ? { pull_request: {} } : {}),
  };
}

function fixture(issues) {
  const listForRepo = () => undefined;
  return {
    github: {
      rest: { issues: { listForRepo } },
      paginate: async (fn, args) => {
        assert.equal(fn, listForRepo);
        assert.equal(args.state, 'open');
        assert.equal(args.labels, 'release-control');
        return issues;
      },
    },
    context: { repo: { owner: 'owner', repo: 'repo' } },
  };
}

test('newest owner-created canonical v2 rollover is current', async () => {
  const input = fixture([
    issue(23, { title: 'Staging Readiness Control', body: '', labels: [{ name: 'release-control' }] }),
    issue(1555),
    issue(1700, { title: 'Staging Readiness Control — Rollover 2026-11-01' }),
  ]);
  const result = await resolveCurrentReleaseControl(input);
  assert.equal(result.issueNumber, 1700);
  assert.equal(result.issueTitle, 'Staging Readiness Control — Rollover 2026-11-01');
});

test('predecessor without canonical marker is excluded', () => {
  assert.deepEqual(canonicalCandidates([
    issue(23, { title: 'Staging Readiness Control', body: '' }),
    issue(1555),
  ], 'owner').map((row) => row.number), [1555]);
});

test('wrong owner, closed issue, PR, or missing release-control label is excluded', () => {
  const candidates = canonicalCandidates([
    issue(1, { user: 'other' }),
    issue(2, { state: 'closed' }),
    issue(3, { pullRequest: true }),
    issue(4, { labels: [{ name: 'other' }] }),
    issue(5),
  ], 'owner');
  assert.deepEqual(candidates.map((row) => row.number), [5]);
});

test('exact current issue passes canonical assertion', async () => {
  const input = fixture([issue(1555)]);
  const current = await assertCurrentReleaseControl({
    ...input,
    issueNumber: 1555,
    issueTitle: 'Staging Readiness Control — Rollover 2026-10-55',
  });
  assert.equal(current.issueNumber, 1555);
});

test('stale predecessor fails closed after rollover', async () => {
  const input = fixture([
    issue(1555),
    issue(1700, { title: 'Staging Readiness Control — Rollover 2026-11-01' }),
  ]);
  await assert.rejects(
    assertCurrentReleaseControl({
      ...input,
      issueNumber: 1555,
      issueTitle: 'Staging Readiness Control — Rollover 2026-10-55',
    }),
    /RELEASE_CONTROL_NOT_CANONICAL/u,
  );
});
