import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  decideResearchDigestV1,
  extractResearchMilestonesV1,
  formatResearchResultsDigestKoV1,
  kstDateV1,
  runResearchResultsDigestV1,
} from '../src/research-results-digest-v1.mjs';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ENV = { RESEARCH_OPS_TELEGRAM_BOT_TOKEN: TOKEN, RESEARCH_OPS_TELEGRAM_CHAT_ID: '-1001234567' };
// 2026-10-18 08:00 KST and 10:00 KST.
const BEFORE_DIGEST = '2026-10-17T23:00:00.000Z';
const AFTER_DIGEST = '2026-10-18T01:00:00.000Z';

function combination({ candidates = [] } = {}) {
  return {
    contract: 'combination-search-lane/v1', observedAt: AFTER_DIGEST,
    datasetLog: ['secret dataset line'],
    lanes: [
      { laneId: 'CRYPTO_FUTURES_LONG', status: 'SEARCHING', trialsEvaluated: 10, cumulativeTrials: 120, survivors: 1, watch: 2, rejected: 7,
        paperCandidates: candidates, top: [{ trialId: 'secret-top-row' }] },
      { laneId: 'CRYPTO_SPOT_LONG', status: 'WAITING_FOR_DATA' },
    ],
  };
}

function exitComparison({ winner = true } = {}) {
  return {
    contract: 'exit-strategy-comparison/v1', observedAt: AFTER_DIGEST,
    lanes: [{ laneId: 'CRYPTO_SPOT_LONG', status: 'COMPLETE', signalSets: [
      { signalSetId: 'SURGE_BREAKOUT', label: '급등 시작', variants: [{ variantId: 'secret-variant-row' }],
        winner: winner ? { status: 'WINNER', variantId: 'SINGLE+TRAIL_FULL', validationMeanR: 0.21 } : { status: 'NO_WINNER', variantId: null } },
    ] }],
  };
}

function exploratory({ eligible = false } = {}) {
  return {
    contract: 'exploratory-paper-ledger/v1', lane: 'EXPLORATORY',
    totals: { trades: 5, closed: 3, open: 2, promotionEligibleRules: eligible ? 1 : 0, demotedRules: 0 },
    rules: [{ ruleId: 'r1', laneId: 'CRYPTO_FUTURES_SHORT', labels: ['급등 후 하락 전환'], promotionEligible: eligible, forwardStrict: { n: 31, lower95: 0.05 } }],
    recentTrades: [{ symbol: 'secret-trade-row' }],
  };
}

async function setup(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'latest'), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(root, 'latest', name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

function telegram(sent, { ok = true } = {}) {
  return async (url, init) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    sent.push(JSON.parse(init.body).text);
    return { ok, status: ok ? 200 : 502, json: async () => ({ ok }) };
  };
}

test('KST date rolls over at 15:00 UTC', () => {
  assert.equal(kstDateV1(Date.parse('2026-10-17T14:59:00Z')), '2026-10-17');
  assert.equal(kstDateV1(Date.parse('2026-10-17T15:00:00Z')), '2026-10-18');
});

test('milestones cover holdout passes, adopted exits and promotion-eligible rules only', () => {
  const none = extractResearchMilestonesV1({ combination: combination(), exitComparison: exitComparison({ winner: false }), exploratory: exploratory() });
  assert.deepEqual(none, []);
  const keys = extractResearchMilestonesV1({
    combination: combination({ candidates: [{ trialId: 't1', labels: ['급등 시작'] }] }),
    exitComparison: exitComparison(),
    exploratory: exploratory({ eligible: true }),
  }).map((row) => row.key);
  assert.deepEqual(keys, ['holdout:CRYPTO_FUTURES_LONG:t1', 'exit:CRYPTO_SPOT_LONG:SURGE_BREAKOUT:SINGLE+TRAIL_FULL', 'promotion:r1']);
});

test('daily summary is Korean, bounded, and carries no row-level data', () => {
  const text = formatResearchResultsDigestKoV1({
    combination: combination(), exitComparison: exitComparison(), exploratory: exploratory(),
    selfUpdate: { status: 'UP_TO_DATE', currentSha: 'a'.repeat(40) }, observedAt: AFTER_DIGEST,
  });
  assert.match(text, /코인선물 롱: 누적 시도 120 · 합격 1 · 관찰 2 · 탈락 7 · 보류 표본 통과 0/u);
  assert.match(text, /코인현물 매수: 데이터 대기/u);
  assert.match(text, /급등 시작 → 한 번에 진입 \+ 추적 전량/u);
  assert.match(text, /규칙 1개 · 거래 5건\(종료 3 · 보유 2\)/u);
  assert.match(text, /연구 서버 업데이트: 최신 · 설치 aaaaaaa/u);
  assert.match(text, /실주문 근거 아님/u);
  for (const secret of ['secret dataset line', 'secret-top-row', 'secret-variant-row', 'secret-trade-row']) assert.equal(text.includes(secret), false);
  const long = formatResearchResultsDigestKoV1({ observedAt: AFTER_DIGEST, newMilestones: Array.from({ length: 400 }, (_, index) => ({ text: `소식 ${index} `.repeat(5) })) });
  assert.ok(long.length <= 3_800);
});

