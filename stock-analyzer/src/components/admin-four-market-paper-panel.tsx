import { useEffect, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';

type AdminMarket = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
const MARKETS: readonly { key: AdminMarket; label: string }[] = [
  { key: 'domestic_stock', label: '국내주식' },
  { key: 'us_stock', label: '미국주식' },
  { key: 'crypto_spot', label: '코인현물' },
  { key: 'crypto_futures', label: '코인선물' },
];
const INITIAL_KRW = 1_000_000;
const BASE = '/api/paper-journal/admin-four-market';
const CONFIRMATION = 'START_ADMIN_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY';
const POLICY_CONFIRMATION = 'SET_ADMIN_FOUR_MARKETS_1M_PAPER_POLICY';

type MarketWallet = {
  market: AdminMarket;
  ready: boolean;
  initialCapitalKrw: number;
  equityKrw: number | null;
  availableMarginKrw: number | null;
  reserveKrw: number | null;
};
type AdminWalletStatus = {
  marketCapital: Record<AdminMarket,{
    settlementReady: boolean;
    blockers: string[];
    operatingCapitalKrw: number | null;
    reserveKrw: number | null;
    newEntriesAllowed: boolean;
    dailyLosingTrades: number | null;
  }>;
  marketCapitalComputedFrom: string;
  ready: boolean;
  canCreate: boolean;
  initialCapitalKrw: number;
  marketWallets: Record<AdminMarket, MarketWallet>;
  creationBlockers: string[];
  blockers: string[];
  historical: { plans: number; orders: number; journalRows: number; historyPreserved: boolean };
  policy: { totalCapitalKrw: number; maxOrderKrw: number; bitgetLeverage: number };
};
type AdminStatusWire = AdminWalletStatus & {
  ok: boolean; readOnlyProbe: boolean; ownerScope: string; administratorOnly: boolean;
  financialMutationCount: number; privateProviderRequests: number;
  orderSubmitted: boolean; exchangeRequestSent: boolean;
};
function money(value: number) {
  return Math.round(value).toLocaleString('ko-KR') + '원';
}
async function readStatus(signal?: AbortSignal): Promise<AdminWalletStatus> {
  const response = await authorizedFetch(BASE + '/status', { signal });
  const value = await response.json().catch(() => null) as AdminStatusWire | null;
  if (!response.ok || value?.ok !== true || value.readOnlyProbe !== true
    || value.ownerScope !== 'SELF' || value.administratorOnly !== true
    || value.financialMutationCount !== 0 || value.privateProviderRequests !== 0
    || value.orderSubmitted !== false || value.exchangeRequestSent !== false
    || !Array.isArray(value.blockers) || !Array.isArray(value.creationBlockers)
    || value.initialCapitalKrw !== 4_000_000
    || value.marketCapitalComputedFrom !== 'CANONICAL_CURRENT_EPOCH_SETTLEMENT_ONLY'
    || !value.marketCapital || MARKETS.some(m => {
      const balance = value.marketCapital[m.key];
      return !balance || typeof balance.settlementReady !== 'boolean'
        || typeof balance.newEntriesAllowed !== 'boolean'
        || !Array.isArray(balance.blockers)
        || (balance.settlementReady && (
          typeof balance.operatingCapitalKrw !== 'number'
          || typeof balance.reserveKrw !== 'number'
        ));
    })) {
    throw new Error('ADMIN_MARKET_PAPER_STATUS_UNAVAILABLE');
  }
  return value;
}
async function confirmedPost(endpoint: string, confirmation: string): Promise<Record<string, unknown>> {
  const response = await authorizedFetch(BASE + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation }),
  });
  const value = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || value?.ok !== true || value?.orderSubmitted !== false
    || value?.exchangeRequestSent !== false || value?.liveTradingEnabledByThisRequest === true
    || value?.liveTradingAuthorityGranted === true) {
    throw new Error(typeof value?.code === 'string' ? value.code : 'ADMIN_MARKET_PAPER_SETUP_BLOCKED');
  }
  return value;
}
/**
 * V2 is a completely separate, admin-only virtual ledger. Rendering or
 * refreshing this panel never enables auto-trading or places an order.
 */
