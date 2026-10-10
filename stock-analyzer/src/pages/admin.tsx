import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ArrowLeft, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useAuth, type MemberProfile } from '@/lib/auth';
import { MEMBER_TIER_LABELS, type MemberTier } from '../../../packages/member-access/src/index.js';
import { adminMemberAccessLabel, adminMemberEditableTier, adminMemberIsActive } from '@/lib/member-admin-state';

type AdminMember = MemberProfile & {
  created_at?: string;
  approved_at?: string | null;
  approved_by?: string | null;
  permissions_updated_at?: string | null;
};

type PagedMembers = { members: AdminMember[]; page: number; pageSize: number; hasMore: boolean };
type PagedAudits = { logs: AuditLog[]; page: number; pageSize: number; hasMore: boolean };

type AuditLog = {
  id: string;
  actor_id: string;
  target_user_id: string;
  action: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
  reason: string;
  created_at: string;
};

const ADMIN_REQUEST_TIMEOUT_MS = 8_000;

async function readAdminResponse(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : `관리자 요청 실패 (${response.status})`);
  return payload;
}

async function adminFetch(path: string, token: string, init?: RequestInit) {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) };

  if (method !== 'GET') {
    const response = await fetch(`/api/admin${path}`, {
      ...init,
      signal: undefined,
      headers,
    });
    return readAdminResponse(response);
  }

  const controller = new AbortController();
  const externalSignal = init?.signal;
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ADMIN_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`/api/admin${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
    return await readAdminResponse(response);
  } catch (cause) {
    if (timedOut) throw new Error('관리자 요청 시간이 초과됐습니다. 다시 시도해 주세요.');
    throw cause;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const client = useQueryClient();
  const token = auth.session?.access_token ?? '';
  const [search, setSearch] = useState('');
  const [memberPage, setMemberPage] = useState(0);
  const [auditPage, setAuditPage] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const members = useQuery<PagedMembers>({
    queryKey: ['admin-members', auth.user?.id ?? 'anonymous', search, memberPage],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(memberPage), pageSize: '100' });
      if (search.trim()) params.set('search', search.trim());
      return adminFetch(`/members?${params.toString()}`, token, { signal });
    },
    enabled: auth.isAdmin && Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const audits = useQuery<PagedAudits>({
    queryKey: ['admin-audit', auth.user?.id ?? 'anonymous', auditPage],
    queryFn: ({ signal }) => adminFetch(`/audit-logs?page=${auditPage}&pageSize=100`, token, { signal }),
    enabled: auth.isAdmin && Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const memberMutationEnabled = auth.isAdmin && Boolean(token) && Boolean(members.data) && !members.error && !members.isFetching;

  async function changed(targetId: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['admin-members'] }),
      client.invalidateQueries({ queryKey: ['admin-audit'] }),
    ]);
    if (targetId === auth.user?.id) await auth.refreshProfile();
  }

  async function submitChange(member: AdminMember, membershipLevel: MemberTier, isActive: boolean, membershipExpiresAt: string | null, reason: string): Promise<boolean> {
    setError(''); setNotice('');
    if (!memberMutationEnabled) { setError('회원 목록의 최신 상태를 확인한 뒤 다시 시도해 주세요.'); return false; }
    if (reason.trim().length < 3) { setError('변경 사유를 3자 이상 입력하세요.'); return false; }
    const currentTier = adminMemberEditableTier(member);
    const expirySummary = membershipExpiresAt ? new Date(membershipExpiresAt).toLocaleString() : '기간 제한 없음';
    const summary = `${member.display_name}\n${MEMBER_TIER_LABELS[currentTier]} → ${MEMBER_TIER_LABELS[membershipLevel]}\n현재 이용 상태: ${adminMemberAccessLabel(member)} → 활성 필드: ${isActive ? '활성' : '비활성'}\n만료: ${expirySummary}\n사유: ${reason.trim()}`;
    if (!window.confirm(`다음 회원 변경을 적용할까요?\n\n${summary}`)) return false;
    try {
      await adminFetch(`/members/${member.id}`, token, { method: 'PATCH', body: JSON.stringify({ membershipLevel, isActive, membershipExpiresAt, reason: reason.trim() }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '회원 변경에 실패했습니다.'); return false; }
    const message = `${member.display_name} 회원의 권한을 갱신했습니다.`;
    setNotice(message);
    try { await changed(member.id); } catch { setNotice(`${message}\n회원 목록 재조회에 실패했습니다. 중복 변경 전에 최신 상태를 확인하세요.`); }
    return true;
  }

  async function approve(member: AdminMember, reason: string): Promise<boolean> {
    setError(''); setNotice('');
    if (!memberMutationEnabled) { setError('회원 목록의 최신 상태를 확인한 뒤 다시 시도해 주세요.'); return false; }
    if (reason.trim().length < 3) { setError('승인 사유를 3자 이상 입력하세요.'); return false; }
    if (!window.confirm(`${member.display_name} 회원을 준회원으로 승인할까요?\n사유: ${reason.trim()}`)) return false;
    try { await adminFetch(`/members/${member.id}/approve`, token, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '회원 승인에 실패했습니다.'); return false; }
    const message = `${member.display_name} 회원을 준회원으로 승인했습니다.`;
    setNotice(message);
    try { await changed(member.id); } catch { setNotice(`${message}\n회원 목록 재조회에 실패했습니다. 중복 승인 전에 최신 상태를 확인하세요.`); }
    return true;
  }

  async function resetPassword(member: AdminMember, reason: string): Promise<boolean> {
    setError(''); setNotice('');
    if (!memberMutationEnabled) { setError('회원 목록의 최신 상태를 확인한 뒤 다시 시도해 주세요.'); return false; }
    if (reason.trim().length < 3) { setError('비밀번호 재설정 사유를 3자 이상 입력하세요.'); return false; }
    if (!window.confirm(`${member.display_name} 회원의 비밀번호를 임시 비밀번호로 재설정할까요?\n기존 비밀번호는 즉시 사용할 수 없게 됩니다.`)) return false;
    let result: { temporaryPassword?: string; auditRecorded?: boolean };
    try {
      result = await adminFetch(`/members/${member.id}/password-reset`, token, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }) as { temporaryPassword?: string; auditRecorded?: boolean };
      if (!result.temporaryPassword) throw new Error('임시 비밀번호를 확인하지 못했습니다. 중복 발급 전에 계정 상태를 확인하세요.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '비밀번호 재설정에 실패했습니다.'); return false; }
    // Never hide an acknowledged credential rotation if the optional readback fails.
    const credentialNotice = `임시 비밀번호: ${result.temporaryPassword}\n사용자에게 안전하게 전달하세요.${result.auditRecorded === false ? ' 감사기록 저장 상태도 확인하세요.' : ''}`;
    setNotice(credentialNotice);
    try { await changed(member.id); } catch { setNotice(`${credentialNotice}\n회원 목록 재조회에 실패했습니다. 이미 발급됐으므로 중복 재설정하지 마세요.`); }
    return true;
  }

  if (!auth.isAdmin) return <div className="p-6"><ShieldAlert className="h-10 w-10 text-destructive" /><h1 className="mt-4 text-xl font-black">관리자 권한이 필요합니다.</h1><button onClick={() => navigate('/account')} className="mt-5 rounded-2xl bg-primary px-4 py-3 font-bold text-primary-foreground">계정으로 돌아가기</button></div>;

  return <div className="h-full overflow-y-auto bg-background pb-12">
    <header className="flex items-center gap-3 border-b border-card-border px-4 py-4">
      <button aria-label="뒤로 가기" onClick={() => navigate('/account')}><ArrowLeft /></button>
      <div className="flex-1"><h1 className="text-xl font-black">회원 관리</h1><p className="text-xs text-muted-foreground">승인·등급·활성 상태 변경은 사유와 함께 감사기록에 남습니다.</p></div>
      <button aria-label="새로고침" onClick={() => void Promise.all([members.refetch(), audits.refetch()])}><RefreshCw className="h-5 w-5" /></button>
    </header>
    <main className="space-y-5 p-4">
      <label className="flex items-center gap-2 rounded-2xl border border-card-border bg-card px-3 py-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input aria-label="회원 검색" value={search} onChange={(event) => { setSearch(event.target.value); setMemberPage(0); }} placeholder="아이디 또는 표시 이름 검색" className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {(notice || error) && <p role="status" className={`whitespace-pre-wrap rounded-2xl p-3 text-sm font-bold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
      {members.isLoading && <p>회원 목록을 불러오는 중입니다.</p>}
      {members.error && <div data-testid="admin-members-unavailable" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3"><p className="text-sm font-bold text-destructive">{members.error.message}</p><button type="button" onClick={() => void members.refetch()} className="mt-3 rounded-xl border border-destructive/30 px-3 py-2 text-xs font-bold">회원 목록 다시 시도</button></div>}
      {members.data && (members.error || members.isFetching) && <p data-testid="admin-member-mutations-locked" className="rounded-2xl bg-warning/10 p-3 text-xs font-bold text-warning">최신 회원 상태 확인이 끝날 때까지 등급·활성·승인 변경을 잠급니다.</p>}
      <section className="space-y-3" aria-label="회원 목록">
        {members.data?.members.map((member) => <MemberCard key={`${member.id}:${member.status}:${adminMemberEditableTier(member)}:${adminMemberIsActive(member)}:${member.membership_expires_at ?? ''}:${member.permissions_updated_at ?? ''}`} member={member} mutationEnabled={memberMutationEnabled} onApprove={approve} onSubmit={submitChange} onPasswordReset={resetPassword} />)}
      </section>
      {members.data && <div className="flex items-center justify-center gap-3">
        <button type="button" disabled={memberPage === 0 || members.isFetching} onClick={() => setMemberPage((page) => Math.max(0, page - 1))} className="rounded-xl border border-card-border px-4 py-2 text-sm font-bold disabled:opacity-40">이전</button>
        <span className="text-xs font-semibold text-muted-foreground">{memberPage + 1}페이지</span>
        <button type="button" disabled={!members.data.hasMore || members.isFetching} onClick={() => setMemberPage((page) => page + 1)} className="rounded-xl border border-card-border px-4 py-2 text-sm font-bold disabled:opacity-40">다음</button>
      </div>}

      <section className="rounded-3xl border border-card-border bg-card p-4" aria-label="권한 변경 감사 이력">
        <div className="flex items-center justify-between"><div><h2 className="font-black">변경 이력</h2><p className="mt-1 text-xs text-muted-foreground">개인 거래기록이나 원본 메모는 포함하지 않습니다.</p></div><button type="button" onClick={() => void audits.refetch()} className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold">새로고침</button></div>
        <div className="mt-4 space-y-2">
          {audits.isLoading && <p className="text-sm">감사 이력을 불러오는 중입니다.</p>}
          {audits.error && <div data-testid="admin-audit-unavailable" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3"><p className="text-sm font-bold text-destructive">{audits.error.message}</p><button type="button" onClick={() => void audits.refetch()} className="mt-3 rounded-xl border border-destructive/30 px-3 py-2 text-xs font-bold">감사 이력 다시 시도</button></div>}
          {audits.error && Boolean(audits.data?.logs.length) && <p data-testid="admin-audit-stale" className="rounded-xl bg-warning/10 p-3 text-xs font-bold text-warning">아래 이력은 마지막 정상 조회 데이터입니다. 현재 조회는 실패했습니다.</p>}
          {audits.data?.logs.map((log) => <article key={log.id} className="rounded-2xl bg-secondary/50 p-3 text-xs">
            <p className="font-extrabold">{log.action}</p>
            <p className="mt-1 break-all text-muted-foreground">대상 {log.target_user_id} · 관리자 {log.actor_id}</p>
            <p className="mt-1">{log.reason}</p>
            <p className="mt-1 text-muted-foreground">{new Date(log.created_at).toLocaleString()}</p>
          </article>)}
          {!audits.isLoading && !audits.error && audits.data?.logs.length === 0 && <p className="text-sm text-muted-foreground">기록된 권한 변경이 없습니다.</p>}
        </div>
        {audits.data && <div className="mt-4 flex items-center justify-center gap-3">
          <button type="button" disabled={auditPage === 0 || audits.isFetching} onClick={() => setAuditPage((page) => Math.max(0, page - 1))} className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold disabled:opacity-40">이전</button>
          <span className="text-xs font-semibold text-muted-foreground">{auditPage + 1}페이지</span>
          <button type="button" disabled={!audits.data.hasMore || audits.isFetching} onClick={() => setAuditPage((page) => page + 1)} className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold disabled:opacity-40">다음</button>
        </div>}
      </section>
    </main>
  </div>;
}

function MemberCard({ member, mutationEnabled, onApprove, onSubmit, onPasswordReset }: {
  member: AdminMember;
  mutationEnabled: boolean;
  onApprove(member: AdminMember, reason: string): Promise<boolean>;
  onSubmit(member: AdminMember, tier: MemberTier, active: boolean, membershipExpiresAt: string | null, reason: string): Promise<boolean>;
  onPasswordReset(member: AdminMember, reason: string): Promise<boolean>;
}) {
  const initialTier = adminMemberEditableTier(member);
  const [tier, setTier] = useState<MemberTier>(initialTier);
  const [active, setActive] = useState(adminMemberIsActive(member));
  const [expiresAt, setExpiresAt] = useState(() => {
    if (!member.membership_expires_at) return '';
    const date = new Date(member.membership_expires_at);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const approvalProvenanceMissing = member.status === 'approved'
    && (!member.approved_at || !member.approved_by);

  async function run(action: () => Promise<boolean>) {
    if (!mutationEnabled) return;
    setBusy(true);
    try { if (await action()) setReason(''); } finally { setBusy(false); }
  }

  return <article className="rounded-3xl border border-card-border bg-card p-4">
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-black">{member.display_name}</p><p className="truncate text-xs text-muted-foreground">{member.login_name}</p><p className="mt-1 break-all text-[10px] text-muted-foreground">{member.id}</p></div><span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-bold">{MEMBER_TIER_LABELS[initialTier]}</span></div>
    {approvalProvenanceMissing && <p data-testid="member-approval-provenance-missing" className="mt-3 rounded-xl bg-warning/10 p-3 text-xs font-bold text-warning">과거 승인 정보 일부가 확인되지 않습니다. 임의로 승인자나 승인시각을 보정하지 않습니다.</p>}
    <dl className="mt-3 grid grid-cols-2 gap-2 rounded-2xl bg-secondary/40 p-3 text-xs"><div><dt className="text-muted-foreground">상태</dt><dd className="font-bold">{member.status}</dd></div><div><dt className="text-muted-foreground">활성</dt><dd className="font-bold">{adminMemberAccessLabel(member)}</dd></div><div><dt className="text-muted-foreground">가입</dt><dd>{member.created_at ? new Date(member.created_at).toLocaleDateString() : '미확인'}</dd></div><div><dt className="text-muted-foreground">권한 갱신</dt><dd>{member.permissions_updated_at ? new Date(member.permissions_updated_at).toLocaleString() : '미확인'}</dd></div><div className="col-span-2"><dt className="text-muted-foreground">회원 만료</dt><dd>{member.membership_expires_at ? new Date(member.membership_expires_at).toLocaleString() : '기간 제한 없음'}</dd></div></dl>
    <div className="mt-4 grid grid-cols-2 gap-2">
      <label className="text-xs font-bold">등급<select disabled={!mutationEnabled || busy} aria-label={`${member.display_name} 등급`} value={tier} onChange={(event) => { const next = event.target.value as MemberTier; setTier(next); if (next === 'pending') setActive(false); if (next === 'admin' || next === 'pending') setExpiresAt(''); }} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2 text-sm disabled:opacity-50"><option value="pending">일반회원 · 승인대기</option><option value="associate">준회원</option><option value="regular">정회원</option><option value="admin">관리자</option></select></label>
      <label className="text-xs font-bold">활성 상태<select disabled={!mutationEnabled || busy || tier === 'pending'} aria-label={`${member.display_name} 활성 상태`} value={tier === 'pending' ? 'inactive' : active ? 'active' : 'inactive'} onChange={(event) => setActive(event.target.value === 'active')} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2 text-sm disabled:opacity-50"><option value="active">활성</option><option value="inactive">비활성</option></select></label>
    </div>
    <label className="mt-3 block text-xs font-bold">회원 만료일<input type="datetime-local" disabled={!mutationEnabled || busy || tier === 'pending' || tier === 'admin'} aria-label={`${member.display_name} 회원 만료일`} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm disabled:opacity-50" /></label>
    <label className="mt-3 block text-xs font-bold">변경 사유<textarea disabled={!mutationEnabled || busy} aria-label={`${member.display_name} 변경 사유`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} className="mt-1 min-h-20 w-full resize-y rounded-xl border border-card-border bg-background p-3 text-sm disabled:opacity-50" placeholder="3자 이상 입력" /></label>
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      <button type="button" disabled={busy || !mutationEnabled || initialTier !== 'pending'} onClick={() => void run(() => onApprove(member, reason))} className="rounded-xl border border-primary px-3 py-3 text-sm font-extrabold text-primary disabled:opacity-40">준회원 승인</button>
      <button type="button" disabled={busy || !mutationEnabled} onClick={() => void run(() => onSubmit(member, tier, tier === 'pending' ? false : active, expiresAt ? new Date(expiresAt).toISOString() : null, reason))} className="rounded-xl bg-primary px-3 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-40">변경 검토·적용</button>
      <button type="button" disabled={busy || !mutationEnabled} onClick={() => void run(() => onPasswordReset(member, reason))} className="rounded-xl border border-card-border px-3 py-3 text-sm font-extrabold disabled:opacity-40">임시 비밀번호 발급</button>
    </div>
  </article>;
}
