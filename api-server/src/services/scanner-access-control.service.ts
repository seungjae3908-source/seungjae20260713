import type { MemberTier } from '../../../packages/member-access/src/index.js';
import type {
  ScannerResponse,
  ScannerSignalGrade,
} from './scanner-signal.types';

const SCANNER_GRADES: readonly ScannerSignalGrade[] = ['S', 'A', 'B', 'C', 'D'];

export function parseScannerGradeQuery(value: unknown): ScannerSignalGrade | undefined | null {
  if (value == null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim().toUpperCase();
  return SCANNER_GRADES.includes(normalized as ScannerSignalGrade)
    ? normalized as ScannerSignalGrade
    : null;
}

export function canReadScannerGrade(tier: MemberTier, grade: ScannerSignalGrade): boolean {
  return tier === 'admin' || grade !== 'S';
}

export function filterScannerResponseForTier(
  response: ScannerResponse,
  tier: MemberTier,
  requestedGrade?: ScannerSignalGrade,
): ScannerResponse {
  const hiddenSignalIds = new Set(
    response.cards
      .filter((card) => !canReadScannerGrade(tier, card.signalGrade ?? 'D'))
      .map((card) => card.signalId),
  );
  const hiddenSymbols = new Set(
    response.cards
      .filter((card) => hiddenSignalIds.has(card.signalId))
      .map((card) => card.symbol),
  );

  const cards = response.cards.filter((card) => {
    const grade = card.signalGrade ?? 'D';
    if (!canReadScannerGrade(tier, grade)) return false;
    return requestedGrade == null || grade === requestedGrade;
  });
  const visibleSignalIds = new Set(cards.map((card) => card.signalId));

  return {
    ...response,
    cards,
    alerts: response.alerts.filter((alert) => visibleSignalIds.has(alert.signalId)),
    failures: response.failures.filter((failure) => !hiddenSymbols.has(failure.symbol)),
  };
}
