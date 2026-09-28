import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { logger } from '../lib/logger';
import { sendTelegramAlert, type TelegramAlertInput } from './telegram-notification.service';
import {
  deliverMemberWatchlistTelegramForSignal,
  type MemberWatchlistTelegramProducerResult,
} from './member-watchlist-telegram-producer.service';

const DEFAULT_URL = 'http://127.0.0.1:8790/v1/signals';
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_DELIVERED_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type V3Event = {
  type: 'NEW_CANDIDATE' | 'STATE_CHANGED' | 'RESCAN_REQUESTED';
  id: string;
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  symbol: string;
  strategy: string;
  timeframe: string;
  direction: 'BUY' | 'LONG' | 'SHORT' | null;
  state?: string;
  previousState?: string;
  validationTier?: 'RESEARCH_CANDIDATE' | 'FORWARD_VALIDATED' | 'CHAMPION';
  utilityR?: number;
  utilityMode?: string;
  leverage?: {
    status?: string;
    recommendedRange?: { min?: number; max?: number };
    hardMaximum?: number;
  } | null;
  reasons?: string[];
};

type V3Snapshot = {
  serviceSha: string;
  safety: {
    executionAuthority: 'NONE';
    privateTradingApiAllowed: false;
    realOrderAllowed: false;
  };
  events: V3Event[];
};

type V3Envelope = { ok: true; serviceSha: string; snapshot: V3Snapshot; executionAuthority: 'NONE' };
type Persisted = { version: 1; delivered: Record<string, string> };
type WatchlistDeliverer = typeof deliverMemberWatchlistTelegramForSignal;

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.max(30_000, Math.min(300_000, Math.trunc(parsed)));
}

function endpoint(): string {
  const value = process.env.SIGNAL_INTELLIGENCE_URL?.trim() || DEFAULT_URL;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('SIGNAL_INTELLIGENCE_SUBSCRIBER_LOOPBACK_ONLY');
  }
  return parsed.toString();
}

function chatIdForMarket(market: V3Event['market']): string | null {
  if (market === 'KR_STOCK' || market === 'US_STOCK') return process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || null;
  return process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || null;
}

function tierLabel(tier: V3Event['validationTier']): string {
  if (tier === 'CHAMPION') return '검증: Champion';
  if (tier === 'FORWARD_VALIDATED') return '검증: Forward 완료';
  return '검증: 연구 후보 · 실전수익 미검증';
}

function finiteText(value: unknown, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : 'N/A';
}

function marketLabel(market: V3Event['market']): string {
  if (market === 'KR_STOCK') return '국내주식';
  if (market === 'US_STOCK') return '미국주식';
  if (market === 'CRYPTO_SPOT') return '코인현물';
  return '코인선물';
}

function strategyLabel(strategy: string): string {
  const normalized = strategy.trim().toUpperCase();
  if (normalized === 'SCALPING') return '단타';
  if (normalized === 'SWING') return '스윙';
  if (normalized === 'POSITION') return '중장기';
  return '전략';
}

function timeframeLabel(timeframe: string): string {
  const normalized = timeframe.trim();
  if (normalized === '60m' || normalized === '1H') return '1시간봉';
  const minute = normalized.match(/^(\d+)m$/u);
  if (minute) return `${minute[1]}분봉`;
  const hour = normalized.match(/^(\d+)H$/u);
  if (hour) return `${hour[1]}시간봉`;
  if (normalized === '1D') return '1일봉';
  if (normalized === '1W') return '1주봉';
  if (normalized === '1M') return '1개월봉';
  return '주기';
}

function directionLabel(direction: V3Event['direction']): string | null {
  if (direction === 'BUY') return '매수';
  if (direction === 'LONG') return '롱';
  if (direction === 'SHORT') return '숏';
  return null;
}

function decisionLine(event: V3Event): string {
  if (event.type === 'NEW_CANDIDATE') return '🟢 현재 판단: 진입 후보';
  if (event.type === 'RESCAN_REQUESTED') return '🔄 현재 판단: 재분석 중';
  if (event.state === 'CANDIDATE') return '🟢 현재 판단: 진입 후보';
  if (event.state === 'BLOCKED_DATA') return '⚪ 현재 판단: 데이터 확인 중';
  if (event.state === 'NO_TRADE' || event.state === 'ABSTAIN') return '🟡 현재 판단: 관망';
  return '🟡 현재 판단: 재평가 중';
}

