import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ArrowLeft, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useAuth, type MemberProfile } from '@/lib/auth';
import { MEMBER_TIER_LABELS, type MemberTier } from '../../../packages/member-access/src/index.js';

type AdminMember = MemberProfile & {
  created_at?: string;
  approved_at?: string | null;
  permissions_updated_at?: string | null;
};

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

async function adminFetch(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : `관리자 요청 실패 (${response.status})`);
  return payload;
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const client = useQueryClient();
  const token = auth.session?.access_token ?? '';
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const members = useQuery<{ members: AdminMember[] }>({
    queryKey: ['admin-members', search],
    queryFn: () => adminFetch(`/members${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`, token),
    enabled: auth.isAdmin && Boolean(token),
  });
  const audits = useQuery<{ logs: AuditLog[] }>({
    queryKey: ['admin-audit'],
    queryFn: () => adminFetch('/audit-logs', token),
    enabled: auth.isAdmin && Boolean(token),
  });

  async function changed(targetId: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['admin-members'] }),
      client.invalidateQueries({ queryKey: ['admin-audit'] }),
    ]);
    if (targetId === auth.user?.id) await auth.refreshProfile();
  }

  async function submitChange(member: AdminMember, membershipLevel: MemberTier, isActive: boolean, reason: string) {
    setError(''); setNotice('');
    if (reason.trim().length < 3) { setError('변경 사유를 3자 이상 입력하세요.'); return; }
    const summary = `${member.display_name}\n${MEMBER_TIER_LABELS[member.membership_level ?? auth.membershipLevel]} → ${MEMBER_TIER_LABELS[membershipLevel]}\n활성 상태: ${member.is_active !== false ? '활성' : '비활성'} → ${isActive ? '활성' : '비활성'}\n사유: ${reason.trim()}`;
    if (!window.confirm(`다음 회원 변경을 적용할까요?\n\n${summary}`)) return;
    try {
      await adminFetch(`/members/${member.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ membershipLevel, isActive, reason: reason.trim() }),
      });
      await changed(member.id);
      setNotice(`${member.display_name} 회원의 권한을 갱신했습니다.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '회원 변경에 실패했습니다.');
    }
  }

  async function approve(member: AdminMember, reason: string) {
    setError(''); setNotice('');
    if (reason.trim().length < 3) { setError('승인 사유를 3자 이상 입력하세요.'); return; }
    if (!window.confirm(`${member.display_name} 회원을 준회원으로 승인할까요?\n사유: ${reason.trim()}`)) return;
    try {
      await adminFetch(`/members/${member.id}/approve`, token, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      await changed(member.id);
      setNotice(`${member.display_name} 회원을 준회원으로 승인했습니다.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '회원 승인에 실패했습니다.');
    }
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
        <input aria-label="회원 검색" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="아이디 또는 표시 이름 검색" className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {(notice || error) && <p role="status" className={`rounded-2xl p-3 text-sm font-bold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
      {members.isLoading && <p>회원 목록을 불러오는 중입니다.</p>}
      {members.error && <p className="text-destructive">{members.error.message}</p>}
      <section className="space-y-3" aria-label="회원 목록">
        {members.data?.members.map((member) => <MemberCard key={member.id} member={member} onApprove={approve} onSubmit={submitChange} />)}
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4" aria-label="권한 변경 감사 이력">
        <div className="flex items-center justify-between"><div><h2 className="font-black">변경 이력</h2><p className="mt-1 text-xs text-muted-foreground">개인 거래기록이나 원본 메모는 포함하지 않습니다.</p></div><button type="button" onClick={() => void audits.refetch()} className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold">새로고침</button></div>
        <div className="mt-4 space-y-2">
          {audits.isLoading && <p className="text-sm">감사 이력을 불러오는 중입니다.</p>}
          {audits.error && <p className="text-sm text-destructive">{audits.error.message}</p>}
          {audits.data?.logs.map((log) => <article key={log.id} className="rounded-2xl bg-secondary/50 p-3 text-xs">
            <p className="font-extrabold">{log.action}</p>
            <p className="mt-1 break-all text-muted-foreground">대상 {log.target_user_id} · 관리자 {log.actor_id}</p>
            <p className="mt-1">{log.reason}</p>
            <p className="mt-1 text-muted-foreground">{new Date(log.created_at).toLocaleString()}</p>
          </article>)}
          {!audits.isLoading && !audits.data?.logs.length && <p className="text-sm text-muted-foreground">기록된 권한 변경이 없습니다.</p>}
        </div>
      </section>
    </main>
  </div>;
}

function MemberCard({ member, onApprove, onSubmit }: {
  member: AdminMember;
  onApprove(member: AdminMember, reason: string): Promise<void>;
  onSubmit(member: AdminMember, tier: MemberTier, active: boolean, reason: string): Promise<void>;
}) {
  const initialTier = member.membership_level ?? (member.role === 'admin' ? 'admin' : member.status === 'approved' ? 'regular' : 'pending');
  const [tier, setTier] = useState<MemberTier>(initialTier);
  const [active, setActive] = useState(member.is_active !== false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); setReason(''); } finally { setBusy(false); }
  }

  return <article className="rounded-3xl border border-card-border bg-card p-4">
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-black">{member.display_name}</p><p className="truncate text-xs text-muted-foreground">{member.login_name}</p><p className="mt-1 break-all text-[10px] text-muted-foreground">{member.id}</p></div><span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-bold">{MEMBER_TIER_LABELS[initialTier]}</span></div>
    <dl className="mt-3 grid grid-cols-2 gap-2 rounded-2xl bg-secondary/40 p-3 text-xs"><div><dt className="text-muted-foreground">상태</dt><dd className="font-bold">{member.status}</dd></div><div><dt className="text-muted-foreground">활성</dt><dd className="font-bold">{member.is_active !== false ? '활성' : '비활성'}</dd></div><div><dt className="text-muted-foreground">가입</dt><dd>{member.created_at ? new Date(member.created_at).toLocaleDateString() : '미확인'}</dd></div><div><dt className="text-muted-foreground">권한 갱신</dt><dd>{member.permissions_updated_at ? new Date(member.permissions_updated_at).toLocaleString() : '미확인'}</dd></div></dl>
    <div className="mt-4 grid grid-cols-2 gap-2">
      <label className="text-xs font-bold">등급<select aria-label={`${member.display_name} 등급`} value={tier} onChange={(event) => setTier(event.target.value as MemberTier)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2 text-sm"><option value="pending">일반회원 · 승인대기</option><option value="associate">준회원</option><option value="regular">정회원</option><option value="admin">관리자</option></select></label>
      <label className="text-xs font-bold">활성 상태<select aria-label={`${member.display_name} 활성 상태`} value={active ? 'active' : 'inactive'} onChange={(event) => setActive(event.target.value === 'active')} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-2 text-sm"><option value="active">활성</option><option value="inactive">비활성</option></select></label>
    </div>
    <label className="mt-3 block text-xs font-bold">변경 사유<textarea aria-label={`${member.display_name} 변경 사유`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} className="mt-1 min-h-20 w-full resize-y rounded-xl border border-card-border bg-background p-3 text-sm" placeholder="3자 이상 입력" /></label>
    <div className="mt-3 grid grid-cols-2 gap-2">
      <button type="button" disabled={busy || initialTier !== 'pending'} onClick={() => void run(() => onApprove(member, reason))} className="rounded-xl border border-primary px-3 py-3 text-sm font-extrabold text-primary disabled:opacity-40">준회원 승인</button>
      <button type="button" disabled={busy} onClick={() => void run(() => onSubmit(member, tier, active, reason))} className="rounded-xl bg-primary px-3 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-40">변경 검토·적용</button>
    </div>
  </article>;
}
