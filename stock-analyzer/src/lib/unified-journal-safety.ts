import type { UnifiedTradeJournal } from './paper-journal-sync';

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function assertUnifiedTradeJournalSafety(
  result: UnifiedTradeJournal | undefined,
): asserts result is UnifiedTradeJournal {
  if (!result
    || result.aiReviewStatus !== 'AI_EXTERNAL_REVIEW_DISABLED_FREE_ONLY'
    || result.toss.liveReadIntegration !== 'BLOCKED_BY_FREE_STATUS_UNVERIFIED'
    || result.safety.finalCostDelta !== '0_KRW'
    || result.safety.actualOrderRequests !== 0
    || result.safety.cancelRequests !== 0
    || result.safety.amendRequests !== 0
    || result.safety.transferRequests !== 0
    || result.safety.withdrawalRequests !== 0
    || !isNonNegativeInteger(result.safety.privateBrokerRequests)) {
    throw new Error('통합 매매일지의 조회 전용·무주문 안전 계약을 확인하지 못했습니다.');
  }

  const history = result.liveAccountHistory;
  if (!history) {
    if (result.safety.privateBrokerRequests !== 0) {
      throw new Error('실계좌 거래이력 근거 없이 private 조회 횟수가 보고되었습니다.');
    }
    return;
  }

  if (history.persisted !== false
    || !isNonNegativeInteger(history.privateProviderRequests)
    || !Number.isInteger(history.effectiveDays)
    || history.effectiveDays < 1
    || history.effectiveDays > 30
    || history.safety.orderRequests !== 0
    || history.safety.cancelRequests !== 0
    || history.safety.amendRequests !== 0
    || history.safety.transferRequests !== 0
    || history.safety.withdrawalRequests !== 0
    || history.safety.credentialsReturned !== false
    || history.safety.liveTradingEnabled !== false
    || history.safety.autoTradingEnabled !== false) {
    throw new Error('실계좌 거래이력의 조회 전용 안전 계약을 확인하지 못했습니다.');
  }

  const providerIds = new Set<string>();
  let providerRequestTotal = 0;
  for (const provider of history.providers) {
    if ((provider.provider !== 'upbit' && provider.provider !== 'bitget' && provider.provider !== 'kiwoom')
      || providerIds.has(provider.provider)
      || !isNonNegativeInteger(provider.privateProviderRequests)
      || !isNonNegativeInteger(provider.records)) {
      throw new Error('실계좌 거래이력 공급자 근거를 확인하지 못했습니다.');
    }
    providerIds.add(provider.provider);
    providerRequestTotal += provider.privateProviderRequests;

    if ((provider.status === 'NOT_CONFIGURED' || provider.status === 'DISABLED')
      && (provider.privateProviderRequests !== 0 || provider.records !== 0)) {
      throw new Error('미연결·비활성 공급자에서 private 조회 또는 거래이력이 보고되었습니다.');
    }
  }

  const realizedEvidence = history.realizedEvidence ?? [];
  if (!Array.isArray(realizedEvidence)
    || realizedEvidence.some((row) => (
      row.provider !== 'kiwoom'
      || row.market !== 'KR'
      || row.evidenceType !== 'DAILY_CASH_REALIZED'
      || row.canonicalAnalyticsPromoted !== false
      || !/^\d{8}$/.test(row.date)
      || !/^\d{6}$/.test(row.symbol)
      || (row.buyAveragePrice != null && (!Number.isFinite(row.buyAveragePrice) || row.buyAveragePrice <= 0))
      || (row.buyQuantity != null && (!Number.isFinite(row.buyQuantity) || row.buyQuantity <= 0))
      || typeof row.sellAveragePrice !== 'number'
      || !Number.isFinite(row.sellAveragePrice)
      || row.sellAveragePrice <= 0
      || typeof row.sellQuantity !== 'number'
      || !Number.isFinite(row.sellQuantity)
      || row.sellQuantity <= 0
      || (row.feesAndTax != null && (!Number.isFinite(row.feesAndTax) || row.feesAndTax < 0))
      || (row.providerReportedPnl != null && !Number.isFinite(row.providerReportedPnl))
      || (row.providerReportedReturnPercent != null && !Number.isFinite(row.providerReportedReturnPercent))
    ))) {
    throw new Error('Kiwoom 국내 실현손익 증거 계약을 확인하지 못했습니다.');
  }
  if (realizedEvidence.length > 0) {
    const kiwoom = history.providers.find((provider) => provider.provider === 'kiwoom');
    if (!kiwoom || (kiwoom.status !== 'READY' && kiwoom.status !== 'PARTIAL')) {
      throw new Error('Kiwoom 공급자 상태 없이 국내 실현손익 증거가 보고되었습니다.');
    }
  }

  if (providerRequestTotal !== history.privateProviderRequests
    || history.privateProviderRequests !== result.safety.privateBrokerRequests) {
    throw new Error('실계좌 READ-ONLY 조회 횟수 근거가 일치하지 않습니다.');
  }
}