function reasonLabel(reason: string): string {
  const normalized = reason.trim().toUpperCase();
  if (normalized.startsWith('UTILITY_EVIDENCE_INCOMPLETE')) return '예상 수익 우위 근거 부족';
  switch (normalized) {
    case 'QUANT_NOT_ELIGIBLE':
      return '정량 조건 미충족';
    case 'PROFIT_GATE_REJECTED':
      return '수익성 검증 기준 미충족';
    case 'RISK_NOT_READY':
      return '리스크 조건 미충족';
    case 'NON_POSITIVE_NET_UTILITY':
      return '비용 반영 기대수익이 양수가 아님';
    case 'DATA_NOT_READY':
      return '시장데이터 준비 미완료';
    case 'DIRECTION_NOT_RECOMMENDABLE':
      return '방향성 판단 근거 부족';
    case 'AI_EVIDENCE_CONFLICT':
      return 'AI 보조 근거가 서로 충돌함';
    case 'DIRECTION_LOST_AUCTION':
      return '다른 방향 후보가 우선 선정됨';
    default:
      return '추가 검증 조건 미충족';
  }
}

function reasonLines(event: V3Event): string[] {
  if (!Array.isArray(event.reasons) || !event.reasons.length) return [];
  return [...new Set(event.reasons.map(reasonLabel))].slice(0, 4).map((reason) => `• ${reason}`);
}

function leverageText(event: V3Event): string | null {
  const leverage = event.leverage;
  if (!leverage || leverage.status !== 'INDICATIVE_ONLY') return null;
  const min = leverage.recommendedRange?.min;
  const max = leverage.recommendedRange?.max;
  const hard = leverage.hardMaximum;
  if (![min, max, hard].every((value) => Number.isFinite(Number(value)))) return null;
  return `레버리지 참고: ${finiteText(min, 1)}x~${finiteText(max, 1)}x · 상한 ${finiteText(hard, 1)}x`;
}

