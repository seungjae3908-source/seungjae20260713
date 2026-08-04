import { AiChatError, normalizeChatText } from './ai-chat.service';
import type {
  AiFeatureExplanationRequest,
  AiFeatureTask,
} from './ai-feature-explanation.service';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from './trade-automation.repository';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingPlan, TradingPolicy } from './trade-automation.types';

type AuthorityContext = {
  userId: string;
  accessToken?: string;
};

type IdentifierKey = 'analysisId' | 'signalId' | 'planId';

let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setAiFeatureAuthorityRepositoryFactoryForTests(
  factory: ((userId: string) => TradingRepository) | null,
): void {
  repositoryFactoryForTests = factory;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiChatError(
      'AI_FEATURE_INVALID_INPUT',
      '서버 권위 AI 기능 설명 요청 형식이 올바르지 않습니다.',
      400,
    );
  }
  return value as Record<string, unknown>;
}

function identifierRequest(value: unknown, key: IdentifierKey): string {
  const row = objectValue(value);
  const allowed = new Set(['taskVersion', key]);
  if (Object.keys(row).some((field) => !allowed.has(field))) {
    throw new AiChatError(
      'AI_FEATURE_INVALID_INPUT',
      '브라우저가 제공한 상태 스냅샷이나 실행 필드는 사용할 수 없습니다.',
      400,
    );
  }
  if (row.taskVersion !== '1') {
    throw new AiChatError(
      'AI_FEATURE_INVALID_INPUT',
      '지원하지 않는 서버 권위 AI 계약 버전입니다.',
      400,
    );
  }
  const identifier = normalizeChatText(row[key], 160);
  if (!identifier) {
    throw new AiChatError(
      'AI_FEATURE_INVALID_INPUT',
      `${key} 값이 필요합니다.`,
      400,
    );
  }
  return identifier;
}

function repositoryFor(context: AuthorityContext): TradingRepository {
  if (!context.userId) {
    throw new AiChatError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  }
  if (repositoryFactoryForTests) return repositoryFactoryForTests(context.userId);
  if (!context.accessToken) {
    throw new AiChatError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  }
  return createSupabaseTradingRepository(context.accessToken, context.userId);
}

function liveExecutionEnabled(plan: TradingPlan): boolean {
  if (plan.accountMode !== 'live') return true;
  const globalEnabled = process.env.ORDER_EXECUTION_ENABLED === 'true'
    && process.env.LIVE_TRADING_ACTIVATION_APPROVED === 'true';
  const exchangeEnabled = plan.exchange === 'bitget'
    ? process.env.BITGET_LIVE_ORDER_ENABLED === 'true'
    : plan.exchange === 'upbit'
      ? process.env.UPBIT_LIVE_ORDER_ENABLED === 'true'
      : process.env.KIWOOM_LIVE_ORDER_ENABLED === 'true';
  return globalEnabled && exchangeEnabled;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function planReferencePrice(plan: TradingPlan): number | null {
  if (finitePositive(plan.limitPrice)) return plan.limitPrice;
  if (finitePositive(plan.quantity) && finitePositive(plan.estimatedKrw)) {
    return plan.estimatedKrw / plan.quantity;
  }
  return null;
}

function percentage(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !finitePositive(denominator)) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function approvalReason(
  plan: TradingPlan,
  policy: TradingPolicy,
  decision: ReturnType<typeof evaluateTradingPlan>,
  now: number,
): string | null {
  if (plan.state !== 'APPROVAL_PENDING') return `PLAN_STATE_${plan.state}`;
  if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= now) {
    return 'TRADE_PLAN_EXPIRED';
  }
  if (!decision.allowed) return decision.blockCodes[0] ?? 'RISK_RECHECK_BLOCKED';
  if (policy.mode !== 'approval') return 'APPROVAL_MODE_DISABLED';
  return null;
}