test('daily digest is due once per KST day from 09:00; milestones in between', () => {
  const milestones = [{ key: 'promotion:r1', text: 'x' }];
  assert.equal(decideResearchDigestV1({ previous: null, milestones: [], nowMs: Date.parse(BEFORE_DIGEST) }).kind, 'NONE');
  assert.equal(decideResearchDigestV1({ previous: null, milestones: [], nowMs: Date.parse(AFTER_DIGEST) }).kind, 'DAILY');
  const sentToday = { lastDigestDate: '2026-10-18', announcedMilestones: [] };
  assert.equal(decideResearchDigestV1({ previous: sentToday, milestones: [], nowMs: Date.parse(AFTER_DIGEST) }).kind, 'NONE');
  assert.equal(decideResearchDigestV1({ previous: sentToday, milestones, nowMs: Date.parse(AFTER_DIGEST) }).kind, 'MILESTONE');
  const announced = { ...sentToday, announcedMilestones: ['promotion:r1'] };
  assert.equal(decideResearchDigestV1({ previous: announced, milestones, nowMs: Date.parse(AFTER_DIGEST) }).kind, 'NONE');
});

test('sends the daily digest once, announces a new milestone once, never leaks the token', async (t) => {
  const root = await setup(t, {
    'combination-research-v1.json': combination(),
    'exit-strategy-comparison-v1.json': exitComparison({ winner: false }),
    'exploratory-paper-ledger-v1.json': exploratory(),
  });
  const sent = [];
  const first = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => AFTER_DIGEST });
  assert.equal(first.kind, 'DAILY');
  assert.equal(first.delivery, 'SENT');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[투자앱 연구 결과\]/u);

  const again = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => '2026-10-18T01:10:00.000Z' });
  assert.equal(again.kind, 'NONE');
  assert.equal(sent.length, 1);

  await writeFile(join(root, 'latest', 'exploratory-paper-ledger-v1.json'), JSON.stringify(exploratory({ eligible: true })));
  const milestone = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => '2026-10-18T01:20:00.000Z' });
  assert.equal(milestone.kind, 'MILESTONE');
  assert.equal(sent.length, 2);
  assert.match(sent[1], /승격 기준 충족: 코인선물 숏 · 급등 후 하락 전환/u);

  const quiet = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => '2026-10-18T01:30:00.000Z' });
  assert.equal(quiet.kind, 'NONE');
  assert.equal(sent.length, 2);

  const summary = await readFile(join(root, 'latest', 'research-results-digest-v1.json'), 'utf8');
  const state = await readFile(join(root, 'research-results-digest', 'state.json'), 'utf8');
  for (const text of [...sent, summary, state]) assert.equal(text.includes(TOKEN), false);
  assert.equal(JSON.parse(summary).executionAuthority, 'NONE');
  assert.equal(JSON.parse(summary).formalCandidate, false);
});

test('unconfigured or failing channel keeps the digest pending for the next tick', async (t) => {
  const root = await setup(t, { 'combination-research-v1.json': combination() });
  const unconfigured = await runResearchResultsDigestV1({ stateRoot: root, env: {}, now: () => AFTER_DIGEST });
  assert.equal(unconfigured.delivery, 'ALERT_CHANNEL_NOT_CONFIGURED');
  assert.equal(unconfigured.alertChannel, 'NOT_CONFIGURED');
  const sent = [];
  const failed = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent, { ok: false }), now: () => AFTER_DIGEST });
  assert.equal(failed.delivery, 'OPS_TELEGRAM_HTTP_502');
  const retried = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => '2026-10-18T01:10:00.000Z' });
  assert.equal(retried.kind, 'DAILY');
  assert.equal(retried.delivery, 'SENT');
});

test('corrupt or foreign result files are treated as absent, not as results', async (t) => {
  const root = await setup(t, {
    'combination-research-v1.json': '{not json',
    'exploratory-paper-ledger-v1.json': { contract: 'something-else/v1', rules: [{ ruleId: 'x', promotionEligible: true }] },
  });
  const sent = [];
  const result = await runResearchResultsDigestV1({ stateRoot: root, env: ENV, fetchImpl: telegram(sent), now: () => AFTER_DIGEST });
  assert.deepEqual(result.inputs, { combination: false, exitComparison: false, exploratory: false, selfUpdate: false });
  assert.equal(result.newMilestones, 0);
  assert.match(sent[0], /조합 탐색\n {2}아직 결과 없음/u);
});
