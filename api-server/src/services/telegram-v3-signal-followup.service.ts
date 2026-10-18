/**
 * Follow-up alerts for Signal V3 market-room signals (owner request, 2026-10-18).
 *
 * After a v2 signal message is accepted by Telegram, its plan is tracked here:
 *   - each target reached → a short follow-up in the same room;
 *   - stop reached, last target reached, entry window or holding period over
 *     → a closing follow-up, and the original message is edited so the
 *     [구매] button disappears and only [차트] and a "종료" line remain.
 *
 * Read-only market marks only: no broker, order or private trading API.
 * Each state change is persisted BEFORE its Telegram send, so a crash can
 * drop a follow-up but never repeat one.
 */
import path from 'node:path';
import { constants as fileConstants } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { logger } from '../lib/logger';
import {
  readMemberAutoTradingMarketMark,
  type MemberAutoTradingMarketMark,
} from './member-auto-trading-market-mark.service';
import {
  editTelegramMessage,
  escapeTelegramHtml,
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
  type TelegramMessageKind,
  type TelegramUrlButton,
} from './telegram-notification.service';
import {
  formatSignalPrice,
  kstLabel,
  type SignalMessageDirection,
  type SignalMessageMarket,
} from './telegram-signal-message-v2.service';

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 500;
const MAX_STATE_BYTES = 2_097_152;
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const STATE_ERROR = 'TELEGRAM_V3_FOLLOWUP_STATE_UNAVAILABLE';

const MARKET_LABEL: Record<SignalMessageMarket, string> = {
  KR_STOCK: '국내주식', US_STOCK: '해외주식', CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물',
};

/** Bar length used for the default entry window and holding period. */
function barMs(timeframe: string): number {
  const t = timeframe.trim();
  const minute = t.match(/^(\d+)m$/u);
  if (minute) return Number(minute[1]) * 60_000;
  if (t === '1H') return 60 * 60_000;
  const hour = t.match(/^(\d+)H$/u);
  if (hour) return Number(hour[1]) * 60 * 60_000;
  if (t === '1D') return 24 * 60 * 60_000;
  return 60 * 60_000;
}

/** Entry stays open for 3 bars (the scanner's card validity), holding for 30 bars. */
export const TELEGRAM_V3_FOLLOWUP_ENTRY_BARS = 3;
export const TELEGRAM_V3_FOLLOWUP_HOLD_BARS = 30;

export type TelegramV3FollowupClose =
  | 'TARGET_DONE' | 'STOP' | 'ENTRY_EXPIRED' | 'HOLD_EXPIRED' | 'MISSED' | 'INVALIDATED';

export type TelegramV3FollowupEntry = {
  key: string;
  market: SignalMessageMarket;
  symbol: string;
  name: string | null;
  direction: SignalMessageDirection;
  timeframe: string;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  targets: number[];
  chatId: string;
  messageId: number;
  messageKind: TelegramMessageKind;
  baseText: string;
  chartButton: TelegramUrlButton | null;
  announcedAt: string;
  entryUntil: string;
  holdUntil: string;
  entered: boolean;
  reachedTargets: number[];
  buyButtonRemoved: boolean;
  closed: { reason: TelegramV3FollowupClose; at: string } | null;
};

