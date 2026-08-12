import { authorizedFetch } from '@/lib/auth-fetch';
import { createBatchIdempotencyKey, JOURNAL_SYNC_BATCH_SIZE } from './paper-journal-batching';
export { createBatchIdempotencyKey, JOURNAL_SYNC_BATCH_SIZE, MAX_IDEMPOTENCY_KEY_LENGTH } from './paper-journal-batching';

export type JournalRecordKind = 'account' | 'order' | 'position' | 'fill' | 'journal';
export type JournalSyncRecord = { kind: JournalRecordKind; id: string; version: number; updatedAt: string; deletedAt: string | null; payload: Record<string, unknown> };
export type StoredJournalSyncRecord = JournalSyncRecord & { createdAt: string; serverUpdatedAt: string };
export type JournalConflict = {
  id: string; kind: JournalRecordKind; recordId: string; version: number;
  serverRecord: StoredJournalSyncRecord; deviceRecord: JournalSyncRecord;
  differenceSummary: string[]; createdAt: string; status: 'open'|'resolved';
};
export type JournalSyncResult = {
  ok: true; mode: 'journal-sync-only'; orderSubmitted: false; exchangeRequestSent: false;
  idempotencyKey: string; serverTime: string; uploaded: StoredJournalSyncRecord[];
  downloaded: StoredJournalSyncRecord[]; unchanged: Array<{ kind: JournalRecordKind; id: string; version: number }>;
  conflicts: JournalConflict[]; failed: Array<{ kind: JournalRecordKind; id: string; code: string; message: string }>;
  warnings: string[]; clockSkewMs: number;
};
export type JournalSnapshotResult = {
  ok: true; mode: 'journal-sync-only'; orderSubmitted: false; exchangeRequestSent: false;
  records: StoredJournalSyncRecord[]; nextCursor: string | null; serverTime: string;
};
export type ConflictChoice = 'server'|'device'|'preserve_both';
export type ConflictResolutionResult = {
  ok: true; mode: 'journal-sync-only'; orderSubmitted: false; exchangeRequestSent: false;
  conflictId: string; choice: ConflictChoice; records: StoredJournalSyncRecord[]; serverTime: string;
};
export type AnalyticsMetricGroup = { key: string; sampleSize: number; netPnl: number; winRate: number|null; expectancy: number|null; averageR: number|null; certainty: 'confirmed'|'candidate'|'insufficient' };
export type BehaviorSignal = { code: string; certainty: 'confirmed'|'candidate'|'insufficient'; count: number; message: string; evidence: string[] };
export type JournalAnalytics = {
  periodStart: string|null; periodEnd: string|null; sampleSize: number; certainty: 'confirmed'|'candidate'|'insufficient';
  totalTrades: number; netPnl: number; wins: number; losses: number; winRate: number|null; expectancy: number|null;
  averageR: number|null; profitFactor: number|null; maximumConsecutiveLosses: number; totalCosts: number; costRatioPercent: number|null;
  stopAdherenceRate: number|null; targetAdherenceRate: number|null; ruleViolationRate: number|null;
  bySide: AnalyticsMetricGroup[]; bySymbol: AnalyticsMetricGroup[]; byStrategy: AnalyticsMetricGroup[];
  byHour: AnalyticsMetricGroup[]; byWeekday: AnalyticsMetricGroup[]; byExitReason: AnalyticsMetricGroup[];
  byDataStatus: AnalyticsMetricGroup[]; byMarketRegime: AnalyticsMetricGroup[];
  byLeverageBucket: AnalyticsMetricGroup[]; byRiskBucket: AnalyticsMetricGroup[];
  behaviorSignals: BehaviorSignal[]; facts: string[]; warnings: string[];
};
export type TradingReviewDataset = {
  periodStart: string; periodEnd: string; sampleSize: number; aggregateMetrics: Record<string, unknown>;
  behaviorSignals: BehaviorSignal[]; strategyMetrics: AnalyticsMetricGroup[]; symbolMetrics: AnalyticsMetricGroup[];
  timeMetrics: AnalyticsMetricGroup[]; representativeTrades: Array<{ anonymizedId: string; side: 'long'|'short'; strategy: string|null; riskPercent: number|null; rMultiple: number|null; netPnlPercent: number|null; exitReason: string; ruleViolations: string[] }>;
  excludedFields: string[]; warnings: string[];
};
export type TradingAiReviewResult = { summary: string; strengths: Array<{ title:string; explanation:string; evidenceIds:string[]; confidence:'low'|'medium'|'high' }>; riskPatterns:Array<{title:string;explanation:string;evidenceIds:string[];confidence:'low'|'medium'|'high';certainty:'confirmed'|'candidate'|'insufficient'}>; costObservations:Array<{title:string;explanation:string;evidenceIds:string[]}>; ruleCompliance:Array<{rule:string;status:'good'|'warning'|'insufficient';explanation:string}>; practiceActions:Array<{priority:1|2|3;action:string;reason:string;measurableTarget:string}>; nextTradeChecklist:string[]; limitations:string[]; disclaimer:string };
export type AiReviewPreview = { dataset: TradingReviewDataset; includedFields:string[]; excludedFields:string[]; warnings:string[] };
export type GeneratedAiReview = { providerRequestId:string|null; model:string; generatedAt:string; result:TradingAiReviewResult; usage:{inputUnits:number|null;outputUnits:number|null} };
export type AiProviderCallState = { attempted:boolean; completed:boolean; reused:boolean };
export type UnifiedTradeSource = 'TOSS_MANUAL'|'TOSS_API'|'KIWOOM_API'|'UPBIT_API'|'BITGET_API'|'APP_PAPER'|'APP_SHADOW'|'APP_AUTO';
export type UnifiedTradeBroker = 'TOSS'|'KIWOOM'|'UPBIT'|'BITGET'|'APP'|'MANUAL';
export type UnifiedTradeMarket = 'KR_STOCK'|'US_STOCK'|'CRYPTO_SPOT'|'CRYPTO_FUTURES';
export type UnifiedTradeRange = 'TODAY'|'7D'|'30D'|'90D'|'1Y'|'ALL';
export type UnifiedTradeGrade = 'A'|'B'|'C'|'D';
export type UnifiedTechnicalSnapshot = {
  snapshotId:string; contextSource:'PRE_TRADE_SNAPSHOT'|'POST_HOC_RECONSTRUCTION'|'NO_PRE_TRADE_CONTEXT';
  capturedAt:string|null; timeframe:string|null; price:number|null; rsi:number|null; macd:number|null; macdSignal:number|null;
  movingAverageFast:number|null; movingAverageSlow:number|null; support:number|null; resistance:number|null;
  volumeRatio:number|null; volatilityPercent:number|null; signalScore:number|null; marketRegime:string|null;
  marketStructure:string|null; signalReasons:readonly string[];
};
export type UnifiedTradeReview = {
  performanceScore:number; qualityScore:number; grade:UnifiedTradeGrade; good:string[]; bad:string[]; improvements:string[];
  mistakes:string[]; deterministic:true; externalAiCalled:false;
};
export type UnifiedTradeCycle = {
  id:string; source:UnifiedTradeSource; broker:string; accountIdMasked:string; market:UnifiedTradeMarket; symbol:string;
  positionSide:'LONG'|'SHORT'; currency:'KRW'|'USD'|'USDT'; status:'OPEN'|'CLOSED'; openedAt:string; closedAt:string|null;
  entryPrice:number; exitPrice:number|null; totalQuantity:number; closedQuantity:number; remainingQuantity:number;
  holdingTimeMs:number|null; grossPnl:number; fees:number; tax:number; netPnl:number; netReturnPercent:number|null;
  strategy:string|null; timeframe:string|null; stopLossPrice:number|null; targetPrice:number|null; ruleViolation:boolean;
  warnings:string[]; technicalSnapshot:UnifiedTechnicalSnapshot; review:UnifiedTradeReview;
  initialEntry:{orderId:string;at:string;price:number;quantity:number;fees:number;tax:number};
  additions:Array<{orderId:string;at:string;price:number;quantity:number;fees:number;tax:number}>;
  partialExits:Array<{orderId:string;at:string;price:number;quantity:number;fees:number;tax:number}>;
  finalExit:{orderId:string;at:string;price:number;quantity:number;fees:number;tax:number}|null;
};
export type UnifiedJournalAnalytics = {
  sampleSize:number; openTrades:number; closedTrades:number; winRate:number|null; profitFactor:number|null;
  averageReturnPercent:number|null; maximumConsecutiveLosses:number;
  netPnlByCurrency:Array<{currency:'KRW'|'USD'|'USDT';value:number}>;
  totalCostsByCurrency:Array<{currency:'KRW'|'USD'|'USDT';value:number}>;
  byMarket:Array<{key:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null}>;
  bySource:Array<{key:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null}>;
  byStrategy:Array<{key:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null}>;
  byTimeframe:Array<{key:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null}>;
  byGrade:Array<{key:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null}>;
  mistakes:Array<{code:string;count:number}>;
  monthlyReport:Array<{month:string;sampleSize:number;winRate:number|null;averageReturnPercent:number|null;netPnlByCurrency:Array<{currency:'KRW'|'USD'|'USDT';value:number}>}>;
  warnings:string[];
};
export type UnifiedTradeJournal = {
  integrationBaseSha:string; generatedAt:string; trades:UnifiedTradeCycle[]; analytics:UnifiedJournalAnalytics;
  integrityIssues:Array<{code:string;orderId:string|null;message:string}>;
  toss:{provider:'TOSS';officialSpecVersion:string;paidStatus:'PAID_STATUS_UNVERIFIED';liveReadIntegration:'MEMBER_CONFIGURED_READ_ONLY';contractNormalizerAvailable:true;executionGranularity:string;livePrivateRequests:0;actualOrders:0};
  brokerImport?:{requested:boolean;importedRecords:number;privateReadRequests:number;privateMutationRequests:0;providers:Record<string,{configured:boolean;importedRecords:number;authenticationRequests:number;privateReadRequests:number;issues:Array<{provider:string;code:string;reference:string|null}>;error:string|null}>|null};
  aiReviewStatus:'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY';
  safety:{finalCostDelta:'0_KRW';actualOrderRequests:0;cancelRequests:0;amendRequests:0;transferRequests:0;withdrawalRequests:0;privateBrokerRequests:0};
};
export type UnifiedJournalFilters = {
  range?:UnifiedTradeRange; market?:UnifiedTradeMarket|'ALL'; source?:UnifiedTradeSource|'ALL';
  broker?:UnifiedTradeBroker|'ALL'; account?:string;
  strategy?:string; timeframe?:string; grade?:UnifiedTradeGrade|'ALL';
};

