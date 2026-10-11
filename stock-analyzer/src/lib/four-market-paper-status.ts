/** Owner-scoped read-only 4-market Paper status, never an order or capital receipt. */
export const PAPER_FOUR_MARKET_KEYS = [
  { key: 'domestic_stock', label: '국내주식' },
  { key: 'us_stock', label: '미국주식' },
  { key: 'crypto_spot', label: '코인현물' },
  { key: 'crypto_futures', label: '코인선물' },
] as const;
export type FourPaperMarket = typeof PAPER_FOUR_MARKET_KEYS[number]['key'];
export type FourPaperMarketReadback = Readonly<{
  settlementReady: boolean;
  newEntriesAllowed: boolean;
  operatingCapitalKrw: number | null;
  reserveKrw: number | null;
  dailyLosingTrades: number | null;
  settledTrades: number | null;
  blockers: readonly string[];
}>;
export type FourPaperReadOnlyStatus = Readonly<{
  ownerScope: 'SELF';
  role: 'admin' | 'member';
  rlsGuardReady: boolean;
  ready: boolean;
  canCreate: boolean;
  creationBlockers: readonly string[];
  perMarketInitialKrw: 1000000;
  totalInitialKrw: 4000000;
  marketCapital: Readonly<Record<FourPaperMarket, FourPaperMarketReadback>>;
}>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safeCodes = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 120 && value.every(code =>
    typeof code === 'string' && code.length > 0 && code.length <= 256);
export function parseFourPaperReadOnlyStatus(raw: unknown): FourPaperReadOnlyStatus {
  if (!isRecord(raw)
    || raw.ok !== true || raw.mode !== 'four-market-paper-readiness-only'
    || raw.readOnlyProbe !== true || raw.ownerScope !== 'SELF'
    || !['admin','member'].includes(String(raw.role))
    || typeof raw.ready !== 'boolean' || typeof raw.canCreate !== 'boolean'
    || typeof raw.rlsGuardReady !== 'boolean'
    || raw.totalInitialKrw !== 4000000 || raw.perMarketInitialKrw !== 1000000
    || !safeCodes(raw.creationBlockers)
    || raw.financialMutationCount !== 0 || raw.privateProviderRequests !== 0
    || raw.orderSubmitted !== false || raw.exchangeRequestSent !== false
    || raw.liveTradingAuthorityGranted !== false
    || raw.autoTradingAuthorityGranted !== false
    || raw.transferAuthorityGranted !== false
    || raw.withdrawalAuthorityGranted !== false
    || !isRecord(raw.marketCapital)) {
    throw new Error('PAPER_FOUR_MARKET_READ_ONLY_CONTRACT_INVALID');
  }
  if (raw.ready && !raw.rlsGuardReady) {
    throw new Error('PAPER_FOUR_MARKET_UNVERIFIED_RLS_READY');
  }
  for (const {key} of PAPER_FOUR_MARKET_KEYS) {
    const lane = raw.marketCapital[key];
    if (!isRecord(lane)
      || typeof lane.settlementReady !== 'boolean'
      || typeof lane.newEntriesAllowed !== 'boolean'
      || !safeCodes(lane.blockers)) {
      throw new Error('PAPER_FOUR_MARKET_INVALID_LANE_' + key);
    }
    // Four-market wallet readiness is independent from settlement readiness.
    // A missing wallet or RLS guard can never authorize a new Paper entry.
    if ((!raw.ready && lane.settlementReady) ||
      (lane.newEntriesAllowed && (!raw.ready || !raw.rlsGuardReady || !lane.settlementReady))) {
      throw new Error('PAPER_FOUR_MARKET_UNVERIFIED_ADMISSION_' + key);
    }
    if (lane.settlementReady === true) {
      if (!safeAmount(lane.operatingCapitalKrw)
        || !safeAmount(lane.reserveKrw)
        || !Number.isSafeInteger(lane.dailyLosingTrades)
        || Number(lane.dailyLosingTrades) < 0
        || !Number.isSafeInteger(lane.settledTrades)
        || Number(lane.settledTrades) < 0
        || lane.blockers.length > 0) {
        throw new Error('PAPER_FOUR_MARKET_UNVERIFIED_EQUITY_' + key);
      }
    } else if (lane.operatingCapitalKrw !== null || lane.reserveKrw !== null
      || lane.dailyLosingTrades !== null || lane.settledTrades !== null
      || lane.newEntriesAllowed !== false) {
      // UNKNOWN is never a provably zero loss, settled reserve, or usable cash.
      throw new Error('PAPER_FOUR_MARKET_UNKNOWN_BALANCE_' + key);
    }
  }
  return raw as unknown as FourPaperReadOnlyStatus;
}

/** Wallet existence, settlement evidence and entry permission are distinct. */
export function summarizeFourPaperReadOnlyStatus(status: FourPaperReadOnlyStatus): string {
  if (!status.rlsGuardReady) return '회원 DB 보호 미적용';
  if (!status.ready) return '모의계좌·이력 준비 필요';
  const markets = PAPER_FOUR_MARKET_KEYS.map(({key}) => status.marketCapital[key]);
  if (markets.some(market => !market.settlementReady)) return '계좌 확인 · 일부 시장 정산 미확인';
  if (markets.some(market => !market.newEntriesAllowed)) return '정산 확인 · 일부 시장 신규진입 차단';
  return '4시장 계좌·정산·진입 검증됨';
}