export type TelegramV3SignalAnnouncement = {
  key: string;
  market: SignalMessageMarket;
  symbol: string;
  name?: string | null;
  direction: SignalMessageDirection;
  timeframe: string;
  entryZone: { from: number; to: number };
  stopLoss: number;
  targets: number[];
  chatId: string;
  receipt: { messageId: number | null; messageKind: TelegramMessageKind; renderedText: string };
  buttons?: TelegramUrlButton[][];
  /** Scanner card validity; defaults to 3 bars after the announcement. */
  entryExpiresAt?: string | null;
  announcedAt: Date;
};

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function validIso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validEntry(raw: any): raw is TelegramV3FollowupEntry {
  return raw && typeof raw === 'object'
    && typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= 1024
    && Object.prototype.hasOwnProperty.call(MARKET_LABEL, raw.market)
    && typeof raw.symbol === 'string' && /^[A-Za-z0-9.\-_/]{1,30}$/u.test(raw.symbol)
    && ['BUY', 'LONG', 'SHORT'].includes(raw.direction)
    && typeof raw.timeframe === 'string'
    && [raw.entryLow, raw.entryHigh, raw.stopLoss].every((v) => finitePositive(v) != null)
    && Array.isArray(raw.targets) && raw.targets.length > 0 && raw.targets.length <= 3
    && raw.targets.every((v: unknown) => finitePositive(v) != null)
    && typeof raw.chatId === 'string' && raw.chatId.length > 0
    && Number.isInteger(raw.messageId) && raw.messageId > 0
    && (raw.messageKind === 'TEXT' || raw.messageKind === 'PHOTO')
    && typeof raw.baseText === 'string'
    && [raw.announcedAt, raw.entryUntil, raw.holdUntil].every(validIso)
    && typeof raw.entered === 'boolean' && typeof raw.buyButtonRemoved === 'boolean'
    && Array.isArray(raw.reachedTargets)
    && raw.reachedTargets.every((i: unknown) => Number.isInteger(i) && Number(i) >= 0 && Number(i) < 3)
    && (raw.closed === null || (raw.closed && typeof raw.closed.reason === 'string' && validIso(raw.closed.at)));
}

/** Durable JSON ledger. Any unreadable state blocks follow-ups instead of guessing. */
export class TelegramV3FollowupStore {
  private entries: Map<string, TelegramV3FollowupEntry> | null = null;
  private blocked = false;
  constructor(private readonly file: string) {}

  async list(): Promise<TelegramV3FollowupEntry[]> {
    return [...(await this.load()).values()];
  }

  async upsert(entry: TelegramV3FollowupEntry, now: Date): Promise<void> {
    const current = await this.load();
    const next = new Map(current);
    for (const [key, item] of next) {
      if (item.closed && now.getTime() - Date.parse(item.closed.at) > CLOSED_RETENTION_MS) next.delete(key);
    }
    next.set(entry.key, entry);
    if (next.size > MAX_ENTRIES) {
      // Oldest closed entries go first; open signals are never dropped silently.
      const closed = [...next.values()].filter((item) => item.closed)
        .sort((a, b) => Date.parse(a.closed!.at) - Date.parse(b.closed!.at));
      while (next.size > MAX_ENTRIES && closed.length) next.delete(closed.shift()!.key);
      if (next.size > MAX_ENTRIES) throw this.block();
    }
    await this.write(next);
    this.entries = next;
  }

  private block(): Error {
    this.blocked = true;
    logger.warn({ code: STATE_ERROR }, 'Telegram V3 follow-up state unavailable; follow-ups paused');
    return new Error(STATE_ERROR);
  }

  private async load(): Promise<Map<string, TelegramV3FollowupEntry>> {
    if (this.blocked) throw new Error(STATE_ERROR);
    if (this.entries) return this.entries;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.entries = new Map();
        return this.entries;
      }
      throw this.block();
    }
    try {
      if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error(STATE_ERROR);
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES
        || !data.entries.every(validEntry)) throw new Error(STATE_ERROR);
      this.entries = new Map((data.entries as TelegramV3FollowupEntry[]).map((item) => [item.key, item]));
      return this.entries;
    } catch {
      throw this.block();
    }
  }

  private async write(entries: Map<string, TelegramV3FollowupEntry>): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      const fd = await open(temp, fileConstants.O_WRONLY | fileConstants.O_CREAT
        | fileConstants.O_TRUNC | fileConstants.O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(`${JSON.stringify({ version: 1, entries: [...entries.values()] })}\n`, 'utf8');
        await fd.sync();
      } finally { await fd.close(); }
      await rename(temp, this.file);
    } catch {
      throw this.block();
    }
  }
}

let defaultStore: TelegramV3FollowupStore | null = null;
function telegramV3FollowupStore(): TelegramV3FollowupStore {
  defaultStore ??= new TelegramV3FollowupStore(
    process.env.TELEGRAM_V3_FOLLOWUP_STATE_PATH?.trim()
      || path.resolve(process.cwd(), '.runtime/telegram-v3-signal-followup.json'),
  );
  return defaultStore;
}

