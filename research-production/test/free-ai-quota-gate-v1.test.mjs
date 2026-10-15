import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  aiIntervalMinutesV1,
  decideFreeAiRunV1,
  isRateLimitedV1,
  nextFreeAiDailyResetV1,
  readFreeAiQuotaGateV1,
  recordFreeAiOutcomeV1,
  writeFreeAiQuotaGateV1,
} from '../src/free-ai-quota-gate-v1.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-15T03:00:00.000Z');
const MIN = 60_000;

test('new release runs once, then AI waits for its interval while the 10-minute tick continues', () => {
  assert.equal(decideFreeAiRunV1({ gate: null, nowMs: NOW, researchCodeSha: SHA }).reason, 'NEW_RELEASE');
  const gate = recordFreeAiOutcomeV1({ gate: null, nowMs: NOW, researchCodeSha: SHA, provider: 'gemini', rateLimited: false });
  assert.equal(decideFreeAiRunV1({ gate, nowMs: NOW + (10 * MIN), researchCodeSha: SHA }).reason, 'NOT_DUE');
  assert.equal(decideFreeAiRunV1({ gate, nowMs: NOW + (60 * MIN), researchCodeSha: SHA }).reason, 'DUE');
  assert.equal(decideFreeAiRunV1({ gate, nowMs: NOW + (10 * MIN), researchCodeSha: 'b'.repeat(40) }).run, true);
});

test('rate limits escalate to a pause until the free daily reset, then resume automatically', () => {
  let gate = recordFreeAiOutcomeV1({ gate: null, nowMs: NOW, researchCodeSha: SHA, provider: 'gemini', rateLimited: true });
  assert.equal(gate.pausedUntil, NOW + (20 * MIN));
  gate = recordFreeAiOutcomeV1({ gate, nowMs: NOW + (20 * MIN), researchCodeSha: SHA, provider: 'gemini', rateLimited: true });
  assert.equal(gate.pausedUntil, NOW + (80 * MIN));
  gate = recordFreeAiOutcomeV1({ gate, nowMs: NOW + (80 * MIN), researchCodeSha: SHA, provider: 'gemini', rateLimited: true });
  // 2026-10-15 is PDT (UTC-7): Gemini's next Pacific midnight is 07:00Z, plus 5 minutes margin.
  assert.equal(gate.pausedUntilIso, '2026-10-15T07:05:00.000Z');
  assert.equal(gate.paidFallbackAllowed, false);
  const paused = decideFreeAiRunV1({ gate, nowMs: Date.parse('2026-10-15T06:00:00.000Z'), researchCodeSha: 'c'.repeat(40) });
  assert.deepEqual([paused.run, paused.reason], [false, 'QUOTA_PAUSED_UNTIL_RESET']);
  const resumed = decideFreeAiRunV1({ gate, nowMs: Date.parse('2026-10-15T07:06:00.000Z'), researchCodeSha: SHA });
  assert.equal(resumed.run, true);
  const ok = recordFreeAiOutcomeV1({ gate, nowMs: Date.parse('2026-10-15T07:06:00.000Z'), researchCodeSha: SHA, provider: 'gemini', rateLimited: false });
  assert.equal(ok.consecutiveRateLimits, 0);
  assert.equal(ok.pausedUntil, null);
});

test('daily reset times follow each free provider', () => {
  assert.equal(new Date(nextFreeAiDailyResetV1('groq', NOW)).toISOString(), '2026-10-16T00:00:00.000Z');
  assert.equal(new Date(nextFreeAiDailyResetV1('gemini', NOW)).toISOString(), '2026-10-15T07:00:00.000Z');
  // Winter (PST, UTC-8).
  assert.equal(new Date(nextFreeAiDailyResetV1('gemini', Date.parse('2026-12-01T12:00:00Z'))).toISOString(), '2026-12-02T08:00:00.000Z');
});

test('rate-limit detection reads discovery and review reasons', () => {
  assert.equal(isRateLimitedV1({ review: { blockedProfiles: [{ reason: 'FREE_AI_RATE_LIMITED' }] } }), true);
  assert.equal(isRateLimitedV1({ cycle: { reason: 'AI_HTTP_429' } }), true);
  assert.equal(isRateLimitedV1({ cycle: { reason: 'FORBIDDEN_AI_AUTHORITY' } }), false);
});

test('interval is bounded and the gate round-trips on disk', async (t) => {
  assert.equal(aiIntervalMinutesV1({}), 60);
  assert.equal(aiIntervalMinutesV1({ RESEARCH_AI_MIN_INTERVAL_MINUTES: '5' }), 60);
  assert.equal(aiIntervalMinutesV1({ RESEARCH_AI_MIN_INTERVAL_MINUTES: '30' }), 30);
  const root = await mkdtemp(join(tmpdir(), 'quota-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readFreeAiQuotaGateV1(root), null);
  const gate = recordFreeAiOutcomeV1({ gate: null, nowMs: NOW, researchCodeSha: SHA, provider: 'groq', rateLimited: false });
  await writeFreeAiQuotaGateV1(root, gate);
  assert.deepEqual(await readFreeAiQuotaGateV1(root), JSON.parse(JSON.stringify(gate)));
});

test('after a rate-limit pause ends, AI retries immediately instead of waiting a full interval', () => {
  const limited = recordFreeAiOutcomeV1({ gate: null, nowMs: NOW, researchCodeSha: SHA, provider: 'gemini', rateLimited: true });
  assert.equal(decideFreeAiRunV1({ gate: limited, nowMs: NOW + (10 * MIN), researchCodeSha: SHA }).reason, 'QUOTA_PAUSED_UNTIL_RESET');
  const after = decideFreeAiRunV1({ gate: limited, nowMs: NOW + (21 * MIN), researchCodeSha: SHA });
  assert.deepEqual([after.run, after.reason], [true, 'RETRY_AFTER_PAUSE']);
});
