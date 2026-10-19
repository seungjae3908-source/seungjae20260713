// Operations watchdog: "멈추면 아무도 모르는 구조"를 막는다.
//
// Checks that every scheduled job produced fresh output recently (file age of
// its latest/*.json), that jobs which publish an outcome did not end in failure
// (OUTCOME targets read the result file: a fresh file whose last run failed is
// FAILED, not OK), and that local services answer their health endpoints with
// a fresh snapshot. A target that turns STALE/DOWN/FAILED raises one Telegram
// operations alert; while it stays bad a reminder is sent every `reminderMs`;
// a recovery message is sent when it is healthy again.
//
// Delay and failure are different states: STALE/MISSING mean "no fresh result"
// (the job did not run or is late), FAILED means "it ran and reported failure".
// The watchdog runs from the 10-minute research coordinator; its own result is
// published to latest/ops-watchdog-v1.json so a dashboard can tell when the
// watchdog itself stopped. Alerts carry no secrets, no account data and no
// trading content. When the Telegram bot token / chat id are not configured
// the state is still written (ALERT_CHANNEL_NOT_CONFIGURED).
// executionAuthority NONE.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

export const OPS_WATCHDOG_CONTRACT_V1 = 'ops-watchdog/v1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// maxAgeMs ~ 2-3x the job cadence so one slow run is not an alarm.
const SELF_UPDATE_FAILURE_STATUSES = Object.freeze(['VALIDATION_FAILED', 'CUTOVER_FAILED', 'AI_ACTIVATION_FAILED', 'AI_RESTORE_FAILED', 'MAIN_UNREADABLE', 'NO_CURRENT_RELEASE']);
export const OPS_WATCH_TARGETS_V1 = Object.freeze([
  Object.freeze({ id: 'combination-search', label: '조합 연구(10분)', kind: 'FILE', path: 'latest/combination-research-v1.json', maxAgeMs: 35 * MINUTE }),
  Object.freeze({ id: 'exploratory-paper', label: '탐색 모의매매(10분)', kind: 'FILE', path: 'latest/exploratory-paper-ledger-v1.json', maxAgeMs: 45 * MINUTE }),
  Object.freeze({ id: 'scanner-evidence', label: '검색기용 연구 근거(10분)', kind: 'FILE', path: 'latest/combination-signal-evidence-v1.json', maxAgeMs: 45 * MINUTE }),
  Object.freeze({ id: 'forward', label: '전진 연구(1시간)', kind: 'FILE', path: 'latest/forward.json', maxAgeMs: 3 * HOUR }),
  Object.freeze({ id: 'factory-status', label: '연구 공장 상태(1시간)', kind: 'FILE', path: 'latest/research-factory.json', maxAgeMs: 3 * HOUR }),
  Object.freeze({ id: 'fast-historical', label: '빠른 과거 연구(매일)', kind: 'FILE', path: 'latest/fast-historical.json', maxAgeMs: 30 * HOUR }),
  Object.freeze({ id: 'long-history', label: '장기 연구(매주)', kind: 'FILE', path: 'latest/long-history.json', maxAgeMs: 8 * 24 * HOUR }),
  // Outcome targets: the file is written every run, so its age says whether
  // the job ran and its content says whether that run failed.
  Object.freeze({ id: 'ai-coordinator', label: 'AI 연구 조정(10분)', kind: 'OUTCOME', path: 'latest/autonomous-research-coordinator-v2.json', maxAgeMs: 45 * MINUTE,
    failedWhen: (value) => Number(value?.exitCode) === 1 || value?.status === 'FAILED_CLOSED' }),
  Object.freeze({ id: 'closed-loop', label: '전략 검증 루프(10분)', kind: 'FILE', path: 'latest/autonomous-research-closed-loop.json', maxAgeMs: 3 * HOUR }),
  Object.freeze({ id: 'temporal-evidence', label: '선물 보조지표 수집(1시간)', kind: 'OUTCOME', path: 'latest/temporal-crypto-futures.json', maxAgeMs: 3 * HOUR,
    failedWhen: (value) => ['partial_failure', 'failed_closed'].includes(String(value?.status ?? '')) }),
  Object.freeze({ id: 'self-update', label: '연구 서버 자동 업데이트(1시간)', kind: 'OUTCOME', path: 'latest/self-update-v1.json', maxAgeMs: 3 * HOUR,
    failedWhen: (value) => SELF_UPDATE_FAILURE_STATUSES.includes(String(value?.status ?? '')) }),
  Object.freeze({ id: 'signal-scanner', label: '신호 검색기(5분)', kind: 'HTTP', url: 'http://127.0.0.1:8790/health', maxAgeMs: 30 * MINUTE }),
  Object.freeze({ id: 'app-server', label: '앱 서버', kind: 'HTTP', url: 'http://127.0.0.1:8080/api/health', maxAgeMs: null }),
]);

