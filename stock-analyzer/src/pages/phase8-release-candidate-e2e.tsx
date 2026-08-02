import { useMemo, useState } from 'react';
import { ShieldCheck, ShieldX, UserCog } from 'lucide-react';
import {
  MEMBER_TIER_LABELS,
  hasCapability,
  type MemberCapability,
  type MemberTier,
} from '../../../packages/member-access/src/index.js';
import { paperOwnerNamespace } from '@/lib/paper-journal-sync-storage';

const USERS = ['phase8-user-a', 'phase8-user-b'] as const;
const STEP_LABELS = [
  '선물 데이터 조회', '계약 규칙 조회', '리스크 미리보기', '백테스트 실행',
  '모의주문', '부분청산', '전체청산', '거래일지 생성', '서버 동기화',
  '거래 분석', 'review dataset 생성',
] as const;

const REQUIRED: MemberCapability[] = [
  'canAccessFutures', 'canAccessFutures', 'canAccessRiskPreview', 'canAccessBacktests',
  'canAccessPaperTrading', 'canAccessPaperTrading', 'canAccessPaperTrading', 'canAccessPaperTrading',
  'canAccessJournalSync', 'canAccessTradingAnalytics', 'canAccessTradingAnalytics',
];

function SafetyContract() {
  return <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3" data-testid="phase8-safety-contract">
    <span className="rounded-xl bg-emerald-500/10 p-2 font-bold">orderSubmitted=false</span>
    <span className="rounded-xl bg-emerald-500/10 p-2 font-bold">exchangeRequestSent=false</span>
    <span className="rounded-xl bg-emerald-500/10 p-2 font-bold">externalAiCalled=false</span>
  </div>;
}

