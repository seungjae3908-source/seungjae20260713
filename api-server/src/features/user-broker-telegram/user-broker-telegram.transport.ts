import type { TelegramTransport, TelegramTransportResult } from './user-broker-telegram.types';

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
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, errorCode: `TELEGRAM_HTTP_${response.status}` };
      const payload = await response.json() as { ok?: unknown };
      return payload.ok === true ? { ok: true } : { ok: false, errorCode: 'TELEGRAM_API_REJECTED' };
    } catch {
      return { ok: false, errorCode: 'TELEGRAM_NETWORK_ERROR' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