export const OPS_BAD_STATUSES_V1 = Object.freeze(['STALE', 'MISSING', 'DOWN', 'ERROR', 'FAILED']);

export const OPS_WATCHDOG_POLICY_V1 = Object.freeze({ reminderMs: 6 * HOUR, httpTimeoutMs: 4_000 });

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function minutes(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}분`;
  if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(1)}시간`;
  return `${(ms / (24 * HOUR)).toFixed(1)}일`;
}

async function checkFile(stateRoot, target, nowMs) {
  try {
    const info = await stat(join(stateRoot, target.path));
    const ageMs = nowMs - info.mtimeMs;
    return { status: ageMs <= target.maxAgeMs ? 'OK' : 'STALE', ageMs, lastSuccessAt: new Date(info.mtimeMs).toISOString() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'MISSING', ageMs: null, lastSuccessAt: null };
    return { status: 'ERROR', ageMs: null, lastSuccessAt: null, detail: String(error?.code ?? 'STAT_FAILED') };
  }
}

/**
 * Outcome target: a job that writes its result every run. Freshness comes from
 * the result's own timestamp (observedAt/generatedAt) or the file mtime; a
 * fresh result that reports failure is FAILED (ran, but failed), never OK.
 */
async function checkOutcome(stateRoot, target, nowMs) {
  const path = join(stateRoot, target.path);
  let info;
  try { info = await stat(path); } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'MISSING', ageMs: null, lastSuccessAt: null };
    return { status: 'ERROR', ageMs: null, lastSuccessAt: null, detail: String(error?.code ?? 'STAT_FAILED') };
  }
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    return { status: 'ERROR', ageMs: nowMs - info.mtimeMs, lastSuccessAt: null, detail: String(error?.code ?? 'RESULT_UNREADABLE') };
  }
  const stamp = [value?.observedAt, value?.generatedAt, value?.updatedAt].map((row) => (typeof row === 'number' ? row : Date.parse(String(row ?? '')))).find(Number.isFinite);
  const ageMs = nowMs - (Number.isFinite(stamp) ? Math.min(stamp, info.mtimeMs) : info.mtimeMs);
  const detail = String(value?.status ?? value?.exitCode ?? '').slice(0, 40) || null;
  let failed = false;
  try { failed = typeof target.failedWhen === 'function' && target.failedWhen(value) === true; } catch { failed = false; }
  if (failed) return { status: 'FAILED', ageMs, lastSuccessAt: null, detail };
  return { status: ageMs <= target.maxAgeMs ? 'OK' : 'STALE', ageMs, lastSuccessAt: new Date(nowMs - ageMs).toISOString(), detail };
}

