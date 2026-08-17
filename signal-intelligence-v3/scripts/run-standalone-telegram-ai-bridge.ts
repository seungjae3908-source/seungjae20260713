// @ts-nocheck
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { sendTelegramAlert } from '../../api-server/src/services/telegram-notification.service';
import { answerAiChat } from '../../api-server/src/services/ai-chat.service';

const SIGNAL_URL = process.env.SIGNAL_INTELLIGENCE_URL?.trim() || 'http://127.0.0.1:8790/v1/signals';
const RESCAN_URL = 'http://127.0.0.1:8790/internal/rescan';
const STATE_PATH = path.resolve(process.env.SIGNAL_INTELLIGENCE_BRIDGE_STATE_PATH || './.runtime/signal-intelligence-v3-bridge-state.json');
const STATUS_PATH = path.resolve(process.env.SIGNAL_INTELLIGENCE_BRIDGE_STATUS_PATH || './.runtime/signal-intelligence-v3-bridge-status.json');
const ONCE = process.env.SIGNAL_INTELLIGENCE_BRIDGE_ONCE === 'true';
const STARTUP_VERIFY = process.env.SIGNAL_INTELLIGENCE_BRIDGE_STARTUP_VERIFY === 'true';
const REVIEW_TTL_MS = 30 * 60_000;
const DELIVERED_TTL_MS = 14 * 24 * 60 * 60_000;
const MAX_AI_REVIEWS_PER_TICK = 3;

function boundedInterval(raw, fallback, minimum, maximum) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed))) : fallback;
}
const TELEGRAM_INTERVAL_MS = boundedInterval(process.env.SIGNAL_INTELLIGENCE_TELEGRAM_INTERVAL_MS, 60_000, 30_000, 300_000);
const AI_INTERVAL_MS = boundedInterval(process.env.SIGNAL_INTELLIGENCE_AI_WATCH_INTERVAL_MS, 120_000, 60_000, 900_000);

function assertLoopback(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('SIGNAL_INTELLIGENCE_BRIDGE_LOOPBACK_ONLY');
  }
  return parsed.toString();
}
assertLoopback(SIGNAL_URL);

function telegramConfigured() {
  return Boolean(process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true'
    && process.env.TELEGRAM_BOT_TOKEN?.trim()
    && (process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim()));
}
function aiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim()
    || process.env.GOOGLE_API_KEY?.trim()
    || process.env.GROQ_API_KEY?.trim()
    || process.env.AI_CHAT_API_KEY?.trim());
}
function chatIdForMarket(market) {
  const fallback = process.env.TELEGRAM_CHAT_ID?.trim() || null;
  if (market === 'KR_STOCK' || market === 'US_STOCK') return process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || fallback;
  return process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || fallback;
}
function uniqueChatIds() {
  return [...new Set([
    process.env.TELEGRAM_STOCK_CHAT_ID?.trim(),
    process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim(),
    process.env.TELEGRAM_CHAT_ID?.trim(),
  ].filter(Boolean))];
}
function alertType(event) {
  if (event.type !== 'NEW_CANDIDATE') return 'intelligence_report';
  if (event.market === 'KR_STOCK' || event.market === 'US_STOCK') return event.direction === 'BUY' ? 'strong_buy' : null;
  if (event.market === 'CRYPTO_SPOT') return event.direction === 'BUY' ? 'crypto_spot_buy' : null;
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'LONG') return 'crypto_futures_long';
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'SHORT') return 'crypto_futures_short';
  return null;
}
function finiteText(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : 'N/A';
}
function tierLabel(tier) {
  if (tier === 'CHAMPION') return 'Champion 검증';
  if (tier === 'FORWARD_VALIDATED') return 'Forward 검증';
  return 'Research 후보 · 실전수익 미검증';
}
function leverageText(event) {
  const leverage = event?.leverage;
  const min = Number(leverage?.recommendedRange?.min);
  const max = Number(leverage?.recommendedRange?.max);
  const hard = Number(leverage?.hardMaximum);
  if (leverage?.status !== 'INDICATIVE_ONLY' || ![min, max, hard].every(Number.isFinite)) return null;
  return `적정 레버리지 ${min.toFixed(1)}x~${max.toFixed(1)}x · hard max ${hard.toFixed(1)}x · 참고값`;
}
function eventDetails(event) {
  if (event.type === 'NEW_CANDIDATE') return [
    `${event.strategy}/${event.timeframe} · ${event.direction}`,
    tierLabel(event.validationTier),
    `Net utility ${finiteText(event.utilityR)}R`,
    leverageText(event),
    '신규 진입 후보 · 실주문 권한 없음',
  ].filter(Boolean).join('\n');
  if (event.type === 'STATE_CHANGED') return [
    `${event.strategy}/${event.timeframe} · ${event.direction ?? 'N/A'}`,
    `${event.previousState ?? 'UNKNOWN'} → ${event.state ?? 'UNKNOWN'}`,
    tierLabel(event.validationTier),
    Array.isArray(event.reasons) && event.reasons.length ? `원인: ${event.reasons.join(', ')}` : null,
    '신규 진입 판단 재평가 · 실주문 권한 없음',
  ].filter(Boolean).join('\n');
  return `${event.strategy}/${event.timeframe} · AI/시장 변화 감지 · deterministic public Scanner 재평가 · 실주문 권한 없음`;
}

