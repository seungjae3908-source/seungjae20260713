import { createHash, randomUUID } from 'node:crypto';
import type { NotificationDeliveryState, TelegramTransport } from '../features/user-broker-telegram/user-broker-telegram.types';
import type { AiEvidenceSnapshot, FinalEvidenceDecision } from './profit-first-ai-evidence.service';

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export type ProfitTelegramDeliveryState = Extract<NotificationDeliveryState, 'PENDING' | 'SENT' | 'FAILED' | 'RETRY_SCHEDULED'>;
export interface ProfitTelegramDelivery {
  id: string; userId: string; signalId: string; dedupeKey: string; cooldownKey: string; state: ProfitTelegramDeliveryState;
  attempts: number; nextRetryAt: string | null; lastErrorCode: string | null; createdAt: string; updatedAt: string;
  message: string; chartImage: { mimeType: string; base64: string } | null;
}
export interface ProfitTelegramOutbox {
  enqueue(delivery: ProfitTelegramDelivery): Promise<boolean>;
  claim(userId: string, id: string): Promise<ProfitTelegramDelivery | null>;
  finish(userId: string, id: string, patch: Partial<Pick<ProfitTelegramDelivery, 'state' | 'attempts' | 'nextRetryAt' | 'lastErrorCode' | 'updatedAt'>>): Promise<void>;
}
export interface ProfitTelegramTransport extends TelegramTransport {
  sendPhoto?(chatId: string, image: { mimeType: string; base64: string }, caption: string): Promise<{ ok: boolean; errorCode?: string | null }>;
}
export interface ProfitTelegramRecipient { userId: string; telegramChatId: string | null; enabled: boolean; }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const number = (value: number | null | undefined, suffix = '') => finite(value) ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}${suffix}` : '데이터 부족';
const sanitize = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
function buildTelegramDedupeKey(input: { userId: string; snapshot: AiEvidenceSnapshot }): string {
  const s = input.snapshot.signal;
  return createHash('sha256').update([input.userId, s.market, s.symbol, s.direction, s.strategyHorizon, s.signalId, s.strategyProfileVersion, 'FINAL_RECOMMENDATION'].join('|')).digest('hex');
}
export function buildTelegramCooldownKey(input: { userId: string; snapshot: AiEvidenceSnapshot }): string {
  const s = input.snapshot.signal;
  return createHash('sha256').update([input.userId, s.market, s.symbol, s.direction, s.strategyHorizon, 'FINAL_RECOMMENDATION'].join('|')).digest('hex');
}
export function renderProfitFirstTelegramReport(snapshot: AiEvidenceSnapshot): string {
  const s = snapshot.signal; const ai = snapshot.ai.validation; const news = snapshot.evidence.news.items; const disclosures = snapshot.evidence.disclosure.items;
  const lines = [`🚨 ${sanitize(s.symbolName || s.symbol)} | ${s.strategyHorizon} ${s.direction}`, '', `신호점수 ${number(s.signalScore, '점')}`];
  lines.push(`실제 수익확률 ${number(s.profitProbability, '%')}`, `과거 유사신호 ${Number.isFinite(s.profitSampleSize) ? `${s.profitSampleSize}건` : '데이터 부족'}`, `기대 순수익 ${number(s.expectedNetReturn, '%')}`, `손익비 ${number(s.riskReward)}`);
  lines.push('', `진입 ${number(s.entryPrice)}`, `목표1 ${number(s.target1)}`, `목표2 ${number(s.target2)}`, `손절 ${number(s.stopLoss)}`);
  lines.push('', '📈 기술 Evidence', sanitize(ai?.technicalAssessment ?? '데이터 부족'));
  lines.push('', '📰 뉴스', news.length ? sanitize(news.slice(0, 3).map((x) => x.title).join(' / ')) : '데이터 부족');
  lines.push('', '📢 공시', disclosures.length ? sanitize(disclosures.slice(0, 3).map((x) => x.reportName).join(' / ')) : '데이터 부족');
  lines.push('', '🤖 AI Validator', ai?.validationResult ?? snapshot.ai.status, '', '🛡 Risk Engine', sanitize(JSON.stringify(s.riskEngineResult ?? '데이터 부족')));
  lines.push('', '최종: BUY/SELL/LONG/SHORT 후보 — 수익을 보장하지 않음');
  return lines.join('\n');
}
export function splitTelegramText(text: string, limit = MAX_TEXT): readonly string[] {
  if (text.length <= limit) return Object.freeze([text]); const chunks: string[] = []; let remaining = text;
  while (remaining.length > limit) { let cut = remaining.lastIndexOf('\n', limit); if (cut < Math.floor(limit * 0.5)) cut = limit; chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).replace(/^\n+/, ''); }
  if (remaining) chunks.push(remaining); return Object.freeze(chunks);
}

export class InMemoryProfitTelegramOutbox implements ProfitTelegramOutbox {
  readonly rows = new Map<string, ProfitTelegramDelivery>(); readonly dedupe = new Set<string>();
  async enqueue(delivery: ProfitTelegramDelivery): Promise<boolean> { if (this.dedupe.has(delivery.dedupeKey)) return false; this.dedupe.add(delivery.dedupeKey); this.rows.set(delivery.id, Object.freeze({ ...delivery })); return true; }
  async claim(userId: string, id: string): Promise<ProfitTelegramDelivery | null> { const row = this.rows.get(id); return row?.userId === userId && (row.state === 'PENDING' || row.state === 'RETRY_SCHEDULED') ? row : null; }
  async finish(userId: string, id: string, patch: Partial<ProfitTelegramDelivery>): Promise<void> { const row = this.rows.get(id); if (row?.userId === userId) this.rows.set(id, Object.freeze({ ...row, ...patch })); }
}

export class ProfitFirstTelegramReportService {
  private readonly lastSentAt = new Map<string, number>();
  constructor(private readonly outbox: ProfitTelegramOutbox, private readonly transport: ProfitTelegramTransport, private readonly cooldownMs = DEFAULT_COOLDOWN_MS) {}
  async queue(input: { recipient: ProfitTelegramRecipient; decision: FinalEvidenceDecision; snapshot: AiEvidenceSnapshot; now?: Date }): Promise<{ queued: boolean; reason?: string; deliveryId?: string }> {
    if (input.decision !== 'FINAL_RECOMMENDATION') return { queued: false, reason: 'NOT_FINAL_RECOMMENDATION' };
    if (!input.recipient.enabled || !input.recipient.telegramChatId) return { queued: false, reason: 'NOT_CONFIGURED' };
    const now = input.now ?? new Date();
    const dedupeKey = buildTelegramDedupeKey({ userId: input.recipient.userId, snapshot: input.snapshot });
    const cooldownKey = buildTelegramCooldownKey({ userId: input.recipient.userId, snapshot: input.snapshot });
    const last = this.lastSentAt.get(cooldownKey); if (last != null && now.getTime() - last < this.cooldownMs) return { queued: false, reason: 'COOLDOWN' };
    const delivery: ProfitTelegramDelivery = { id: randomUUID(), userId: input.recipient.userId, signalId: input.snapshot.signal.signalId, dedupeKey, cooldownKey, state: 'PENDING', attempts: 0, nextRetryAt: null, lastErrorCode: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), message: renderProfitFirstTelegramReport(input.snapshot), chartImage: input.snapshot.evidence.chart.image };
    const queued = await this.outbox.enqueue(delivery); return queued ? { queued: true, deliveryId: delivery.id } : { queued: false, reason: 'DUPLICATE' };
  }
  async process(input: { recipient: ProfitTelegramRecipient; deliveryId: string; now?: Date }): Promise<{ processed: boolean; state: ProfitTelegramDeliveryState | null }> {
    const now = input.now ?? new Date(); const row = await this.outbox.claim(input.recipient.userId, input.deliveryId); if (!row || !input.recipient.telegramChatId) return { processed: false, state: null };
    let result: { ok: boolean; errorCode?: string | null }; let photoSent = false;
    try {
      if (row.chartImage && this.transport.sendPhoto) { result = await this.transport.sendPhoto(input.recipient.telegramChatId, row.chartImage, row.message.slice(0, MAX_CAPTION)); photoSent = result.ok; }
      else result = { ok: true };
      if (result.ok) { const chunks = splitTelegramText(photoSent ? row.message.slice(MAX_CAPTION) : row.message); for (const chunk of chunks) { if (!chunk) continue; result = await this.transport.send(input.recipient.telegramChatId, chunk); if (!result.ok) break; } }
    } catch { result = { ok: false, errorCode: 'TELEGRAM_TRANSPORT_ERROR' }; }
    const attempts = row.attempts + 1;
    if (result.ok) { await this.outbox.finish(row.userId, row.id, { state: 'SENT', attempts, nextRetryAt: null, lastErrorCode: null, updatedAt: now.toISOString() }); this.lastSentAt.set(row.cooldownKey, now.getTime()); return { processed: true, state: 'SENT' }; }
    const retryable = /429|5\d\d|TIMEOUT|TRANSPORT/.test(result.errorCode ?? ''); const state: ProfitTelegramDeliveryState = retryable && attempts < 3 ? 'RETRY_SCHEDULED' : 'FAILED'; const nextRetryAt = state === 'RETRY_SCHEDULED' ? new Date(now.getTime() + 30_000 * (2 ** (attempts - 1))).toISOString() : null;
    await this.outbox.finish(row.userId, row.id, { state, attempts, nextRetryAt, lastErrorCode: sanitize(result.errorCode || 'TELEGRAM_DELIVERY_FAILED').slice(0, 120), updatedAt: now.toISOString() }); return { processed: true, state };
  }
}
