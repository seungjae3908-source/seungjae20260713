// Research results digest: the research center's results in plain Korean on
// the operations Telegram channel, because the app's Research Center page is
// byte-pinned and cannot show them yet.
//
// Once per KST day (from 09:00) it sends a short summary of the combination
// search, the exit-strategy comparison, the exploratory forward paper ledger
// and the research self-update. In between it sends only new milestones: a
// combination that passed the sealed holdout, a newly adopted exit method or
// a ledger rule that met the promotion bar (30 trades, 95% lower bound > 0,
// 3 symbols). Milestones are announced once.
//
// Read-only over latest/*.json. No trade rows, no account data, no secrets.
// None of this is a formal candidate or profit evidence; real orders stay
// behind the separate S-grade automatic-trading gate. executionAuthority NONE.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { opsTelegramConfigV1, sendOpsTelegramV1 } from './ops-watchdog-v1.mjs';
import { variantLabelKoV1 } from './exit-strategy-comparison-v1.mjs';

export const RESEARCH_RESULTS_DIGEST_CONTRACT_V1 = 'research-results-digest/v1';

export const RESEARCH_RESULTS_DIGEST_POLICY_V1 = Object.freeze({
  // Daily summary hour in KST (UTC+9, no daylight saving).
  digestHourKst: 9,
  // Telegram rejects messages above 4096 characters.
  maxMessageChars: 3_800,
  // Upper bound of remembered milestone keys so state stays small.
  maxRememberedMilestones: 2_000,
});

const KST_OFFSET_MS = 9 * 60 * 60_000;
const LANE_KO = Object.freeze({
  CRYPTO_SPOT_LONG: '코인현물 매수', CRYPTO_FUTURES_LONG: '코인선물 롱', CRYPTO_FUTURES_SHORT: '코인선물 숏',
  KR_STOCK_LONG: '국내주식 매수', US_STOCK_LONG: '해외주식 매수',
});
const SELF_UPDATE_KO = Object.freeze({
  UP_TO_DATE: '최신', NO_RESEARCH_CHANGE: '연구 변경 없음', VALIDATING: '격리 시험 중', CUTTING_OVER: '교체 중',
  UPDATED: '업데이트 완료', VALIDATION_FAILED: '격리 시험 실패(기존 버전 유지)', CUTOVER_FAILED: '교체 실패(기존 버전 복구)',
  AI_ACTIVATION_FAILED: 'AI 일정 전환 실패', WAITING_AFTER_FAILURE: '최근 실패, 나중에 재시도',
  DEFERRED_MANUAL_ACTIVATION: '수동 활성화 중이라 미룸', RESTORING_AI: 'AI 일정 복구 중', AI_RESTORED: 'AI 일정 복구 완료',
  AI_RESTORE_FAILED: 'AI 일정 복구 실패', MAIN_UNREADABLE: 'main 확인 실패', NO_CURRENT_RELEASE: '현재 버전 없음',
});