export const JOURNAL_DELETE_CONFIRMATION = 'DELETE MY PAPER JOURNAL';

function safeError(body: unknown, fallback: string) {
  if (body && typeof body === 'object') {
    const value = body as { message?: unknown; code?: unknown };
    if (typeof value.message === 'string' && value.message.length <= 240) return value.message;
    if (typeof value.code === 'string' && value.code.length <= 80) return value.code;
  }
  return fallback;
}

async function parseJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

function assertSyncEnvelope(body: Record<string, unknown> | null) {
  if (!body || body.mode !== 'journal-sync-only' || body.orderSubmitted !== false || body.exchangeRequestSent !== false) {
    throw new Error('거래일지 동기화 안전 계약을 확인하지 못했습니다.');
  }
}

function assertAnalysisEnvelope(body: Record<string, unknown> | null) {
  if (!body || body.mode !== 'analysis-only' || body.externalAiCalled !== false) {
    throw new Error('거래 분석 안전 계약을 확인하지 못했습니다.');
  }
}

async function syncSingleBatch(
  input: { idempotencyKey: string; clientTime: string; records: JournalSyncRecord[] },
  signal?: AbortSignal,
) {
  const response = await authorizedFetch('/api/paper-journal/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal,
  });
  const body = await parseJson(response);
  assertSyncEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '거래일지를 동기화하지 못했습니다.'));
  return body as unknown as JournalSyncResult;
}