/**
 * Called once Telegram accepted a v2 signal message. Without a message id the
 * button cannot be removed later, so the signal is not tracked at all.
 */
export async function recordTelegramV3SignalAnnounced(
  input: TelegramV3SignalAnnouncement,
  store: TelegramV3FollowupStore = telegramV3FollowupStore(),
): Promise<boolean> {
  const messageId = input.receipt?.messageId;
  const from = finitePositive(input.entryZone?.from);
  const to = finitePositive(input.entryZone?.to);
  const stop = finitePositive(input.stopLoss);
  const targets = (input.targets ?? []).map(finitePositive).filter((v): v is number => v != null).slice(0, 3);
  const at = input.announcedAt.getTime();
  if (!Number.isInteger(messageId) || Number(messageId) <= 0 || from == null || to == null
    || stop == null || !targets.length || !Number.isFinite(at)) return false;
  const bar = barMs(input.timeframe);
  const cardExpiry = Date.parse(input.entryExpiresAt ?? '');
  const entryUntil = Number.isFinite(cardExpiry) && cardExpiry > at ? cardExpiry : at + TELEGRAM_V3_FOLLOWUP_ENTRY_BARS * bar;
  const chartButton = (input.buttons ?? []).flat().find((button) => button.text.includes('차트')) ?? null;
  const entry: TelegramV3FollowupEntry = {
    key: input.key,
    market: input.market,
    symbol: input.symbol,
    name: input.name?.trim() || null,
    direction: input.direction,
    timeframe: input.timeframe,
    entryLow: Math.min(from, to),
    entryHigh: Math.max(from, to),
    stopLoss: stop,
    targets,
    chatId: input.chatId,
    messageId: Number(messageId),
    messageKind: input.receipt.messageKind,
    baseText: input.receipt.renderedText,
    chartButton,
    announcedAt: new Date(at).toISOString(),
    entryUntil: new Date(entryUntil).toISOString(),
    holdUntil: new Date(Math.max(entryUntil, at + TELEGRAM_V3_FOLLOWUP_HOLD_BARS * bar)).toISOString(),
    entered: false,
    reachedTargets: [],
    buyButtonRemoved: false,
    closed: null,
  };
  if (!validEntry(entry)) return false;
  await store.upsert(entry, input.announcedAt);
  return true;
}

function favourable(direction: SignalMessageDirection, price: number, level: number): boolean {
  return direction === 'SHORT' ? price <= level : price >= level;
}

function entryRef(entry: TelegramV3FollowupEntry): number {
  return (entry.entryLow + entry.entryHigh) / 2;
}

function movePercent(entry: TelegramV3FollowupEntry, price: number): string {
  const ref = entryRef(entry);
  const move = entry.direction === 'SHORT' ? ((ref - price) / ref) * 100 : ((price - ref) / ref) * 100;
  return `${move >= 0 ? '+' : ''}${move.toFixed(1)}%`;
}

function displayName(entry: TelegramV3FollowupEntry): string {
  return entry.name ? `${entry.name} (${entry.symbol})` : entry.symbol;
}

const CLOSE_LABEL: Record<TelegramV3FollowupClose, string> = {
  TARGET_DONE: '마지막 목표 도달',
  STOP: '손절가 도달',
  ENTRY_EXPIRED: '진입 시간 지남 (진입가에 오지 않음)',
  HOLD_EXPIRED: '보유 기간 끝남',
  MISSED: '진입가에 오기 전에 1차 목표를 넘음',
  INVALIDATED: '진입가에 오기 전에 손절가를 넘음',
};

const CLOSE_ICON: Record<TelegramV3FollowupClose, string> = {
  TARGET_DONE: '🏁', STOP: '🛑', ENTRY_EXPIRED: '⌛', HOLD_EXPIRED: '⌛', MISSED: '⏭️', INVALIDATED: '⛔',
};

