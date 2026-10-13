import { useMemo, useState } from 'react';
import { CheckCircle2, PlayCircle, ShieldCheck, XCircle } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';

type RehearsalMarketRow = {
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  direction: 'BUY' | 'LONG' | 'SHORT';
  strategyId: string;
  status: 'ACTIVE_REHEARSAL' | 'BLOCKED_REHEARSAL';
  wouldActivateLiveAuto: boolean;
  blockers: string[];
};

type ProviderStatus = {
  configured: boolean;
  accountMode: string | null;
  liveConnectionVerified: boolean;
  reusableReadonlyCredential: boolean;
  readOnlyVerified: boolean;
  ready: boolean;
  lastErrorCode: string | null;
  credentialsExposed: false;
};

type RehearsalPayload = {
  ok: boolean;
  error?: string;
  mode?: 'DRIFT_REHEARSAL' | 'ISOLATED_PR_PREVIEW';
  preview?: {
    isolated: true;
    passed: boolean;
    memberDataRead: false;
    providerCredentialsRead: false;
    providerGateSimulated: true;
    credentialGateSimulated: true;
    telegramDelivered: false;
    telegramMutationAttempted: false;
    persistentJournalRead: false;
    productionDataRead: false;
  };
  exceptionPolicy?: string;
  signal?: {
    deterministicRuleReady: boolean;
    productionSignalCreated: boolean;
  };
  ai?: {
    positiveDecision: 'PASS';
    vetoDecision: 'VETO';
    vetoBlocked: boolean;
    liveAiProviderInvokedByThisEndpoint: boolean;
  };
  providers?: Record<'toss' | 'kiwoom' | 'upbit' | 'bitget', ProviderStatus>;
  credentialReuse?: Record<'toss' | 'kiwoom' | 'upbit' | 'bitget', {
    configured: boolean;
    reusable: boolean;
    readOnlyVerified: boolean;
    errorCode: string | null;
    credentialsExposed: false;
  }>;
  paper?: {
    paperAutoReady: boolean;
    paperFillReady: boolean;
    journalReady: boolean;
    riskReady: boolean;
    orderState: string | null;
    fillCount: number;
    journalEntryCount: number;
    executionAuthority: 'NONE';
    realOrderSubmitted: false;
    exchangeRequestSent: false;
    providerMutationRequests: 0;
    productionMutationAllowed: false;
  };
  journal?: {
    paperJournalProjectionReady: boolean;
    journalEndpointReadReady: boolean;
    ready: boolean;
    persistentMutationPerformedByThisEndpoint: false;
  };
  telegram?: {
    ready: boolean;
    testMessageRequestedByThisEndpoint: false;
  };
  futures?: {
    marginMode: string | null;
    maxLeverage: number;
    isolatedReady: boolean;
    leverageReady: boolean;
  };
  markets?: RehearsalMarketRow[];
  wouldActivateLiveAuto?: boolean;
  executionAuthority?: 'NONE';
  realOrderSubmitted?: false;
  actualOrderSubmitted?: false;
  exchangeRequestSent?: false;
  providerMutationRequests?: 0;
  productionMutationAllowed?: false;
  liveTradingActivated?: false;
  automaticLiveExecutionActivated?: false;
};

type ProbeState = {
  journalReadReady: boolean;
  journalMessage: string;
  telegramReady: boolean;
  telegramMessage: string;
};

