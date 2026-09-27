import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Eye, EyeOff, KeyRound, RefreshCw, WalletCards, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { resolveEvidenceDisplay } from '@/lib/evidence-display';

type Provider = 'toss' | 'kiwoom' | 'upbit' | 'bitget';
type CredentialProvider = Provider;
type AccountReadStatus = 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'STALE' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'UNAVAILABLE';

type CanonicalBalance = { currency: string; available: number | null; locked: number | null; total: number | null; estimatedKrwValue: number | null };
type CanonicalPosition = { market: string; symbol: string; quantity: number | null; availableQuantity: number | null; averageEntryPrice: number | null; currentPrice: number | null; marketValue: number | null; unrealizedPnl: number | null; unrealizedPnlPercent: number | null; leverage: number | null; liquidationPrice: number | null; marginMode: string | null; side: string | null };
type CanonicalAccount = { market: 'KR' | 'US' | 'UPBIT' | 'BITGET'; accountRef: string | null; currency: string | null; buyingPower: number | null };
type CanonicalAccountSnapshot = {
  provider: Provider; readOnly: true; connected: boolean; status: AccountReadStatus;
  accounts?: CanonicalAccount[] | null; balances?: CanonicalBalance[] | null; positions?: CanonicalPosition[] | null; openOrders?: Array<unknown> | null;
  checkedAt: string; lastGoodAt: string | null; stale: boolean; errorCode: string | null;
  orderRequests: 0; cancelRequests: 0; amendRequests: 0; transferRequests: 0; withdrawalRequests: 0;
  credentialsReturned: false; liveTradingEnabled: false; autoTradingEnabled: false;
};
type CredentialDraft = { first: string; second: string; third: string };
type Props = { canAccessSpot?: boolean; canAccessFutures?: boolean };
type DisplayCurrency = 'KRW' | 'USD';
type MoneyCurrency = 'KRW' | 'USD' | 'USDT';
type FxPoint = { krwRate: number; source: string; asOf: string; quality: string };
type AccountDisplayFx = {
  ok: true;
  displayCurrencies: readonly ['KRW', 'USD'];
  usdKrw: FxPoint | null;
  usdtKrw: FxPoint | null;
  missing: string[];
  checkedAt: string;
  publicMarketDataOnly: true;
};
type MoneyFact = { amount: number; currency: MoneyCurrency };

const EMPTY_CREDENTIALS: CredentialDraft = { first: '', second: '', third: '' };
const DISPLAY_CURRENCY_KEY = 'account-display-currency-v1';

function initialDisplayCurrency(): DisplayCurrency {
  if (typeof window === 'undefined') return 'KRW';
  return window.localStorage.getItem(DISPLAY_CURRENCY_KEY) === 'USD' ? 'USD' : 'KRW';
}

function validMoney(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function convertMoney(
  value: number | null | undefined,
  source: MoneyCurrency,
  target: DisplayCurrency,
  fx: AccountDisplayFx | null,
) {
  if (!validMoney(value)) return null;
  if (source === target) return value;
  const usdKrw = fx?.usdKrw?.krwRate;
  const usdtKrw = fx?.usdtKrw?.krwRate;
  if (source === 'KRW' && target === 'USD') return validMoney(usdKrw) && usdKrw > 0 ? value / usdKrw : null;
  if (source === 'USD' && target === 'KRW') return validMoney(usdKrw) && usdKrw > 0 ? value * usdKrw : null;
  if (source === 'USDT' && target === 'KRW') return validMoney(usdtKrw) && usdtKrw > 0 ? value * usdtKrw : null;
  if (source === 'USDT' && target === 'USD') {
    return validMoney(usdtKrw) && usdtKrw > 0 && validMoney(usdKrw) && usdKrw > 0
      ? value * (usdtKrw / usdKrw)
      : null;
  }
  return null;
}

function formatDisplayMoney(value: number | null, currency: DisplayCurrency) {
  if (!validMoney(value)) return '—';
  const digits = currency === 'KRW' ? 0 : 2;
  const formatted = new Intl.NumberFormat('ko-KR', {
    minimumFractionDigits: currency === 'USD' ? 2 : 0,
    maximumFractionDigits: digits,
  }).format(value);
  return currency === 'KRW' ? `₩${formatted}` : `$${formatted}`;
}

function summarizeFacts(facts: MoneyFact[], currency: DisplayCurrency, fx: AccountDisplayFx | null) {
  let value = 0;
  let converted = 0;
  let missing = 0;
  for (const fact of facts) {
    const amount = convertMoney(fact.amount, fact.currency, currency, fx);
    if (amount == null) {
      missing += 1;
      continue;
    }
    value += amount;
    converted += 1;
  }
  return {
    value: converted > 0 ? value : null,
    partial: missing > 0,
  };
}

function marketCurrency(market: string): MoneyCurrency | null {
  if (market === 'KR') return 'KRW';
  if (market === 'US') return 'USD';
  if (market === 'BITGET') return 'USDT';
  return null;
}

function validFxPoint(value: unknown): value is FxPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return typeof point.krwRate === 'number'
    && Number.isFinite(point.krwRate)
    && point.krwRate > 0
    && typeof point.asOf === 'string'
    && Number.isFinite(Date.parse(point.asOf))
    && typeof point.source === 'string'
    && typeof point.quality === 'string';
}