const EMPTY_STATE = () => ({ version: 1, delivered: {}, reviewed: {}, rowFingerprints: {}, startupVerified: {} });
async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    return parsed?.version === 1 ? { ...EMPTY_STATE(), ...parsed } : EMPTY_STATE();
  } catch { return EMPTY_STATE(); }
}
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
function pruneState(state, nowMs) {
  for (const [key, at] of Object.entries(state.delivered || {})) if (nowMs - Date.parse(String(at)) > DELIVERED_TTL_MS) delete state.delivered[key];
  for (const [key, at] of Object.entries(state.reviewed || {})) if (nowMs - Date.parse(String(at)) > REVIEW_TTL_MS) delete state.reviewed[key];
}

async function fetchEnvelope() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(SIGNAL_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`SIGNAL_HTTP_${response.status}`);
    const envelope = await response.json();
    const snapshot = envelope?.snapshot;
    if (envelope?.ok !== true || envelope?.executionAuthority !== 'NONE'
      || snapshot?.safety?.executionAuthority !== 'NONE'
      || snapshot?.safety?.privateTradingApiAllowed !== false
      || snapshot?.safety?.realOrderAllowed !== false
      || !/^[0-9a-f]{40}$/u.test(String(snapshot?.serviceSha ?? ''))
      || !Array.isArray(snapshot?.events) || !Array.isArray(snapshot?.rows)) {
      throw new Error('SIGNAL_SAFETY_ENVELOPE_REJECTED');
    }
    return envelope;
  } finally { clearTimeout(timer); }
}

async function verifyStartupTelegram(snapshot, state, now) {
  const result = { attempted: 0, delivered: 0, failed: 0, skipped: 0 };
  if (!STARTUP_VERIFY || !telegramConfigured() || state.startupVerified?.[snapshot.serviceSha]) return result;
  const ids = uniqueChatIds();
  if (!ids.length) return result;
  for (const chatId of ids) {
    result.attempted += 1;
    const sent = await sendTelegramAlert({
      type: 'intelligence_report',
      destinationChatId: chatId,
      dedupeKey: `signal-intelligence-v3-bridge-startup:${snapshot.serviceSha}:${chatId}`,
      cooldownMs: 0,
      duplicateWindowMs: 0,
      timestamp: now.toISOString(),
      details: `Signal Intelligence V3 독립 bridge 활성화 확인 · service ${snapshot.serviceSha.slice(0, 12)} · Telegram/AI 감시 · executionAuthority=NONE · 실주문 없음`,
    });
    if (sent.ok || sent.skipped === 'DUPLICATE') result.delivered += 1;
    else if (sent.skipped === 'NOT_CONFIGURED') result.skipped += 1;
    else result.failed += 1;
  }
  if (result.failed === 0 && result.delivered > 0) state.startupVerified[snapshot.serviceSha] = now.toISOString();
  return result;
}

