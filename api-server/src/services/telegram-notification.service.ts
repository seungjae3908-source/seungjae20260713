import { createHash } from 'node:crypto';
import { logger } from '../lib/logger';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 2_000;
const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

export const TELEGRAM_ALERT_TYPES = [
  'strong_buy',
  'strong_sell',
  'crypto_spot_buy',
  'crypto_futures_long',
  'crypto_futures_short',
  'price_alert',
  'provider_outage',
  'system_critical',
  'intelligence_report',
] as const;

export type TelegramAlertType = (typeof TELEGRAM_ALERT_TYPES)[number];

export interface TelegramAlertInput {
  type: TelegramAlertType;
  symbol?: string;
  market?: string;
  provider?: string;
  currentPrice?: number;
  targetPrice?: number;
  details?: string;
  timestamp?: string;
  dedupeKey?: string;
  cooldownMs?: number;
  duplicateWindowMs?: number;
  destinationChatId?: string;
}

export type TelegramAlertResult =
  | { ok: true; attempts: number }
  | {
      ok: false;
      attempts: number;
      skipped: 'NOT_CONFIGURED' | 'DUPLICATE' | 'COOLDOWN' | 'DELIVERY_FAILED';
    };

type TelegramSendResponse = {
  ok?: unknown;
};

const deliveredAtByHash = new Map<string, number>();
const deliveredAtByCooldownKey = new Map<string, number>();
const inFlightHashes = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function defaultChatId(): string | null {
  return process.env.TELEGRAM_CHAT_ID?.trim() || null;
}

function destinationFor(input: TelegramAlertInput): string | null {
  return input.destinationChatId?.trim() || defaultChatId();
}

export function isTelegramConfigured(): boolean {
  return Boolean(token() && defaultChatId());
}

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function titleForType(type: TelegramAlertType): string {
  switch (type) {
    case 'strong_buy':
      return '🟢 강한매수 신호';
    case 'strong_sell':
      return '🔴 강한매도 신호';
    case 'crypto_spot_buy':
      return '🟢 코인현물 매수 신호';
    case 'crypto_futures_long':
      return '🟦 코인선물 LONG 신호';
    case 'crypto_futures_short':
      return '🟧 코인선물 SHORT 신호';
    case 'price_alert':
      return '🔔 가격 알림';
    case 'provider_outage':
      return '⚠️ 데이터 Provider 장애';
    case 'system_critical':
      return '🚨 시스템 중요 경고';
    case 'intelligence_report':
      return '📊 투자 인텔리전스 리포트';
  }
}

export function renderTelegramAlert(input: TelegramAlertInput): string {
  const lines = [`<b>${escapeTelegramHtml(titleForType(input.type))}</b>`];
  if (input.symbol) lines.push(`종목: <code>${escapeTelegramHtml(input.symbol)}</code>`);
  if (input.market) lines.push(`시장: ${escapeTelegramHtml(input.market)}`);
  if (input.provider) lines.push(`Provider: ${escapeTelegramHtml(input.provider)}`);

  const currentPrice = formatNumber(input.currentPrice);
  if (currentPrice) lines.push(`현재가: ${escapeTelegramHtml(currentPrice)}`);
  const targetPrice = formatNumber(input.targetPrice);
  if (targetPrice) lines.push(`기준가: ${escapeTelegramHtml(targetPrice)}`);

  if (input.details) lines.push(`내용: ${escapeTelegramHtml(input.details)}`);
  if (input.timestamp) lines.push(`시각: ${escapeTelegramHtml(input.timestamp)}`);
  lines.push('실주문 실행 기능은 포함되지 않습니다.');
  return lines.join('\n');
}

function normalizeWindow(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.trunc(value)));
}

function hashFor(input: TelegramAlertInput, rendered: string, destination: string): string {
  const source = `${destination}:${input.dedupeKey?.trim() || rendered}`;
  return createHash('sha256').update(source).digest('hex');
}

