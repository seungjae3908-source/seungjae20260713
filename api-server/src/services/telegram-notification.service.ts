import { createHash } from 'node:crypto';
import { logger } from '../lib/logger';
import { normalizeTelegramReadableText } from './telegram-readable-format.service';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 2_000;
const DEFAULT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const TELEGRAM_TEXT_LIMIT = 4_096;
const TELEGRAM_CAPTION_LIMIT = 1_024;

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

export type TelegramUrlButton = {
  text: string;
  url: string;
};

export type TelegramPhotoAttachment = {
  bytes?: Uint8Array;
  url?: string;
  filename?: string;
};

export interface TelegramAlertInput {
  type: TelegramAlertType;
  title?: string;
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
  linkPreview?: boolean;
  buttons?: TelegramUrlButton[][];
  photo?: TelegramPhotoAttachment;
}

export type TelegramAlertResult =
  | { ok: true; attempts: number }
  | {
      ok: false;
      attempts: number;
      skipped: 'NOT_CONFIGURED' | 'DUPLICATE' | 'COOLDOWN' | 'DELIVERY_FAILED';
    };

export type TelegramMessageKind = 'TEXT' | 'PHOTO';

export type TelegramDeliveryReceipt = {
  messageId: number | null;
  messageKind: TelegramMessageKind;
  renderedText: string;
};

export type TelegramTrackedAlertResult =
  | { ok: true; attempts: number; receipt: TelegramDeliveryReceipt }
  | {
      ok: false;
      attempts: number;
      skipped: 'NOT_CONFIGURED' | 'DUPLICATE' | 'COOLDOWN' | 'DELIVERY_FAILED';
    };

type TelegramSendResponse = {
  ok?: unknown;
  result?: {
    message_id?: unknown;
  };
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
      return '🟢 매수 신호';
    case 'strong_sell':
      return '🔴 강한매도 신호';
    case 'crypto_spot_buy':
      return '🟢 매수 신호';
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

function escapedPrefix(text: string, budget: number): string {
  let result = '';
  for (const codePoint of text) {
    const piece = escapeTelegramHtml(codePoint);
    if (result.length + piece.length > budget) break;
    result += piece;
  }
  return result;
}

/** Respect the 4096-char Telegram HTML limit without cutting entities or tags. */
function boundedTelegramHtmlLines(lines: readonly { text: string; bold?: boolean }[]): string {
  let result = '';
  for (const line of lines) {
    const separator = result ? '\n' : '';
    const escaped = escapeTelegramHtml(line.text);
    const formatted = line.bold ? '<b>' + escaped + '</b>' : escaped;
    if (result.length + separator.length + formatted.length <= TELEGRAM_TEXT_LIMIT) {
      result += separator + formatted;
      continue;
    }
    const budget = TELEGRAM_TEXT_LIMIT - result.length - separator.length - (line.bold ? 7 : 0) - 1;
    if (budget > 0) {
      const shortened = escapedPrefix(line.text, budget);
      if (shortened) result += separator + (line.bold ? '<b>' + shortened + '…</b>' : shortened + '…');
    }
    break;
  }
  return result.trimEnd();
}

export function renderTelegramAlert(input: TelegramAlertInput): string {
  const customTitle = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 180)
    : null;
  const lines: Array<{ text: string; bold?: boolean }> = [
    { text: customTitle || titleForType(input.type), bold: true },
    { text: '' },
  ];
  if (!customTitle && input.symbol) {
    lines.push({ text: input.symbol + (input.market ? ' · ' + input.market : '') });
  }
  if (input.provider) lines.push({ text: input.provider });
  const currentPrice = formatNumber(input.currentPrice);
  if (currentPrice) lines.push({ text: '현재가 ' + currentPrice });
  const targetPrice = formatNumber(input.targetPrice);
  if (targetPrice) lines.push({ text: '기준가 ' + targetPrice });

  const details = normalizeTelegramReadableText(input.details);
  if (details) {
    if (lines.at(-1)?.text !== '') lines.push({ text: '' });
    for (const line of details.split('\n')) {
      lines.push({ text: line, bold: /^\[[^\]\n]{1,72}\]/u.test(line) });
    }
  }
  if (input.timestamp && !customTitle) {
    lines.push({ text: '' }, { text: input.timestamp });
  }
  return boundedTelegramHtmlLines(lines);
}

