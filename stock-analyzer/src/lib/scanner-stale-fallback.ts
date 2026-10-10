import type { ScannerResponse } from './signal-scanner';

export type ScannerFallbackError = Readonly<{
  status: number;
  code: string;
  retryAfterSeconds: number | null;
}>;

function fallbackReason(error: ScannerFallbackError): string {
  if (error.status === 409) return '동일 조건 분석이 이미 진행 중입니다. 기존 결과를 유지하며 완료를 기다립니다.';
  if (error.status === 429) {
    const retry = error.retryAfterSeconds == null ? '' : ` ${error.retryAfterSeconds}초 후`;
    return `검색 요청 한도를 보호하고 있습니다.${retry} 다음 갱신을 기다립니다.`;
  }
  return '시장데이터 공급자 응답이 불안정합니다. 마지막 정상 결과를 유지합니다.';
}

/** A last-good result is only a historical reference, never a new S/A alert.
 * The server's immutable quality grade cannot authorize an expired signal.
 * Keep original times and price provenance; never forge a fresh snapshot.
 */
export function createScannerStaleFallback(
  response: ScannerResponse,
  error: ScannerFallbackError,
): ScannerResponse {
  const reason = fallbackReason(error);
  const cards = response.cards.map((card) => ({
    ...card,
    signalGrade: 'B' as const,
    action: 'NONE' as const,
    signalState: 'WEAKENED' as const,
    dataState: 'stale' as const,
    strongSignalEligible: false,
    warnings: [...new Set([...card.warnings, reason])],
    ...(card.candidateRanking
      ? {
          candidateRanking: {
            ...card.candidateRanking,
            watchCompletionPercent: Math.min(99, card.candidateRanking.watchCompletionPercent),
            watchReasons: [...new Set([...card.candidateRanking.watchReasons, '이전 시점 결과: 최신 데이터 재검증 필요'])].slice(0, 5),
          },
        }
      : {}),
  }));
  return {
    ...response,
    cards,
    alerts: [],
    execution: {
      ...response.execution,
      partial: true,
      duplicate: response.execution.duplicate || error.status === 409,
      ...(response.execution.sGradeCount === undefined ? {} : { sGradeCount: 0 }),
      ...(response.execution.aGradeCount === undefined ? {} : { aGradeCount: 0 }),
      ...(response.execution.bGradeCount === undefined ? {} : { bGradeCount: cards.length }),
    },
    universe: { ...response.universe, partial: true, stale: true },
    dataState: 'stale',
    message: `${response.message} · ${reason}`,
    refreshIssue: {
      status: error.status as 409 | 429 | 502,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      message: reason,
    },
  };
}
