import path from 'node:path';
import { constants as fileConstants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { logger } from '../lib/logger';
import {
  dueTelegramIntelligenceReports,
  type TelegramIntelligenceReportKind,
  type TelegramReportDestination,
} from './telegram-intelligence-report.service';
import {
  buildTelegramMarketBriefInput,
  collectTelegramMarketBrief,
  type TelegramMarketBriefSnapshot,
} from './telegram-market-brief.service';
import {
  missingTelegramMarketRoomEnv,
  telegramMarketRoomChatId,
} from './telegram-market-room.service';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_STATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LEDGER_BYTES = 1_048_576;
// A stuck tick could have been accepted by Bot API already. This watchdog
// only marks health degraded; it NEVER retries or releases dedupe reservations.
const BRIEF_STALL_AFTER_MS = 10 * 60_000;
const BRIEF_PRE_SEND_MAX_MS = 15_000;
const BRIEF_PUBLIC_READ_MAX_MS = 8_500;

/**
 * Deadline is ONLY permitted for an operation that cannot send Telegram or
 * persist a send reservation: optional public reads and ledger has()/hasUnconfirmed().
 * If its underlying promise completes late there is NO continuing caller
 * that may issue a Bot POST. NEVER wrap reservation, delivery or receipt writes.
 */
export async function boundedTelegramBriefPreSendRead<T>(
  read: () => Promise<T>,
  timeoutMs: number = BRIEF_PRE_SEND_MAX_MS,
): Promise<T> {
  if (typeof read !== 'function' || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > BRIEF_PRE_SEND_MAX_MS)
    throw new Error('TELEGRAM_BRIEF_PRE_SEND_INVALID');
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      Promise.resolve().then(read),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('TELEGRAM_BRIEF_PRE_SEND_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export type TelegramBriefStage =
  | 'IDLE' | 'PLAN' | 'PUBLIC_BRIEF_READ' | 'LEDGER_LOOKUP'
  | 'RESERVE_UNCONFIRMED' | 'BOT_POST' | 'DURABLE_RECEIPT_WRITE';
export function telegramBriefTickStalled(
  startedAt: string | null, nowMs: number = Date.now(),
): boolean {
  const at = Date.parse(startedAt ?? '');
  return Number.isFinite(nowMs) && Number.isFinite(at) && at > 0
    && nowMs >= at && nowMs - at > BRIEF_STALL_AFTER_MS;
}

export interface TelegramIntelligenceStateStore {
  has(key: string): Promise<boolean>;
  hasUnconfirmed(key: string): Promise<boolean>;
  markDelivered(key: string, deliveredAt: Date): Promise<void>;
  markUnconfirmed(key: string, attemptedAt: Date): Promise<void>;
  releaseExplicitNoSend(key: string, attemptedAt: Date): Promise<void>;
}

type PersistedState = {
  version: 1;
  delivered: Record<string, string>;
  unconfirmed?: Record<string, string>;
};

export class FileTelegramIntelligenceStateStore implements TelegramIntelligenceStateStore {
  private loaded = false;
  private blocked = false;
  private loading: Promise<void> | null = null;
  private delivered = new Map<string, string>();
  private unconfirmed = new Map<string, string>();

  constructor(private readonly statePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.blocked) throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE');
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.initializeLedger();
    try {
      await this.loading;
      this.loaded = true;
    } finally { this.loading = null; }
  }

  private async initializeLedger(): Promise<void> {
    let originalLedgerObserved = false;
    try {
      const details = await lstat(this.statePath);
      originalLedgerObserved = true;
      if (!details.isFile() || details.isSymbolicLink()
        || details.size > MAX_LEDGER_BYTES) {
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      }
      const fd = await open(this.statePath,
        fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      let raw: string;
      try {
        const actual = await fd.stat();
        if (!actual.isFile() || actual.size > MAX_LEDGER_BYTES
          || actual.dev !== details.dev || actual.ino !== details.ino) {
          throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
        }
        // Bounded fd-only read: never follow a swapped pathname and never
        // load an unbounded file if it grows during the observation.
        const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await fd.read(buffer, offset,
            buffer.length - offset, offset);
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 0
            || bytesRead > buffer.length - offset)
            throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MAX_LEDGER_BYTES)
          throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
        raw = buffer.subarray(0, offset).toString('utf8');
      } finally {
        await fd.close();
      }
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== 1 || !parsed.delivered || typeof parsed.delivered !== 'object'
        || Array.isArray(parsed.delivered)) {
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      }
      const entries = Object.entries(parsed.delivered);
      if (entries.length > 10000 || entries.some(([key, value]) =>
        key.length > 1024 || typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      }
      const pending = parsed.unconfirmed === undefined ? {} : parsed.unconfirmed;
      if (!pending || typeof pending !== 'object' || Array.isArray(pending))
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      const unconfirmedEntries = Object.entries(pending);
      if (entries.length + unconfirmedEntries.length > 10000
        || unconfirmedEntries.some(([key, value]) =>
          !key.startsWith('telegram-intelligence:') || key.length > 1024
          || typeof value !== 'string' || !Number.isFinite(Date.parse(value))
          || Object.prototype.hasOwnProperty.call(parsed.delivered, key)))
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      for (const [key, value] of entries) this.delivered.set(key, value);
      for (const [key, value] of unconfirmedEntries) this.unconfirmed.set(key, value);
    } catch (error) {
      // An initially absent ledger can legitimately start empty. But a
      // ledger that disappears AFTER a successful lstat is a dangerous
      // swap/race, not proof that no prior Telegram send occurred.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT'
        && !originalLedgerObserved) return;
      this.blocked = true;
      this.delivered.clear();
      this.unconfirmed.clear();
      logger.warn({ code: 'TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE' },
        'telegram intelligence persisted dedupe state unreadable; scheduled sends blocked');
      throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE');
    }
  }

  async has(key: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.delivered.has(key);
  }
  async hasUnconfirmed(key: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.unconfirmed.has(key);
  }
  async markDelivered(key: string, deliveredAt: Date): Promise<void> {
    return this.persist(key, deliveredAt, true);
  }
  async markUnconfirmed(key: string, attemptedAt: Date): Promise<void> {
    return this.persist(key, attemptedAt, false);
  }
  /** Only a documented local skip or explicit Bot API rejection may release a
   * pre-send reservation; an uncertain POST must stay permanently blocked. */
  async releaseExplicitNoSend(key: string, attemptedAt: Date): Promise<void> {
    return this.persist(key, attemptedAt, null);
  }
  private async persist(key: string, at: Date, confirmed: boolean | null): Promise<void> {
    await this.ensureLoaded();
    try {
      if (!key.startsWith('telegram-intelligence:') || key.length > 1024
        || !Number.isFinite(at.getTime())) throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      const nextDelivered = new Map(this.delivered);
      const nextUnconfirmed = new Map(this.unconfirmed);
      const cutoff = at.getTime() - MAX_STATE_AGE_MS;
      // Confirmed receipts have a bounded dedupe lifetime, but an ambiguous
      // remote POST is never made retry-safe solely by the passage of time.
      for (const [candidate, timestamp] of nextDelivered)
        if (Date.parse(timestamp) < cutoff) nextDelivered.delete(candidate);
      if (confirmed === true) {
        nextUnconfirmed.delete(key);
        nextDelivered.set(key, at.toISOString());
      } else if (confirmed === false) {
        if (nextDelivered.has(key)) throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
        nextUnconfirmed.set(key, at.toISOString());
      } else {
        if (nextDelivered.has(key) || !nextUnconfirmed.has(key))
          throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
        nextUnconfirmed.delete(key);
      }
      if (nextDelivered.size + nextUnconfirmed.size > 10000)
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      const payload: PersistedState = { version: 1,
        delivered: Object.fromEntries(nextDelivered),
        unconfirmed: Object.fromEntries(nextUnconfirmed) };
      const serialized = `${JSON.stringify(payload, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES)
        throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_INVALID');
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      const fd = await open(temporary,
        fileConstants.O_WRONLY | fileConstants.O_CREAT
          | fileConstants.O_EXCL | fileConstants.O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(serialized, { encoding: 'utf8' });
        await fd.sync();
      } finally { await fd.close(); }
      await rename(temporary, this.statePath);
      // The rename itself must survive a host crash before the POST starts.
      const directory = await open(path.dirname(this.statePath), fileConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      this.delivered = nextDelivered;
      this.unconfirmed = nextUnconfirmed;
    } catch {
      this.blocked = true;
      this.delivered.clear();
      this.unconfirmed.clear();
      logger.warn({ code: 'TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE' },
        'telegram intelligence dedupe write failed; further scheduled sends blocked');
      throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE');
    }
  }
}

export class MemoryTelegramIntelligenceStateStore implements TelegramIntelligenceStateStore {
  readonly delivered = new Set<string>();
  readonly unconfirmed = new Set<string>();
  async has(key: string): Promise<boolean> { return this.delivered.has(key); }
  async hasUnconfirmed(key: string): Promise<boolean> { return this.unconfirmed.has(key); }
  async markDelivered(key: string): Promise<void> {
    this.unconfirmed.delete(key);
    this.delivered.add(key);
  }
  async markUnconfirmed(key: string): Promise<void> {
    if (this.delivered.has(key)) throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE');
    this.unconfirmed.add(key);
  }
  async releaseExplicitNoSend(key: string): Promise<void> {
    if (this.delivered.has(key) || !this.unconfirmed.has(key))
      throw new Error('TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE');
    this.unconfirmed.delete(key);
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

export function safeTelegramBriefFailureCode(error: unknown):
  'TELEGRAM_BRIEF_TIMEOUT' | 'TELEGRAM_BRIEF_SOURCE_UNAVAILABLE' {
  // Never expose provider exception strings (may include tokens/URLs).
  return error instanceof Error && error.name === 'AbortError'
    ? 'TELEGRAM_BRIEF_TIMEOUT' : 'TELEGRAM_BRIEF_SOURCE_UNAVAILABLE';
}

function reportDetails(kind: TelegramIntelligenceReportKind, localDate: string): string {
  return [
    `${reportLabel(kind)} · ${localDate}`,
    '검증된 앱 데이터와 저장된 성과만 투자 판단 근거로 사용합니다.',
    '이 자동 리포트는 신호·수익률·확률을 새로 만들어내지 않으며, 증거가 없으면 N/A/NO_TRADE 원칙을 유지합니다.',
  ].join('\n');
}

export function telegramDestinationChatId(destination: TelegramReportDestination): string | null {
  return telegramMarketRoomChatId(destination, process.env);
}

export type TelegramIntelligenceDelivery = (
  input: TelegramAlertInput,
) => Promise<TelegramAlertResult>;

export type TelegramBriefCollector = () => Promise<TelegramMarketBriefSnapshot>;

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
    private readonly collectBrief: TelegramBriefCollector = collectTelegramMarketBrief,
    private readonly stageObserver: (stage: TelegramBriefStage) => void = () => {},
    private readonly preSendReadTimeoutMs: number = BRIEF_PRE_SEND_MAX_MS,
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
      this.stageObserver('PLAN');
      const plans = dueTelegramIntelligenceReports(now, {
        membership: 'admin',
        portfolioRelevant: false,
        watchlistRelevant: false,
        includeStocks: true,
        includeCrypto: true,
      });
      result.duePlans = plans.length;

      let briefSnapshot: TelegramMarketBriefSnapshot | null = null;
      if (plans.length > 0 && process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED === 'true') {
        try {
          this.stageObserver('PUBLIC_BRIEF_READ');
          briefSnapshot = await boundedTelegramBriefPreSendRead(
            () => this.collectBrief(), BRIEF_PUBLIC_READ_MAX_MS,
          );
        } catch (error) {
          logger.warn(
            { code: safeTelegramBriefFailureCode(error) },
            'telegram rich market brief unavailable; using safety fallback',
          );
        }
      }

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
          this.stageObserver('LEDGER_LOOKUP');
          if (await boundedTelegramBriefPreSendRead(
            () => this.store.has(deliveryKey), this.preSendReadTimeoutMs,
          )) {
            result.deduped += 1;
            continue;
          }
          if (await boundedTelegramBriefPreSendRead(
            () => this.store.hasUnconfirmed(deliveryKey), this.preSendReadTimeoutMs,
          )) {
            result.failed += 1;
            continue;
          }
          const alert = briefSnapshot
            ? buildTelegramMarketBriefInput({
                kind: plan.kind,
                localDate: plan.localDate,
                destination,
                destinationChatId: chatId,
                dedupeKey: deliveryKey,
                now,
                snapshot: briefSnapshot,
              })
            : {
                type: 'intelligence_report' as const,
                market: destination,
                details: reportDetails(plan.kind, plan.localDate),
                timestamp: now.toISOString(),
                destinationChatId: chatId,
                dedupeKey: deliveryKey,
                duplicateWindowMs: 24 * 60 * 60 * 1000,
                cooldownMs: 0,
              };
          // Checkpoint an UNKNOWN outcome *before* the non-idempotent Bot API
          // POST, not after it. A crash following remote acceptance must not
          // cause the next process to retransmit this report.
          this.stageObserver('RESERVE_UNCONFIRMED');
          await this.store.markUnconfirmed(deliveryKey, now);
          result.attempted += 1;
          this.stageObserver('BOT_POST');
          const delivered = await this.deliver(alert);
          if (delivered.ok) {
            this.stageObserver('DURABLE_RECEIPT_WRITE');
            await this.store.markDelivered(deliveryKey, now);
            result.delivered += 1;
          } else if (delivered.attempts === 0
            && delivered.skipped === 'NOT_CONFIGURED') {
            this.stageObserver('DURABLE_RECEIPT_WRITE');
            await this.store.releaseExplicitNoSend(deliveryKey, now);
            result.notConfigured += 1;
          } else if (delivered.attempts === 0
            && delivered.skipped === 'COOLDOWN') {
            this.stageObserver('DURABLE_RECEIPT_WRITE');
            await this.store.releaseExplicitNoSend(deliveryKey, now);
            result.deduped += 1;
          } else if (delivered.skipped === 'DELIVERY_FAILED'
            && (delivered.errorCode === 'TELEGRAM_API_REJECTED'
              || /^TELEGRAM_HTTP_(?:400|401|403|404|409|410|422|429)$/u
                .test(delivered.errorCode ?? ''))) {
            // A specific rejection proves that Telegram did not accept this
            // POST. Other transport errors must retain the reservation.
            this.stageObserver('DURABLE_RECEIPT_WRITE');
            await this.store.releaseExplicitNoSend(deliveryKey, now);
            result.failed += 1;
          } else {
            // DUPLICATE is not a remote receipt (the other call may still be
            // in-flight). Unknown/failed results require reconciliation.
            result.failed += 1;
          }
        }
      }
      return result;
    } finally {
      this.stageObserver('IDLE');
      this.running = false;
    }
  }
}

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.max(30_000, Math.min(300_000, Math.trunc(parsed)));
}

// Counts and fixed codes only. No tokens, chat IDs, symbols or member information.
export type TelegramIntelligenceWorkerHealth = Readonly<{
  enabled: boolean;
  state: 'NOT_STARTED' | 'DISABLED' | 'RUNNING' | 'STOPPED';
  startErrorCode: 'FLAG_DISABLED' | 'ACTIVATION_REQUIRED' | 'TOKEN_MISSING' | 'ROOMS_MISSING' | null;
  lastTickAt: string | null;
  tickOk: boolean | null;
  lastDueTickAt: string | null;
  lastDuePlans: number;
  lastDueAttempted: number;
  lastDueDelivered: number;
  lastDueDeduped: number;
  lastDueNotConfigured: number;
  lastDueFailed: number;
  lastDueCode: 'NOT_OBSERVED' | 'BOT_API_ACCEPTED' | 'DEDUPED_ONLY'
    | 'NOT_CONFIGURED' | 'DELIVERY_FAILED' | 'NO_ATTEMPTS'
    | 'LEDGER_UNREADABLE' | 'TICK_FAILED';
  inFlight: boolean;
  activeStage: TelegramBriefStage;
  tickStartedAt: string | null;
  stageStartedAt: string | null;
  stalled: boolean;
}>;

function emptyTelegramIntelligenceWorkerHealth(): TelegramIntelligenceWorkerHealth {
  return Object.freeze({
    enabled: false, state: 'NOT_STARTED', startErrorCode: null,
    lastTickAt: null, tickOk: null, lastDueTickAt: null,
    lastDuePlans: 0, lastDueAttempted: 0, lastDueDelivered: 0,
    lastDueDeduped: 0, lastDueNotConfigured: 0, lastDueFailed: 0,
    lastDueCode: 'NOT_OBSERVED',
    inFlight: false, activeStage: 'IDLE', tickStartedAt: null,
    stageStartedAt: null, stalled: false,
  });
}

let runtimeHealth: TelegramIntelligenceWorkerHealth = emptyTelegramIntelligenceWorkerHealth();
export function readTelegramIntelligenceWorkerHealth(): TelegramIntelligenceWorkerHealth {
  return runtimeHealth;
}

function putTelegramIntelligenceHealth(patch: Partial<TelegramIntelligenceWorkerHealth>): void {
  runtimeHealth = Object.freeze({ ...runtimeHealth, ...patch });
}

function sanitizedTelegramIntelligenceError(error: unknown): 'LEDGER_UNREADABLE' | 'TICK_FAILED' {
  return error instanceof Error && error.message === 'TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE'
    ? 'LEDGER_UNREADABLE' : 'TICK_FAILED';
}

export type TelegramIntelligenceWorkerControl = {
  worker: TelegramIntelligenceWorker;
  stop: () => void;
};

export function startTelegramIntelligenceWorker(): TelegramIntelligenceWorkerControl | null {
  runtimeHealth = emptyTelegramIntelligenceWorkerHealth();
  const disabled = (code: NonNullable<TelegramIntelligenceWorkerHealth['startErrorCode']>) => {
    putTelegramIntelligenceHealth({ state: 'DISABLED', startErrorCode: code });
    return null;
  };
  if (process.env.TELEGRAM_INTELLIGENCE_WORKER_ENABLED === 'false') {
    console.log('[telegram-intelligence-worker] disabled by explicit flag');
    return disabled('FLAG_DISABLED');
  }
  if (process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true') {
    console.log('[telegram-intelligence-worker] disabled; LIVE_TELEGRAM_ACTIVATION_APPROVED=true is required');
    return disabled('ACTIVATION_REQUIRED');
  }
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    console.log('[telegram-intelligence-worker] disabled; Telegram bot token is required');
    return disabled('TOKEN_MISSING');
  }
  const missingMarketRooms = missingTelegramMarketRoomEnv(process.env);
  if (missingMarketRooms.length) {
    console.log('[telegram-intelligence-worker] disabled; four dedicated market Telegram rooms are required', {
      missing: missingMarketRooms,
    });
    return disabled('ROOMS_MISSING');
  }

  const statePath = process.env.TELEGRAM_INTELLIGENCE_STATE_PATH?.trim()
    || path.resolve(process.cwd(), '.runtime/telegram-intelligence-delivery-state.json');
  const observeStage = (stage: TelegramBriefStage) => {
    putTelegramIntelligenceHealth({
      activeStage: stage,
      stageStartedAt: stage === 'IDLE' ? null : new Date().toISOString(),
    });
  };
  const worker = new TelegramIntelligenceWorker(
    new FileTelegramIntelligenceStateStore(statePath),
    sendTelegramAlert, telegramDestinationChatId, collectTelegramMarketBrief, observeStage,
  );
  putTelegramIntelligenceHealth({ enabled: true, state: 'RUNNING' });
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    const observedAt = new Date();
    putTelegramIntelligenceHealth({
      inFlight: true, tickStartedAt: observedAt.toISOString(),
      activeStage: 'PLAN', stageStartedAt: observedAt.toISOString(), stalled: false,
    });
    const dueExpected = dueTelegramIntelligenceReports(observedAt, {
      membership: 'admin', portfolioRelevant: false, watchlistRelevant: false,
      includeStocks: true, includeCrypto: true,
    }).length;
    try {
      const result = await worker.runOnce(observedAt);
      const completedAt = new Date().toISOString();
      putTelegramIntelligenceHealth({
        lastTickAt: completedAt, tickOk: true,
        ...(result.duePlans > 0 ? {
          lastDueTickAt: completedAt,
          lastDuePlans: result.duePlans,
          lastDueAttempted: result.attempted,
          lastDueDelivered: result.delivered,
          lastDueDeduped: result.deduped,
          lastDueNotConfigured: result.notConfigured,
          lastDueFailed: result.failed,
          lastDueCode: result.failed > 0 ? 'DELIVERY_FAILED'
            : result.notConfigured > 0 ? 'NOT_CONFIGURED'
              : result.delivered > 0 ? 'BOT_API_ACCEPTED'
                : result.deduped > 0 ? 'DEDUPED_ONLY' : 'NO_ATTEMPTS',
        } : {}),
      });
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
      const code = sanitizedTelegramIntelligenceError(error);
      const failedAt = new Date().toISOString();
      putTelegramIntelligenceHealth({
        lastTickAt: failedAt, tickOk: false,
        ...(dueExpected > 0 ? {
          lastDueTickAt: failedAt, lastDuePlans: dueExpected,
          lastDueCode: code,
        } : {}),
      });
      logger.warn({ code }, 'telegram intelligence worker tick failed');
    } finally {
      inFlight = false;
      putTelegramIntelligenceHealth({
        inFlight: false, tickStartedAt: null, activeStage: 'IDLE',
        stageStartedAt: null, stalled: false,
      });
    }
  };

  void tick();
  const timer = setInterval(() => {
    if (!inFlight) { void tick(); return; }
    if (!runtimeHealth.stalled
      && telegramBriefTickStalled(runtimeHealth.tickStartedAt)) {
      putTelegramIntelligenceHealth({
        tickOk: false, stalled: true, lastDueCode: 'TICK_FAILED',
      });
      logger.warn({
        code: 'TELEGRAM_BRIEF_IN_FLIGHT_STALLED',
        stage: runtimeHealth.activeStage,
      }, 'telegram brief blocked by unresolved in-flight work; never retry POST');
    }
  }, boundedInterval(process.env.TELEGRAM_INTELLIGENCE_INTERVAL_MS));
  timer.unref?.();
  console.log('[telegram-intelligence-worker] started');
  return {
    worker,
    stop: () => {
      clearInterval(timer);
      putTelegramIntelligenceHealth({ enabled: false, state: 'STOPPED' });
    },
  };
}
