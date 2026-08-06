import type {
  TradingAccountMode,
  TradingPlan,
  TradingPolicy,
} from './trade-automation.types';

const PAPER_ACCOUNT_MODES = new Set<TradingAccountMode>(['paper', 'mock']);
const PAPER_ADAPTERS = new Set(['paper', 'paper-simulator']);
const MOCK_ADAPTERS = new Set(['mock', 'mock-simulator']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown) {
  return value == null ? null : String(value).trim().toLowerCase();
}

export function assertPaperApprovalEnvelope(
  value: unknown,
  options: { requireAccountMode?: boolean } = {},
) {
  const input = asRecord(value);
  const mode = optionalString(input.mode);
  if (mode === 'automatic') throw new Error('AUTOMATIC_MODE_FORBIDDEN');
  if (mode != null && mode !== 'approval') throw new Error('APPROVAL_MODE_REQUIRED');
  if (input.automaticEnabled === true || input.automatic === true || input.autoApprove === true) {
    throw new Error('AUTOMATIC_MODE_FORBIDDEN');
  }
  if (input.live === true || input.liveEnabled === true || input.liveOrderEnabled === true) {
    throw new Error('LIVE_MODE_FORBIDDEN');
  }

  const accountMode = optionalString(input.accountMode);
  if (accountMode === 'live') throw new Error('LIVE_MODE_FORBIDDEN');
  if (options.requireAccountMode && accountMode == null) throw new Error('PAPER_ACCOUNT_MODE_REQUIRED');
  if (accountMode != null && !PAPER_ACCOUNT_MODES.has(accountMode as TradingAccountMode)) {
    throw new Error('PAPER_ACCOUNT_MODE_REQUIRED');
  }

  const adapter = optionalString(input.executionAdapter ?? input.brokerAdapter ?? input.adapter);
  if (adapter != null) {
    const allowed = accountMode === 'mock' ? MOCK_ADAPTERS : PAPER_ADAPTERS;
    if (!allowed.has(adapter)) throw new Error('PAPER_ADAPTER_REQUIRED');
  }
}

export function assertPaperApprovalPlan(plan: TradingPlan) {
  if (plan.accountMode === 'live') throw new Error('LIVE_MODE_FORBIDDEN');
  if (!PAPER_ACCOUNT_MODES.has(plan.accountMode)) throw new Error('PAPER_ACCOUNT_MODE_REQUIRED');
}

export function approvalOnlyPolicy(policy: TradingPolicy): TradingPolicy {
  return {
    ...policy,
    mode: 'approval',
    automaticEnabled: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
    enabledStrategies: [],
  };
}

export function paperApprovalReason(code: string) {
  const reasons: Record<string, string> = {
    APPROVAL_MODE_REQUIRED: '승인형 주문은 mode=approval만 허용됩니다.',
    AUTOMATIC_MODE_FORBIDDEN: '승인형 Paper 주문에서는 자동 승인과 automatic 모드를 사용할 수 없습니다.',
    PAPER_ACCOUNT_MODE_REQUIRED: '승인형 주문은 Paper 또는 명시적으로 허용된 mock 계정만 사용할 수 있습니다.',
    PAPER_ADAPTER_REQUIRED: '승인형 주문은 서버가 선택한 Paper/mock 어댑터만 사용할 수 있습니다.',
    LIVE_MODE_FORBIDDEN: '승인형 Paper 주문에서는 live 계정과 실주문 어댑터를 사용할 수 없습니다.',
  };
  return reasons[code] ?? '승인형 Paper 주문 안전 조건을 충족하지 못했습니다.';
}
