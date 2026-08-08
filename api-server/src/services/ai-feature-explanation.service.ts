import { AiChatError, normalizeChatText } from './ai-chat.service';

export type AiFeatureTask =
  | 'chart_analysis_explanation'
  | 'scanner_signal_explanation'
  | 'trade_plan_risk_explanation';

type Market = 'KR' | 'US' | 'UPBIT' | 'BITGET';

type ChartExplanationPayload = {
  analysisId: string;
  engineVersion: string;
  market: Market;
  symbol: string;
  displayName?: string;
  timeframe: string;
  dataAsOf: string;
  dataStatus: string;
  status: 'forming' | 'candidate' | 'confirmed' | 'weakened' | 'invalidated' | 'expired';
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  title: string;
  summary: string;
  reasons: string[];
  confirmationConditions: string[];
  invalidationConditions: string[];
  indicators: Record<string, number | string | boolean | null>;
};

type ScannerExplanationPayload = {
  signalId: string;
  signalRevision: string;
  market: Market;
  symbol: string;
  displayName?: string;
  timeframe: string;
  state: 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
  reasonCode: string;
  score: number;
  confidence: number;
  riskReward: number | null;
  coreConditionsMaintained: boolean;
  reasons: string[];
  warnings: string[];
  dataTimestamp: string;
  expiresAt: string;
  matchedConditions: string[];
};

type TradePlanExplanationPayload = {
  planId: string;
  planRevision: string;
  market: string;
  symbol: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  accountMode: 'paper' | 'live';
  planState: string;
  signalState: string;
  approvalEnabled: boolean;
  approvalReasonCode: string | null;
  optimizationAllowed: boolean;
  blockCodes: string[];
  warnings: string[];
  expectedValueR: number | null;
  stopDistancePercent: number | null;
  riskBudgetPercent: number | null;
  proposedExposurePercent: number | null;
  entryZoneStatus: string;
  pilotStage: string;
};

export type AiFeatureExplanationRequest =
  | { task: 'chart_analysis_explanation'; taskVersion: '1'; sourceVersion: string; payload: ChartExplanationPayload }
  | { task: 'scanner_signal_explanation'; taskVersion: '1'; sourceVersion: string; payload: ScannerExplanationPayload }
  | { task: 'trade_plan_risk_explanation'; taskVersion: '1'; sourceVersion: string; payload: TradePlanExplanationPayload };

export type ChartExplanationContent = {
  plainSummary: string;
  bullishFactors: string[];
  bearishFactors: string[];
  confirmationWatch: string[];
  invalidationWatch: string[];
  limitations: string[];
  advisoryOnly: true;
};

export type ScannerExplanationContent = {
  plainSummary: string;
  supportingFactors: string[];
  riskFactors: string[];
  whyApprovalIsEnabledOrBlocked: string;
  nextDeterministicChecks: string[];
  limitations: string[];
  advisoryOnly: true;
};

export type TradePlanExplanationContent = {
  plainSummary: string;
  blockingReasonsExplained: string[];
  riskNotes: string[];
  planChecklist: string[];
  dataLimitations: string[];
  advisoryOnly: true;
};

export type AiFeatureExplanationContent =
  | ChartExplanationContent
  | ScannerExplanationContent
  | TradePlanExplanationContent;

export type AiFeatureExplanationResult = {
  task: AiFeatureTask;
  taskVersion: '1';
  sourceVersion: string;
  model: string;
  generatedAt: string;
  advisoryOnly: true;
  content: AiFeatureExplanationContent;
};

type GenerateOptions = {
  fetchImpl?: typeof fetch;
  externalSignal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const sensitivePattern = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|eyJ[a-z0-9_-]{12,}\.|authorization\s*:|(?:refresh[_ -]?token|access[_ -]?token|api[_ -]?key|private[_ -]?key|approval[_ -]?token|approval[_ -]?nonce|idempotency[_ -]?key|monitor[_ -]?token|계좌번호|비밀번호|주민등록번호|실행키|주문\s*승인\s*토큰)\s*[:=]?\s*\S{6,})/i;
