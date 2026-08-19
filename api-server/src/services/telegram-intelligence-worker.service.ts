import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { logger } from '../lib/logger';
import {
  dueTelegramIntelligenceReports,
  type TelegramIntelligenceReportKind,
  type TelegramReportDestination,
} from './telegram-intelligence-report.service';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_STATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface TelegramIntelligenceStateStore {
  has(key: string): Promise<boolean>;
  markDelivered(key: string, deliveredAt: Date): Promise<void>;
}

type PersistedState = {
  version: 1;
  delivered: Record<string, string>;
};

export class FileTelegramIntelligenceStateStore implements TelegramIntelligenceStateStore {
  private loaded = false;
  private delivered = new Map<string, string>();

  constructor(private readonly statePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>;
      if (parsed.version !== 1 || !parsed.delivered || typeof parsed.delivered !== 'object') return;
      for (const [key, value] of Object.entries(parsed.delivered)) {
        if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) {
          this.delivered.set(key, value);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn({ code }, 'telegram intelligence state could not be read; starting fail-closed empty state');
      }
    }
  }

  async has(key: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.delivered.has(key);
  }

  async markDelivered(key: string, deliveredAt: Date): Promise<void> {
    await this.ensureLoaded();
    const cutoff = deliveredAt.getTime() - MAX_STATE_AGE_MS;
    for (const [candidate, timestamp] of this.delivered) {
      if (new Date(timestamp).getTime() < cutoff) this.delivered.delete(candidate);
    }
    this.delivered.set(key, deliveredAt.toISOString());
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const payload: PersistedState = {
      version: 1,
      delivered: Object.fromEntries(this.delivered),
    };
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

export class MemoryTelegramIntelligenceStateStore implements TelegramIntelligenceStateStore {
  readonly delivered = new Set<string>();

  async has(key: string): Promise<boolean> {
    return this.delivered.has(key);
  }

  async markDelivered(key: string): Promise<void> {
    this.delivered.add(key);
  }
}

function reportLabel(kind: TelegramIntelligenceReportKind): string {
  switch (kind) {
    case 'MORNING': return '아침 브리핑';
    case 'KR_CLOSING': return '한국장 마감 브리핑';
    case 'US_PREMARKET': return '미국장 프리마켓 브리핑';
    case 'WEEKLY': return '주간 브리핑';
  }
}

function reportDetails(kind: TelegramIntelligenceReportKind, localDate: string): string {
  return [
    `${reportLabel(kind)} · ${localDate}`,
    '검증된 앱 데이터와 저장된 성과만 투자 판단 근거로 사용합니다.',
    '이 자동 리포트는 신호·수익률·확률을 새로 만들어내지 않으며, 증거가 없으면 N/A/NO_TRADE 원칙을 유지합니다.',
  ].join('\n');
}

export function telegramDestinationChatId(destination: TelegramReportDestination): string | null {
  const fallback = process.env.TELEGRAM_CHAT_ID?.trim() || null;
  switch (destination) {
    case 'STOCK_ROOM': return process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || fallback;
    case 'CRYPTO_ROOM': return process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || fallback;
    case 'PERSONAL': return process.env.TELEGRAM_PERSONAL_CHAT_ID?.trim() || fallback;
  }
}

export type TelegramIntelligenceDelivery = (
  input: TelegramAlertInput,
) => Promise<TelegramAlertResult>;

export type TelegramIntelligenceRunResult = {
  duePlans: number;
  attempted: number;
  delivered: number;
  deduped: number;
  notConfigured: number;
  failed: number;
  orderSubmitted: false;
  privateTradingApiCount: 0;
  liveTradingAuthority: false;
};

export class TelegramIntelligenceWorker {
  private running = false;

  constructor(
    private readonly store: TelegramIntelligenceStateStore,
    private readonly deliver: TelegramIntelligenceDelivery = sendTelegramAlert,
    private readonly resolveChatId: (destination: TelegramReportDestination) => string | null = telegramDestinationChatId,
  ) {}

  async runOnce(now = new Date()): Promise<TelegramIntelligenceRunResult> {
    const result: TelegramIntelligenceRunResult = {
      duePlans: 0,
      attempted: 0,
      delivered: 0,
      deduped: 0,
      notConfigured: 0,
      failed: 0,
      orderSubmitted: false,
      privateTradingApiCount: 0,
      liveTradingAuthority: false,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const includePersonal = Boolean(process.env.TELEGRAM_PERSONAL_CHAT_ID?.trim());
      const plans = dueTelegramIntelligenceReports(now, {
        membership: 'admin',
        portfolioRelevant: includePersonal,
        includeStocks: true,
        includeCrypto: true,
      });
      result.duePlans = plans.length;

      for (const plan of plans) {
        const uniqueChats = new Map<string, TelegramReportDestination>();
        for (const destination of plan.destinations) {
          const chatId = this.resolveChatId(destination);
          if (!chatId) {
            result.notConfigured += 1;
            continue;
          }
          if (!uniqueChats.has(chatId)) uniqueChats.set(chatId, destination);
        }

        for (const [chatId, destination] of uniqueChats) {
          const deliveryKey = `${plan.dedupeKey}:${destination}:${chatId}`;
          if (await this.store.has(deliveryKey)) {
            result.deduped += 1;
            continue;
          }
          result.attempted += 1;
          const delivered = await this.deliver({
            type: 'intelligence_report',
            market: destination,
            details: reportDetails(plan.kind, plan.localDate),
            timestamp: now.toISOString(),
            destinationChatId: chatId,
            dedupeKey: deliveryKey,
            duplicateWindowMs: 24 * 60 * 60 * 1000,
            cooldownMs: 0,
          });
          if (delivered.ok) {
            await this.store.markDelivered(deliveryKey, now);
            result.delivered += 1;
          } else if (delivered.skipped === 'DUPLICATE') {
            await this.store.markDelivered(deliveryKey, now);
            result.deduped += 1;
          } else if (delivered.skipped === 'NOT_CONFIGURED') {
            result.notConfigured += 1;
          } else {
            result.failed += 1;
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.max(30_000, Math.min(300_000, Math.trunc(parsed)));
}

export type TelegramIntelligenceWorkerControl = {
  worker: TelegramIntelligenceWorker;
  stop: () => void;
};

export function startTelegramIntelligenceWorker(): TelegramIntelligenceWorkerControl | null {
  if (process.env.TELEGRAM_INTELLIGENCE_WORKER_ENABLED === 'false') {
    console.log('[telegram-intelligence-worker] disabled by explicit flag');
    return null;
  }
  if (process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true') {
    console.log('[telegram-intelligence-worker] disabled; LIVE_TELEGRAM_ACTIVATION_APPROVED=true is required');
    return null;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !process.env.TELEGRAM_CHAT_ID?.trim()) {
    console.log('[telegram-intelligence-worker] disabled; Telegram bot token and default chat are required');
    return null;
  }

  const statePath = process.env.TELEGRAM_INTELLIGENCE_STATE_PATH?.trim()
    || path.resolve(process.cwd(), '.runtime/telegram-intelligence-delivery-state.json');
  const worker = new TelegramIntelligenceWorker(new FileTelegramIntelligenceStateStore(statePath));
  const tick = async () => {
    try {
      const result = await worker.runOnce(new Date());
      if (result.duePlans > 0) {
        console.log('[telegram-intelligence-worker] tick', {
          duePlans: result.duePlans,
          attempted: result.attempted,
          delivered: result.delivered,
          deduped: result.deduped,
          failed: result.failed,
        });
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'telegram intelligence worker tick failed');
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, boundedInterval(process.env.TELEGRAM_INTELLIGENCE_INTERVAL_MS));
  timer.unref?.();
  console.log('[telegram-intelligence-worker] started');
  return { worker, stop: () => clearInterval(timer) };
}
