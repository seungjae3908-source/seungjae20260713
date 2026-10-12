import { OriginalMinuteBacktestPanelContent } from '@/components/original-minute-backtest-panel';
import { createOriginalMinuteClient, validateOriginalMinuteRun, type OriginalMinuteBacktestRequestV1, type OriginalMinuteBacktestRunV1 } from '@/lib/original-minute-backtest';
import { normalizeOriginalMinuteBacktestRequestV1, ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 } from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

declare global {
  interface Window { __originalMinuteRecordedRun?: unknown }
}

// This page is reachable only behind the existing VITE_PHASE5_E2E route gate.
// Default scenarios use synthetic data. Recorded mode accepts only a validated,
// externally injected result. Neither injected transport contacts an API.
function fixtureRun(selection: OriginalMinuteBacktestRequestV1, runId: string, status: OriginalMinuteBacktestRunV1['status']): OriginalMinuteBacktestRunV1 {
  const selectedDays = (Date.parse(selection.endDate) - Date.parse(selection.startDate)) / 86_400_000 + 1;
  return {
    ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1, schemaVersion: 'original-minute-backtest-run-v1', runId, selection, status,
    reason: status === 'BLOCKED_DATA' ? 'ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE' : null,
    createdAtMs: Date.now() - 1000, finishedAtMs: status === 'RUNNING' ? null : Date.now(),
    blockers: status === 'BLOCKED_DATA' ? ['ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE'] : [],
    source: { evidenceScope: 'HISTORICAL_PIT_ROSTER', sourceClass: 'TEST_FIXTURE', fixtureOnly: true,
      currentRosterDigestSha256: null, currentRosterObservedAtMs: null, historicalPITRosterChecked: true,
      sourceSessionIndexDigestSha256: 'a'.repeat(64), sourceModelDigestSha256: 'b'.repeat(64) },
    coverage: { indexedPrivateSessions: status === 'COMPLETED' ? selectedDays : null,
      verifiedNativeMinuteSessions: status === 'COMPLETED' ? selectedDays : null,
      missingSourceDays: status === 'BLOCKED_DATA' ? selectedDays : 0, missingExpectedStockSessions: null,
      blockedDatesPreview: status === 'BLOCKED_DATA' ? [selection.startDate] : [], blockedDate: null },
    report: status === 'COMPLETED' ? {
      kind: 'PERIOD', status: 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY', selectedStartDate: selection.startDate,
      selectedEndDate: selection.endDate, symbol: selection.symbol, timeframe: selection.timeframe, direction: selection.direction,
      sourceSessionsVerified: selectedDays, modeledTradeCount: 4, modeledWins: 3, modeledLosses: 1,
      modeledReturnPercent: 1.5, modeledNetPnlKRW: selection.initialCapitalKRW * 0.015,
      modeledCostKRW: 500, modeledMaxDrawdownPercent: 2, modeledEndingCapitalKRW: selection.initialCapitalKRW * 1.015,
      modeledProfitReserveKRW: 0, sessionClosePolicy: 'CLOSE_EACH_SOURCE_SESSION',
      horizonReturns: [1, 7, 30, 90, 180, 365, 1095, 1825, 3650].map(horizonDays => ({
        horizonDays, requiredStartDate: new Date(Date.parse(selection.endDate) - (horizonDays - 1) * 86_400_000).toISOString().slice(0, 10),
        status: selectedDays >= horizonDays ? 'MODELED_SOURCE_ONLY' : 'BLOCKED_DATA',
        modeledReturnPercent: selectedDays >= horizonDays ? 1.5 : null, reason: selectedDays >= horizonDays ? null : 'SELECTED_WINDOW_SHORTER_THAN_HORIZON',
      })),
      canonicalPaperResearchReview: { status: 'RESEARCH_HOLD', blockerCount: 2, blockers: ['FIXTURE_IS_NOT_REAL_MARKET_DATA', 'INDEPENDENT_OOS_NOT_PROVEN'],
        canonicalProfitabilityStatus: 'RESEARCH_HOLD', canonicalPaperBridgeStatus: 'BLOCKED', canonicalPaperBridgeBlockers: ['PROFITABILITY_NOT_PROVEN'],
        paperAdmissionAllowed: false, executionAuthority: 'NONE' },
      independentOOSProven: false, independentFullCostProven: false, originalHistoricalSignalVerified: false,
      actualFillCount: null, profitabilityProven: false, paperCandidatePASS: false, executionAuthority: 'NONE',
    } : null,
  };
}