function validAccountDisplayFx(value: unknown): value is AccountDisplayFx {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fx = value as Record<string, unknown>;
  const pointOrNull = (point: unknown) => point === null || validFxPoint(point);
  return fx.ok === true
    && pointOrNull(fx.usdKrw)
    && pointOrNull(fx.usdtKrw)
    && Array.isArray(fx.missing)
    && fx.missing.every((item) => typeof item === 'string')
    && typeof fx.checkedAt === 'string'
    && Number.isFinite(Date.parse(fx.checkedAt))
    && fx.publicMarketDataOnly === true;
}

function evidenceAvailable(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return true;
  return snapshot.status !== 'AUTH_FAILED' && snapshot.status !== 'RATE_LIMITED' && snapshot.status !== 'UNAVAILABLE';
}

function accountEvidence(
  snapshot: CanonicalAccountSnapshot | undefined,
  value: number | string | null | undefined,
  formatter?: (value: number | string) => string,
) {
  return resolveEvidenceDisplay({
    value: snapshot?.connected ? value : null,
    collected: snapshot?.connected === true,
    stale: snapshot?.stale === true || snapshot?.status === 'STALE',
    available: evidenceAvailable(snapshot),
    formatter,
  }).display;
}

function amount(snapshot: CanonicalAccountSnapshot | undefined, value: number | null | undefined, currency?: string | null, suffix = '') {
  return accountEvidence(snapshot, value, (observed) => `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: currency === 'KRW' ? 0 : 8 }).format(Number(observed))}${suffix}`);
}

function countMetric(snapshot: CanonicalAccountSnapshot | undefined, value: number | null, suffix: string) {
  return accountEvidence(snapshot, value, (observed) => `${observed}${suffix}`);
}

function knownNonZeroCount<T>(rows: T[], select: (row: T) => number | null) {
  const values = rows.map(select);
  if (values.some((value) => value == null || !Number.isFinite(value))) return null;
  return values.filter((value) => value !== 0).length;
}

function isKnownNonZero(value: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

function credentialKnownConfigured(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return false;
  return snapshot.connected === true
    || snapshot.status === 'CONFIGURED_UNVERIFIED'
    || snapshot.status === 'STALE'
    || snapshot.status === 'AUTH_FAILED'
    || snapshot.status === 'RATE_LIMITED'
    || snapshot.status === 'UNAVAILABLE';
}

function statusLabel(snapshot?: CanonicalAccountSnapshot) {
  if (!snapshot) return '확인 전';
  if (snapshot.connected) return snapshot.stale ? '이전 정상값' : '연결됨';
  const labels: Record<AccountReadStatus, string> = { CONNECTED: '연결됨', CONFIGURED_UNVERIFIED: '검증 필요', NOT_CONFIGURED: '미연결', STALE: '이전 정상값', AUTH_FAILED: '인증 오류', RATE_LIMITED: '조회 제한', UNAVAILABLE: '조회 불가' };
  return labels[snapshot.status];
}

function Status({ snapshot }: { snapshot?: CanonicalAccountSnapshot }) {
  const connected = Boolean(snapshot?.connected);
  const caution = snapshot?.stale || snapshot?.status === 'CONFIGURED_UNVERIFIED' || snapshot?.status === 'RATE_LIMITED';
  const className = connected && !snapshot?.stale ? 'bg-positive/10 text-positive' : caution ? 'bg-warning/10 text-warning' : 'bg-secondary text-muted-foreground';
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>{statusLabel(snapshot)}</span>;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string; errorCode?: string };
  if (!response.ok) throw new Error(payload.errorCode ?? payload.error ?? `HTTP_${response.status}`);
  return payload;
}