export async function syncJournalRecords(
  input: { idempotencyKey: string; clientTime: string; records: JournalSyncRecord[] },
  signal?: AbortSignal,
) {
  if (input.records.length <= JOURNAL_SYNC_BATCH_SIZE) return syncSingleBatch(input, signal);

  const results: JournalSyncResult[] = [];
  for (let offset = 0; offset < input.records.length; offset += JOURNAL_SYNC_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('동기화가 중단되었습니다.', 'AbortError');
    const index = Math.floor(offset / JOURNAL_SYNC_BATCH_SIZE);
    results.push(await syncSingleBatch({
      idempotencyKey: createBatchIdempotencyKey(input.idempotencyKey, index),
      clientTime: input.clientTime,
      records: input.records.slice(offset, offset + JOURNAL_SYNC_BATCH_SIZE),
    }, signal));
  }

  const latest = results.at(-1)!;
  const largestSkew = results.reduce((selected, result) => Math.abs(result.clockSkewMs) > Math.abs(selected) ? result.clockSkewMs : selected, 0);
  return {
    ok: true,
    mode: 'journal-sync-only',
    orderSubmitted: false,
    exchangeRequestSent: false,
    idempotencyKey: input.idempotencyKey,
    serverTime: latest.serverTime,
    uploaded: results.flatMap((result) => result.uploaded),
    downloaded: results.flatMap((result) => result.downloaded),
    unchanged: results.flatMap((result) => result.unchanged),
    conflicts: results.flatMap((result) => result.conflicts),
    failed: results.flatMap((result) => result.failed),
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
    clockSkewMs: largestSkew,
  } satisfies JournalSyncResult;
}

export async function getJournalSnapshot(cursor: string | null = null, limit = 100, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const response = await authorizedFetch(`/api/paper-journal/snapshot?${params}`, { signal });
  const body = await parseJson(response);
  assertSyncEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '서버 거래일지를 불러오지 못했습니다.'));
  return body as unknown as JournalSnapshotResult;
}