export function normalizeTelegramHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function telegramInlineKeyboard(buttons: TelegramAlertInput['buttons']): { inline_keyboard: TelegramUrlButton[][] } | null {
  if (!Array.isArray(buttons)) return null;
  const rows = buttons.slice(0, 8).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const safe = row.slice(0, 3).flatMap((button) => {
      const text = String(button?.text ?? '').normalize('NFKC').trim().slice(0, 64);
      const url = normalizeTelegramHttpUrl(button?.url);
      return text && url ? [{ text, url }] : [];
    });
    return safe.length ? [safe] : [];
  });
  return rows.length ? { inline_keyboard: rows } : null;
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

function safePhoto(input: TelegramPhotoAttachment | undefined): TelegramPhotoAttachment | null {
  if (!input) return null;
  if (input.bytes instanceof Uint8Array && input.bytes.byteLength > 0 && input.bytes.byteLength <= 10 * 1024 * 1024) {
    return { bytes: input.bytes, filename: input.filename?.trim().slice(0, 80) || 'signal-evidence.png' };
  }
  const url = normalizeTelegramHttpUrl(input.url);
  return url ? { url } : null;
}

async function sendOnce(
  botToken: string,
  destination: string,
  text: string,
  input: TelegramAlertInput,
  attempt: number,
): Promise<{
  delivered: boolean;
  attempts: number;
  messageId: number | null;
  messageKind: TelegramMessageKind;
  renderedText: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const keyboard = telegramInlineKeyboard(input.buttons);
    // Preserve full plans and news. A long rich alert becomes TEXT instead
    // of silently losing everything after Telegram's 1024-char photo caption.
    const photo = text.length <= TELEGRAM_CAPTION_LIMIT ? safePhoto(input.photo) : null;
    const messageKind: TelegramMessageKind = photo ? 'PHOTO' : 'TEXT';
    const renderedText = text;
    const endpoint = photo ? 'sendPhoto' : 'sendMessage';
    let body: BodyInit;
    let headers: HeadersInit;

    if (photo?.bytes) {
      const form = new FormData();
      form.append('chat_id', destination);
      form.append('caption', renderedText);
      form.append('parse_mode', 'HTML');
      form.append('protect_content', 'true');
      if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
      const bytes = Buffer.from(photo.bytes);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.append('photo', new Blob([arrayBuffer], { type: 'image/png' }), photo.filename || 'signal-evidence.png');
      body = form;
      headers = { Accept: 'application/json' };
    } else {
      const payload: Record<string, unknown> = photo?.url
        ? {
            chat_id: destination,
            photo: photo.url,
            caption: renderedText,
            parse_mode: 'HTML',
            protect_content: true,
          }
        : {
            chat_id: destination,
            text: renderedText,
            parse_mode: 'HTML',
            protect_content: true,
            link_preview_options: { is_disabled: input.linkPreview !== true },
          };
      if (keyboard) payload.reply_markup = keyboard;
      body = JSON.stringify(payload);
      headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    }

    const response = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${encodeURIComponent(botToken)}/${endpoint}`,
      { method: 'POST', headers, body, signal: controller.signal },
    );

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const delay = retryDelay(response, attempt);
      clearTimeout(timeout);
      await sleep(delay);
      return sendOnce(botToken, destination, text, input, attempt + 1);
    }
    if (!response.ok) {
      return {
        delivered: false,
        attempts: attempt + 1,
        messageId: null,
        messageKind,
        renderedText,
      };
    }

    let result: TelegramSendResponse;
    try {
      result = (await response.json()) as TelegramSendResponse;
    } catch {
      return {
        delivered: false,
        attempts: attempt + 1,
        messageId: null,
        messageKind,
        renderedText,
      };
    }
    const rawMessageId = result.result?.message_id;
    const messageId = typeof rawMessageId === 'number' && Number.isInteger(rawMessageId) && rawMessageId > 0
      ? rawMessageId
      : null;
    return {
      delivered: result.ok === true,
      attempts: attempt + 1,
      messageId,
      messageKind,
      renderedText,
    };
  } catch {
    if (attempt < MAX_RETRIES) {
      clearTimeout(timeout);
      await sleep(300 * (attempt + 1));
      return sendOnce(botToken, destination, text, input, attempt + 1);
    }
    return {
      delivered: false,
      attempts: attempt + 1,
      messageId: null,
      messageKind: text.length <= TELEGRAM_CAPTION_LIMIT && safePhoto(input.photo) ? 'PHOTO' : 'TEXT',
      renderedText: text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTelegramAlertWithReceipt(
  input: TelegramAlertInput,
): Promise<TelegramTrackedAlertResult> {
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
    const result = await sendOnce(botToken, destination, rendered, input, 0);
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
    return {
      ok: true,
      attempts: result.attempts,
      receipt: {
        messageId: result.messageId,
        messageKind: result.messageKind,
        renderedText: result.renderedText,
      },
    };
  } catch {
    logger.warn({ alertType: input.type }, 'telegram alert delivery failed');
    return { ok: false, attempts: 0, skipped: 'DELIVERY_FAILED' };
  } finally {
    inFlightHashes.delete(hash);
  }
}

export async function sendTelegramAlert(
  input: TelegramAlertInput,
): Promise<TelegramAlertResult> {
  const result = await sendTelegramAlertWithReceipt(input);
  return result.ok
    ? { ok: true, attempts: result.attempts }
    : result;
}

/**
 * Keep Telegram HTML entities and formatting tags whole when editing a long
 * signal. A raw slice can end inside <b>, </b>, or &amp; and reject the edit,
 * leaving obsolete order buttons on the old Telegram message.
 */
function boundedTelegramEditHtml(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tokens = text.match(/<[^<>]*>|&(?:[a-z]+|#[0-9]+|#x[0-9a-f]+);|[\s\S]/giu) ?? [];
  const openTags: string[] = [];
  let result = '';

  for (const token of tokens) {
    const opening = /^<(b|strong|i|em|u|s|strike|code|pre|a)(?:\s[^<>]*)?>$/iu.exec(token);
    const closing = /^<\/(b|strong|i|em|u|s|strike|code|pre|a)>$/iu.exec(token);
    const nextOpen = [...openTags];
    if (opening) nextOpen.push(opening[1].toLowerCase());
    else if (closing && nextOpen.at(-1) === closing[1].toLowerCase()) nextOpen.pop();

    const closingCost = nextOpen.reduce((n, tag) => n + tag.length + 3, 0);
    if (result.length + token.length + closingCost + 1 > limit) break;
    result += token;
    openTags.splice(0, openTags.length, ...nextOpen);
  }
  const closings = [...openTags].reverse().map((tag) => '</' + tag + '>').join('');
  return result.trimEnd() + '…' + closings;
}

export async function editTelegramMessage(input: {
  destinationChatId: string;
  messageId: number;
  messageKind: TelegramMessageKind;
  text: string;
  buttons?: TelegramAlertInput['buttons'];
  linkPreview?: boolean;
}): Promise<TelegramAlertResult> {
  const botToken = token();
  const destination = input.destinationChatId.trim();
  if (!botToken || !destination || !Number.isInteger(input.messageId) || input.messageId <= 0) {
    return { ok: false, attempts: 0, skipped: 'NOT_CONFIGURED' };
  }

  const renderedText = boundedTelegramEditHtml(
    input.text,
    input.messageKind === 'PHOTO' ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT,
  );

  const run = async (attempt: number): Promise<TelegramAlertResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const endpoint = input.messageKind === 'PHOTO' ? 'editMessageCaption' : 'editMessageText';
      const payload: Record<string, unknown> = {
        chat_id: destination,
        message_id: input.messageId,
        parse_mode: 'HTML',
      };
      if (input.messageKind === 'PHOTO') payload.caption = renderedText;
      else {
        payload.text = renderedText;
        payload.link_preview_options = { is_disabled: input.linkPreview !== true };
      }
      // Explicit empty keyboard revokes a stale order link, including photo captions.
      if (input.buttons !== undefined) {
        payload.reply_markup = telegramInlineKeyboard(input.buttons) ?? { inline_keyboard: [] };
      }

      const response = await fetch(
        `${TELEGRAM_API_BASE_URL}/bot${encodeURIComponent(botToken)}/${endpoint}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const delay = retryDelay(response, attempt);
        clearTimeout(timeout);
        await sleep(delay);
        return run(attempt + 1);
      }
      if (!response.ok) return { ok: false, attempts: attempt + 1, skipped: 'DELIVERY_FAILED' };

      let result: TelegramSendResponse;
      try {
        result = (await response.json()) as TelegramSendResponse;
      } catch {
        return { ok: false, attempts: attempt + 1, skipped: 'DELIVERY_FAILED' };
      }
      return result.ok === true
        ? { ok: true, attempts: attempt + 1 }
        : { ok: false, attempts: attempt + 1, skipped: 'DELIVERY_FAILED' };
    } catch {
      if (attempt < MAX_RETRIES) {
        clearTimeout(timeout);
        await sleep(300 * (attempt + 1));
        return run(attempt + 1);
      }
      return { ok: false, attempts: attempt + 1, skipped: 'DELIVERY_FAILED' };
    } finally {
      clearTimeout(timeout);
    }
  };

  return run(0);
}