const jobs = new Map<string, OriginalMinuteBacktestRunV1>();
function recordedResponse(url: RequestInfo | URL, init?: RequestInit): Response {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const raw = window.__originalMinuteRecordedRun;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('selection' in raw)) return json({}, 400);
  let recorded: OriginalMinuteBacktestRunV1;
  try {
    const selection = normalizeOriginalMinuteBacktestRequestV1(raw.selection);
    recorded = validateOriginalMinuteRun(raw, selection);
  } catch { return json({}, 400); }
  if (recorded.status !== 'COMPLETED' && recorded.status !== 'BLOCKED_DATA') return json({}, 400);
  const root = '/api/backtests/original-minute/runs';
  if (init?.method === 'POST' && String(url) === root) {
    let selection: OriginalMinuteBacktestRequestV1;
    try { selection = normalizeOriginalMinuteBacktestRequestV1(JSON.parse(String(init.body))); }
    catch { return json({}, 400); }
    if (JSON.stringify(selection) !== JSON.stringify(recorded.selection)) return json({}, 400);
    const accepted: OriginalMinuteBacktestRunV1 = { ...recorded, status: 'RUNNING', report: null,
      finishedAtMs: null, reason: null, blockers: [] };
    jobs.set(accepted.runId, accepted);
    return json(accepted, 202);
  }
  if (init?.method === 'GET' && String(url) === `${root}/${recorded.runId}`) {
    const accepted = jobs.get(recorded.runId);
    if (!accepted || JSON.stringify(accepted.selection) !== JSON.stringify(recorded.selection)) return json({}, 404);
    return json(recorded, 200);
  }
  return json({}, 405);
}
const client = createOriginalMinuteClient(async (url, init) => {
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  if (scenario === 'recorded') return recordedResponse(url, init);
  await new Promise(resolve => setTimeout(resolve, scenario === 'slow-accept' && init?.method === 'POST' ? 250 : 25));
  let job: OriginalMinuteBacktestRunV1;
  if (init?.method === 'POST') {
    const selection = JSON.parse(String(init.body)) as OriginalMinuteBacktestRequestV1;
    job = fixtureRun(selection, crypto.randomUUID(), 'RUNNING'); jobs.set(job.runId, job);
  } else {
    const runId = String(url).split('/').at(-1)!;
    const prior = jobs.get(runId);
    if (!prior) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    job = fixtureRun(prior.selection, runId, init?.method === 'DELETE' ? 'CANCELLED' : scenario === 'blocked' ? 'BLOCKED_DATA' : scenario === 'slow' || scenario === 'slow-accept' ? 'RUNNING' : 'COMPLETED');
    jobs.set(runId, job);
  }
  return new Response(JSON.stringify(scenario === 'invalid' && init?.method === 'GET' ? { ...job, profitabilityProven: true } : job), {
    status: init?.method === 'POST' ? 202 : 200, headers: { 'Content-Type': 'application/json' },
  });
});

export default function OriginalMinuteBacktestE2EPage() {
  const recorded = new URLSearchParams(window.location.search).get('scenario') === 'recorded';
  return <div className="flex h-dvh min-h-0 flex-col bg-background"><p className="shrink-0 bg-muted px-3 py-2 text-xs font-semibold">{recorded ? '보관한 실제 원본 자료의 사후 연구 결과 · 로컬 화면 QA · 공급원·주문 호출 없음' : '로컬 UI 테스트 · 합성 원본 · 실제 API 호출 없음'}</p><div className="min-h-0 flex-1"><OriginalMinuteBacktestPanelContent client={client} /></div></div>;
}
