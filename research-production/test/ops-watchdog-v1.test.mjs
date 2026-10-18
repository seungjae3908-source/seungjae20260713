import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decideOpsAlertsV1, opsTelegramConfigV1, runOpsWatchdogV1, sendOpsTelegramV1 } from '../src/ops-watchdog-v1.mjs';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ENV = { RESEARCH_OPS_TELEGRAM_BOT_TOKEN: TOKEN, RESEARCH_OPS_TELEGRAM_CHAT_ID: '-1001234567' };
const TARGETS = [
  { id: 'job', label: '조합 연구', kind: 'FILE', path: 'latest/job.json', maxAgeMs: 30 * 60_000 },
  { id: 'svc', label: '검색기', kind: 'HTTP', url: 'http://127.0.0.1:1/health', maxAgeMs: 30 * 60_000 },
];

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'latest'), { recursive: true });
  await writeFile(join(root, 'latest', 'job.json'), '{}');
  return root;
}

function fetcher({ healthy = true, sent }) {
  return async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(init.body).text); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (!healthy) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ ok: true, ageMs: 60_000 }) };
  };
}

test('alert once on failure, remind after 6h, announce recovery; never leak the token', async (t) => {
  const root = await setup(t);
  const sent = [];
  const at = (h) => new Date(Date.UTC(2026, 9, 17, h)).toISOString();
  await utimes(join(root, 'latest', 'job.json'), new Date(Date.UTC(2026, 9, 17, 0)), new Date(Date.UTC(2026, 9, 17, 0)));
  const ok = await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS, env: ENV, fetchImpl: fetcher({ sent }), now: () => new Date(Date.UTC(2026, 9, 17, 0, 10)).toISOString() });
  assert.equal(ok.healthy, 2);
  assert.equal(sent.length, 0);
  const stale = await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS, env: ENV, fetchImpl: fetcher({ sent }), now: () => at(2) });
  assert.deepEqual(stale.problems, ['job']);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /멈춤 감지: 조합 연구/u);
  await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS, env: ENV, fetchImpl: fetcher({ sent }), now: () => at(3) });
  assert.equal(sent.length, 1, 'no repeat within the reminder window');
  await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS, env: ENV, fetchImpl: fetcher({ sent }), now: () => at(9) });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /계속 멈춤/u);
  await utimes(join(root, 'latest', 'job.json'), new Date(Date.UTC(2026, 9, 17, 10)), new Date(Date.UTC(2026, 9, 17, 10)));
  await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS, env: ENV, fetchImpl: fetcher({ sent }), now: () => new Date(Date.UTC(2026, 9, 17, 10, 5)).toISOString() });
  assert.match(sent[2], /복구: 조합 연구/u);
  const stored = await readFile(join(root, 'latest', 'ops-watchdog-v1.json'), 'utf8');
  assert.ok(!stored.includes(TOKEN));
});

test('a local service that never answered is treated as not on this host; one that disappears alerts', () => {
  const nowMs = Date.UTC(2026, 9, 17);
  const down = [{ id: 'svc', label: '검색기', kind: 'HTTP', status: 'DOWN', ageMs: null }];
  const first = decideOpsAlertsV1({ previous: {}, observed: down, nowMs });
  assert.equal(first.messages.length, 0);
  const seen = decideOpsAlertsV1({ previous: {}, observed: [{ ...down[0], status: 'OK' }], nowMs });
  const lost = decideOpsAlertsV1({ previous: seen.next, observed: down, nowMs: nowMs + 60_000 });
  assert.equal(lost.messages.length, 1);
  assert.match(lost.messages[0].text, /응답 없음/u);
});

test('without a configured channel the state is still written and marked', async (t) => {
  const root = await setup(t);
  await utimes(join(root, 'latest', 'job.json'), new Date(0), new Date(0));
  const result = await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS.slice(0, 1), env: {}, fetchImpl: fetcher({ sent: [] }) });
  assert.equal(result.alertChannel, 'NOT_CONFIGURED');
  assert.deepEqual(result.delivery, ['ALERT_CHANNEL_NOT_CONFIGURED']);
  assert.equal(opsTelegramConfigV1({ RESEARCH_OPS_TELEGRAM_BOT_TOKEN: 'bad', RESEARCH_OPS_TELEGRAM_CHAT_ID: '1' }), null);
});

test('a failed Telegram delivery is retried on the next run', async (t) => {
  const root = await setup(t);
  await utimes(join(root, 'latest', 'job.json'), new Date(0), new Date(0));
  const failing = async (url) => { if (String(url).includes('telegram')) return { ok: false, status: 502 }; return { ok: true, status: 200, json: async () => ({}) }; };
  const first = await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS.slice(0, 1), env: ENV, fetchImpl: failing });
  assert.deepEqual(first.delivery, ['OPS_TELEGRAM_HTTP_502']);
  const sent = [];
  const second = await runOpsWatchdogV1({ stateRoot: root, targets: TARGETS.slice(0, 1), env: ENV, fetchImpl: fetcher({ sent }) });
  assert.equal(second.delivery[0], 'SENT');
  assert.equal(sent.length, 1);
});

test('ops Telegram send widens the IPv6/IPv4 race budget and names network failures', async () => {
  const { getDefaultAutoSelectFamilyAttemptTimeout } = await import('node:net');
  const config = { token: TOKEN, chatId: '-1001234567' };
  await sendOpsTelegramV1(config, 'x', async () => ({ ok: true }));
  assert.ok(getDefaultAutoSelectFamilyAttemptTimeout() >= 2_500);
  const timeout = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
  await assert.rejects(sendOpsTelegramV1(config, 'x', async () => { throw timeout; }), /^Error: OPS_TELEGRAM_NETWORK_ETIMEDOUT$/);
  await assert.rejects(sendOpsTelegramV1(config, 'x', async () => { throw new TypeError('fetch failed'); }), /OPS_TELEGRAM_NETWORK_FAILED/);
});