function cooldownKeyFor(input: TelegramAlertInput, destination: string): string {
  const subject = input.symbol?.trim().toUpperCase()
    || input.provider?.trim().toLowerCase()
    || 'global';
  return `${destination}:${input.type}:${subject}`;
}

function prune(now: number): void {
  const oldest = now - 24 * 60 * 60 * 1000;
  for (const [key, value] of deliveredAtByHash) {
    if (value < oldest) deliveredAtByHash.delete(key);
  }
  for (const [key, value] of deliveredAtByCooldownKey) {
    if (value < oldest) deliveredAtByCooldownKey.delete(key);
  }
}

export function clearTelegramAlertState(): void {
  deliveredAtByHash.clear();
  deliveredAtByCooldownKey.clear();
  inFlightHashes.clear();
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  const seconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000));
  }
  return Math.min(MAX_RETRY_DELAY_MS, 300 * (attempt + 1));
}

async function sendOnce(
  botToken: string,
  destination: string,
  text: string,
  attempt: number,
): Promise<{ delivered: boolean; attempts: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${encodeURIComponent(botToken)}/sendMessage`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: destination,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const delay = retryDelay(response, attempt);
      clearTimeout(timeout);
      await sleep(delay);
      return sendOnce(botToken, destination, text, attempt + 1);
    }
    if (!response.ok) return { delivered: false, attempts: attempt + 1 };

    let result: TelegramSendResponse;
    try {
      result = (await response.json()) as TelegramSendResponse;
    } catch {
      return { delivered: false, attempts: attempt + 1 };
    }
    return { delivered: result.ok === true, attempts: attempt + 1 };
  } catch {
    if (attempt < MAX_RETRIES) {
      clearTimeout(timeout);
      await sleep(300 * (attempt + 1));
      return sendOnce(botToken, destination, text, attempt + 1);
    }
    return { delivered: false, attempts: attempt + 1 };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTelegramAlert(
  input: TelegramAlertInput,
): Promise<TelegramAlertResult> {
  const botToken = token();
  const destination = destinationFor(input);
  if (!botToken || !destination) {
    return { ok: false, attempts: 0, skipped: 'NOT_CONFIGURED' };
  }

  const rendered = renderTelegramAlert(input);
  const hash = hashFor(input, rendered, destination);
  const cooldownKey = cooldownKeyFor(input, destination);
  const now = Date.now();
  prune(now);

  const duplicateWindowMs = normalizeWindow(
    input.duplicateWindowMs,
    DEFAULT_DUPLICATE_WINDOW_MS,
  );
  const cooldownMs = normalizeWindow(input.cooldownMs, DEFAULT_COOLDOWN_MS);
  const lastDuplicate = deliveredAtByHash.get(hash);
  if (
    inFlightHashes.has(hash)
    || (lastDuplicate != null && now - lastDuplicate < duplicateWindowMs)
  ) {
    return { ok: false, attempts: 0, skipped: 'DUPLICATE' };
  }

  const lastCooldown = deliveredAtByCooldownKey.get(cooldownKey);
  if (lastCooldown != null && now - lastCooldown < cooldownMs) {
    return { ok: false, attempts: 0, skipped: 'COOLDOWN' };
  }

  inFlightHashes.add(hash);
  try {
    const result = await sendOnce(botToken, destination, rendered, 0);
    if (!result.delivered) {
      logger.warn(
        { alertType: input.type, attempts: result.attempts },
        'telegram alert delivery failed',
      );
      return {
        ok: false,
        attempts: result.attempts,
        skipped: 'DELIVERY_FAILED',
      };
    }

    const deliveredAt = Date.now();
    deliveredAtByHash.set(hash, deliveredAt);
    deliveredAtByCooldownKey.set(cooldownKey, deliveredAt);
    return { ok: true, attempts: result.attempts };
  } catch {
    logger.warn({ alertType: input.type }, 'telegram alert delivery failed');
    return { ok: false, attempts: 0, skipped: 'DELIVERY_FAILED' };
  } finally {
    inFlightHashes.delete(hash);
  }
}