export default function Phase8ReleaseCandidateE2EPage() {
  const [tier, setTier] = useState<MemberTier>('regular');
  const [userIndex, setUserIndex] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [syncStatus, setSyncStatus] = useState<'local-only'|'syncing'|'completed'|'failed'>('local-only');
  const [failure, setFailure] = useState(false);
  const [reason, setReason] = useState('신규 회원 승인');
  const [memberTier, setMemberTier] = useState<MemberTier>('pending');
  const [memberActive, setMemberActive] = useState(true);
  const [audit, setAudit] = useState<string[]>([]);
  const [adminError, setAdminError] = useState('');
  const activeUser = USERS[userIndex];
  const namespace = useMemo(() => paperOwnerNamespace(activeUser), [activeUser]);

  function resetFlow(nextTier = tier) {
    setCompleted(0); setSyncStatus('local-only'); setFailure(false); setTier(nextTier);
  }

  function runStep(index: number) {
    if (index !== completed || !hasCapability(tier, REQUIRED[index])) return;
    if (failure && index === 8) { setSyncStatus('failed'); return; }
    if (index === 8) { setSyncStatus('syncing'); window.setTimeout(() => setSyncStatus('completed'), 10); }
    if (index === 7) {
      const key = `phase8.rc.journal:${namespace}`;
      const current = Number(window.localStorage.getItem(key) ?? '0');
      window.localStorage.setItem(key, String(current + 1));
    }
    setCompleted(index + 1);
  }

  function switchAccount() {
    setUserIndex((value) => value ? 0 : 1);
    setCompleted(0); setSyncStatus('local-only'); setFailure(false);
  }

  function applyAdminChange(targetTier = memberTier, targetActive = memberActive) {
    if (reason.trim().length < 3) { setAdminError('변경 사유를 3자 이상 입력하세요.'); return; }
    setAdminError('');
    setMemberTier(targetTier);
    setMemberActive(targetActive);
    const before = 'pending/active';
    const after = `${targetTier}/${targetActive ? 'active' : 'inactive'}`;
    setAudit((items) => [`대상=test-member · before=${before} · after=${after} · reason=${reason.trim()} · actor=admin-a`, ...items]);
  }

  return <main className="min-h-[100dvh] overflow-y-auto bg-background p-4" data-testid="phase8-e2e-page">
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="rounded-3xl border border-card-border bg-card p-4">
        <h1 className="text-xl font-black">Phase 8 Release Candidate</h1>
        <p className="mt-1 text-sm text-muted-foreground">권한·통합 흐름·장애 복구·개인정보 최소화 fixture</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <label className="text-xs font-bold">회원 등급<select aria-label="회원 등급" value={tier} onChange={(event) => resetFlow(event.target.value as MemberTier)} className="ml-2 h-10 rounded-xl border border-card-border bg-background px-2"><option value="pending">pending</option><option value="associate">associate</option><option value="regular">regular</option><option value="admin">admin</option></select></label>
          <button type="button" onClick={switchAccount} className="min-h-10 rounded-xl border border-card-border px-3 text-sm font-bold" data-testid="phase8-account-switch">계정 전환</button>
          <span className="self-center text-xs" data-testid="phase8-active-namespace">{namespace}</span>
        </div>
      </header>

      {tier === 'pending' ? <section className="rounded-3xl border border-amber-500/40 bg-card p-6 text-center" data-testid="phase8-pending-screen">
        <ShieldX className="mx-auto h-10 w-10 text-amber-500" /><h2 className="mt-3 text-lg font-black">일반회원 · 승인대기</h2><p className="mt-2 text-sm text-muted-foreground">승인 대기 화면, 계정 설정과 로그아웃만 사용할 수 있습니다.</p>
      </section> : null}

      {tier === 'associate' ? <section className="space-y-3" data-testid="phase8-associate-screen">
        <div className="rounded-3xl border border-emerald-500/40 bg-card p-4"><ShieldCheck className="h-6 w-6 text-emerald-500" /><h2 className="mt-2 font-black">기본 정보 접근 성공</h2><p className="text-sm text-muted-foreground">국내·미국주식, 코인 현물, 기본 차트와 뉴스</p></div>
        {['코인 선물', '리스크 API', '백테스트 API', '모의매매 API', '거래일지 동기화 API'].map((label) => <div key={label} className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-sm font-bold" data-testid="phase8-associate-denied">{label} · CAPABILITY_REQUIRED</div>)}
      </section> : null}

      {(tier === 'regular' || tier === 'admin') ? <section className="space-y-4" data-testid="phase8-regular-flow">
        <SafetyContract />
        <div className="rounded-3xl border border-card-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-black">정회원 전체 흐름</h2><p className="text-xs text-muted-foreground">단계를 순서대로 실행합니다.</p></div><label className="text-xs font-bold"><input type="checkbox" checked={failure} onChange={(event) => setFailure(event.target.checked)} className="mr-2" />동기화 실패 모사</label></div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {STEP_LABELS.map((label, index) => <button key={label} type="button" disabled={index !== completed || !hasCapability(tier, REQUIRED[index])} onClick={() => runStep(index)} className={`min-h-12 rounded-2xl border px-3 text-left text-sm font-extrabold ${index < completed ? 'border-emerald-500 bg-emerald-500/10' : 'border-card-border disabled:opacity-50'}`} data-testid={`phase8-step-${index}`}><span>{index + 1}. {label}</span><span className="float-right">{index < completed ? '완료' : index === completed ? '실행' : '대기'}</span></button>)}
          </div>
          <div className="mt-4 rounded-2xl bg-secondary/50 p-3 text-sm" data-testid="phase8-sync-status">동기화 상태: {syncStatus}</div>
          {syncStatus === 'failed' ? <button type="button" onClick={() => { setFailure(false); setSyncStatus('local-only'); }} className="mt-2 rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-foreground" data-testid="phase8-retry">실패 상태 유지 후 수동 재시도 준비</button> : null}
          <p className="mt-3 text-xs text-muted-foreground">현재 계정 로컬 거래일지: {window.localStorage.getItem(`phase8.rc.journal:${namespace}`) ?? '0'}건</p>
        </div>
        <div className="rounded-3xl border border-card-border bg-card p-4" data-testid="phase8-privacy-notice"><p className="font-bold">현재 단계에서는 거래기록을 외부 AI로 전송하지 않습니다.</p><p className="mt-1 text-sm text-muted-foreground">개인정보를 제외한 구조화된 복기 데이터만 준비합니다.</p></div>
      </section> : null}

      {tier === 'admin' ? <section className="rounded-3xl border border-card-border bg-card p-4" data-testid="phase8-admin-flow">
        <div className="flex items-center gap-2"><UserCog className="h-5 w-5" /><h2 className="font-black">관리자 회원관리</h2></div>
        <p className="mt-1 text-xs text-muted-foreground">개인 거래 메모와 원본 거래기록은 표시하지 않습니다.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2"><label className="text-xs font-bold">대상 회원 등급<select aria-label="대상 회원 등급" value={memberTier} onChange={(event) => setMemberTier(event.target.value as MemberTier)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2"><option value="pending">pending</option><option value="associate">associate</option><option value="regular">regular</option><option value="admin">admin</option></select></label><label className="text-xs font-bold">활성 상태<select aria-label="대상 회원 활성 상태" value={memberActive ? 'active' : 'inactive'} onChange={(event) => setMemberActive(event.target.value === 'active')} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2"><option value="active">active</option><option value="inactive">inactive</option></select></label></div>
        <label className="mt-3 block text-xs font-bold">변경 사유<input aria-label="관리자 변경 사유" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3" /></label>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => applyAdminChange('associate', true)} className="rounded-xl border border-primary px-3 py-2 text-sm font-bold">준회원 승인</button><button type="button" onClick={() => applyAdminChange()} className="rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-foreground">등급·활성 변경</button><button type="button" onClick={() => setAdminError('LAST_ACTIVE_ADMIN_PROTECTED')} className="rounded-xl border border-destructive px-3 py-2 text-sm font-bold text-destructive" data-testid="phase8-last-admin-protect">마지막 관리자 제거 시도</button></div>
        {adminError ? <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{adminError}</p> : null}
        <div className="mt-4 space-y-2" data-testid="phase8-audit-log">{audit.map((item, index) => <p key={`${item}-${index}`} className="rounded-xl bg-secondary/50 p-2 text-xs">{item}</p>)}{!audit.length ? <p className="text-xs text-muted-foreground">변경 이력 없음</p> : null}</div>
      </section> : null}
    </div>
  </main>;
}
