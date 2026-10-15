// Free-only AI cadence gate. The coordinator ticks every 10 minutes, but free
// Gemini/Groq calls run at most once per interval (default 60 min). When a
// provider reports a rate limit, AI work pauses with escalating back-off and,
// after repeated limits, until the provider's next daily reset. It resumes on
// its own; there is never a paid fallback.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const FREE_AI_QUOTA_GATE_CONTRACT_V1 = 'free-ai-quota-gate/v1';
const MINUTE = 60_000;
const RATE_LIMIT_PATTERN = /RATE_LIMITED|HTTP_429|QUOTA|RESOURCE_EXHAUSTED/u;

export function freeAiQuotaGatePathV1(stateRoot) {
  return join(resolve(String(stateRoot)), 'latest', 'free-ai-quota-gate-v1.json');
}

export async function readFreeAiQuotaGateV1(stateRoot) {
  try { return JSON.parse(await readFile(freeAiQuotaGatePathV1(stateRoot), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function writeFreeAiQuotaGateV1(stateRoot, gate) {
  const path = freeAiQuotaGatePathV1(stateRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export function aiIntervalMinutesV1(env = process.env) {
  const value = Number(env?.RESEARCH_AI_MIN_INTERVAL_MINUTES ?? 60);
  return Number.isSafeInteger(value) && value >= 20 && value <= 240 ? value : 60;
}

function zonedMidnightAfter(nowMs, timeZone) {
  // Find the next instant where the wall clock in `timeZone` reads 00:00.
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const p = parts(nowMs);
  const minutesIntoDay = (Number(p.hour) * 60) + Number(p.minute);
  let candidate = nowMs - (nowMs % MINUTE) + ((1440 - minutesIntoDay) * MINUTE);
  // DST days are 23/25 hours; nudge until the zone shows midnight.
  for (let k = 0; k < 4; k += 1) {
    const q = parts(candidate);
    if (q.hour === '00' && q.minute === '00') break;
    candidate += (Number(q.hour) >= 12 ? (24 - Number(q.hour)) : -Number(q.hour)) * 60 * MINUTE - (Number(q.minute) * MINUTE);
  }
  return candidate;
}

/** Gemini free quotas reset at midnight Pacific; Groq at midnight UTC. */
export function nextFreeAiDailyResetV1(provider, nowMs) {
  return zonedMidnightAfter(nowMs, provider === 'gemini' ? 'America/Los_Angeles' : 'UTC');
}

export function isRateLimitedV1({ cycle, review, cycleError, reviewError } = {}) {
  const reasons = [
    cycle?.reason, cycleError, reviewError, review?.reason,
    ...(Array.isArray(review?.blockedProfiles) ? review.blockedProfiles.map((row) => row?.reason) : []),
  ].map((value) => String(value ?? ''));
  return reasons.some((reason) => RATE_LIMIT_PATTERN.test(reason));
}

export function decideFreeAiRunV1({ gate, nowMs, researchCodeSha, intervalMinutes = 60 }) {
  if (gate?.pausedUntil && Number(gate.pausedUntil) > nowMs) {
    return Object.freeze({ run: false, reason: 'QUOTA_PAUSED_UNTIL_RESET', nextAiAt: Number(gate.pausedUntil) });
  }
  // A newly activated release always gets one AI pass (activation one-shot proof).
  if (gate?.lastResearchCodeSha !== researchCodeSha) return Object.freeze({ run: true, reason: 'NEW_RELEASE', nextAiAt: nowMs });
  // A rate-limited attempt did no useful AI work: retry as soon as its pause ends.
  if (Number(gate?.consecutiveRateLimits ?? 0) > 0) return Object.freeze({ run: true, reason: 'RETRY_AFTER_PAUSE', nextAiAt: nowMs });
  const last = Number(gate?.lastAiRunAt ?? 0);
  const due = last + (intervalMinutes * MINUTE);
  if (!(last > 0) || due <= nowMs + MINUTE) return Object.freeze({ run: true, reason: 'DUE', nextAiAt: nowMs });
  return Object.freeze({ run: false, reason: 'NOT_DUE', nextAiAt: due });
}

export function recordFreeAiOutcomeV1({ gate, nowMs, researchCodeSha, provider, rateLimited }) {
  const consecutive = rateLimited ? Number(gate?.consecutiveRateLimits ?? 0) + 1 : 0;
  let pausedUntil = null;
  let pauseReason = null;
  if (rateLimited) {
    if (consecutive === 1) { pausedUntil = nowMs + (20 * MINUTE); pauseReason = 'RATE_LIMITED_SHORT_BACKOFF'; }
    else if (consecutive === 2) { pausedUntil = nowMs + (60 * MINUTE); pauseReason = 'RATE_LIMITED_REPEATED'; }
    else {
      pausedUntil = Math.max(nowMs + (60 * MINUTE), nextFreeAiDailyResetV1(provider, nowMs) + (5 * MINUTE));
      pauseReason = 'FREE_DAILY_QUOTA_LIKELY_EXHAUSTED_WAIT_FOR_RESET';
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    contract: FREE_AI_QUOTA_GATE_CONTRACT_V1,
    provider: provider ?? null,
    lastAiRunAt: nowMs,
    lastResearchCodeSha: researchCodeSha,
    consecutiveRateLimits: consecutive,
    pausedUntil,
    pausedUntilIso: pausedUntil ? new Date(pausedUntil).toISOString() : null,
    pauseReason,
    paidFallbackAllowed: false,
  });
}