async function checkHttp(target, nowMs, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, { signal: controller.signal, headers: { accept: 'application/json' } });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const generatedAt = Date.parse(String(body?.generatedAt ?? body?.snapshot?.generatedAt ?? ''));
    const ageMs = Number.isFinite(Number(body?.ageMs)) ? Number(body.ageMs) : Number.isFinite(generatedAt) ? nowMs - generatedAt : null;
    if (!response.ok) return { status: response.status === 503 && ageMs != null ? 'STALE' : 'DOWN', ageMs, httpStatus: response.status };
    if (target.maxAgeMs != null && ageMs != null && ageMs > target.maxAgeMs) return { status: 'STALE', ageMs, httpStatus: response.status };
    return { status: 'OK', ageMs, httpStatus: response.status };
  } catch {
    return { status: 'DOWN', ageMs: null, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

export function opsTelegramConfigV1(env = process.env) {
  const token = String(env.RESEARCH_OPS_TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = String(env.RESEARCH_OPS_TELEGRAM_CHAT_ID ?? '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/u.test(token) || !/^-?\d{5,}$/u.test(chatId)) return null;
  return Object.freeze({ token, chatId });
}

// Node's fetch races IPv6/IPv4 with a 250 ms per-address budget. On a host
// whose DNS returns AAAA without a global IPv6 route, a ~300 ms IPv4 handshake
// to api.telegram.org then fails as ETIMEDOUT ("fetch failed") most of the time.
const OPS_TELEGRAM_FAMILY_ATTEMPT_MS = 2_500;

export async function sendOpsTelegramV1(config, text, fetchImpl) {
  if (getDefaultAutoSelectFamilyAttemptTimeout() < OPS_TELEGRAM_FAMILY_ATTEMPT_MS) {
    setDefaultAutoSelectFamilyAttemptTimeout(OPS_TELEGRAM_FAMILY_ATTEMPT_MS);
  }
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
    });
  } catch (error) {
    // Surface only the network error code ("fetch failed" alone is undiagnosable).
    const code = String(error?.cause?.code ?? '').replace(/[^A-Z0-9_]/gu, '').slice(0, 24);
    throw new Error(`OPS_TELEGRAM_NETWORK_${code || 'FAILED'}`);
  }
  if (!response.ok) throw new Error(`OPS_TELEGRAM_HTTP_${response.status}`);
  return true;
}

/** Pure decision: which messages to send for this observation. */
export function decideOpsAlertsV1({ previous = {}, observed, nowMs, policy = OPS_WATCHDOG_POLICY_V1 }) {
  const messages = [];
  const next = {};
  for (const row of observed) {
    const prior = previous[row.id] ?? null;
    const bad = OPS_BAD_STATUSES_V1.includes(row.status);
    // A local HTTP service that never answered is "not on this host", not an outage.
    const everSeen = prior?.everSeen === true || ['OK', 'STALE', 'FAILED'].includes(row.status);
    // A result file that never existed is a job not installed here, not an outage.
    const applicable = row.kind === 'HTTP' ? everSeen : (row.status !== 'MISSING' || prior?.everSeen === true);
    const entry = { status: row.status, everSeen, since: prior?.status === row.status ? prior.since : new Date(nowMs).toISOString(), lastAlertAt: prior?.lastAlertAt ?? null };
    if (bad && applicable) {
      const wasBad = prior && OPS_BAD_STATUSES_V1.includes(prior.status);
      // A job that was merely late and is now failing (or the reverse) is news.
      const kindChanged = wasBad && (prior.status === 'FAILED') !== (row.status === 'FAILED');
      const dueReminder = wasBad && prior.lastAlertAt && nowMs - Date.parse(prior.lastAlertAt) >= policy.reminderMs;
      if (!wasBad || dueReminder || kindChanged) {
        const failed = row.status === 'FAILED';
        const head = failed ? (wasBad && !kindChanged ? '⏰ 계속 실패' : '🚨 실패 감지') : (wasBad && !kindChanged ? '⏰ 계속 멈춤' : '🚨 멈춤 감지');
        const why = failed ? `마지막 실행 결과 ${row.detail ?? '실패'}${Number.isFinite(row.ageMs) ? ` (${minutes(row.ageMs)} 전)` : ''}`
          : row.status === 'DOWN' ? '응답 없음' : row.status === 'MISSING' ? '결과 파일 없음' : `마지막 성공 ${minutes(row.ageMs)} 전`;
        messages.push({ id: row.id, kind: wasBad && !kindChanged ? 'REMINDER' : 'ALERT', text: `${head}: ${row.label} — ${why}` });
        entry.lastAlertAt = new Date(nowMs).toISOString();
      }
    } else if (!bad && prior && OPS_BAD_STATUSES_V1.includes(prior.status) && prior.lastAlertAt) {
      messages.push({ id: row.id, kind: 'RECOVERED', text: `✅ 복구: ${row.label}` });
      entry.lastAlertAt = null;
    }
    next[row.id] = entry;
  }
  return { messages, next };
}

export async function runOpsWatchdogV1({
  stateRoot,
  targets = OPS_WATCH_TARGETS_V1,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  policy = OPS_WATCHDOG_POLICY_V1,
  invoker = 'unknown',
} = {}) {
  if (!stateRoot) throw new Error('OPS_WATCHDOG_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const nowMs = Date.parse(observedAt);
  const observed = [];
  for (const target of targets) {
    const result = target.kind === 'FILE' ? await checkFile(stateRoot, target, nowMs)
      : target.kind === 'OUTCOME' ? await checkOutcome(stateRoot, target, nowMs)
        : await checkHttp(target, nowMs, fetchImpl, policy.httpTimeoutMs);
    observed.push({ id: target.id, label: target.label, kind: target.kind, maxAgeMs: target.maxAgeMs, ...result });
  }
  const statePath = join(stateRoot, 'ops-watchdog', 'state.json');
  const previous = (await readJson(statePath))?.targets ?? {};
  const { messages, next } = decideOpsAlertsV1({ previous, observed, nowMs, policy });
  const telegram = opsTelegramConfigV1(env);
  const delivery = [];
  if (messages.length > 0) {
    if (!telegram) delivery.push('ALERT_CHANNEL_NOT_CONFIGURED');
    else {
      const text = ['[투자앱 운영 알림]', ...messages.map((row) => row.text), `확인 시각 ${observedAt}`].join('\n');
      try { await sendOpsTelegramV1(telegram, text, fetchImpl); delivery.push('SENT'); }
      catch (error) {
        delivery.push(String(error?.message ?? 'OPS_TELEGRAM_FAILED').slice(0, 60));
        // Not delivered: keep previous alert timestamps so the next run retries.
        for (const row of messages) next[row.id].lastAlertAt = previous[row.id]?.lastAlertAt ?? null;
        for (const row of messages) if (row.kind === 'ALERT') next[row.id].status = previous[row.id]?.status ?? 'OK';
      }
    }
  }
  await atomicJson(statePath, { contract: OPS_WATCHDOG_CONTRACT_V1, updatedAt: observedAt, targets: next });
  const summary = Object.freeze({
    contract: OPS_WATCHDOG_CONTRACT_V1, observedAt, invoker,
    healthy: observed.filter((row) => row.status === 'OK').length,
    problems: observed.filter((row) => row.status !== 'OK' && (row.kind !== 'HTTP' ? row.status !== 'MISSING' || next[row.id]?.everSeen : next[row.id]?.everSeen)).map((row) => row.id),
    // Failed (ran, reported failure) and late (no fresh result) are reported apart.
    failed: observed.filter((row) => row.status === 'FAILED').map((row) => row.id),
    late: observed.filter((row) => ['STALE', 'MISSING'].includes(row.status) && (row.status !== 'MISSING' || next[row.id]?.everSeen)).map((row) => row.id),
    targets: observed,
    alerts: messages, delivery,
    alertChannel: telegram ? 'TELEGRAM' : 'NOT_CONFIGURED',
    executionAuthority: 'NONE',
  });
  await atomicJson(join(stateRoot, 'latest', 'ops-watchdog-v1.json'), summary);
  return summary;
}