const unsafeFeatureOutput = /(?:수익\s*보장|무조건\s*(?:상승|하락)|확정\s*(?:매수|매도)|반드시\s*(?:매수|매도)|지금\s*(?:매수|매도)|차단(?:을|은)?\s*무시|승인(?:을|은)?\s*(?:강제|우회)|실제\s*주문|주문\s*(?:실행|전송|취소)|자동매매\s*(?:시작|활성|실행)|포지션\s*(?:종료|청산)|레버리지\s*(?:변경|설정)|\b(?:buy|sell|close|execute|submit)\s+(?:now|order|position)\b)/i;
const forbiddenIndicatorKey = /(?:token|secret|password|credential|account|balance|holding|idempotency|nonce|approval|private|api[_-]?key)/i;

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiChatError(code, '구조화 AI 입력 형식이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(row).some((key) => !allowedSet.has(key))) {
    throw new AiChatError(code, '허용되지 않은 구조화 AI 필드가 포함되어 있습니다.');
  }
}

function cleanString(value: unknown, field: string, maximum = 240, optional = false): string | undefined {
  const normalized = normalizeChatText(value, maximum);
  if (!normalized) {
    if (optional) return undefined;
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 값이 필요합니다.`);
  }
  if (sensitivePattern.test(normalized)) {
    throw new AiChatError('AI_FEATURE_PRIVATE_DATA_FORBIDDEN', '민감정보가 포함된 구조화 AI 입력은 전송할 수 없습니다.');
  }
  return normalized;
}

function cleanDate(value: unknown, field: string): string {
  const normalized = cleanString(value, field, 64) as string;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 시각이 올바르지 않습니다.`);
  }
  return normalized;
}

function cleanEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 값이 허용 범위를 벗어났습니다.`);
  }
  return value as T;
}

function cleanNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 숫자가 허용 범위를 벗어났습니다.`);
  }
  return value;
}

function cleanNullableNumber(value: unknown, field: string, minimum: number, maximum: number): number | null {
  if (value == null) return null;
  return cleanNumber(value, field, minimum, maximum);
}

function cleanBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 값은 boolean이어야 합니다.`);
  }
  return value;
}

function cleanStrings(value: unknown, field: string, maximumItems = 12): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', `${field} 목록이 허용 범위를 벗어났습니다.`);
  }
  return value.map((item) => cleanString(item, field, 240) as string);
}

function cleanIndicators(value: unknown): Record<string, number | string | boolean | null> {
  const row = objectValue(value, 'AI_FEATURE_INVALID_INPUT');
  if (Object.keys(row).length > 40) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', '지표 항목이 너무 많습니다.');
  }
  return Object.fromEntries(Object.entries(row).map(([key, raw]) => {
    const normalizedKey = normalizeChatText(key, 60);
    if (!normalizedKey || forbiddenIndicatorKey.test(normalizedKey)) {
      throw new AiChatError('AI_FEATURE_PRIVATE_DATA_FORBIDDEN', '허용되지 않은 지표 키가 포함되어 있습니다.');
    }
    if (raw == null || typeof raw === 'boolean') return [normalizedKey, raw];
    if (typeof raw === 'number' && Number.isFinite(raw)) return [normalizedKey, raw];
    if (typeof raw === 'string') return [normalizedKey, cleanString(raw, normalizedKey, 120) as string];
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', '지표 값 형식이 올바르지 않습니다.');
  }));
}

function validateChartPayload(value: unknown): ChartExplanationPayload {
  const row = objectValue(value, 'AI_FEATURE_INVALID_INPUT');
  exactKeys(row, [
    'analysisId', 'engineVersion', 'market', 'symbol', 'displayName', 'timeframe', 'dataAsOf', 'dataStatus',
    'status', 'bias', 'confidence', 'title', 'summary', 'reasons', 'confirmationConditions',
    'invalidationConditions', 'indicators',
  ], 'AI_FEATURE_INVALID_INPUT');
  return {
    analysisId: cleanString(row.analysisId, 'analysisId', 160) as string,
    engineVersion: cleanString(row.engineVersion, 'engineVersion', 80) as string,
    market: cleanEnum(row.market, ['KR', 'US', 'UPBIT', 'BITGET'] as const, 'market'),
    symbol: (cleanString(row.symbol, 'symbol', 40) as string).toUpperCase(),
    displayName: cleanString(row.displayName, 'displayName', 120, true),
    timeframe: cleanString(row.timeframe, 'timeframe', 20) as string,
    dataAsOf: cleanDate(row.dataAsOf, 'dataAsOf'),
    dataStatus: cleanString(row.dataStatus, 'dataStatus', 80) as string,
    status: cleanEnum(row.status, ['forming', 'candidate', 'confirmed', 'weakened', 'invalidated', 'expired'] as const, 'status'),
    bias: cleanEnum(row.bias, ['bullish', 'bearish', 'neutral'] as const, 'bias'),
    confidence: cleanNumber(row.confidence, 'confidence', 0, 100),
    title: cleanString(row.title, 'title', 160) as string,
    summary: cleanString(row.summary, 'summary', 600) as string,
    reasons: cleanStrings(row.reasons, 'reasons'),
    confirmationConditions: cleanStrings(row.confirmationConditions, 'confirmationConditions'),
    invalidationConditions: cleanStrings(row.invalidationConditions, 'invalidationConditions'),
    indicators: cleanIndicators(row.indicators),
  };
}

function validateScannerPayload(value: unknown): ScannerExplanationPayload {
  const row = objectValue(value, 'AI_FEATURE_INVALID_INPUT');
  exactKeys(row, [
    'signalId', 'signalRevision', 'market', 'symbol', 'displayName', 'timeframe', 'state', 'reasonCode',
    'score', 'confidence', 'riskReward', 'coreConditionsMaintained', 'reasons', 'warnings', 'dataTimestamp',
    'expiresAt', 'matchedConditions',
  ], 'AI_FEATURE_INVALID_INPUT');
  return {
    signalId: cleanString(row.signalId, 'signalId', 160) as string,
    signalRevision: cleanString(row.signalRevision, 'signalRevision', 120) as string,
    market: cleanEnum(row.market, ['KR', 'US', 'UPBIT', 'BITGET'] as const, 'market'),
    symbol: (cleanString(row.symbol, 'symbol', 40) as string).toUpperCase(),
    displayName: cleanString(row.displayName, 'displayName', 120, true),
    timeframe: cleanString(row.timeframe, 'timeframe', 20) as string,
    state: cleanEnum(row.state, ['WATCHING', 'READY_FOR_APPROVAL', 'WEAKENED', 'INVALIDATED', 'EXPIRED'] as const, 'state'),
    reasonCode: cleanString(row.reasonCode, 'reasonCode', 120) as string,
    score: cleanNumber(row.score, 'score', 0, 100),
    confidence: cleanNumber(row.confidence, 'confidence', 0, 100),
    riskReward: cleanNullableNumber(row.riskReward, 'riskReward', -100, 100),
    coreConditionsMaintained: cleanBoolean(row.coreConditionsMaintained, 'coreConditionsMaintained'),
    reasons: cleanStrings(row.reasons, 'reasons'),
    warnings: cleanStrings(row.warnings, 'warnings'),
    dataTimestamp: cleanDate(row.dataTimestamp, 'dataTimestamp'),
    expiresAt: cleanDate(row.expiresAt, 'expiresAt'),
    matchedConditions: cleanStrings(row.matchedConditions, 'matchedConditions', 20),
  };
}

function validateTradePayload(value: unknown): TradePlanExplanationPayload {
  const row = objectValue(value, 'AI_FEATURE_INVALID_INPUT');
  exactKeys(row, [
    'planId', 'planRevision', 'market', 'symbol', 'side', 'accountMode', 'planState', 'signalState',
    'approvalEnabled', 'approvalReasonCode', 'optimizationAllowed', 'blockCodes', 'warnings', 'expectedValueR',
    'stopDistancePercent', 'riskBudgetPercent', 'proposedExposurePercent', 'entryZoneStatus', 'pilotStage',
  ], 'AI_FEATURE_INVALID_INPUT');
  return {
    planId: cleanString(row.planId, 'planId', 160) as string,
    planRevision: cleanString(row.planRevision, 'planRevision', 120) as string,
    market: cleanString(row.market, 'market', 40) as string,
    symbol: (cleanString(row.symbol, 'symbol', 40) as string).toUpperCase(),
    side: cleanEnum(row.side, ['buy', 'sell', 'long', 'short'] as const, 'side'),
    accountMode: cleanEnum(row.accountMode, ['paper', 'live'] as const, 'accountMode'),
    planState: cleanString(row.planState, 'planState', 80) as string,
    signalState: cleanString(row.signalState, 'signalState', 80) as string,
    approvalEnabled: cleanBoolean(row.approvalEnabled, 'approvalEnabled'),
    approvalReasonCode: row.approvalReasonCode == null ? null : cleanString(row.approvalReasonCode, 'approvalReasonCode', 120) as string,
    optimizationAllowed: cleanBoolean(row.optimizationAllowed, 'optimizationAllowed'),
    blockCodes: cleanStrings(row.blockCodes, 'blockCodes', 20),
    warnings: cleanStrings(row.warnings, 'warnings', 20),
    expectedValueR: cleanNullableNumber(row.expectedValueR, 'expectedValueR', -100, 100),
    stopDistancePercent: cleanNullableNumber(row.stopDistancePercent, 'stopDistancePercent', 0, 1000),
    riskBudgetPercent: cleanNullableNumber(row.riskBudgetPercent, 'riskBudgetPercent', 0, 100),
    proposedExposurePercent: cleanNullableNumber(row.proposedExposurePercent, 'proposedExposurePercent', 0, 1000),
    entryZoneStatus: cleanString(row.entryZoneStatus, 'entryZoneStatus', 80) as string,
    pilotStage: cleanString(row.pilotStage, 'pilotStage', 80) as string,
  };
}

export function validateFeatureExplanationRequest(value: unknown): AiFeatureExplanationRequest {
  const row = objectValue(value, 'AI_FEATURE_INVALID_INPUT');
  exactKeys(row, ['task', 'taskVersion', 'sourceVersion', 'payload'], 'AI_FEATURE_INVALID_INPUT');
  const task = cleanEnum(row.task, [
    'chart_analysis_explanation',
    'scanner_signal_explanation',
    'trade_plan_risk_explanation',
  ] as const, 'task');
  if (row.taskVersion !== '1') {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', '지원하지 않는 구조화 AI 계약 버전입니다.');
  }
  const sourceVersion = cleanString(row.sourceVersion, 'sourceVersion', 160) as string;
  if (task === 'chart_analysis_explanation') {
    return { task, taskVersion: '1', sourceVersion, payload: validateChartPayload(row.payload) };
  }
  if (task === 'scanner_signal_explanation') {
    return { task, taskVersion: '1', sourceVersion, payload: validateScannerPayload(row.payload) };
  }
  return { task, taskVersion: '1', sourceVersion, payload: validateTradePayload(row.payload) };
}

function cleanOutputString(value: unknown, field: string): string {
  const normalized = cleanString(value, field, 800) as string;
  if (unsafeFeatureOutput.test(normalized)) {
    throw new AiChatError('AI_FEATURE_UNSAFE_RESPONSE', '주문이나 안전장치 변경을 지시하는 AI 응답이 차단되었습니다.', 502);
  }
  return normalized;
}

function cleanOutputStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw new AiChatError('AI_FEATURE_INVALID_RESPONSE', '구조화 AI 응답 목록 형식이 올바르지 않습니다.', 502);
  }
  return value.map((item) => cleanOutputString(item, field));
}

function validateAdvisory(value: unknown): true {
  if (value !== true) {
    throw new AiChatError('AI_FEATURE_INVALID_RESPONSE', '구조화 AI 응답의 advisoryOnly 계약이 올바르지 않습니다.', 502);
  }
  return true;
}

function validateChartContent(value: unknown): ChartExplanationContent {
  const row = objectValue(value, 'AI_FEATURE_INVALID_RESPONSE');
  exactKeys(row, ['plainSummary', 'bullishFactors', 'bearishFactors', 'confirmationWatch', 'invalidationWatch', 'limitations', 'advisoryOnly'], 'AI_FEATURE_INVALID_RESPONSE');
  return {
    plainSummary: cleanOutputString(row.plainSummary, 'plainSummary'),
    bullishFactors: cleanOutputStrings(row.bullishFactors, 'bullishFactors'),
    bearishFactors: cleanOutputStrings(row.bearishFactors, 'bearishFactors'),
    confirmationWatch: cleanOutputStrings(row.confirmationWatch, 'confirmationWatch'),
    invalidationWatch: cleanOutputStrings(row.invalidationWatch, 'invalidationWatch'),
    limitations: cleanOutputStrings(row.limitations, 'limitations'),
    advisoryOnly: validateAdvisory(row.advisoryOnly),
  };
}

function validateScannerContent(value: unknown): ScannerExplanationContent {
  const row = objectValue(value, 'AI_FEATURE_INVALID_RESPONSE');
  exactKeys(row, ['plainSummary', 'supportingFactors', 'riskFactors', 'whyApprovalIsEnabledOrBlocked', 'nextDeterministicChecks', 'limitations', 'advisoryOnly'], 'AI_FEATURE_INVALID_RESPONSE');
  return {
    plainSummary: cleanOutputString(row.plainSummary, 'plainSummary'),
    supportingFactors: cleanOutputStrings(row.supportingFactors, 'supportingFactors'),
    riskFactors: cleanOutputStrings(row.riskFactors, 'riskFactors'),
    whyApprovalIsEnabledOrBlocked: cleanOutputString(row.whyApprovalIsEnabledOrBlocked, 'whyApprovalIsEnabledOrBlocked'),
    nextDeterministicChecks: cleanOutputStrings(row.nextDeterministicChecks, 'nextDeterministicChecks'),
    limitations: cleanOutputStrings(row.limitations, 'limitations'),
    advisoryOnly: validateAdvisory(row.advisoryOnly),
  };
}

function validateTradeContent(value: unknown): TradePlanExplanationContent {
  const row = objectValue(value, 'AI_FEATURE_INVALID_RESPONSE');
  exactKeys(row, ['plainSummary', 'blockingReasonsExplained', 'riskNotes', 'planChecklist', 'dataLimitations', 'advisoryOnly'], 'AI_FEATURE_INVALID_RESPONSE');
  return {
    plainSummary: cleanOutputString(row.plainSummary, 'plainSummary'),
    blockingReasonsExplained: cleanOutputStrings(row.blockingReasonsExplained, 'blockingReasonsExplained'),
    riskNotes: cleanOutputStrings(row.riskNotes, 'riskNotes'),
    planChecklist: cleanOutputStrings(row.planChecklist, 'planChecklist'),
    dataLimitations: cleanOutputStrings(row.dataLimitations, 'dataLimitations'),
    advisoryOnly: validateAdvisory(row.advisoryOnly),
  };
}

function validateProviderContent(task: AiFeatureTask, value: unknown): AiFeatureExplanationContent {
  if (task === 'chart_analysis_explanation') return validateChartContent(value);
  if (task === 'scanner_signal_explanation') return validateScannerContent(value);
  return validateTradeContent(value);
}

function taskInstruction(task: AiFeatureTask): string {
  const contract = task === 'chart_analysis_explanation'
    ? 'Explain only the supplied deterministic chart analysis. Do not change status, bias, confidence, prices, indicators, confirmation conditions, or invalidation conditions.'
    : task === 'scanner_signal_explanation'
      ? 'Explain only the supplied deterministic scanner state and approval reason. Do not change signal state, approval availability, expiry, score, confidence, or revalidation result.'
      : 'Explain only the supplied deterministic trade-plan risk assessment. Do not change approval, block codes, risk limits, quantities, prices, account mode, adapter, queue, or execution state.';
  return `You are a read-only Korean financial explanation service. ${contract} Return one JSON object matching the requested schema exactly. Never return executable instructions, buy/sell commands, approval bypasses, secrets, personal data, account data, idempotency values, tool calls, server commands, or order actions. advisoryOnly must be true.`;
}

function resolveGeminiConfig(): { apiKey: string; model: string } {
  const explicitProvider = process.env.AI_CHAT_PROVIDER?.trim().toLowerCase();
  if (explicitProvider && !['gemini', 'google', 'google-gemini'].includes(explicitProvider)) {
    throw new AiChatError('AI_FEATURE_PROVIDER_UNSUPPORTED', '구조화 기능 설명은 현재 무료 Gemini 공급자만 지원합니다.', 503);
  }
  const apiKey = process.env.AI_CHAT_API_KEY?.trim()
    || process.env.GEMINI_API_KEY?.trim()
    || process.env.GOOGLE_API_KEY?.trim();
  const model = process.env.AI_CHAT_MODEL?.trim()
    || process.env.GEMINI_MODEL?.trim()
    || DEFAULT_GEMINI_MODEL;
  if (!apiKey) {
    throw new AiChatError('AI_FEATURE_NOT_CONFIGURED', '구조화 AI 기능 설명 공급자가 설정되지 않았습니다.', 503);
  }
  return { apiKey, model };
}

function providerText(body: unknown): string {
  const parts = (body as any)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim();
}

export async function generateStructuredFeatureExplanation(
  input: unknown,
  options: GenerateOptions = {},
): Promise<AiFeatureExplanationResult> {
  const request = validateFeatureExplanationRequest(input);
  const config = resolveGeminiConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 20_000, 20_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.externalSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: taskInstruction(request.task) }] },
        contents: [{
          role: 'user',
          parts: [{ text: JSON.stringify(request) }],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 1_200,
          temperature: 0.1,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
    });

    if (response.status === 429) {
      throw new AiChatError('AI_FEATURE_RATE_LIMITED', '무료 Gemini 기능 설명 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 429);
    }
    if (!response.ok) {
      throw new AiChatError('AI_FEATURE_PROVIDER_ERROR', '구조화 AI 기능 설명 응답을 받지 못했습니다.', 502);
    }

    const raw = providerText(await response.json());
    if (!raw || raw.startsWith('```')) {
      throw new AiChatError('AI_FEATURE_INVALID_RESPONSE', '구조화 AI 응답이 JSON 계약을 따르지 않았습니다.', 502);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new AiChatError('AI_FEATURE_INVALID_RESPONSE', '구조화 AI 응답을 해석할 수 없습니다.', 502);
    }

    const content = validateProviderContent(request.task, decoded);
    return {
      task: request.task,
      taskVersion: request.taskVersion,
      sourceVersion: request.sourceVersion,
      model: config.model,
      generatedAt: new Date().toISOString(),
      advisoryOnly: true,
      content,
    };
  } catch (cause) {
    if (cause instanceof AiChatError) throw cause;
    if (controller.signal.aborted) {
      throw new AiChatError('AI_FEATURE_TIMEOUT', '구조화 AI 기능 설명 요청 시간이 초과되었습니다.', 504);
    }
    throw new AiChatError('AI_FEATURE_PROVIDER_ERROR', '구조화 AI 기능 설명 응답을 받지 못했습니다.', 502);
  } finally {
    clearTimeout(timeout);
    options.externalSignal?.removeEventListener('abort', onAbort);
  }
}