function ResultBadge({ pass, pending = false, text }: { pass: boolean; pending?: boolean; text?: string }) {
  const label = text ?? (pending ? '대기' : pass ? 'PASS' : 'FAIL');
  return (
    <span className={[
      'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold',
      pending
        ? 'bg-muted text-muted-foreground'
        : pass
          ? 'bg-emerald-500/10 text-emerald-700'
          : 'bg-destructive/10 text-destructive',
    ].join(' ')}>
      {pending ? null : pass ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function marketReady(rows: RehearsalMarketRow[] | undefined, market: RehearsalMarketRow['market'], direction: RehearsalMarketRow['direction']) {
  return rows?.find((row) => row.market === market && row.direction === direction)?.wouldActivateLiveAuto === true;
}

export function FormulaAiAutoRehearsalPanel({ isolatedPreview = false }: { isolatedPreview?: boolean }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RehearsalPayload | null>(null);
  const [probes, setProbes] = useState<ProbeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerSummary = useMemo(() => {
    if (!result?.providers) return null;
    const entries = Object.entries(result.providers);
    return {
      ready: entries.filter(([, row]) => row.ready).length,
      total: entries.length,
      reusable: entries.filter(([, row]) => row.reusableReadonlyCredential).length,
    };
  }, [result]);

  const runRehearsal = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setProbes(null);

    if (isolatedPreview) {
      try {
        const response = await fetch('/api/preview/auto-rehearsal/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmed: true }),
        });
        const payload = await response.json().catch(() => null) as RehearsalPayload | null;
        if (!response.ok || !payload) {
          throw new Error(payload?.error ?? `AUTO_REHEARSAL_PREVIEW_HTTP_${response.status}`);
        }
        setProbes({
          journalReadReady: payload.paper?.journalReady === true,
          journalMessage: payload.paper?.journalReady === true
            ? 'Paper 엔진 Journal 생성 PASS'
            : 'Paper 엔진 Journal 확인 필요',
          telegramReady: payload.preview?.telegramMutationAttempted === false,
          telegramMessage: '실제 Telegram 전송 없음 · 안전성 PASS',
        });
        setResult(payload);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '격리 리허설을 실행하지 못했습니다.');
      } finally {
        setRunning(false);
      }
      return;
    }

    let journalReadReady = false;
    let journalMessage = '거래일지 조회 실패';
    try {
      const response = await authorizedFetch('/api/paper-journal/snapshot?limit=1');
      const payload = await response.json().catch(() => null) as { ok?: boolean; code?: string; error?: string } | null;
      journalReadReady = response.ok && payload?.ok !== false;
      journalMessage = journalReadReady
        ? '서버 거래일지 조회 PASS'
        : payload?.code ?? payload?.error ?? `HTTP ${response.status}`;
    } catch {
      journalMessage = '서버 거래일지에 연결하지 못했습니다.';
    }

    let telegramReady = false;
    let telegramMessage = 'Telegram 미연결';
    try {
      const stateResponse = await authorizedFetch('/api/user-integrations');
      const state = await stateResponse.json().catch(() => null) as {
        ok?: boolean;
        telegram?: { connected?: boolean; status?: string };
        telegramRuntime?: { deliveryReady?: boolean };
        error?: string;
      } | null;
      const connected = stateResponse.ok
        && state?.ok !== false
        && state?.telegram?.connected === true
        && state?.telegramRuntime?.deliveryReady === true;
      if (connected) {
        const testResponse = await authorizedFetch('/api/user-integrations/telegram/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'AUTO_REHEARSAL' }),
        });
        const testPayload = await testResponse.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        telegramReady = testResponse.ok && testPayload?.ok !== false;
        telegramMessage = telegramReady
          ? '테스트 메시지 전송 PASS'
          : testPayload?.error ?? `HTTP ${testResponse.status}`;
      } else {
        telegramMessage = state?.error
          ?? (state?.telegram?.connected !== true ? '개인 Telegram 연결 필요' : 'Telegram 전송 런타임 준비 필요');
      }
    } catch {
      telegramMessage = 'Telegram 상태를 확인하지 못했습니다.';
    }

    const nextProbes = { journalReadReady, journalMessage, telegramReady, telegramMessage };
    setProbes(nextProbes);

    try {
      const response = await authorizedFetch('/api/trade-automation/rehearsal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          journalReadReady,
          telegramReady,
        }),
      });
      const payload = await response.json().catch(() => null) as RehearsalPayload | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `AUTO_REHEARSAL_HTTP_${response.status}`);
      }
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '자동매매 리허설을 실행하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const markets = result?.markets;
  const formulaPass = Boolean(result?.signal?.deterministicRuleReady)
    && Boolean(markets?.length)
    && markets!.every((row) => row.status === 'ACTIVE_REHEARSAL');
  const futuresPass = marketReady(markets, 'CRYPTO_FUTURES', 'LONG')
    && marketReady(markets, 'CRYPTO_FUTURES', 'SHORT');
  const finalReady = isolatedPreview
    ? result?.preview?.passed === true
    : result?.wouldActivateLiveAuto === true
      && probes?.journalReadReady === true
      && probes?.telegramReady === true;

  const rows = [
    { label: '수식+AI 전략', pass: formulaPass, value: formulaPass ? 'PASS' : '확인 필요' },
    { label: '국내주식 BUY', pass: marketReady(markets, 'KR_STOCK', 'BUY'), value: marketReady(markets, 'KR_STOCK', 'BUY') ? 'READY' : 'BLOCKED' },
    { label: '미국주식 BUY', pass: marketReady(markets, 'US_STOCK', 'BUY'), value: marketReady(markets, 'US_STOCK', 'BUY') ? 'READY' : 'BLOCKED' },
    { label: '코인현물 BUY', pass: marketReady(markets, 'CRYPTO_SPOT', 'BUY'), value: marketReady(markets, 'CRYPTO_SPOT', 'BUY') ? 'READY' : 'BLOCKED' },
    { label: '코인선물 LONG / SHORT', pass: futuresPass, value: futuresPass ? 'READY' : 'BLOCKED' },
    { label: 'AI Gate', pass: result?.ai?.positiveDecision === 'PASS' && result?.ai?.vetoBlocked === true, value: result ? 'PASS · VETO 차단 PASS' : '대기' },
    {
      label: '4 Provider',
      pass: isolatedPreview ? result?.preview?.providerGateSimulated === true : providerSummary?.ready === 4,
      value: isolatedPreview
        ? (result ? '격리 Gate 4/4 · 실계정 미조회' : '대기')
        : providerSummary ? `${providerSummary.ready}/${providerSummary.total} READY` : '대기',
    },
    {
      label: 'Credential Reuse',
      pass: isolatedPreview ? result?.preview?.credentialGateSimulated === true : providerSummary?.reusable === 4,
      value: isolatedPreview
        ? (result ? '격리 Gate PASS · 실제 키 미조회' : '대기')
        : providerSummary ? `${providerSummary.reusable}/${providerSummary.total} PASS` : '대기',
    },
    { label: 'Paper 자동주문', pass: result?.paper?.paperFillReady === true, value: result?.paper?.paperFillReady ? `체결 PASS · ${result.paper.fillCount} fill` : '대기' },
    { label: 'Journal', pass: isolatedPreview ? result?.paper?.journalReady === true : result?.journal?.ready === true, value: probes?.journalMessage ?? '대기' },
    { label: isolatedPreview ? 'Telegram 안전성' : 'Telegram', pass: isolatedPreview ? result?.preview?.telegramMutationAttempted === false : result?.telegram?.ready === true, value: probes?.telegramMessage ?? '대기' },
    {
      label: 'Bitget',
      pass: result?.futures?.isolatedReady === true
        && result?.futures?.leverageReady === true
        && (isolatedPreview || result?.providers?.bitget?.ready === true),
      value: result?.futures
        ? `${result.futures.marginMode ?? '미설정'} / ${result.futures.maxLeverage || '-'}×${result.providers?.bitget?.lastErrorCode ? ` · ${result.providers.bitget.lastErrorCode}` : ' · Provider 오류 없음'}`
        : '대기',
    },
    { label: 'OOS 예외', pass: result?.exceptionPolicy === 'FORMULA_AI_LIVE_EXCEPTION_V1', value: result?.exceptionPolicy ?? '대기' },
    { label: 'AUTO 결과', pass: finalReady, value: result ? (isolatedPreview ? `PREVIEW_CHAIN = ${finalReady ? 'TRUE' : 'FALSE'}` : `WOULD_ACTIVATE = ${finalReady ? 'TRUE' : 'FALSE'}`) : '대기' },
    { label: '실제 주문', pass: result?.realOrderSubmitted === false, value: result ? '0건' : '0건' },
  ];

  return (
    <section className="space-y-3" data-testid="formula-ai-auto-rehearsal-panel">
      <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-base font-bold">자동매매 활성화 리허설</h2>
            </div>
            <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
              {isolatedPreview
                ? '로그인/회원승인 없이 수식+AI Gate → 위험검사 → 실제 Paper 엔진 entry/fill/close/Journal 생성까지 격리 실행합니다. 실계정 Provider·Credential·Telegram·운영 데이터는 읽거나 변경하지 않습니다.'
                : '테스트 신호 → AI Gate → 위험검사 → 실제 Paper 엔진 체결 → Journal 조회 → Telegram 테스트 → LIVE 사전검사를 순서대로 확인합니다. 이 화면은 LIVE/AUTO/REAL 권한을 켜지 않고 거래소 주문을 전송하지 않습니다.'}
            </p>
          </div>
          <ResultBadge pass={finalReady} pending={!result && !error} text={result ? (finalReady ? '활성화 가능' : '보완 필요') : '실행 전'} />
        </div>

        <button
          type="button"
          disabled={running}
          onClick={() => void runRehearsal()}
          data-testid="run-auto-rehearsal"
          className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {running ? '리허설 실행 중…' : '자동매매 활성화 리허설 실행'}
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          리허설 실패: {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-card-border bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-card-border px-4 py-3 text-xs font-bold text-muted-foreground">
          <span>확인 항목</span>
          <span>결과</span>
        </div>
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-card-border px-4 py-3 last:border-b-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{row.label}</p>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">{row.value}</p>
            </div>
            <ResultBadge pass={row.pass} pending={!result && row.label !== '실제 주문'} />
          </div>
        ))}
      </div>

      {!isolatedPreview && result?.providers ? (
        <div className="rounded-2xl border border-card-border bg-card p-4" data-testid="rehearsal-provider-grid">
          <h3 className="text-sm font-bold">Provider 연결 상세</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['toss', 'kiwoom', 'upbit', 'bitget'] as const).map((provider) => {
              const state = result.providers![provider];
              return (
                <div key={provider} className="rounded-xl border border-card-border bg-background p-3">
                  <p className="text-xs font-bold uppercase">{provider}</p>
                  <div className="mt-2"><ResultBadge pass={state.ready} /></div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {state.liveConnectionVerified ? '실거래 연결 검증됨' : state.readOnlyVerified ? 'Read-only 검증됨' : state.lastErrorCode ?? '검증 필요'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className={[
          'rounded-2xl border p-4',
          finalReady ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5',
        ].join(' ')} data-testid="auto-rehearsal-final-verdict">
          <p className="text-base font-bold">{finalReady ? (isolatedPreview ? '✅ 격리 리허설 체인 PASS' : '✅ 자동매매 활성화 가능') : '⚠️ 활성화 전 보완 필요'}</p>
          <div className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
            <span>실주문 권한: <strong>OFF</strong></span>
            <span>실주문: <strong>0건</strong></span>
            <span>운영 변경: <strong>0건</strong></span>
          </div>
          {isolatedPreview ? (
            <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
              Preview는 회원승인과 무관하게 동작하며 실제 Provider 연결상태·저장 키·Telegram 전달상태를 판정하지 않습니다. 해당 항목은 로그인 가능한 Staging/운영 환경에서 별도 확인합니다.
            </p>
          ) : null}
          {!isolatedPreview && !finalReady && markets ? (
            <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
              차단 사유: {markets.flatMap((row) => row.blockers).filter((value, index, values) => values.indexOf(value) === index).join(', ') || 'Journal/Telegram/Provider 상태를 확인하세요.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
