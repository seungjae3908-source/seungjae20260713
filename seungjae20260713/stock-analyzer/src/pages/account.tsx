import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Clock3, Eye, EyeOff, LogIn, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';

type AccountMode = 'login' | 'register' | 'find-id' | 'reset-password';

async function recoveryRequest(path: string, body: Record<string, string>) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.message ?? payload?.error ?? '계정 확인에 실패했습니다.'));
  return payload as Record<string, unknown>;
}

export default function AccountPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const [mode, setMode] = useState<AccountMode>('login');
  const [loginName, setLoginName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const changeMode = (next: AccountMode) => {
    setMode(next);
    setNotice('');
    setError('');
    setPassword('');
    setConfirm('');
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if ((mode === 'register' || mode === 'reset-password') && password !== confirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await auth.signIn(loginName, password);
        navigate('/');
      } else if (mode === 'register') {
        await auth.signUp(loginName, password, displayName, birthDate);
        setNotice('가입 신청이 완료되었습니다. 관리자 승인 후 이용할 수 있습니다.');
      } else if (mode === 'find-id') {
        const result = await recoveryRequest('find-id', { displayName, birthDate });
        setNotice(`확인된 아이디: ${String(result.maskedLoginName ?? '')}`);
      } else {
        await recoveryRequest('reset-password', { loginName, birthDate, newPassword: password });
        setNotice('비밀번호를 재설정했습니다. 새 비밀번호로 로그인해 주세요.');
        setMode('login');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계정 처리에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  const stateMessage = auth.profile?.status === 'pending' ? '관리자 승인 대기 중입니다.'
    : auth.profile?.status === 'rejected' ? '가입 신청이 반려되었습니다.'
      : auth.profile?.status === 'suspended' ? '이용이 정지된 계정입니다.'
        : auth.profile?.status === 'withdrawn' ? '탈퇴 처리된 계정입니다.' : '';

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
	<header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur"><div className="flex items-center gap-3">
      <button type="button" aria-label="뒤로 가기" onClick={() => navigate(auth.isApproved ? '/settings' : '/')} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border"><ArrowLeft className="h-5 w-5" /></button>
      <div className="min-w-0"><h1 className="text-left text-xl font-extrabold">계정</h1><p className="mt-1 break-keep text-left text-xs text-muted-foreground">가입, 승인, 로그인과 계정 복구를 관리합니다.</p></div>
    </div></header>
    <main className="flex-1 px-4 pb-28 pt-5">
      {!auth.configured && <Card><p className="font-extrabold text-destructive">계정 저장소 설정이 필요합니다.</p><p className="mt-2 text-sm text-muted-foreground">Supabase 연결 정보를 관리자 설정에 등록해 주세요.</p></Card>}
      {auth.loading && <Card>계정 상태를 확인하고 있습니다.</Card>}
      {!auth.loading && auth.user ? <Card>
        <div className="flex items-center gap-3"><ShieldCheck className="h-8 w-8 text-primary" /><div className="min-w-0"><p className="text-xs text-muted-foreground">로그인 중</p><p className="truncate text-xl font-black">{auth.displayName ?? '사용자'}</p></div></div>
        {stateMessage && <div className="mt-4 flex gap-2 rounded-2xl bg-warning/10 p-4 text-sm font-bold text-warning"><Clock3 className="h-5 w-5 shrink-0" />{stateMessage}</div>}
        {auth.isApproved && <p className="mt-4 rounded-2xl bg-positive/10 p-4 text-sm font-bold text-positive">승인된 {auth.profile?.role === 'admin' ? '관리자' : auth.profile?.role === 'member' ? '정회원' : '일반회원'} 계정입니다.</p>}
        {auth.isAdmin && <button type="button" onClick={() => navigate('/admin')} className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">관리자 관리센터</button>}
        <button type="button" onClick={() => void auth.signOut()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold"><LogOut className="h-4 w-4" />로그아웃</button>
      </Card> : !auth.loading && auth.configured && <Card>
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
          <ModeButton active={mode === 'login'} onClick={() => changeMode('login')}>로그인</ModeButton>
          <ModeButton active={mode === 'register'} onClick={() => changeMode('register')}>회원가입</ModeButton>
          <ModeButton active={mode === 'find-id'} onClick={() => changeMode('find-id')}>아이디 찾기</ModeButton>
          <ModeButton active={mode === 'reset-password'} onClick={() => changeMode('reset-password')}>비밀번호 재설정</ModeButton>
        </div>
        <form onSubmit={submit} className="mt-5 space-y-4">
          {(mode === 'login' || mode === 'register' || mode === 'reset-password') && <Field label="아이디"><input value={loginName} onChange={(event) => setLoginName(event.target.value)} minLength={2} maxLength={20} required autoComplete="username" className="input" placeholder="한글·영문·숫자 2~20자" /></Field>}
          {(mode === 'register' || mode === 'find-id') && <Field label="이름"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={40} required autoComplete="name" className="input" placeholder="이름" /></Field>}
          {(mode === 'register' || mode === 'find-id' || mode === 'reset-password') && <Field label="생년월일 앞 6자리"><input value={birthDate} onChange={(event) => setBirthDate(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="\d{6}" minLength={6} maxLength={6} required className="input" placeholder="YYMMDD" /></Field>}
          {(mode === 'login' || mode === 'register' || mode === 'reset-password') && <Field label={mode === 'reset-password' ? '새 비밀번호' : '비밀번호'}><div className="relative"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={72} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="input pr-12" placeholder="8자 이상" /><button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'} className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></Field>}
          {(mode === 'register' || mode === 'reset-password') && <Field label="비밀번호 확인"><input type={showPassword ? 'text' : 'password'} value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={8} maxLength={72} required className="input" placeholder="비밀번호 다시 입력" /></Field>}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">{mode === 'register' ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}{busy ? '처리 중…' : mode === 'login' ? '로그인' : mode === 'register' ? '가입 신청' : mode === 'find-id' ? '아이디 확인' : '비밀번호 재설정'}</button>
        </form>
        {(mode === 'find-id' || mode === 'reset-password') && <p className="mt-4 break-keep text-left text-[11px] font-bold leading-relaxed text-muted-foreground">생년월일 원문은 저장하지 않고 서버 HMAC 값으로만 비교합니다. 기존 비밀번호는 표시하지 않습니다.</p>}
      </Card>}
      {(notice || error) && <p className={`mt-3 break-keep rounded-2xl p-4 text-left text-sm font-bold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
    </main>{auth.isApproved && <BottomNav />}
  </div>;
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className={`rounded-xl px-2 py-2 text-xs font-bold ${active ? 'bg-card shadow' : 'text-muted-foreground'}`}>{children}</button>; }
function Card({ children }: { children: React.ReactNode }) { return <section className="rounded-3xl border border-card-border bg-card p-5 text-left shadow-sm">{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="text-xs font-extrabold text-muted-foreground">{label}</span><div className="mt-2 [&_.input]:h-12 [&_.input]:w-full [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-card-border [&_.input]:bg-background [&_.input]:px-4 [&_.input]:text-sm [&_.input]:font-bold [&_.input]:outline-none [&_.input]:focus:border-primary">{children}</div></label>; }
