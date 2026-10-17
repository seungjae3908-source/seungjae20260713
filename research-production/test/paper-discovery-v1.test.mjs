import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';
import { customUserRuleV1 } from '../src/exploratory-paper-ledger-v1.mjs';
import { draftHypothesisFromAbstractV1, parseArxivAtomV1, runPaperDiscoveryV1, validateAiDraftV1 } from '../src/paper-discovery-v1.mjs';

const FEED = `<?xml version="1.0"?><feed>
<entry><id>http://arxiv.org/abs/2610.01234v2</id><title>Time-series momentum in Bitcoin perpetual futures</title>
<summary>We study trend-following and volume shocks &amp; breakouts in cryptocurrency perpetual markets.</summary>
<published>2026-10-10T00:00:00Z</published><category term="q-fin.TR"/></entry>
<entry><id>http://arxiv.org/abs/2610.09999v1</id><title>A note on option pricing</title><summary>Closed form for exotic payoffs.</summary>
<published>2026-10-11T00:00:00Z</published></entry>
</feed>`;

test('arXiv Atom parsing and deterministic drafting with library atoms only', () => {
  const papers = parseArxivAtomV1(FEED);
  assert.equal(papers.length, 2);
  assert.equal(papers[0].arxivId, '2610.01234');
  assert.match(papers[0].summary, /volume shocks & breakouts/u);
  const draft = draftHypothesisFromAbstractV1(papers[0]);
  assert.ok(draft.drafts.length >= 1);
  assert.ok(draft.drafts.every((row) => row.laneId.startsWith('CRYPTO')));
  const short = draft.drafts.find((row) => row.direction === 'SHORT');
  assert.ok(short.atoms.every((id) => !id.includes('ABOVE') && !id.includes('BREAKOUT')));
  assert.equal(draftHypothesisFromAbstractV1(papers[1]), null);
});

test('AI refinements outside the library or on the wrong side are discarded', () => {
  assert.equal(validateAiDraftV1({ atoms: ['NOT_AN_ATOM'] }, 'CRYPTO_FUTURES_LONG'), null);
  assert.equal(validateAiDraftV1({ atoms: ['T_CLOSE_ABOVE_SMA50'] }, 'CRYPTO_FUTURES_SHORT'), null);
  assert.deepEqual(validateAiDraftV1({ atoms: ['T_CLOSE_ABOVE_SMA50'] }, 'CRYPTO_FUTURES_LONG').atoms, ['T_CLOSE_ABOVE_SMA50']);
});

test('discovery stores drafts as pending owner approval, de-duplicates and respects its interval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'papers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => FEED }; };
  const first = await runPaperDiscoveryV1({ stateRoot: root, fetchImpl, now: () => '2026-10-17T00:00:00.000Z' });
  assert.equal(first.added, 2);
  assert.equal(first.pendingApproval, 1);
  assert.equal(first.automaticApproval, false);
  const early = await runPaperDiscoveryV1({ stateRoot: root, fetchImpl, now: () => '2026-10-17T01:00:00.000Z' });
  assert.equal(early.status, 'NOT_DUE');
  const later = await runPaperDiscoveryV1({ stateRoot: root, fetchImpl, now: () => '2026-10-17T07:00:00.000Z' });
  assert.equal(later.added, 0, 'same papers are not stored twice');
  assert.ok(calls >= 6);
});

test('an approved custom formula becomes a paper rule only with library atoms on the lane side', () => {
  const long = RESEARCH_LANES_V2.find((lane) => lane.id === 'CRYPTO_FUTURES_LONG');
  const ok = customUserRuleV1(long, { atoms: ['T_CLOSE_ABOVE_SMA200', 'U_RVOL20_GT_2_5'], exitId: 'X3' });
  assert.match(ok.trialId, /^user-/u);
  assert.equal(ok.exitId, 'X3');
  assert.equal(customUserRuleV1(long, { atoms: ['T_CLOSE_BELOW_SMA200'] }), null, 'short atom on a long lane');
  assert.equal(customUserRuleV1(long, { atoms: ['U_RVOL20_GT_2_5'] }), null, 'filter-only rule has no direction');
  assert.equal(customUserRuleV1(long, { atoms: ['X'] }), null);
});

test('a fully failed run retries within the hour instead of waiting the full interval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'papers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const down = async () => { throw new Error('fetch failed'); };
  const first = await runPaperDiscoveryV1({ stateRoot: root, fetchImpl: down, now: () => '2026-10-17T00:00:00.000Z' });
  assert.equal(first.status, 'FAILED_RETRY_HOURLY');
  assert.equal((await runPaperDiscoveryV1({ stateRoot: root, fetchImpl: down, now: () => '2026-10-17T00:30:00.000Z' })).status, 'RETRY_LATER');
  const up = async () => ({ ok: true, status: 200, text: async () => FEED });
  assert.equal((await runPaperDiscoveryV1({ stateRoot: root, fetchImpl: up, now: () => '2026-10-17T01:10:00.000Z' })).status, 'RAN');
});