export async function resolveJournalConflict(id: string, choice: ConflictChoice, signal?: AbortSignal) {
  const response = await authorizedFetch(`/api/paper-journal/conflicts/${encodeURIComponent(id)}/resolve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice }), signal,
  });
  const body = await parseJson(response);
  assertSyncEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '동기화 충돌을 해결하지 못했습니다.'));
  return body as unknown as ConflictResolutionResult;
}

export async function deleteServerJournal(confirmation: string, signal?: AbortSignal) {
  const response = await authorizedFetch('/api/paper-journal/all', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation }), signal,
  });
  const body = await parseJson(response);
  assertSyncEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '서버 거래일지를 삭제하지 못했습니다.'));
  return body;
}

export async function getJournalAnalytics(periodStart?: string, periodEnd?: string, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (periodStart) params.set('start', periodStart);
  if (periodEnd) params.set('end', periodEnd);
  const suffix = params.size ? `?${params}` : '';
  const response = await authorizedFetch(`/api/paper-journal/analytics${suffix}`, { signal });
  const body = await parseJson(response);
  assertAnalysisEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '거래 분석을 불러오지 못했습니다.'));
  return body?.result as JournalAnalytics;
}

export async function getUnifiedTradeJournal(filters: UnifiedJournalFilters = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  params.set('includeBroker', 'true');
  const suffix = params.size ? `?${params}` : '';
  const response = await authorizedFetch(`/api/paper-journal/unified-ledger${suffix}`, { signal });
  const body = await parseJson(response);
  assertAnalysisEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '통합 매매일지를 불러오지 못했습니다.'));
  const result = body.result as UnifiedTradeJournal | undefined;
  if (!result
    || result.aiReviewStatus !== 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY'
    || result.toss.liveReadIntegration !== 'MEMBER_CONFIGURED_READ_ONLY'
    || result.safety.finalCostDelta !== '0_KRW'
    || result.safety.actualOrderRequests !== 0
    || result.safety.cancelRequests !== 0
    || result.safety.amendRequests !== 0
    || result.safety.transferRequests !== 0
    || result.safety.withdrawalRequests !== 0
    || result.safety.privateBrokerRequests !== 0) {
    throw new Error('통합 매매일지의 무료·무주문 안전 계약을 확인하지 못했습니다.');
  }
  return { ...result, brokerImport: body.brokerImport as UnifiedTradeJournal['brokerImport'] };
}

export async function buildTradingReviewDataset(periodStart?: string, periodEnd?: string, signal?: AbortSignal) {
  const response = await authorizedFetch('/api/paper-journal/review-dataset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ periodStart: periodStart || null, periodEnd: periodEnd || null }), signal,
  });
  const body = await parseJson(response);
  assertAnalysisEnvelope(body);
  if (!response.ok || body?.ok !== true) throw new Error(safeError(body, '복기용 구조화 데이터를 준비하지 못했습니다.'));
  return body?.result as TradingReviewDataset;
}

export async function previewTradingAiReview(periodStart?: string, periodEnd?: string, signal?: AbortSignal) {
  const response = await authorizedFetch('/api/paper-journal/ai-review/preview', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({periodStart:periodStart||null,periodEnd:periodEnd||null}), signal });
  const body=await parseJson(response); const providerCall=body?.providerCall as AiProviderCallState|undefined; if (!body || body.mode!=='ai-review-preview' || body.externalAiCalled!==false || providerCall?.attempted!==false || providerCall?.completed!==false || providerCall?.reused!==false || body.rateLimitScope!=='process' || body.orderSubmitted!==false || body.exchangeRequestSent!==false) throw new Error('AI 복기 미리보기 안전 계약을 확인하지 못했습니다.');
  if (!response.ok || body.ok!==true) throw new Error(safeError((body.error as Record<string,unknown>)??body,'AI 복기 미리보기를 만들지 못했습니다.'));
  return body.result as AiReviewPreview;
}
export async function generateTradingAiReview(input:{periodStart?:string;periodEnd?:string;consent:boolean;reviewStyle:'concise'|'detailed';idempotencyKey:string},signal?:AbortSignal){
  const response=await authorizedFetch('/api/paper-journal/ai-review/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,locale:'ko-KR'}),signal}); const body=await parseJson(response);
  const providerCall=body?.providerCall as AiProviderCallState|undefined;
  if(!body||body.mode!=='ai-review-only'||body.orderSubmitted!==false||body.exchangeRequestSent!==false||body.rateLimitScope!=='process'||!providerCall||typeof providerCall.attempted!=='boolean'||typeof providerCall.completed!=='boolean'||typeof providerCall.reused!=='boolean'||body.externalAiCalled!==providerCall.attempted)throw new Error('AI 복기 생성 안전 계약을 확인하지 못했습니다.');
  if(!response.ok||body.ok!==true||providerCall.completed!==true)throw new Error(safeError((body.error as Record<string,unknown>)??body,'AI 복기를 생성하지 못했습니다.'));
  return body.result as GeneratedAiReview;
}