export function AdminFourMarketPaperPanel() {
  const [status, setStatus] = useState<AdminWalletStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function reload() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await readStatus(controller.signal);
        if (!controller.signal.aborted) { setStatus(next); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) { setStatus(null); setFailed(true); }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void reload();
    const id = window.setInterval(() => void reload(), 60_000);
    return () => { controller.abort(); window.clearInterval(id); };
  }, [revision]);
  async function prepare() {
    if (!status || status.ready || busy || failed) return;
    // The current server's policy may still be 100k; the explicit action
    // changes the Paper budgeting floor without expanding maxOrder or leverage.
    if (!window.confirm(
      '관리자 전용 모의자본을 국내주식·미국주식·코인현물·코인선물 각각 100만원, 합계 400만원으로 준비합니다. 과거 거래 기록은 삭제하거나 청산 처리하지 않습니다. 실계좌 입출금과 실주문은 실행되지 않습니다. 계속할까요?',
    )) return;
    setBusy(true);
    setMessage('');
    try {
      await confirmedPost('/prepare-policy', POLICY_CONFIRMATION);
      const afterPolicy = await readStatus();
      if (!afterPolicy.canCreate) throw new Error(
        afterPolicy.creationBlockers[0] ?? 'ADMIN_MARKET_PAPER_HISTORY_RECONCILIATION_REQUIRED');
      const result = await confirmedPost('/bootstrap', CONFIRMATION);
      if (result.ready !== true || result.initialCapitalKrw !== 4_000_000
        || result.automaticWithdrawalEnabled !== false) {
        throw new Error('ADMIN_MARKET_PAPER_READBACK_INVALID');
      }
      const verified = await readStatus();
      if (!verified.ready || MARKETS.some((m) =>
        verified.marketWallets[m.key]?.initialCapitalKrw !== INITIAL_KRW
        || verified.marketWallets[m.key]?.ready !== true)) {
        throw new Error('ADMIN_MARKET_PAPER_SERVER_READBACK_FAILED');
      }
      setStatus(verified);
      setFailed(false);
      setRevision((n) => n + 1);
      setMessage('4시장 각각 100만원 가상계좌의 서버 저장·조회를 확인했습니다. 실거래는 활성화되지 않았습니다.');
    } catch {
      // Never blindly retry an atomic write: the first request might already
      // have succeeded when its response was lost. Re-read state instead.
      try { const verified = await readStatus(); setStatus(verified); setFailed(false); }
      catch { setStatus(null); setFailed(true); }
      setMessage('안전조건 또는 저장 검증 때문에 준비가 중단됐습니다. 서버 상태를 확인한 뒤 다시 진행하세요.');
    } finally { setBusy(false); }
  }
  const hasHistoricalConflict = status?.creationBlockers.some((code) =>
    code.includes('PARTIAL_WALLET') || code.includes('EXISTING_ACCOUNT')
    || code.includes('EPOCH_') || code.includes('WALLETS_ALREADY_CREATED')) === true;
  const memberAutoActive = status?.creationBlockers.includes('ADMIN_PAPER_MEMBER_AUTO_MUST_BE_OFF') === true;
  const serverLiveAutoActive = status?.creationBlockers.includes('ADMIN_PAPER_REAL_AUTO_GATE_MUST_BE_OFF') === true;
  return (
    <section className="rounded-2xl border border-card-border bg-card p-4"
      data-testid="admin-four-market-paper-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">관리자 · 4시장 독립 자동모의자본</h2>
        <span className="text-xs font-semibold">
          {failed ? '조회 불가' : loading ? '조회 중' : status?.ready ? '4시장 계좌 확인' : '준비 필요'}
        </span>
      </div>
      <p className="mt-2 break-keep text-xs text-muted-foreground">
        시장별 기준자본 100만원 · 총 400만원 · 수익은 시장별 50% 복리/50% 예비금.
        실제 입출금 없이 시장마다 별도의 가상 잔고와 위험을 관리합니다.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="admin-four-market-wallets">
        {MARKETS.map(({ key, label }) => {
          const value = status?.marketWallets?.[key];
          const actual = status?.marketCapital?.[key];
          return (
            <div key={key} className="rounded-xl border border-card-border p-3">
              <p className="text-xs font-semibold">{label}</p>
              <p className="mt-1 text-sm font-bold">
                {value?.ready && actual?.settlementReady
                  ? money(actual.operatingCapitalKrw ?? INITIAL_KRW)
                  : '기준 원금 ' + money(INITIAL_KRW)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {value?.ready
                  ? actual?.settlementReady
                    ? `검증된 예비금 ${money(actual.reserveKrw ?? 0)} · 당일 손실 ${actual.dailyLosingTrades ?? 0}회`
                    : '정산 자료 부족 · 현재 운용잔고/예비금 미확정'
                  : '미생성 · 다른 시장의 자금은 사용할 수 없음'}
              </p>
            </div>
          );
        })}
      </div>
      {status && !status.ready ? (
        <p className="mt-2 text-xs text-muted-foreground">
          기존 모의 주문 {status.historical.orders}건과 일지 {status.historical.journalRows}건은 보존합니다.
          {hasHistoricalConflict ? ' 기존 계좌·거래 이력 충돌을 먼저 확인해야 합니다.' : ''}
          {memberAutoActive || serverLiveAutoActive
            ? ' 자본 정책 변경 전 자동매매와 실자동매매 권한을 OFF로 해주세요.' : ''}
        </p>
      ) : null}
      {message ? <p role="status" className="mt-2 text-xs">{message}</p> : null}
      {!status?.ready ? (
        <button type="button" onClick={() => void prepare()}
          disabled={!status || failed || busy || hasHistoricalConflict || memberAutoActive || serverLiveAutoActive}
          className="mt-3 min-h-11 rounded-xl border border-card-border px-4 text-sm font-semibold disabled:opacity-50"
          data-testid="admin-four-market-paper-prepare">
          {busy ? '서버 안전검증 및 계좌 준비 중' : '4시장 각각 100만원 계좌 준비'}
        </button>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        관리자 계좌 준비는 1회성입니다. 기존 자금·위험 한도를 임의로 재설정하거나 실주문을 실행하지 않습니다.
      </p>
    </section>
  );
}