async function deliverEvents(snapshot, state, now) {
  const result = { attempted: 0, delivered: 0, deduped: 0, skipped: 0, failed: 0 };
  if (!telegramConfigured()) return result;
  for (const event of snapshot.events) {
    const type = alertType(event);
    const destinationChatId = chatIdForMarket(event.market);
    if (!type || !destinationChatId) { result.skipped += 1; continue; }
    const key = `${snapshot.serviceSha}:${event.type}:${event.id}:${event.previousState ?? ''}:${event.state ?? ''}`;
    if (state.delivered[key]) { result.deduped += 1; continue; }
    result.attempted += 1;
    const sent = await sendTelegramAlert({
      type, symbol: event.symbol, market: event.market, destinationChatId,
      dedupeKey: `signal-intelligence-v3:${key}`, duplicateWindowMs: DELIVERED_TTL_MS, cooldownMs: 0,
      timestamp: now.toISOString(), details: eventDetails(event),
    });
    if (sent.ok || sent.skipped === 'DUPLICATE') {
      state.delivered[key] = now.toISOString();
      if (sent.ok) result.delivered += 1; else result.deduped += 1;
    } else if (sent.skipped === 'NOT_CONFIGURED') result.skipped += 1;
    else result.failed += 1;
  }
  return result;
}

function contextFor(row) {
  if (row.market === 'KR_STOCK') return { market: 'KR', symbol: row.symbol };
  if (row.market === 'US_STOCK') return { market: 'US', symbol: row.symbol };
  if (row.market === 'CRYPTO_SPOT') return { market: 'UPBIT', symbol: row.symbol };
  if (row.market === 'CRYPTO_FUTURES') return { market: 'BITGET', symbol: row.symbol };
  return null;
}
function parseAiJson(answer) {
  const match = String(answer ?? '').match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const row = JSON.parse(match[0]);
    if (!['POSITIVE','NEGATIVE','MIXED','NONE'].includes(String(row.catalyst))) return null;
    if (!['HIGH','MEDIUM','LOW'].includes(String(row.impact))) return null;
    if (!['BREAKOUT','BREAKDOWN','FAILED_BREAKOUT','VOLUME_ANOMALY','VOLATILITY_EXPANSION','NONE'].includes(String(row.technicalChange))) return null;
    if (typeof row.contradiction !== 'boolean') return null;
    return { catalyst: row.catalyst, impact: row.impact, technicalChange: row.technicalChange, contradiction: row.contradiction,
      risks: Array.isArray(row.risks) ? row.risks.map(String).slice(0, 5) : [], reason: String(row.reason ?? '').slice(0, 500) };
  } catch { return null; }
}
function materialChange(row) { return row.impact === 'HIGH' || row.contradiction === true || row.technicalChange !== 'NONE'; }
function rowFingerprint(row) {
  return JSON.stringify([row.state, row.direction, row.utilityR, row.sourceAsOf, row.dataStatus, row.quantEligible, row.profitEligible, row.riskReady]);
}
function watchPrompt(row) {
  return [
    '공개 데이터 감시 전용입니다. 주문·자동매매·레버리지 변경·매매 지시는 하지 마세요.',
    '최근 공개 뉴스/공시/이벤트와 현재 가격·기술 변화에서 이 종목을 즉시 deterministic Scanner로 다시 계산해야 할 새 변화가 있는지만 분류하세요.',
    '호재/악재가 없거나 확인되지 않으면 NONE으로 두고 추측하지 마세요.',
    '반드시 설명 없이 아래 JSON 객체 하나만 반환하세요.',
    '{"catalyst":"POSITIVE|NEGATIVE|MIXED|NONE","impact":"HIGH|MEDIUM|LOW","technicalChange":"BREAKOUT|BREAKDOWN|FAILED_BREAKOUT|VOLUME_ANOMALY|VOLATILITY_EXPANSION|NONE","contradiction":false,"risks":[],"reason":"짧은 공개근거 요약"}',
    `현재 V3 행: ${row.market} ${row.symbol} ${row.strategy}/${row.timeframe} ${row.direction ?? 'N/A'} ${row.state}`,
  ].join('\n');
}
async function requestRescan() {
  try {
    const response = await fetch(RESCAN_URL, { method: 'POST', headers: { 'content-type': 'application/json' } });
    return response.status === 202;
  } catch { return false; }
}
async function reviewWithAi(snapshot, state, now) {
  const result = { reviewed: 0, material: 0, rescans: 0, notified: 0, unavailable: 0 };
  if (!aiConfigured()) return result;
  const eventIds = new Set(snapshot.events.filter((event) => ['NEW_CANDIDATE','RESCAN_REQUESTED'].includes(event.type)).map((event) => event.id));
  const changed = [];
  for (const row of snapshot.rows) {
    const fingerprint = rowFingerprint(row);
    const before = state.rowFingerprints?.[row.id];
    state.rowFingerprints[row.id] = fingerprint;
    if (eventIds.has(row.id) || before == null || before !== fingerprint) changed.push(row);
  }
  changed.sort((a, b) => (eventIds.has(b.id) ? 1 : 0) - (eventIds.has(a.id) ? 1 : 0)
    || Number(b.utilityR ?? -999) - Number(a.utilityR ?? -999));
  for (const row of changed) {
    if (result.reviewed >= MAX_AI_REVIEWS_PER_TICK) break;
    const key = `${snapshot.serviceSha}:${row.id}`;
    if (state.reviewed[key] && now.getTime() - Date.parse(state.reviewed[key]) < REVIEW_TTL_MS) continue;
    const context = contextFor(row);
    if (!context) continue;
    state.reviewed[key] = now.toISOString();
    result.reviewed += 1;
    let parsed = null;
    try {
      const answer = await answerAiChat({ message: watchPrompt(row), context }, fetch, undefined, 12_000);
      parsed = parseAiJson(answer.answer);
    } catch { result.unavailable += 1; continue; }
    if (!parsed || !materialChange(parsed)) continue;
    result.material += 1;
    if (await requestRescan()) result.rescans += 1;
    const destinationChatId = chatIdForMarket(row.market);
    if (telegramConfigured() && destinationChatId) {
      const sent = await sendTelegramAlert({
        type: 'intelligence_report', symbol: row.symbol, market: row.market, destinationChatId,
        dedupeKey: `signal-intelligence-v3-ai:${key}:${parsed.catalyst}:${parsed.technicalChange}:${parsed.contradiction}`,
        duplicateWindowMs: REVIEW_TTL_MS, cooldownMs: 0, timestamp: now.toISOString(),
        details: [
          `AI 변화감시 · ${row.strategy}/${row.timeframe} · ${row.direction ?? 'N/A'} · 현재 ${row.state}`,
          `Catalyst ${parsed.catalyst}/${parsed.impact}`,
          `Technical ${parsed.technicalChange}`,
          `Contradiction ${parsed.contradiction ? 'YES' : 'NO'}`,
          parsed.risks.length ? `Risk: ${parsed.risks.join(', ')}` : null,
          parsed.reason ? `근거: ${parsed.reason}` : null,
          'AI는 후보 승격/레버리지/주문 권한 없음 · public Scanner 재계산만 요청',
        ].filter(Boolean).join('\n'),
      });
      if (sent.ok) result.notified += 1;
    }
  }
  return result;
}