export function BrokerageAccountConnections({ canAccessSpot = true, canAccessFutures = true }: Props) {
  const [snapshots, setSnapshots] = useState<Partial<Record<Provider, CanonicalAccountSnapshot>>>({});
  const [kiwoomSupported, setKiwoomSupported] = useState(false);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(initialDisplayCurrency);
  const [fx, setFx] = useState<AccountDisplayFx | null>(null);
  const [fxWarning, setFxWarning] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CredentialProvider | null>(null);
  const [credentials, setCredentials] = useState<CredentialDraft>(EMPTY_CREDENTIALS);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<CredentialProvider | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const enabledProviders = useCallback((): Provider[] => [
    'toss',
    ...(kiwoomSupported ? ['kiwoom' as const] : []),
    ...(canAccessSpot ? ['upbit' as const] : []),
    ...(canAccessFutures ? ['bitget' as const] : []),
  ], [canAccessFutures, canAccessSpot, kiwoomSupported]);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true); setError(''); setFxWarning('');

    const [results, fxResult] = await Promise.all([
      Promise.all(enabledProviders().map(async (provider) => {
        try {
          const value = await jsonRequest<CanonicalAccountSnapshot>(`/api/accounts/read-only/${provider}`, { signal: controller.signal });
          return { provider, value, error: null as string | null };
        } catch (cause) {
          if (controller.signal.aborted) return { provider, value: null, error: null };
          return { provider, value: null, error: cause instanceof Error ? cause.message : 'ACCOUNT_READ_FAILED' };
        }
      })),
      jsonRequest<AccountDisplayFx>('/api/accounts/read-only/fx', { signal: controller.signal })
        .then((value) => ({ value, error: null as string | null }))
        .catch((cause) => ({
          value: null,
          error: controller.signal.aborted ? null : cause instanceof Error ? cause.message : 'FX_UNAVAILABLE',
        })),
    ]);

    if (controller.signal.aborted || sequence !== requestSequence.current) return;
    setSnapshots((current) => {
      const next = { ...current };
      for (const result of results) if (result.value) next[result.provider] = result.value;
      return next;
    });
    const validFx = validAccountDisplayFx(fxResult.value) ? fxResult.value : null;
    setFx(validFx);
    setFxWarning(
      fxResult.error || (fxResult.value !== null && !validFx)
        ? '환율 조회 불가'
        : validFx?.missing.length
          ? '일부 환율 조회 불가'
          : '',
    );
    setError(results.filter((result) => result.error).map((result) => `${result.provider.toUpperCase()}: ${result.error}`).join(' · '));
    setLoading(false);
  }, [enabledProviders]);

  useLayoutEffect(() => {
    let active = true;
    void jsonRequest<{ supportedProviders?: string[] }>('/api/accounts/read-only/credentials/status')
      .then((value) => {
        if (active) setKiwoomSupported(Array.isArray(value.supportedProviders) && value.supportedProviders.includes('kiwoom'));
      })
      .catch(() => {
        if (active) setKiwoomSupported(false);
      });
    return () => { active = false; };
  }, []);

  useLayoutEffect(() => {
    void refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onOnline = () => void refresh();
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('online', onOnline);
    return () => {
      requestSequence.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  function chooseDisplayCurrency(currency: DisplayCurrency) {
    setDisplayCurrency(currency);
    if (typeof window !== 'undefined') window.localStorage.setItem(DISPLAY_CURRENCY_KEY, currency);
  }

  function openSetup(provider: CredentialProvider) { setEditing(provider); setCredentials(EMPTY_CREDENTIALS); setSaveMessage(''); }

  async function saveConnection() {
    if (!editing || !credentials.first.trim() || !credentials.second.trim() || (editing === 'bitget' && !credentials.third.trim())) {
      setSaveMessage('필수 조회 키를 모두 입력해 주세요.'); return;
    }
    const payload = editing === 'toss'
      ? { clientId: credentials.first.trim(), clientSecret: credentials.second.trim(), ...(credentials.third.trim() ? { accountSeq: credentials.third.trim() } : {}) }
      : editing === 'kiwoom'
        ? { appKey: credentials.first.trim(), appSecret: credentials.second.trim() }
        : editing === 'upbit'
          ? { accessKey: credentials.first.trim(), secretKey: credentials.second.trim() }
          : { apiKey: credentials.first.trim(), secretKey: credentials.second.trim(), passphrase: credentials.third.trim() };
    setSaving(true); setSaveMessage('');
    try {
      const result = await jsonRequest<{ configured: boolean; credentialsReturned: false }>(`/api/accounts/read-only/credentials/${editing}`, { method: 'PUT', body: JSON.stringify({ purpose: 'read_only', permissions: ['read'], credentials: payload }) });
      if (result.configured !== true || result.credentialsReturned !== false) throw new Error('READONLY_CREDENTIAL_SAVE_FAILED');
      const providerLabel = editing === 'toss' ? 'Toss' : editing === 'kiwoom' ? 'Kiwoom' : editing === 'upbit' ? 'Upbit' : 'Bitget';
      setCredentials(EMPTY_CREDENTIALS); setEditing(null); setSaveMessage(`저장 완료 · ${providerLabel} 조회 전용 키를 암호화 Vault에 저장했습니다.`); await refresh();
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : '조회 키를 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }

  async function disconnect(provider: CredentialProvider) {
    setDisconnecting(provider); setSaveMessage('');
    try {
      const result = await jsonRequest<{ configured: boolean; credentialsReturned: false }>(
        `/api/accounts/read-only/credentials/${provider}`,
        { method: 'DELETE' },
      );
      if (result.configured !== false || result.credentialsReturned !== false) {
        throw new Error('READONLY_CREDENTIAL_DELETE_FAILED');
      }
      setSnapshots((current) => {
        const next = { ...current };
        delete next[provider];
        return next;
      });
      setSaveMessage(`연결 해제 완료 · ${providerLabel(provider)} 조회 키를 삭제했습니다.`);
      await refresh();
    } catch (cause) {
      setSaveMessage(cause instanceof Error ? cause.message : '조회 연결을 해제하지 못했습니다.');
    } finally {
      setDisconnecting(null);
    }
  }

  const toss = snapshots.toss; const kiwoom = snapshots.kiwoom; const upbit = snapshots.upbit; const bitget = snapshots.bitget;
  const tossBalances = Array.isArray(toss?.balances) ? toss.balances : [];
  const tossPositions = Array.isArray(toss?.positions) ? toss.positions : [];
  const kiwoomBalances = Array.isArray(kiwoom?.balances) ? kiwoom.balances : [];
  const kiwoomPositions = Array.isArray(kiwoom?.positions) ? kiwoom.positions : [];
  const upbitBalances = Array.isArray(upbit?.balances) ? upbit.balances : [];
  const bitgetBalances = Array.isArray(bitget?.balances) ? bitget.balances : [];
  const bitgetPositions = Array.isArray(bitget?.positions) ? bitget.positions : [];
  const visibleTossPositions = tossPositions.filter((row) => isKnownNonZero(row.quantity));
  const visibleKiwoomPositions = kiwoomPositions.filter((row) => isKnownNonZero(row.quantity));
  const visibleUpbitBalances = upbitBalances.filter((row) => row.currency !== 'KRW' && isKnownNonZero(row.total));
  const visibleBitgetPositions = bitgetPositions.filter((row) => isKnownNonZero(row.quantity));
  const editingCredentialConfigured = editing ? credentialKnownConfigured(snapshots[editing]) : false;

  const positionFacts = (rows: CanonicalPosition[]) => rows.flatMap((row): MoneyFact[] => {
    const currency = marketCurrency(row.market);
    return currency && validMoney(row.marketValue) ? [{ amount: row.marketValue, currency }] : [];
  });
  const stockBalanceFacts = (rows: CanonicalBalance[]) => rows.flatMap((row): MoneyFact[] => {
    const currency = row.currency as MoneyCurrency;
    return (currency === 'KRW' || currency === 'USD') && validMoney(row.total)
      ? [{ amount: row.total, currency }]
      : [];
  });
  const accountBuyingPowerFacts = (accounts: CanonicalAccount[] | null | undefined) => (Array.isArray(accounts) ? accounts : []).flatMap((row): MoneyFact[] => {
    const currency = row.currency as MoneyCurrency | null;
    return currency && (currency === 'KRW' || currency === 'USD') && validMoney(row.buyingPower)
      ? [{ amount: row.buyingPower, currency }]
      : [];
  });

  const tossHoldingFacts = positionFacts(tossPositions);
  const tossTotalFacts = [...tossHoldingFacts, ...stockBalanceFacts(tossBalances)];
  const tossOrderFacts = accountBuyingPowerFacts(toss?.accounts);

  const kiwoomHoldingFacts = positionFacts(kiwoomPositions);
  const kiwoomTotalFacts = [...kiwoomHoldingFacts, ...stockBalanceFacts(kiwoomBalances)];
  const kiwoomOrderFacts = accountBuyingPowerFacts(kiwoom?.accounts);

  const upbitHoldingFacts = upbitBalances.flatMap((row): MoneyFact[] => (
    row.currency !== 'KRW' && validMoney(row.estimatedKrwValue)
      ? [{ amount: row.estimatedKrwValue, currency: 'KRW' }]
      : []
  ));
  const upbitCashFacts = upbitBalances.flatMap((row): MoneyFact[] => (
    row.currency === 'KRW' && validMoney(row.total) ? [{ amount: row.total, currency: 'KRW' }] : []
  ));
  const upbitTotalFacts = [...upbitCashFacts, ...upbitHoldingFacts];
  const upbitOrderFacts = upbitBalances.flatMap((row): MoneyFact[] => (
    row.currency === 'KRW' && validMoney(row.available) ? [{ amount: row.available, currency: 'KRW' }] : []
  ));

  const bitgetEquityFacts = bitgetBalances.flatMap((row): MoneyFact[] => {
    const currency = row.currency as MoneyCurrency;
    return (currency === 'USDT' || currency === 'USD' || currency === 'KRW') && validMoney(row.total)
      ? [{ amount: row.total, currency }]
      : [];
  });
  const bitgetHoldingFacts = positionFacts(bitgetPositions);
  const bitgetTotalFacts = bitgetEquityFacts;
  const bitgetOrderFacts = bitgetBalances.flatMap((row): MoneyFact[] => {
    const currency = row.currency as MoneyCurrency;
    return (currency === 'USDT' || currency === 'USD' || currency === 'KRW') && validMoney(row.available)
      ? [{ amount: row.available, currency }]
      : [];
  });

  const tossTotalPartial = toss?.connected === true && (
    tossBalances.length === 0
    || !tossBalances.some((row) => validMoney(row.total))
    || tossPositions.some((row) => !validMoney(row.marketValue))
  );
  const kiwoomTotalPartial = kiwoom?.connected === true && kiwoomPositions.some((row) => !validMoney(row.marketValue));
  const upbitTotalPartial = upbit?.connected === true && upbitBalances.some((row) => (
    row.currency !== 'KRW' && isKnownNonZero(row.total) && !validMoney(row.estimatedKrwValue)
  ));
  const bitgetTotalPartial = bitget?.connected === true && (
    bitgetEquityFacts.length === 0
    || bitgetBalances.some((row) => !['USDT', 'USD', 'KRW'].includes(row.currency) && isKnownNonZero(row.total))
  );

  const totalSummary = summarizeFacts(
    [...tossTotalFacts, ...kiwoomTotalFacts, ...upbitTotalFacts, ...bitgetTotalFacts],
    displayCurrency,
    fx,
  );
  const holdingsSummary = summarizeFacts(
    [...tossHoldingFacts, ...kiwoomHoldingFacts, ...upbitHoldingFacts, ...bitgetHoldingFacts],
    displayCurrency,
    fx,
  );
  const orderSummary = summarizeFacts(
    [...tossOrderFacts, ...kiwoomOrderFacts, ...upbitOrderFacts, ...bitgetOrderFacts],
    displayCurrency,
    fx,
  );
  const totalPartial = totalSummary.partial || tossTotalPartial || kiwoomTotalPartial || upbitTotalPartial || bitgetTotalPartial;
  const holdingsPartial = holdingsSummary.partial
    || tossPositions.some((row) => !validMoney(row.marketValue))
    || kiwoomPositions.some((row) => !validMoney(row.marketValue))
    || upbitTotalPartial
    || bitgetPositions.some((row) => isKnownNonZero(row.quantity) && !validMoney(row.marketValue));
  const connectedSnapshots = enabledProviders()
    .map((provider) => snapshots[provider])
    .filter((snapshot): snapshot is CanonicalAccountSnapshot => snapshot?.connected === true);
  const openOrdersKnown = connectedSnapshots.length > 0 && connectedSnapshots.every((snapshot) => Array.isArray(snapshot.openOrders));
  const openOrderCount = openOrdersKnown
    ? connectedSnapshots.reduce((sum, snapshot) => sum + (snapshot.openOrders?.length ?? 0), 0)
    : null;

  const providerMoney = (
    snapshot: CanonicalAccountSnapshot | undefined,
    facts: MoneyFact[],
    partial = false,
  ) => {
    if (!snapshot?.connected) return { value: '—', partial: false };
    const summary = summarizeFacts(facts, displayCurrency, fx);
    return {
      value: formatDisplayMoney(summary.value, displayCurrency),
      partial: partial || summary.partial,
    };
  };

  const tossTotal = providerMoney(toss, tossTotalFacts, tossTotalPartial);
  const tossHolding = providerMoney(toss, tossHoldingFacts, tossPositions.some((row) => !validMoney(row.marketValue)));
  const tossOrder = providerMoney(toss, tossOrderFacts);
  const kiwoomTotal = providerMoney(kiwoom, kiwoomTotalFacts, kiwoomTotalPartial);
  const kiwoomHolding = providerMoney(kiwoom, kiwoomHoldingFacts, kiwoomPositions.some((row) => !validMoney(row.marketValue)));
  const kiwoomOrder = providerMoney(kiwoom, kiwoomOrderFacts);
  const upbitTotal = providerMoney(upbit, upbitTotalFacts, upbitTotalPartial);
  const upbitHolding = providerMoney(upbit, upbitHoldingFacts, upbitTotalPartial);
  const upbitOrder = providerMoney(upbit, upbitOrderFacts);
  const bitgetTotal = providerMoney(bitget, bitgetTotalFacts, bitgetTotalPartial);
  const bitgetHolding = providerMoney(bitget, bitgetHoldingFacts, bitgetPositions.some((row) => isKnownNonZero(row.quantity) && !validMoney(row.marketValue)));
  const bitgetOrder = providerMoney(bitget, bitgetOrderFacts);

  return <section data-testid="brokerage-account-connections" className="mt-3 min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <WalletCards className="h-5 w-5 shrink-0 text-primary" />
        <h2 className="truncate text-base font-bold">실계좌</h2>
        <span className="rounded-full bg-positive/10 px-2 py-0.5 text-[10px] font-bold text-positive">조회 전용</span>
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <div className="inline-flex rounded-xl bg-secondary p-1" data-testid="account-display-currency">
          {(['KRW', 'USD'] as const).map((currency) => <button
            key={currency}
            type="button"
            aria-pressed={displayCurrency === currency}
            onClick={() => chooseDisplayCurrency(currency)}
            className={`min-h-9 rounded-lg px-3 text-xs font-bold ${displayCurrency === currency ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >{currency}</button>)}
        </div>
        <button type="button" aria-label="계좌 새로고침" disabled={loading} onClick={() => void refresh()} className="flex h-10 w-10 items-center justify-center rounded-xl border border-card-border text-muted-foreground disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>
    </div>

    <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="account-summary">
      <SummaryMetric label="실계좌 총금액" value={formatDisplayMoney(totalSummary.value, displayCurrency)} partial={totalPartial} />
      <SummaryMetric label="보유자산" value={formatDisplayMoney(holdingsSummary.value, displayCurrency)} partial={holdingsPartial} />
      <SummaryMetric label="주문가능" value={formatDisplayMoney(orderSummary.value, displayCurrency)} partial={orderSummary.partial} />
      <SummaryMetric label="미체결" value={openOrderCount == null ? '—' : `${openOrderCount}건`} partial={!openOrdersKnown && connectedSnapshots.length > 0} />
    </div>

    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span>최근 동기화 {latestCheckedAt(enabledProviders().map((provider) => snapshots[provider]))}</span>
      {fxWarning ? <span className="font-semibold text-warning">{fxWarning}</span> : null}
    </div>

    {error ? <p role="alert" className="mt-2 break-words rounded-xl bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">{error}</p> : null}
    {saveMessage ? <p role="status" className="mt-2 break-words rounded-xl bg-secondary px-3 py-2 text-xs font-semibold">{saveMessage}</p> : null}

    <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
      <ProviderCard
        provider="toss"
        title="Toss · 주식"
        snapshot={toss}
        total={tossTotal}
        holding={tossHolding}
        order={tossOrder}
        holdingCount={Array.isArray(toss?.positions) ? knownNonZeroCount(tossPositions, (row) => row.quantity) : null}
        openOrders={Array.isArray(toss?.openOrders) ? toss.openOrders.length : null}
        configured={credentialKnownConfigured(toss)}
        disconnecting={disconnecting === 'toss'}
        onSetup={() => openSetup('toss')}
        onDisconnect={() => void disconnect('toss')}
      >
        {visibleTossPositions.slice(0, 5).map((row, index) => {
          const currency = marketCurrency(row.market);
          const converted = currency ? convertMoney(row.marketValue, currency, displayCurrency, fx) : null;
          return <HoldingRow key={`${row.symbol}-${index}`} symbol={row.symbol} value={formatDisplayMoney(converted, displayCurrency)} meta={row.market} />;
        })}
      </ProviderCard>

      {kiwoomSupported ? <ProviderCard
        provider="kiwoom"
        title="Kiwoom · 주식"
        snapshot={kiwoom}
        total={kiwoomTotal}
        holding={kiwoomHolding}
        order={kiwoomOrder}
        holdingCount={Array.isArray(kiwoom?.positions) ? knownNonZeroCount(kiwoomPositions, (row) => row.quantity) : null}
        openOrders={Array.isArray(kiwoom?.openOrders) ? kiwoom.openOrders.length : null}
        configured={credentialKnownConfigured(kiwoom)}
        disconnecting={disconnecting === 'kiwoom'}
        onSetup={() => openSetup('kiwoom')}
        onDisconnect={() => void disconnect('kiwoom')}
      >
        {visibleKiwoomPositions.slice(0, 5).map((row, index) => {
          const currency = marketCurrency(row.market);
          const converted = currency ? convertMoney(row.marketValue, currency, displayCurrency, fx) : null;
          return <HoldingRow key={`${row.symbol}-${index}`} symbol={row.symbol} value={formatDisplayMoney(converted, displayCurrency)} meta={row.market} />;
        })}
      </ProviderCard> : null}

      {canAccessSpot ? <ProviderCard
        provider="upbit"
        title="Upbit · 현물"
        snapshot={upbit}
        total={upbitTotal}
        holding={upbitHolding}
        order={upbitOrder}
        holdingCount={Array.isArray(upbit?.balances) ? knownNonZeroCount(visibleUpbitBalances, (row) => row.total) : null}
        openOrders={Array.isArray(upbit?.openOrders) ? upbit.openOrders.length : null}
        configured={credentialKnownConfigured(upbit)}
        disconnecting={disconnecting === 'upbit'}
        onSetup={() => openSetup('upbit')}
        onDisconnect={() => void disconnect('upbit')}
      >
        {visibleUpbitBalances.slice(0, 5).map((row) => {
          const converted = validMoney(row.estimatedKrwValue)
            ? convertMoney(row.estimatedKrwValue, 'KRW', displayCurrency, fx)
            : null;
          const value = converted == null
            ? validMoney(row.total)
              ? `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 }).format(row.total)} ${row.currency}`
              : '—'
            : formatDisplayMoney(converted, displayCurrency);
          return <HoldingRow key={row.currency} symbol={row.currency} value={value} />;
        })}
      </ProviderCard> : null}

      {canAccessFutures ? <ProviderCard
        provider="bitget"
        title="Bitget · 선물"
        snapshot={bitget}
        total={bitgetTotal}
        holding={bitgetHolding}
        order={bitgetOrder}
        holdingCount={Array.isArray(bitget?.positions) ? knownNonZeroCount(bitgetPositions, (row) => row.quantity) : null}
        openOrders={Array.isArray(bitget?.openOrders) ? bitget.openOrders.length : null}
        configured={credentialKnownConfigured(bitget)}
        disconnecting={disconnecting === 'bitget'}
        onSetup={() => openSetup('bitget')}
        onDisconnect={() => void disconnect('bitget')}
      >
        {visibleBitgetPositions.slice(0, 5).map((row, index) => {
          const pnl = convertMoney(row.unrealizedPnl, 'USDT', displayCurrency, fx);
          return <HoldingRow key={`${row.symbol}-${row.side}-${index}`} symbol={row.symbol} value={formatDisplayMoney(pnl, displayCurrency)} meta={row.side ?? undefined} />;
        })}
      </ProviderCard> : null}
    </div>

    {editing ? <div className="fixed inset-0 z-50 flex items-end bg-black/55 p-3 sm:items-center sm:justify-center" role="presentation"><div role="dialog" aria-modal="true" aria-label={`${providerLabel(editing)} 조회 연결 설정`} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-card p-4 shadow-2xl"><div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2"><span aria-hidden className="h-11 w-11" /><div className="min-w-0 text-center"><h3 className="truncate text-base font-bold">{providerLabel(editing)} 조회 전용 연결</h3><p className="mt-1 text-xs text-muted-foreground">거래·출금 권한 없이 조회 키만 저장합니다.</p></div><button type="button" aria-label="연결 설정 닫기" onClick={() => setEditing(null)} className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border"><X className="h-4 w-4" /></button></div><div className="mt-4 space-y-3">
      <CredentialField testId={`${editing}-credential-primary`} label={editing === 'toss' ? 'Client ID' : editing === 'kiwoom' ? 'App Key' : editing === 'upbit' ? 'Access Key' : 'API Key'} value={credentials.first} onChange={(value) => setCredentials((current) => ({ ...current, first: value }))} configured={editingCredentialConfigured} />
      <CredentialField testId={`${editing}-credential-secret`} label={editing === 'toss' ? 'Client Secret' : editing === 'kiwoom' ? 'App Secret' : 'Secret Key'} value={credentials.second} onChange={(value) => setCredentials((current) => ({ ...current, second: value }))} configured={editingCredentialConfigured} />
      {editing === 'toss' ? <CredentialField testId="toss-account-seq" label="Account Seq (계좌가 여러 개인 경우만)" value={credentials.third} onChange={(value) => setCredentials((current) => ({ ...current, third: value }))} optional /> : null}
      {editing === 'bitget' ? <CredentialField testId="bitget-credential-passphrase" label="Passphrase" value={credentials.third} onChange={(value) => setCredentials((current) => ({ ...current, third: value }))} configured={editingCredentialConfigured} /> : null}
    </div><div className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-secondary p-3 text-center text-xs text-muted-foreground"><KeyRound className="h-4 w-4 shrink-0" /><span>저장된 키 원문은 다시 표시하지 않습니다.</span></div><button data-testid={`${editing}-save-connection`} type="button" aria-busy={saving} disabled={saving} onClick={() => void saveConnection()} className="mt-4 min-h-12 w-full rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{saving ? '저장 중…' : '조회 전용 키 저장'}</button></div></div> : null}
  </section>;
}

function providerLabel(provider: CredentialProvider) { return provider === 'toss' ? 'Toss' : provider === 'kiwoom' ? 'Kiwoom' : provider === 'upbit' ? 'Upbit' : 'Bitget'; }
function latestCheckedAt(values: Array<CanonicalAccountSnapshot | undefined>) { const timestamps = values.map((value) => value?.checkedAt).filter((value): value is string => Boolean(value)); if (!timestamps.length) return resolveEvidenceDisplay({ value: null }).display; return new Date(timestamps.sort().at(-1)!).toLocaleString('ko-KR'); }
function errorGuide(value: string) {
  if (value === 'UPBIT_IP_NOT_ALLOWED') return 'Upbit API 허용 IP에 서버 출구 IP를 등록해 주세요.';
  if (value === 'UPBIT_PERMISSION_DENIED') return 'Upbit API Key의 자산·주문조회 권한을 확인해 주세요.';
  if (value === 'UPBIT_AUTH_FAILED') return 'Upbit Access/Secret Key를 다시 확인해 주세요.';
  if (value === 'BITGET_IP_NOT_ALLOWED') return 'Bitget API IP 화이트리스트에 서버 출구 IP를 등록해 주세요.';
  if (value === 'BITGET_PERMISSION_DENIED') return 'Bitget API의 계좌·주문조회 권한을 확인해 주세요.';
  if (value === 'BITGET_AUTH_FAILED') return 'Bitget API Key·Secret·Passphrase를 다시 확인해 주세요.';
  if (value === 'BITGET_TIMESTAMP_REJECTED') return '서버 시각 동기화 후 Bitget 조회를 다시 시도해 주세요.';
  if (value === 'BITGET_PARAMETER_REJECTED') return 'Bitget 조회 파라미터가 거부되었습니다. 연동 버전과 계정 모드를 확인해 주세요.';
  if (value === 'BITGET_ACCOUNT_MODE_TRANSITION') return 'Bitget 계정 모드 전환 중입니다. 전환 완료 후 다시 조회해 주세요.';
  if (value.startsWith('TOSS_BUYING_POWER_')) return 'Toss 보유종목은 조회됐지만 현금 매수가능금액 일부를 가져오지 못했습니다.';
  if (value === 'KIWOOM_AUTH_OR_IP_REJECTED') return 'Kiwoom 실전 App Key·Secret과 인증 환경을 확인해 주세요.';
  if (value === 'RATE_LIMITED') return 'Provider 조회 제한에 도달했습니다. 잠시 뒤 다시 확인해 주세요.';
  if (value === 'PROVIDER_TIMEOUT') return 'Provider 응답 시간이 초과되었습니다.';
  if (value === 'PROVIDER_UNAVAILABLE') return 'Provider 연결이 현재 불안정합니다.';
  if (/_OPEN_ORDERS_/.test(value)) return '계좌 조회는 됐지만 미체결 주문 조회가 완료되지 않았습니다.';
  return value;
}
function ErrorLine({ value }: { value?: string | null }) {
  if (!value || value === 'ACCOUNT_READ_DISABLED' || value === 'ACCOUNT_NOT_CONFIGURED') return null;
  return <p className="mt-2 break-words text-xs font-semibold text-warning">{errorGuide(value)}</p>;
}

function SummaryMetric({ label, value, partial = false }: { label: string; value: string; partial?: boolean }) {
  return <div className="min-w-0 rounded-xl bg-secondary/60 px-3 py-2.5">
    <div className="flex min-w-0 items-center justify-between gap-2">
      <p className="truncate text-[10px] font-medium text-muted-foreground">{label}</p>
      {partial ? <span className="shrink-0 text-[9px] font-bold text-warning">일부</span> : null}
    </div>
    <p className="mt-1 truncate text-sm font-extrabold tabular-nums sm:text-base">{value}</p>
  </div>;
}

function HoldingRow({ symbol, value, meta }: { symbol: string; value: string; meta?: string }) {
  return <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-secondary/50 px-2.5 py-2 text-xs">
    <span className="min-w-0 truncate font-semibold">{symbol}{meta ? <span className="ml-1 text-[10px] font-medium text-muted-foreground">{meta}</span> : null}</span>
    <span className="shrink-0 font-semibold tabular-nums">{value}</span>
  </div>;
}

function ProviderCard({
  provider,
  title,
  snapshot,
  total,
  holding,
  order,
  holdingCount,
  openOrders,
  configured,
  disconnecting,
  onSetup,
  onDisconnect,
  children,
}: {
  provider: CredentialProvider;
  title: string;
  snapshot?: CanonicalAccountSnapshot;
  total: { value: string; partial: boolean };
  holding: { value: string; partial: boolean };
  order: { value: string; partial: boolean };
  holdingCount: number | null;
  openOrders: number | null;
  configured: boolean;
  disconnecting: boolean;
  onSetup: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  return <article className="min-w-0 rounded-xl border border-card-border bg-background p-3" data-testid={`connection-${provider}`}>
    <div className="flex min-w-0 items-center justify-between gap-2">
      <p className="truncate text-sm font-bold">{title}</p>
      <Status snapshot={snapshot} />
    </div>
    <div className="mt-2 grid grid-cols-3 gap-1.5">
      <SummaryMetric label="총금액" value={total.value} partial={total.partial} />
      <SummaryMetric label="보유금액" value={holding.value} partial={holding.partial} />
      <SummaryMetric label="주문가능" value={order.value} partial={order.partial} />
    </div>
    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span>보유 {holdingCount == null ? '—' : holdingCount}</span>
      <span>미체결 {openOrders == null ? '—' : openOrders}</span>
    </div>
    <div className="mt-2 max-h-36 space-y-1 overflow-y-auto overscroll-contain">{children}</div>
    <ConnectionActions provider={provider} configured={configured} disconnecting={disconnecting} onSetup={onSetup} onDisconnect={onDisconnect} />
    <ErrorLine value={snapshot?.errorCode} />
  </article>;
}

function ConnectionActions({ provider, configured, disconnecting, onSetup, onDisconnect }: { provider: CredentialProvider; configured: boolean; disconnecting: boolean; onSetup: () => void; onDisconnect: () => void }) {
  return <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
    <button type="button" aria-label={`${providerLabel(provider)} 조회 연결 설정`} onClick={onSetup} className="min-h-10 rounded-lg border border-card-border px-2 text-[11px] font-semibold">연결 설정</button>
    {configured ? <button type="button" aria-label={`${providerLabel(provider)} 조회 연결 해제`} disabled={disconnecting} onClick={onDisconnect} className="min-h-10 rounded-lg border border-destructive/40 px-2 text-[11px] font-semibold text-destructive disabled:opacity-50">{disconnecting ? '해제 중…' : '해제'}</button> : <span aria-hidden className="hidden sm:block" />}
  </div>;
}
function CredentialField({ testId, label, value, onChange, optional = false, configured = false }: { testId: string; label: string; value: string; onChange: (value: string) => void; optional?: boolean; configured?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const placeholder = configured ? '•••••••• 저장됨 · 변경 시 새 값 입력' : `${label} 입력`;
  return <label className="block"><span className="text-xs font-semibold text-muted-foreground">{label}{optional ? ' · 선택' : ''}</span><div className="relative mt-2"><input data-testid={testId} aria-label={label} type={revealed ? 'text' : 'password'} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(event) => onChange(event.currentTarget.value)} className="h-12 w-full rounded-2xl border border-card-border bg-background px-4 pr-12 text-sm font-medium outline-none placeholder:text-muted-foreground/70 focus:border-primary" /><button data-testid={`${testId}-visibility`} type="button" disabled={!value} aria-label={`${label} ${revealed ? '숨기기' : '보기'}`} onClick={() => setRevealed((current) => !current)} className="absolute inset-y-0 right-1 flex w-11 items-center justify-center rounded-xl text-muted-foreground disabled:opacity-35">{revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{value ? '입력됨 · 아직 저장 전입니다.' : configured ? '기존 키가 암호화 저장되어 있습니다. 원문은 다시 표시하지 않습니다.' : '조회 전용 키를 입력해 주세요.'}</span></label>;
}
