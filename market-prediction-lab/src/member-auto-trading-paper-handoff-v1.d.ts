export type MemberAutoTradingPaperHandoffSafety = Readonly<{
  executionAuthority: 'NONE';
  publicDataOnly: true;
  simulatedOnly: true;
  liveTrading: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
}>;

export type MemberAutoTradingPaperHandoffEntry = Readonly<{
  handoffId: string;
  cycleId: string;
  evaluatedAtMs: number;
  identity: Readonly<{
    signalId: string;
    candidateId: string | null;
    market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
    symbol: string;
    timeframe: string;
    horizon: number;
    direction: 'BUY' | 'LONG' | 'SHORT';
    regime: string | null;
    strategyId: string;
    strategyVersion: string;
    parameterHash: string;
    researchCodeSha: string;
    costPolicyVersion: string;
    executionAuthority: 'NONE';
  }>;
  signal: Readonly<{
    signalId: string;
    market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
    symbol: string;
    timestampMs: number | null;
    expiresAtMs: number | null;
    ttlMs: number | null;
    style: string | null;
    timeframe: string;
    horizon: number;
    direction: 'BUY' | 'LONG' | 'SHORT';
    regime: string | null;
    strategyIdentity: Readonly<Record<string, unknown>>;
    learningSnapshot: Readonly<Record<string, unknown>> | null;
  }>;
  profitEvidence: Readonly<Record<string, unknown>> | null;
  riskEvidence: Readonly<{
    status: 'APPROVED';
    source: 'TRADING_RISK_ENGINE';
    evaluatedAtMs: number;
    simulatedOnly: true;
    allowed: true;
    blockCodes: readonly string[];
    recommendedQuantity: number;
    actualRiskPercent: number | null;
    riskReward1: number | null;
    riskReward2: number | null;
    policyIdentity: Readonly<Record<string, unknown>> | null;
    executionAuthority: 'NONE';
  }>;
  execution: Readonly<{
    marketAdapterIdentity: Readonly<Record<string, unknown>> | null;
    costPolicy: Readonly<Record<string, unknown>> | null;
    executionPolicy: Readonly<Record<string, unknown>> | null;
    dataEvidence: Readonly<Record<string, unknown>>;
  }>;
  simulatedOrder: Readonly<Record<string, unknown>> | null;
  publicQuote: Readonly<Record<string, unknown>> | null;
  safety: Readonly<{
    executionAuthority: 'NONE';
    simulatedOnly: true;
    liveOrderAllowed: false;
    privateTradingApiAllowed: false;
    orderSubmitted: false;
    exchangeRequestSent: false;
  }>;
}>;

export type MemberAutoTradingPaperHandoff = Readonly<{
  schemaVersion: 'member-auto-trading-paper-handoff-v1';
  status: 'READY' | 'BLOCKED_DATA';
  cycleId: string;
  evaluatedAtMs: number;
  entries: readonly MemberAutoTradingPaperHandoffEntry[];
  entryCount: number;
  blockers: readonly string[];
  safety: MemberAutoTradingPaperHandoffSafety;
  handoffDigest?: string;
}>;

export const MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION: 'member-auto-trading-paper-handoff-v1';

export function buildMemberAutoTradingPaperHandoff(input?: {
  cycleId?: string;
  evaluatedAtMs?: number;
  lanes?: readonly unknown[];
}): MemberAutoTradingPaperHandoff;

export function validateMemberAutoTradingPaperHandoff(
  value: unknown,
  nowMs?: number,
): MemberAutoTradingPaperHandoff;
