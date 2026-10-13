import path from 'node:path';
import { answerAiChat } from './ai-chat.service';
import { FileTelegramIntelligenceStateStore, type TelegramIntelligenceStateStore } from './telegram-intelligence-worker.service';
import { boundedTelegramV3Json, validTelegramV3CurrentSource } from './telegram-v3-current-source.service';
import { aiWatchDurableKey, sendAiWatchWithDurableReceipt } from './telegram-ai-watch-delivery.service';
import { sendTelegramAlert } from './telegram-notification.service';
import { logger } from '../lib/logger';
import { telegramMarketRoomForLane, telegramMarketRoomChatId } from './telegram-market-room.service';

const SIGNAL_URL = 'http://127.0.0.1:8790/v1/signals';
const RESCAN_URL = 'http://127.0.0.1:8790/internal/rescan';
const DEFAULT_INTERVAL_MS = 120_000;
const REVIEW_TTL_MS = 30 * 60_000;
const MAX_REVIEWS_PER_TICK = 3;

type WatchEvent = {
  type: 'NEW_CANDIDATE' | 'RESCAN_REQUESTED' | 'STATE_CHANGED';
  id: string;
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  symbol: string;
  strategy: string;
  timeframe: string;
  direction: 'BUY' | 'LONG' | 'SHORT' | null;
  state?: string;
  validationTier?: string;
};

type WatchEnvelope = {
  ok: true;
  serviceSha: string;
  executionAuthority: 'NONE';
  snapshot: {
    serviceSha: string;
    generatedAt: string;
    publicDataOnly: true;
    safety: { executionAuthority: 'NONE'; privateTradingApiAllowed: false; realOrderAllowed: false };
    events: WatchEvent[];
  };
};

type AiWatchResult = {
  catalyst: 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NONE';
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  technicalChange: 'BREAKOUT' | 'BREAKDOWN' | 'FAILED_BREAKOUT' | 'VOLUME_ANOMALY' | 'VOLATILITY_EXPANSION' | 'NONE';
  contradiction: boolean;
  risks: string[];
  reason: string;
};

function boundedInterval(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(60_000, Math.min(900_000, Math.trunc(parsed))) : DEFAULT_INTERVAL_MS;
}

function aiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY?.trim()
    || process.env.GOOGLE_API_KEY?.trim()
    || process.env.GROQ_API_KEY?.trim()
    || process.env.AI_CHAT_API_KEY?.trim(),
  );
}

function contextFor(event: WatchEvent): { market: 'KR' | 'US' | 'UPBIT' | 'BITGET'; symbol: string } | null {
  if (event.market === 'KR_STOCK') return { market: 'KR', symbol: event.symbol };
  if (event.market === 'US_STOCK') return { market: 'US', symbol: event.symbol };
  if (event.market === 'CRYPTO_SPOT') return { market: 'UPBIT', symbol: event.symbol };
  if (event.market === 'CRYPTO_FUTURES') return { market: 'BITGET', symbol: event.symbol };
  return null;
}

function parseAiJson(answer: string): AiWatchResult | null {
  const match = answer.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const row = JSON.parse(match[0]) as Partial<AiWatchResult>;
    if (!['POSITIVE', 'NEGATIVE', 'MIXED', 'NONE'].includes(String(row.catalyst))) return null;
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(String(row.impact))) return null;
    if (!['BREAKOUT', 'BREAKDOWN', 'FAILED_BREAKOUT', 'VOLUME_ANOMALY', 'VOLATILITY_EXPANSION', 'NONE'].includes(String(row.technicalChange))) return null;
    if (typeof row.contradiction !== 'boolean') return null;
    return {
      catalyst: row.catalyst as AiWatchResult['catalyst'],
      impact: row.impact as AiWatchResult['impact'],
      technicalChange: row.technicalChange as AiWatchResult['technicalChange'],
      contradiction: row.contradiction,
      risks: Array.isArray(row.risks) ? row.risks.map(String).slice(0, 5) : [],
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 500) : '',
    };
  } catch {
    return null;
  }
}

function materialChange(result: AiWatchResult): boolean {
  return result.impact === 'HIGH' || result.contradiction || result.technicalChange !== 'NONE';
}

function destination(event: WatchEvent): string | null {
  // Never collapse distinct four-market signals into legacy stock/crypto rooms.
  return telegramMarketRoomChatId(telegramMarketRoomForLane(event.market));
}