let running = false;
async function runOnce() {
  if (running) return null;
  running = true;
  const now = new Date();
  const state = await loadState();
  pruneState(state, now.getTime());
  const status = { version: 1, checkedAt: now.toISOString(), serviceSha: null, telegramConfigured: telegramConfigured(), aiConfigured: aiConfigured(),
    executionAuthority: 'NONE', privateTradingApiAllowed: false, realOrderAllowed: false, signalReachable: false,
    startup: null, telegram: null, ai: null, error: null };
  try {
    const envelope = await fetchEnvelope();
    status.signalReachable = true;
    status.serviceSha = envelope.snapshot.serviceSha;
    status.startup = await verifyStartupTelegram(envelope.snapshot, state, now);
    status.telegram = await deliverEvents(envelope.snapshot, state, now);
    status.ai = await reviewWithAi(envelope.snapshot, state, now);
    await atomicJson(STATE_PATH, state);
  } catch (error) { status.error = error instanceof Error ? error.message.split(':')[0] : 'BRIDGE_TICK_FAILED'; }
  await atomicJson(STATUS_PATH, status);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  running = false;
  return status;
}

async function main() {
  await runOnce();
  if (ONCE) return;
  const telegramTimer = setInterval(() => { void runOnce(); }, TELEGRAM_INTERVAL_MS);
  const aiTimer = setInterval(() => { void runOnce(); }, AI_INTERVAL_MS);
  const stop = () => { clearInterval(telegramTimer); clearInterval(aiTimer); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(async (error) => {
  await atomicJson(STATUS_PATH, { version: 1, checkedAt: new Date().toISOString(), executionAuthority: 'NONE', privateTradingApiAllowed: false,
    realOrderAllowed: false, error: error instanceof Error ? error.message.split(':')[0] : 'BRIDGE_FATAL' });
  process.exitCode = 1;
});