const laneName = (laneId) => LANE_KO[laneId] ?? String(laneId ?? '-');
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const r = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}R` : '-');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/** Reads one latest/*.json result; a corrupt or unexpected file counts as absent. */
async function readResult(stateRoot, name, contract) {
  try {
    const value = await readJson(join(stateRoot, 'latest', name));
    return value && value.contract === contract ? value : null;
  } catch {
    return null;
  }
}

export function kstDateV1(nowMs) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstHourV1(nowMs) {
  return new Date(nowMs + KST_OFFSET_MS).getUTCHours();
}

/** Pure: every milestone currently present, keyed so each is announced once. */
export function extractResearchMilestonesV1({ combination = null, exitComparison = null, exploratory = null } = {}) {
  const milestones = [];
  for (const lane of combination?.lanes ?? []) {
    for (const row of lane.paperCandidates ?? []) {
      if (!row?.trialId) continue;
      milestones.push({
        key: `holdout:${lane.laneId}:${row.trialId}`,
        text: `🎯 보류 표본(2026) 통과 조합: ${laneName(lane.laneId)} · ${(row.labels ?? row.atoms ?? []).join(' + ') || row.trialId}`,
      });
    }
  }
  for (const lane of exitComparison?.lanes ?? []) {
    if (lane.status !== 'COMPLETE') continue;
    for (const set of lane.signalSets ?? []) {
      const winner = set?.winner;
      if (winner?.status !== 'WINNER' || !winner.variantId) continue;
      milestones.push({
        key: `exit:${lane.laneId}:${set.signalSetId}:${winner.variantId}`,
        text: `🏁 청산 방식 채택: ${laneName(lane.laneId)} · ${set.label ?? set.signalSetId} → ${variantLabelKoV1(winner.variantId)} (검증 평균 ${r(winner.validationMeanR)})`,
      });
    }
  }
  for (const rule of exploratory?.rules ?? []) {
    if (rule?.promotionEligible !== true || !rule.ruleId) continue;
    milestones.push({
      key: `promotion:${rule.ruleId}`,
      text: `⭐ 탐색 장부 승격 기준 충족: ${laneName(rule.laneId)} · ${(rule.labels ?? []).join(' + ') || rule.ruleId} (엄격 표본 ${count(rule.forwardStrict?.n)}건, 95% 하한 ${r(rule.forwardStrict?.lower95)}) → 사람 승인 후 정식 검토`,
    });
  }
  return milestones;
}

/** Pure: the daily Korean summary, bounded to one Telegram message. */
export function formatResearchResultsDigestKoV1({ combination = null, exitComparison = null, exploratory = null, selfUpdate = null, observedAt, newMilestones = [], policy = RESEARCH_RESULTS_DIGEST_POLICY_V1 }) {
  const lines = ['[투자앱 연구 결과]', `기준 시각 ${observedAt} · 탐색용 결과(실주문 근거 아님)`];
  if (newMilestones.length > 0) {
    lines.push('', '새 소식');
    for (const row of newMilestones) lines.push(row.text);
  }
  lines.push('', '조합 탐색');
  if (!combination) lines.push('  아직 결과 없음');
  for (const lane of combination?.lanes ?? []) {
    if (lane.status === 'WAITING_FOR_DATA') { lines.push(`  ${laneName(lane.laneId)}: 데이터 대기`); continue; }
    lines.push(`  ${laneName(lane.laneId)}: 누적 시도 ${count(lane.cumulativeTrials ?? lane.trialsEvaluated)} · 합격 ${count(lane.survivors)} · 관찰 ${count(lane.watch)} · 탈락 ${count(lane.rejected)} · 보류 표본 통과 ${(lane.paperCandidates ?? []).length}`);
  }
  lines.push('', '청산 방식 비교');
  if (!exitComparison) lines.push('  아직 결과 없음');
  for (const lane of exitComparison?.lanes ?? []) {
    if (lane.status !== 'COMPLETE') { lane.status === 'WAITING_FOR_DATA' ? lines.push(`  ${laneName(lane.laneId)}: 데이터 대기`) : lines.push(`  ${laneName(lane.laneId)}: 다음 계산 대기`); continue; }
    const winners = (lane.signalSets ?? []).filter((set) => set?.winner?.status === 'WINNER');
    lines.push(`  ${laneName(lane.laneId)}: ${winners.length ? winners.map((set) => `${set.label ?? set.signalSetId} → ${variantLabelKoV1(set.winner.variantId)}`).join(' / ') : `신호 ${(lane.signalSets ?? []).length}개 모두 채택 기준 미달`}`);
  }
  lines.push('', '탐색용 모의 장부');
  if (!exploratory) lines.push('  아직 결과 없음');
  else {
    const totals = exploratory.totals ?? {};
    lines.push(`  규칙 ${(exploratory.rules ?? []).length}개 · 거래 ${count(totals.trades)}건(종료 ${count(totals.closed)} · 보유 ${count(totals.open)}) · 승격 기준 충족 ${count(totals.promotionEligibleRules)} · 강등 ${count(totals.demotedRules)}`);
  }
  if (selfUpdate) lines.push('', `연구 서버 업데이트: ${SELF_UPDATE_KO[selfUpdate.status] ?? '확인 필요'} · 설치 ${String(selfUpdate.currentSha ?? '-').slice(0, 7)}`);
  lines.push('', '실주문은 S급 신호와 별도 자동매매 관문만 사용합니다.');
  const text = lines.join('\n');
  return text.length <= policy.maxMessageChars ? text : `${text.slice(0, policy.maxMessageChars - 12)}\n…(이하 생략)`;
}

/** Pure decision: send the daily summary, a milestone note, or nothing. */
export function decideResearchDigestV1({ previous = null, milestones, nowMs, policy = RESEARCH_RESULTS_DIGEST_POLICY_V1 }) {
  const announced = new Set(previous?.announcedMilestones ?? []);
  const fresh = milestones.filter((row) => !announced.has(row.key));
  const today = kstDateV1(nowMs);
  const dailyDue = kstHourV1(nowMs) >= policy.digestHourKst && previous?.lastDigestDate !== today;
  return { kind: dailyDue ? 'DAILY' : fresh.length > 0 ? 'MILESTONE' : 'NONE', fresh, today };
}

export async function runResearchResultsDigestV1({
  stateRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  policy = RESEARCH_RESULTS_DIGEST_POLICY_V1,
} = {}) {
  if (!stateRoot) throw new Error('RESEARCH_DIGEST_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const nowMs = Date.parse(observedAt);
  const [combination, exitComparison, exploratory, selfUpdate] = await Promise.all([
    readResult(stateRoot, 'combination-research-v1.json', 'combination-search-lane/v1'),
    readResult(stateRoot, 'exit-strategy-comparison-v1.json', 'exit-strategy-comparison/v1'),
    readResult(stateRoot, 'exploratory-paper-ledger-v1.json', 'exploratory-paper-ledger/v1'),
    readResult(stateRoot, 'self-update-v1.json', 'research-self-update/v1'),
  ]);
  const statePath = join(stateRoot, 'research-results-digest', 'state.json');
  const previous = await readJson(statePath);
  const milestones = extractResearchMilestonesV1({ combination, exitComparison, exploratory });
  const decision = decideResearchDigestV1({ previous, milestones, nowMs, policy });
  const telegram = opsTelegramConfigV1(env);
  let delivery = 'NOTHING_DUE';
  if (decision.kind !== 'NONE') {
    const text = decision.kind === 'DAILY'
      ? formatResearchResultsDigestKoV1({ combination, exitComparison, exploratory, selfUpdate, observedAt, newMilestones: decision.fresh, policy })
      : ['[투자앱 연구 결과 · 새 소식]', ...decision.fresh.map((row) => row.text), '탐색용 결과(실주문 근거 아님)'].join('\n').slice(0, policy.maxMessageChars);
    if (!telegram) delivery = 'ALERT_CHANNEL_NOT_CONFIGURED';
    else {
      try { await sendOpsTelegramV1(telegram, text, fetchImpl); delivery = 'SENT'; }
      catch (error) { delivery = String(error?.message ?? 'OPS_TELEGRAM_FAILED').slice(0, 60); }
    }
  }
  // Only a delivered message advances state, so an unconfigured or failed
  // channel retries on the next tick instead of silently dropping news.
  if (delivery === 'SENT') {
    const announced = [...(previous?.announcedMilestones ?? []), ...decision.fresh.map((row) => row.key)];
    await atomicJson(statePath, {
      contract: RESEARCH_RESULTS_DIGEST_CONTRACT_V1,
      updatedAt: observedAt,
      lastDigestDate: decision.kind === 'DAILY' ? decision.today : previous?.lastDigestDate ?? null,
      announcedMilestones: announced.slice(-policy.maxRememberedMilestones),
    });
  }
  const summary = Object.freeze({
    contract: RESEARCH_RESULTS_DIGEST_CONTRACT_V1,
    observedAt,
    kind: decision.kind,
    newMilestones: decision.fresh.length,
    delivery,
    alertChannel: telegram ? 'TELEGRAM' : 'NOT_CONFIGURED',
    inputs: { combination: combination != null, exitComparison: exitComparison != null, exploratory: exploratory != null, selfUpdate: selfUpdate != null },
    formalCandidate: false,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  });
  await atomicJson(join(stateRoot, 'latest', 'research-results-digest-v1.json'), summary);
  return summary;
}
