import type { TelegramTransport, TelegramTransportResult } from './user-broker-telegram.types';
import { normalizeTelegramReadableText } from '../../services/telegram-readable-format.service';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 5_000;

export class HttpUserTelegramTransport implements TelegramTransport {
  constructor(private readonly botToken: string) {
    if (!botToken.trim()) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
  }

  async send(chatId: string, text: string): Promise<TelegramTransportResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${encodeURIComponent(this.botToken)}/sendMessage`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: normalizeTelegramReadableText(text),
          disable_web_page_preview: true,
          protect_content: true,
        }),
        signal: controller.signal,
      });
      // A 5xx/transport failure can occur after Telegram accepted POST.
      // Retrying an unknown result can produce an unintended second message.
      if (!response.ok) return { ok: false, errorCode: response.status >= 500
        ? 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' : `TELEGRAM_HTTP_${response.status}` };
      const payload = await response.json() as {
        ok?: unknown; result?: { message_id?: unknown };
      };
      const id = payload?.result?.message_id;
      return payload?.ok === true && typeof id === 'number'
        && Number.isSafeInteger(id) && id > 0
        ? { ok: true }
        : { ok: false, errorCode: payload?.ok === true
          ? 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' : 'TELEGRAM_API_REJECTED' };
    } catch {
      return { ok: false, errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