async function authoritativeTradePlanRequest(
  body: unknown,
  context: AuthorityContext,
): Promise<AiFeatureExplanationRequest> {
  const planId = identifierRequest(body, 'planId');
  const repository = repositoryFor(context);

  let plan: TradingPlan | null;
  let policy: TradingPolicy;
  let persistentGlobalStop: boolean;
  try {
    [plan, policy, persistentGlobalStop] = await Promise.all([
      repository.getPlan(context.userId, planId),
      repository.getPolicy(context.userId),
      repository.getGlobalEmergencyStop(),
    ]);
  } catch {
    throw new AiChatError(
      'AI_FEATURE_AUTHORITY_STORAGE_UNAVAILABLE',
      '서버 권위 주문계획을 읽을 수 없습니다.',
      503,
    );
  }

  if (!plan) {
    throw new AiChatError(
      'AI_FEATURE_SOURCE_NOT_FOUND',
      '현재 사용자에게 속한 주문계획을 찾을 수 없습니다.',
      404,
    );
  }
  if (plan.accountMode === 'mock') {
    throw new AiChatError(
      'AI_FEATURE_ACCOUNT_MODE_UNSUPPORTED',
      'mock 주문계획은 현재 구조화 AI 설명 계약에서 지원하지 않습니다.',
      409,
    );
  }

  const effectiveEmergencyStop = policy.emergencyStopped
    || persistentGlobalStop
    || process.env.TRADING_EMERGENCY_STOP === 'true';
  const decision = evaluateTradingPlan(plan, policy, {
    emergencyStopped: effectiveEmergencyStop,
    serverLiveEnabled: liveExecutionEnabled(plan),
  });
  const now = Date.now();
  const reasonCode = approvalReason(plan, policy, decision, now);
  const approvalEnabled = reasonCode === null;
  const capitalBase = Math.max(
    1,
    Math.min(
      policy.totalCapitalKrw,
      finitePositive(plan.marketSnapshot.accountValueKrw)
        ? plan.marketSnapshot.accountValueKrw
        : policy.totalCapitalKrw,
    ),
  );
  const proposedExposurePercent = Math.round((
    plan.marketSnapshot.assetExposurePercent
    + (plan.estimatedKrw / capitalBase) * 100
  ) * 100) / 100;
  const referencePrice = planReferencePrice(plan);
  const stopDistancePercent = referencePrice == null
    ? null
    : percentage(Math.abs(referencePrice - plan.stopPrice), referencePrice);

  const warnings = [
    ...decision.warnings,
    '검색기 신호 생명주기 기록은 아직 main 권위 원본에 통합되지 않아 signalId 연결 여부만 표시합니다.',
    '기대값 및 고급 최적화 평가는 현재 권위 원본에 없어 AI가 계산하거나 보완하지 않습니다.',
  ];

  return {
    task: 'trade_plan_risk_explanation',
    taskVersion: '1',
    sourceVersion: `trade-plan:${plan.id}:${plan.updatedAt}`,
    payload: {
      planId: plan.id,
      planRevision: plan.updatedAt,
      market: plan.market,
      symbol: plan.symbol,
      side: plan.side,
      accountMode: plan.accountMode,
      planState: plan.state,
      signalState: 'NOT_INTEGRATED',
      approvalEnabled,
      approvalReasonCode: reasonCode,
      optimizationAllowed: false,
      blockCodes: decision.blockCodes,
      warnings,
      expectedValueR: null,
      stopDistancePercent,
      riskBudgetPercent: policy.maxAssetPercent,
      proposedExposurePercent,
      entryZoneStatus: finitePositive(plan.limitPrice)
        ? 'limit-price-defined'
        : 'market-or-unspecified',
      pilotStage: `${plan.accountMode}:${policy.mode}`,
    },
  };
}

export async function resolveAuthoritativeFeatureRequest(
  task: AiFeatureTask,
  body: unknown,
  context: AuthorityContext,
): Promise<AiFeatureExplanationRequest> {
  if (task === 'chart_analysis_explanation') {
    identifierRequest(body, 'analysisId');
    throw new AiChatError(
      'AI_FEATURE_AUTHORITY_NOT_AVAILABLE',
      '차트 분석 권위 기록은 PR #50 통합 전이므로 서버에서 불러올 수 없습니다.',
      503,
    );
  }
  if (task === 'scanner_signal_explanation') {
    identifierRequest(body, 'signalId');
    throw new AiChatError(
      'AI_FEATURE_AUTHORITY_NOT_AVAILABLE',
      '검색기 신호 권위 기록은 PR #52 통합 전이므로 서버에서 불러올 수 없습니다.',
      503,
    );
  }
  return authoritativeTradePlanRequest(body, context);
}
