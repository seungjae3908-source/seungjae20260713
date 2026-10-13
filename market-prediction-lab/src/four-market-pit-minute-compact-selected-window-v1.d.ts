/** Type-only boundary for the OFFLINE JS PIT minute compact day receipt.
 * SHA-256 self-check is not provider authentication or investment approval. */
export type ResearchPITMinuteMarket =
  | 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type ResearchPITMinuteResearchDates = Readonly<{
  startDate: string; endDate: string;
}>;
export type ResearchPITMinuteCompactReceipt = Readonly<{
  schemaVersion: 'four-market-pit-minute-compact-day-receipt-v1';
  receiptSha256: string;
  market: ResearchPITMinuteMarket;
  tradingDate: string;
  executionAuthority: 'NONE';
  profitabilityProven: false;
  actualFillCount: null;
  trueMarketWideRecall: null;
  [key: string]: unknown;
}>;
export function sealPITMinuteDayCompactReceiptV1(input: {
  summary: Readonly<Record<string, unknown>>;
  manifest: Readonly<Record<string, unknown>>;
}): ResearchPITMinuteCompactReceipt;
export function auditCompactPITMinuteSelectedWindowChunkV1(input: {
  market: ResearchPITMinuteMarket;
  researchWindow: ResearchPITMinuteResearchDates;
  cursorDate?: string | null;
  chunkCalendarDays?: number;
  stockTradingDates?: readonly string[] | null;
  dayReceipts?: readonly ResearchPITMinuteCompactReceipt[];
}): Readonly<Record<string, unknown>>;