type Step =
  | { kind: 'TARGET'; index: number }
  | { kind: 'ENTRY_WINDOW_OVER' }
  | { kind: 'CLOSE'; reason: TelegramV3FollowupClose };

/** Pure: what the latest mark means for this signal. Order: stop, targets, time. */
export function telegramV3FollowupSteps(entry: TelegramV3FollowupEntry, price: number | null, nowMs: number): {
  next: TelegramV3FollowupEntry; steps: Step[];
} {
  const next: TelegramV3FollowupEntry = { ...entry, reachedTargets: [...entry.reachedTargets] };
  const steps: Step[] = [];
  if (next.closed) return { next, steps };
  const close = (reason: TelegramV3FollowupClose) => {
    next.closed = { reason, at: new Date(nowMs).toISOString() };
    steps.push({ kind: 'CLOSE', reason });
  };
  const short = next.direction === 'SHORT';
  if (price != null) {
    const stopHit = short ? price >= next.stopLoss : price <= next.stopLoss;
    const inZone = short ? price >= next.entryLow : price <= next.entryHigh;
    if (!next.entered && inZone && !stopHit && !favourable(next.direction, price, next.targets[0])
      && Date.parse(next.entryUntil) >= nowMs) next.entered = true;
    if (stopHit) {
      close(next.entered ? 'STOP' : 'INVALIDATED');
      return { next, steps };
    }
    if (!next.entered) {
      if (favourable(next.direction, price, next.targets[0])) {
        close('MISSED');
        return { next, steps };
      }
    } else {
      for (let index = 0; index < next.targets.length; index += 1) {
        if (next.reachedTargets.includes(index) || !favourable(next.direction, price, next.targets[index])) continue;
        next.reachedTargets.push(index);
        if (index === next.targets.length - 1) {
          close('TARGET_DONE');
          return { next, steps };
        }
        steps.push({ kind: 'TARGET', index });
      }
    }
  }
  if (!next.entered && Date.parse(next.entryUntil) < nowMs) {
    close('ENTRY_EXPIRED');
  } else if (Date.parse(next.holdUntil) < nowMs) {
    close('HOLD_EXPIRED');
  } else if (next.entered && !next.buyButtonRemoved && Date.parse(next.entryUntil) < nowMs) {
    // Entry window over while the trade is open: no new buys from the old message.
    steps.push({ kind: 'ENTRY_WINDOW_OVER' });
  }
  return { next, steps };
}

function followupText(entry: TelegramV3FollowupEntry, step: Step, price: number | null, nowMs: number): string {
  const fmt = (value: number) => formatSignalPrice(value, entry.market);
  const head = `[${MARKET_LABEL[entry.market]}] ${displayName(entry)}`;
  const priceLine = price != null ? `현재가 ${fmt(price)} (진입 기준 ${movePercent(entry, price)})` : null;
  const time = `🕒 ${kstLabel(new Date(nowMs).toISOString()) ?? ''} 기준`;
  if (step.kind === 'TARGET') {
    const sellVerb = entry.direction === 'SHORT' ? '숏 정리' : '매도';
    return [
      `🎯 ${head} · ${step.index + 1}차 목표 도달`,
      `목표 ${fmt(entry.targets[step.index])}`,
      priceLine,
      `계획: ${step.index + 1}차 ${sellVerb} 구간이에요.`,
      '🔒 알림만 보내요. 주문은 앱에서 직접 확인 후 진행돼요.',
      time,
    ].filter(Boolean).join('\n');
  }
  if (step.kind === 'CLOSE') {
    return [
      `${CLOSE_ICON[step.reason]} ${head} · 신호 종료`,
      `사유: ${CLOSE_LABEL[step.reason]}`,
      priceLine,
      '처음 메시지의 [구매] 버튼은 지웠어요.',
      time,
    ].filter(Boolean).join('\n');
  }
  return '';
}

function editedBaseText(entry: TelegramV3FollowupEntry, step: Step, nowMs: number): string {
  const when = kstLabel(new Date(nowMs).toISOString()) ?? '';
  const line = step.kind === 'CLOSE'
    ? `${CLOSE_ICON[step.reason]} 종료: ${CLOSE_LABEL[step.reason]} · ${when}`
    : `⌛ 진입 시간 끝남 · 새 주문 금지 · 목표·손절은 계속 알려드려요 · ${when}`;
  return `<b>${escapeTelegramHtml(line)}</b>\n\n${entry.baseText}`;
}

