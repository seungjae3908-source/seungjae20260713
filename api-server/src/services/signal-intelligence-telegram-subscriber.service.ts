import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { logger } from '../lib/logger';
import { sendTelegramAlert, type TelegramAlertInput } from './telegram-notification.service';

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
  if (tier === 'CHAMPION') return 'Champion 검증';
  if (tier === 'FORWARD_VALIDATED') return 'Forward 검증';
  return 'Research 후보 · 실전수익 미검증';
}

function finiteText(value: unknown, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : 'N/A';
}

function leverageText(event: V3Event): string | null {
  const leverage = event.leverage;
  if (!leverage || leverage.status !== 'INDICATIVE_ONLY') return null;
  const min = leverage.recommendedRange?.min;
  const max = leverage.recommendedRange?.max;
  const hard = leverage.hardMaximum;
  if (![min, max, hard].every((value) => Number.isFinite(Number(value)))) return null;
  return `적정 레버리지 ${finiteText(min, 1)}x~${finiteText(max, 1)}x · hard max ${finiteText(hard, 1)}x · 참고값`;
}

function alertType(event: V3Event): TelegramAlertInput['type'] | null {
  if (event.type !== 'NEW_CANDIDATE') return 'intelligence_report';
  if (event.market === 'KR_STOCK' || event.market === 'US_STOCK') return event.direction === 'BUY' ? 'strong_buy' : null;
  if (event.market === 'CRYPTO_SPOT') return event.direction === 'BUY' ? 'crypto_spot_buy' : null;
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'LONG') return 'crypto_futures_long';
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'SHORT') return 'crypto_futures_short';
  return null;
}

function details(event: V3Event): string {
  if (event.type === 'NEW_CANDIDATE') {
    return [
      `${event.strategy}/${event.timeframe} · ${event.direction}`,
      tierLabel(event.validationTier),
      `Net utility ${finiteText(event.utilityR)}R`,
      leverageText(event),
      '신규 진입 후보 알림 · 주문 권한 없음',
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'STATE_CHANGED') {
    return [
      `${event.strategy}/${event.timeframe} · ${event.direction}`,
      `${event.previousState ?? 'UNKNOWN'} → ${event.state ?? 'UNKNOWN'}`,
      tierLabel(event.validationTier),
      Array.isArray(event.reasons) && event.reasons.length ? `원인: ${event.reasons.join(', ')}` : null,
      '신규 진입 판단 재평가 · 주문 권한 없음',
    ].filter(Boolean).join('\n');
  }
  return [
    `${event.strategy}/${event.timeframe} · ${event.direction ?? 'N/A'}`,
    tierLabel(event.validationTier),
    'AI/시장 변화 감지 · deterministic Scanner 재평가 요청',
    `현재 상태: ${event.state ?? 'UNKNOWN'}`,
    '주문 권한 없음',
  ].join('\n');
}

function alertFromEvent(event: V3Event, serviceSha: string): TelegramAlertInput | null {
  const type = alertType(event);
  const destinationChatId = chatIdForMarket(event.market);
  if (!type || !destinationChatId) return null;
  return {
    type,
    symbol: event.symbol,
    market: event.market,
    details: details(event),
    destinationChatId,
    dedupeKey: `signal-intelligence-v3:${serviceSha}:${event.type}:${event.id}:${event.previousState ?? ''}:${event.state ?? ''}`,
    duplicateWindowMs: 14 * 24 * 60 * 60 * 1000,
    cooldownMs: 0,
    timestamp: new Date().toISOString(),
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

export class SignalIntelligenceTelegramSubscriber {
  private running = false;
  constructor(
    private readonly store: DeliveryState,
    private readonly deliver: typeof sendTelegramAlert = sendTelegramAlert,
    private readonly fetchImpl: typeof fetch = fetch,
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
        const alert = alertFromEvent(event, snapshot.serviceSha);
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