function kstTimestamp(now: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}월 ${Number(parts.day)}일 ${parts.hour}:${parts.minute}`;
}

function alertType(event: V3Event): TelegramAlertInput['type'] | null {
  if (event.type !== 'NEW_CANDIDATE') return 'intelligence_report';
  if (event.market === 'KR_STOCK' || event.market === 'US_STOCK') return event.direction === 'BUY' ? 'strong_buy' : null;
  if (event.market === 'CRYPTO_SPOT') return event.direction === 'BUY' ? 'crypto_spot_buy' : null;
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'LONG') return 'crypto_futures_long';
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'SHORT') return 'crypto_futures_short';
  return null;
}

function details(event: V3Event, now: Date): string {
  const candidate = event.type === 'NEW_CANDIDATE' || event.state === 'CANDIDATE';
  const direction = candidate ? directionLabel(event.direction) : null;
  const reasons = reasonLines(event);
  const action = event.type === 'RESCAN_REQUESTED'
    ? '시장 변화 반영 후 다시 판단합니다.'
    : event.state === 'BLOCKED_DATA'
      ? '데이터가 준비되면 다시 분석합니다.'
      : event.state === 'NO_TRADE' || event.state === 'ABSTAIN'
        ? '조건 충족 시 다시 분석합니다.'
        : candidate
          ? '최신 시장데이터로 진입 조건을 다시 확인합니다.'
          : '조건 변화를 확인해 다시 평가합니다.';

  return [
    decisionLine(event),
    `${strategyLabel(event.strategy)} · ${timeframeLabel(event.timeframe)}`,
    direction ? `방향: ${direction}` : null,
    tierLabel(event.validationTier),
    candidate && Number.isFinite(Number(event.utilityR)) ? `비용 반영 기대값: ${finiteText(event.utilityR)}R` : null,
    candidate ? leverageText(event) : null,
    reasons.length ? '이유' : null,
    ...reasons,
    action,
    '🔒 이 알림은 주문을 실행하지 않습니다.',
    `🕒 ${kstTimestamp(now)}`,
  ].filter(Boolean).join('\n');
}

export function buildSignalIntelligenceTelegramInput(
  event: V3Event,
  serviceSha: string,
  now = new Date(),
): TelegramAlertInput | null {
  const type = alertType(event);
  const destinationChatId = chatIdForMarket(event.market);
  if (!type || !destinationChatId) return null;
  return {
    type,
    title: `📊 ${event.symbol} · ${marketLabel(event.market)}`,
    symbol: event.symbol,
    market: event.market,
    details: details(event, now),
    destinationChatId,
    dedupeKey: `signal-intelligence-v3:${serviceSha}:${event.type}:${event.id}:${event.previousState ?? ''}:${event.state ?? ''}`,
    duplicateWindowMs: 14 * 24 * 60 * 60 * 1000,
    cooldownMs: 0,
  };
}

class DeliveryState {
  private loaded = false;
  private delivered = new Map<string, string>();
  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Persisted>;
      if (parsed.version !== 1 || !parsed.delivered) return;
      for (const [key, value] of Object.entries(parsed.delivered)) if (typeof value === 'string') this.delivered.set(key, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') logger.warn('signal intelligence Telegram state read failed');
    }
  }

  async has(key: string): Promise<boolean> {
    await this.load();
    return this.delivered.has(key);
  }

  async mark(key: string, now: Date): Promise<void> {
    await this.load();
    const cutoff = now.getTime() - MAX_DELIVERED_AGE_MS;
    for (const [candidate, at] of this.delivered) if (Date.parse(at) < cutoff) this.delivered.delete(candidate);
    this.delivered.set(key, now.toISOString());
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, delivered: Object.fromEntries(this.delivered) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }
}

function mergePersonalResult(
  result: { attempted: number; delivered: number; deduped: number; skipped: number; failed: number },
  personal: MemberWatchlistTelegramProducerResult,
): void {
  result.attempted += personal.attempted;
  result.delivered += personal.delivered;
  result.skipped += personal.skipped;
  result.failed += personal.failed;
}

export class SignalIntelligenceTelegramSubscriber {
  private running = false;
  constructor(
    private readonly store: DeliveryState,
    private readonly deliver: typeof sendTelegramAlert = sendTelegramAlert,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly deliverWatchlist: WatchlistDeliverer = deliverMemberWatchlistTelegramForSignal,
  ) {}

  async runOnce(now = new Date()): Promise<{ attempted: number; delivered: number; deduped: number; skipped: number; failed: number }> {
    const result = { attempted: 0, delivered: 0, deduped: 0, skipped: 0, failed: 0 };
    if (this.running) return result;
    this.running = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.fetchImpl(endpoint(), { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) return result;
      const envelope = await response.json() as V3Envelope;
      const snapshot = envelope.snapshot;
      if (envelope.ok !== true || envelope.executionAuthority !== 'NONE'
        || snapshot?.safety?.executionAuthority !== 'NONE'
        || snapshot?.safety?.privateTradingApiAllowed !== false
        || snapshot?.safety?.realOrderAllowed !== false
        || !/^[0-9a-f]{40}$/u.test(snapshot?.serviceSha ?? '')
        || !Array.isArray(snapshot?.events)) return result;

      for (const event of snapshot.events) {
        try {
          const personal = await this.deliverWatchlist({
            type: event.type,
            id: event.id,
            serviceSha: snapshot.serviceSha,
            market: event.market,
            symbol: event.symbol,
            strategy: event.strategy,
            timeframe: event.timeframe,
            direction: event.direction,
            validationTier: event.validationTier,
            occurredAt: now.toISOString(),
          });
          mergePersonalResult(result, personal);
        } catch {
          result.failed += 1;
        }

        const alert = buildSignalIntelligenceTelegramInput(event, snapshot.serviceSha, now);
        if (!alert?.dedupeKey) { result.skipped += 1; continue; }
        if (await this.store.has(alert.dedupeKey)) { result.deduped += 1; continue; }
        result.attempted += 1;
        const sent = await this.deliver(alert);
        if (sent.ok || sent.skipped === 'DUPLICATE') {
          await this.store.mark(alert.dedupeKey, now);
          if (sent.ok) result.delivered += 1; else result.deduped += 1;
        } else if (sent.skipped === 'NOT_CONFIGURED') result.skipped += 1;
        else result.failed += 1;
      }
      return result;
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') logger.debug('signal intelligence Telegram subscriber unavailable');
      return result;
    } finally {
      clearTimeout(timeout);
      this.running = false;
    }
  }
}

export function startSignalIntelligenceTelegramSubscriber(): { stop(): void } | null {
  if (process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true') return null;
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return null;
  const statePath = process.env.SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH?.trim()
    || path.resolve(process.cwd(), '.runtime/signal-intelligence-telegram-state.json');
  const subscriber = new SignalIntelligenceTelegramSubscriber(new DeliveryState(statePath));
  const tick = async () => {
    const result = await subscriber.runOnce(new Date());
    if (result.delivered > 0 || result.failed > 0) logger.info({ result }, 'signal intelligence Telegram subscriber tick');
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, boundedInterval(process.env.SIGNAL_INTELLIGENCE_TELEGRAM_INTERVAL_MS));
  timer.unref?.();
  console.log('[signal-intelligence-telegram] subscriber started');
  return { stop: () => clearInterval(timer) };
}