export type TelegramV3FollowupDeps = {
  store?: TelegramV3FollowupStore;
  readMark?: (market: SignalMessageMarket, symbol: string) => Promise<MemberAutoTradingMarketMark>;
  send?: (input: TelegramAlertInput) => Promise<TelegramAlertResult>;
  edit?: typeof editTelegramMessage;
};

export type TelegramV3FollowupRunResult = {
  open: number; checked: number; sent: number; edited: number; closed: number; failed: number;
};

export async function runTelegramV3SignalFollowupOnce(
  now = new Date(),
  deps: TelegramV3FollowupDeps = {},
): Promise<TelegramV3FollowupRunResult> {
  const store = deps.store ?? telegramV3FollowupStore();
  const readMark = deps.readMark ?? readMemberAutoTradingMarketMark;
  const send = deps.send ?? sendTelegramAlert;
  const edit = deps.edit ?? editTelegramMessage;
  const result: TelegramV3FollowupRunResult = { open: 0, checked: 0, sent: 0, edited: 0, closed: 0, failed: 0 };
  const open = (await store.list()).filter((entry) => !entry.closed);
  result.open = open.length;
  for (const entry of open) {
    let price: number | null = null;
    try {
      price = finitePositive((await readMark(entry.market, entry.symbol)).price);
      result.checked += 1;
    } catch {
      // No fresh mark (market closed, provider down): only time rules apply.
    }
    const { next, steps } = telegramV3FollowupSteps(entry, price, now.getTime());
    if (!steps.length) {
      if (next.entered !== entry.entered) await store.upsert(next, now);
      continue;
    }
    const removesButton = steps.find((step) => step.kind === 'CLOSE' || step.kind === 'ENTRY_WINDOW_OVER');
    if (removesButton) next.buyButtonRemoved = true;
    // Persist first: a crash after this point may lose a follow-up, never repeat one.
    await store.upsert(next, now);
    for (const step of steps) {
      if (step.kind === 'ENTRY_WINDOW_OVER') continue;
      const [title, ...details] = followupText(next, step, price, now.getTime()).split('\n');
      try {
        const sent = await send({
          type: 'intelligence_report',
          title,
          details: details.join('\n'),
          destinationChatId: next.chatId,
          dedupeKey: `telegram-v3-followup:${next.key}:${step.kind}:${step.kind === 'TARGET' ? step.index : step.kind === 'CLOSE' ? step.reason : ''}`,
          duplicateWindowMs: 14 * 24 * 60 * 60_000,
          cooldownMs: 0,
        });
        if (sent.ok) result.sent += 1; else result.failed += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (removesButton && !entry.buyButtonRemoved) {
      try {
        const edited = await edit({
          destinationChatId: next.chatId,
          messageId: next.messageId,
          messageKind: next.messageKind,
          text: editedBaseText(next, removesButton, now.getTime()),
          buttons: next.chartButton ? [[next.chartButton]] : [],
        });
        if (edited.ok) result.edited += 1; else result.failed += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (next.closed) result.closed += 1;
  }
  return result;
}

let followupRunning = false;

/** Started by the Signal V3 subscriber, in the same Telegram owner process. */
export function startTelegramV3SignalFollowup(deps: TelegramV3FollowupDeps = {}): { stop(): void } {
  const tick = async () => {
    if (followupRunning) return;
    followupRunning = true;
    try {
      const result = await runTelegramV3SignalFollowupOnce(new Date(), deps);
      if (result.sent || result.edited || result.failed) {
        logger.info(result, 'Telegram V3 signal follow-up tick');
      }
    } catch (error) {
      logger.warn({ code: error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'TELEGRAM_V3_FOLLOWUP_TICK_FAILED' },
        'Telegram V3 signal follow-up tick failed');
    } finally {
      followupRunning = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
