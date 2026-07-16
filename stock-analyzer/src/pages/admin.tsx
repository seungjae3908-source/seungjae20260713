import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ArrowLeft, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth, type MemberProfile } from '@/lib/auth';

async function adminFetch(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`/api/admin${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`관리자 요청 실패 (${response.status})`);
  return response.json();
}

export default function AdminPage() {
  const [, navigate] = useLocation(); const auth = useAuth(); const client = useQueryClient(); const token = auth.session?.access_token ?? '';
  const members = useQuery<{ members: MemberProfile[] }>({ queryKey: ['admin-members'], queryFn: () => adminFetch('/members', token), enabled: auth.isAdmin && Boolean(token) });
  async function update(id: string, changes: Partial<Pick<MemberProfile, 'status' | 'role'>>) {
    await adminFetch(`/members/${id}`, token, { method: 'PATCH', body: JSON.stringify(changes) });
    await client.invalidateQueries({ queryKey: ['admin-members'] });
  }
  if (!auth.isAdmin) return <div className="p-6"><ShieldAlert className="h-10 w-10 text-destructive" /><h1 className="mt-4 text-xl font-black">관리자 권한이 필요합니다.</h1><button onClick={() => navigate('/account')} className="mt-5 rounded-2xl bg-primary px-4 py-3 font-bold text-primary-foreground">계정으로 돌아가기</button></div>;
  return <div className="h-full overflow-y-auto bg-background pb-12">
    <header className="flex items-center gap-3 border-b border-card-border px-4 py-4"><button aria-label="뒤로 가기" onClick={() => navigate('/account')}><ArrowLeft /></button><div className="flex-1"><h1 className="text-xl font-black">회원 관리</h1><p className="text-xs text-muted-foreground">승인·정지·권한 변경은 감사기록에 남습니다.</p></div><button aria-label="새로고침" onClick={() => void members.refetch()}><RefreshCw className="h-5 w-5" /></button></header>
    <main className="space-y-3 p-4">{members.isLoading && <p>회원 목록을 불러오는 중입니다.</p>}{members.error && <p className="text-destructive">{members.error.message}</p>}
      {members.data?.members.map((member) => <article key={member.id} className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-start justify-between gap-2"><div><p className="font-black">{member.display_name}</p><p className="text-xs text-muted-foreground">{member.login_name}</p></div><span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold">{member.role === 'admin' ? '관리자' : '일반회원'}</span></div>
        <div className="mt-4 grid grid-cols-2 gap-2"><select aria-label={`${member.display_name} 상태`} value={member.status} onChange={(e) => void update(member.id, { status: e.target.value as MemberProfile['status'] })} className="rounded-xl border border-card-border bg-background p-2 text-sm font-bold"><option value="pending">승인대기</option><option value="approved">승인</option><option value="rejected">반려</option><option value="suspended">정지</option><option value="withdrawn">탈퇴</option></select><select aria-label={`${member.display_name} 권한`} value={member.role} onChange={(e) => void update(member.id, { role: e.target.value as MemberProfile['role'] })} className="rounded-xl border border-card-border bg-background p-2 text-sm font-bold"><option value="user">일반회원</option><option value="admin">관리자</option></select></div>
      </article>)}</main>
  </div>;
}