function watchPrompt(event: WatchEvent): string {
  return [
    '공개 데이터 감시 전용 분석입니다. 주문·자동매매·레버리지 변경·매매 지시는 하지 마세요.',
    '최근 공개 뉴스/이벤트와 현재 가격·기술 변화에서 기존 정량 후보를 즉시 다시 계산해야 할 새 변화가 있는지만 분류하세요.',
    '사실이 없으면 NONE으로 두고 추측해서 채우지 마세요.',
    '반드시 설명 없이 아래 JSON 객체 하나만 반환하세요.',
    '{"catalyst":"POSITIVE|NEGATIVE|MIXED|NONE","impact":"HIGH|MEDIUM|LOW","technicalChange":"BREAKOUT|BREAKDOWN|FAILED_BREAKOUT|VOLUME_ANOMALY|VOLATILITY_EXPANSION|NONE","contradiction":false,"risks":[],"reason":"짧은 공개근거 요약"}',
    `현재 V3 후보: ${event.market} ${event.symbol} ${event.strategy}/${event.timeframe} ${event.direction ?? 'N/A'} ${event.state ?? ''}`,
  ].join('\n');
}

export class SignalIntelligenceAiWatch {
  private readonly reviewed = new Map<string, number>();
  private running = false;
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ai: typeof answerAiChat = answerAiChat,
    private readonly deliver: typeof sendTelegramAlert = sendTelegramAlert,
    private readonly store: TelegramIntelligenceStateStore = new FileTelegramIntelligenceStateStore(
      process.env.SIGNAL_INTELLIGENCE_AI_WATCH_STATE_PATH?.trim()
        || path.resolve(process.cwd(), '.runtime/signal-ai-watch-delivery-state.json'),
    ),
  ) {}

  private prune(now: number): void {
    for (const [key, at] of this.reviewed) if (now - at > REVIEW_TTL_MS) this.reviewed.delete(key);
  }

  async runOnce(now = new Date()) {
    const result = { reviewed: 0, material: 0, rescans: 0, aiUnavailable: 0,
      deliveryAccepted: 0, deliveryDeduped: 0, deliveryUnconfirmed: 0,
      deliveryNotAttempted: 0 };
    if (this.running || !aiConfigured()) return result;
    this.running = true;
    this.prune(now.getTime());
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      let response: Response;
      try { response = await this.fetchImpl(SIGNAL_URL, { signal: controller.signal }); } finally { clearTimeout(timeout); }
      if (!response.ok) return result;
      // A JSON 200 alone does not establish a current, complete 12-lane
      // public source. Bound response bytes and validate full V3 lineage.
      const envelope = await boundedTelegramV3Json(response) as WatchEnvelope;
      if (!envelope || envelope.ok !== true || envelope.executionAuthority !== 'NONE'
        || !validTelegramV3CurrentSource(envelope.snapshot, now.getTime())
        || envelope.snapshot.serviceSha !== envelope.serviceSha
        || envelope.snapshot?.safety?.executionAuthority !== 'NONE'
        || envelope.snapshot?.safety?.privateTradingApiAllowed !== false
        || envelope.snapshot?.safety?.realOrderAllowed !== false
        || !Array.isArray(envelope.snapshot?.events)) return result;

      const events = envelope.snapshot.events
        .filter((event) => event.type === 'NEW_CANDIDATE' || event.type === 'RESCAN_REQUESTED')
        .slice(0, 20);

      for (const event of events) {
        if (result.reviewed >= MAX_REVIEWS_PER_TICK) break;
        const key = `${envelope.serviceSha}:${event.type}:${event.id}`;
        if (this.reviewed.has(key)) continue;
        this.reviewed.set(key, now.getTime());
        const context = contextFor(event);
        if (!context) continue;
        result.reviewed += 1;
        let reviewed: AiWatchResult | null = null;
        try {
          const answer = await this.ai({ message: watchPrompt(event), context }, this.fetchImpl, undefined, 12_000);
          reviewed = parseAiJson(answer.answer);
        } catch {
          result.aiUnavailable += 1;
          continue;
        }
        if (!reviewed || !materialChange(reviewed)) continue;
        result.material += 1;

        try {
          const rescan = await this.fetchImpl(RESCAN_URL, { method: 'POST', headers: { 'content-type': 'application/json' } });
          if (rescan.status === 202) result.rescans += 1;
        } catch {
          // AI never changes signal authority if the public rescan bridge is unavailable.
        }

        const chatId = destination(event);
        // Existing AI watch had in-memory-only dedupe. Require separate
        // reconciliation/approval before enabling its durable delivery lane.
        if (process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true'
          && process.env.TELEGRAM_AI_WATCH_DELIVERY_APPROVED === 'true' && chatId) {
          const durableKey = aiWatchDurableKey({
            signalId: event.id, eventType: event.type,
            sourceDay: envelope.snapshot.generatedAt.slice(0,10),
            catalyst: reviewed.catalyst, technicalChange: reviewed.technicalChange,
            contradiction: reviewed.contradiction,
          });
          const status = await sendAiWatchWithDurableReceipt(this.store, durableKey, {
            type: 'intelligence_report',
            symbol: event.symbol,
            market: event.market,
            destinationChatId: chatId,
            dedupeKey: durableKey,
            duplicateWindowMs: REVIEW_TTL_MS,
            cooldownMs: 0,
            timestamp: now.toISOString(),
            details: [
              `AI 변화감시 · ${event.strategy}/${event.timeframe} · ${event.direction ?? 'N/A'}`,
              `Catalyst ${reviewed.catalyst}/${reviewed.impact}`,
              `Technical ${reviewed.technicalChange}`,
              `Contradiction ${reviewed.contradiction ? 'YES' : 'NO'}`,
              reviewed.risks.length ? `Risk: ${reviewed.risks.join(', ')}` : null,
              reviewed.reason ? `근거: ${reviewed.reason}` : null,
              'AI는 주문/승격 권한 없음 · public Scanner 즉시 재계산만 요청',
            ].filter(Boolean).join('\n'),
          }, now, this.deliver);
          if (status === 'ACCEPTED') result.deliveryAccepted += 1;
          else if (status === 'ALREADY_RESERVED') result.deliveryDeduped += 1;
          else if (status === 'UNCONFIRMED') result.deliveryUnconfirmed += 1;
          else result.deliveryNotAttempted += 1;
        } else {
          result.deliveryNotAttempted += 1;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}

export type SignalIntelligenceAiWatchRuntimeHealth = Readonly<{
  state: 'NOT_STARTED' | 'DISABLED' | 'RUNNING' | 'STOPPING' | 'STOPPED';
  inFlight: number;
}>;
let aiWatchRuntimeHealth: SignalIntelligenceAiWatchRuntimeHealth =
  Object.freeze({state:'NOT_STARTED',inFlight:0});
export function readSignalIntelligenceAiWatchRuntimeHealth(): SignalIntelligenceAiWatchRuntimeHealth {
  return aiWatchRuntimeHealth;
}
function updateAiWatchRuntimeHealth(patch:Partial<SignalIntelligenceAiWatchRuntimeHealth>) {
  aiWatchRuntimeHealth = Object.freeze({...aiWatchRuntimeHealth,...patch});
}

export function startSignalIntelligenceAiWatch(): { stop(): void } | null {
  if (aiWatchRuntimeHealth.state === 'RUNNING' || aiWatchRuntimeHealth.state === 'STOPPING')
    return null;
  if (!aiConfigured()) {
    aiWatchRuntimeHealth = Object.freeze({state:'DISABLED',inFlight:0});
    return null;
  }
  const watch = new SignalIntelligenceAiWatch();
  aiWatchRuntimeHealth = Object.freeze({state:'RUNNING',inFlight:0});
  const tick = async () => {
    updateAiWatchRuntimeHealth({inFlight:aiWatchRuntimeHealth.inFlight+1});
    try {
      const result = await watch.runOnce(new Date());
      if (result.material > 0 || result.aiUnavailable > 0) logger.info({ result }, 'signal intelligence AI watch tick');
    } catch {
      logger.debug('signal intelligence AI watch unavailable');
    } finally {
      const remaining = Math.max(0,aiWatchRuntimeHealth.inFlight-1);
      updateAiWatchRuntimeHealth({inFlight:remaining,...(
        remaining===0 && aiWatchRuntimeHealth.state==='STOPPING' ? {state:'STOPPED' as const} : {}
      )});
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, boundedInterval(process.env.SIGNAL_INTELLIGENCE_AI_WATCH_INTERVAL_MS));
  timer.unref?.();
  console.log('[signal-intelligence-ai-watch] started');
  return { stop: () => {
    clearInterval(timer);
    updateAiWatchRuntimeHealth({state:aiWatchRuntimeHealth.inFlight===0?'STOPPED':'STOPPING'});
  } };
}
