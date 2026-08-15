import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Clock3, LogIn, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { BrokerageAccountConnections } from '@/components/brokerage-account-connections';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';
import { useAuth } from '@/lib/auth';
import { MEMBER_TIER_LABELS } from '../../../packages/member-access/src/index.js';

export default function AccountPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const [register, setRegister] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    if (register && password !== confirm) { setError('비밀번호 확인이 일치하지 않습니다.'); return; }
    setBusy(true);
    try {
      if (register) {
        await auth.signUp(name, password);
        setNotice('가입 신청이 완료되었습니다. 관리자 승인 후 이용할 수 있습니다.');
      } else {
        await auth.signIn(name, password);
        setNotice('로그인되었습니다.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계정 처리에 실패했습니다.');
    } finally { setBusy(false); }
  }

  const stateMessage = auth.profile?.status === 'rejected' ? '가입 신청이 반려되었습니다.'
    : auth.profile?.status === 'suspended' || auth.profile?.is_active === false ? '이용이 정지된 계정입니다.'
    : auth.profile?.status === 'withdrawn' ? '탈퇴 처리된 계정입니다.'
    : auth.membershipLevel === 'pending' ? '관리자 승인 대기 중입니다.' : '';

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
    <header className="border-b border-card-border px-4 py-4"><div className="flex items-center gap-3">
      <button aria-label="뒤로 가기" onClick={() => navigate(auth.isApproved ? '/settings' : '/login')} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border"><ArrowLeft className="h-5 w-5" /></button>
      <div className="min-w-0"><h1 className="truncate text-xl font-extrabold">계정</h1><p className="mt-1 break-keep text-xs text-muted-foreground">회원가입, 승인 상태와 로그인 정보를 관리합니다.</p></div>
    </div></header>
    <main className="min-w-0 flex-1 px-4 pb-28 pt-5">
      {!auth.configured && <Card><p className="font-extrabold text-destructive">계정 저장소 설정이 필요합니다.</p><p className="mt-2 text-sm text-muted-foreground">Supabase 연결 정보를 관리자 설정에 등록해 주세요.</p></Card>}
      {auth.loading && <Card>계정 상태를 확인하고 있습니다.</Card>}
      {!auth.loading && auth.user ? <Card>
        <div className="flex min-w-0 flex-wrap items-center gap-3"><ShieldCheck className="h-8 w-8 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">로그인 중</p><p className="truncate text-xl font-black">{auth.displayName ?? '사용자'}</p></div><span data-testid="membership-label" className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-extrabold">{MEMBER_TIER_LABELS[auth.membershipLevel]}</span></div>
        {stateMessage && <div className="mt-4 flex gap-2 rounded-2xl bg-warning/10 p-4 text-sm font-bold text-warning"><Clock3 className="h-5 w-5 shrink-0" /><span className="min-w-0 break-words">{stateMessage}</span></div>}
        {auth.isApproved && <p className="mt-4 rounded-2xl bg-positive/10 p-4 text-sm font-bold text-positive">현재 등급에 허용된 기능을 사용할 수 있습니다.</p>}
        {auth.isAdmin && <button onClick={() => navigate('/admin')} className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">관리자 회원 관리</button>}
        <button onClick={() => void auth.signOut()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold"><LogOut className="h-4 w-4" />로그아웃</button>
      </Card> : !auth.loading && auth.configured && <Card>
        <div className="flex rounded-2xl bg-secondary p-1"><button aria-label="로그인 탭" onClick={() => setRegister(false)} className={`flex-1 rounded-xl py-2 text-sm font-bold ${!register ? 'bg-card shadow' : ''}`}>로그인</button><button aria-label="회원가입 탭" onClick={() => setRegister(true)} className={`flex-1 rounded-xl py-2 text-sm font-bold ${register ? 'bg-card shadow' : ''}`}>회원가입</button></div>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label="아이디"><input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={20} required autoComplete="username" className="input" placeholder="한글·영문·숫자 2~20자" /></Field>
          <Field label="비밀번호"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={72} required autoComplete={register ? 'new-password' : 'current-password'} className="input" placeholder="8자 이상" /></Field>
          {register && <Field label="비밀번호 확인"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required className="input" placeholder="비밀번호 다시 입력" /></Field>}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">{register ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}{busy ? '처리 중...' : register ? '가입 신청' : '로그인'}</button>
        </form>
      </Card>}
      {!auth.loading && auth.user && auth.isAdmin ? <BrokerageAccountConnections /> : null}
      {!auth.loading && auth.user && auth.can('canConnectPersonalTelegram') ? <div className="mt-4"><UserBrokerTelegramPanel /></div> : null}
      {(notice || error) && <p className={`mt-3 break-words rounded-2xl p-4 text-sm font-bold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
    </main>{auth.isApproved && <BottomNav />}
  </div>;
}

function Card({ children }: { children: React.ReactNode }) { return <section className="min-w-0 rounded-3xl border border-card-border bg-card p-5 shadow-sm">{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block min-w-0"><span className="text-xs font-extrabold text-muted-foreground">{label}</span><div className="mt-2 min-w-0 [&_.input]:h-12 [&_.input]:w-full [&_.input]:min-w-0 [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-card-border [&_.input]:bg-background [&_.input]:px-4 [&_.input]:text-sm [&_.input]:font-bold [&_.input]:outline-none [&_.input]:focus:border-primary">{children}</div></label>; }
