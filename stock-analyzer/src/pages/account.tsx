import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Clock3, Eye, EyeOff, KeyRound, LogIn, LogOut, Mail, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import { memberGradeLabel } from '@/lib/permissions';
import { cn } from '@/lib/utils';

type AuthTab = 'login' | 'register' | 'find';
type FindTab = 'id' | 'password';

export default function AccountPage() {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const [tab, setTab] = useState<AuthTab>('login');
  const [findTab, setFindTab] = useState<FindTab>('id');

  // 로그인
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [keepLogin, setKeepLogin] = useState(true);

  // 회원가입
  const [regLoginName, setRegLoginName] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regBirth6, setRegBirth6] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);

  // 계정찾기
  const [findName, setFindName] = useState('');
  const [findEmail, setFindEmail] = useState('');
  const [findBirth6, setFindBirth6] = useState('');
  const [findIdentifier, setFindIdentifier] = useState('');
  const [foundLoginName, setFoundLoginName] = useState('');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newConfirm, setNewConfirm] = useState('');

  const recoveryMode = useMemo(() => {
    const query = location.includes('?') ? location.slice(location.indexOf('?')) : window.location.search;
    return new URLSearchParams(query).get('recovery');
  }, [location]);
  const recoveringLoginName = recoveryMode === 'login_name';
  const recoveringPassword = recoveryMode === 'password';

  function resetMessages() {
    setError('');
    setNotice('');
  }

  function switchTab(next: AuthTab) {
    setTab(next);
    resetMessages();
    setFoundLoginName('');
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    // 모바일 브라우저·비밀번호 관리자 자동완성은 input 표시값과 React 상태가
    // 순간적으로 어긋날 수 있으므로 제출 시 실제 폼 값을 기준으로 로그인한다.
    const formData = new FormData(event.currentTarget);
    const submittedId = String(formData.get('loginId') ?? loginId);
    const submittedPassword = String(formData.get('loginPassword') ?? loginPassword);

    resetMessages();
    setBusy(true);
    try {
      await auth.signIn(submittedId, submittedPassword, keepLogin);
      await auth.refreshProfile();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    resetMessages();
    if (regPassword !== regConfirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    if (!agreeTerms) {
      setError('이용약관 및 개인정보 처리방침에 동의해 주세요.');
      return;
    }
    setBusy(true);
    try {
      await auth.signUp({
        loginName: regLoginName,
        displayName: regDisplayName,
        email: regEmail,
        password: regPassword,
        birth6: regBirth6,
      });
      setNotice('가입 신청이 완료되었습니다. 가입 이메일의 인증 링크를 확인한 뒤 관리자 승인을 기다려 주세요.');
      setTab('login');
      setRegLoginName('');
      setRegDisplayName('');
      setRegEmail('');
      setRegBirth6('');
      setRegPassword('');
      setRegConfirm('');
      setAgreeTerms(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '회원가입에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function submitFindId(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    resetMessages();
    setFoundLoginName('');
    setBusy(true);
    try {
      const masked = await auth.findLoginName({ name: findName, email: findEmail, birth6: findBirth6 });
      setFoundLoginName(masked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '아이디 찾기에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function submitFindPassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    resetMessages();
    setBusy(true);
    try {
      await auth.findPassword({ identifier: findIdentifier, name: findName, birth6: findBirth6 });
      setNotice('가입 이메일로 비밀번호 재설정 링크를 보냈습니다. 이메일을 확인해 주세요.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '비밀번호 찾기에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function submitNewPassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    resetMessages();
    if (newPassword !== newConfirm) {
      setError('새 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      await auth.updateRecoveredPassword(newPassword);
      await auth.signOut();
      setNewPassword('');
      setNewConfirm('');
      setNotice('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.');
      navigate('/account', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '비밀번호 변경에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function finishLoginNameRecovery() {
    await auth.signOut();
    setNotice('확인한 아이디와 비밀번호로 로그인해 주세요.');
    navigate('/account', { replace: true });
  }

  const stateMessage = auth.profile?.status === 'pending'
    ? '가입 신청이 접수되었습니다. 관리자 승인 후 서비스를 이용할 수 있습니다. (현재 등급: 일반회원)'
    : auth.profile?.status === 'rejected'
      ? '가입 신청이 반려되었습니다.'
      : auth.profile?.status === 'suspended'
        ? '이용이 정지된 계정입니다.'
        : auth.profile?.status === 'withdrawn'
          ? '탈퇴 처리된 계정입니다.'
          : '';

  if (!auth.loading && auth.user && recoveringLoginName) {
    return (
      <RecoveryLayout title="아이디 찾기">
        <Card>
          <Mail className="mx-auto h-10 w-10 text-primary" />
          <p className="mt-4 text-center text-sm font-bold text-muted-foreground">이메일 본인 확인이 완료되었습니다.</p>
          <p className="mt-4 rounded-2xl bg-primary/10 p-4 text-center text-sm font-bold">가입 아이디</p>
          <p className="mt-2 break-all text-center text-2xl font-black text-primary">{auth.profile?.login_name ?? '프로필 확인 중'}</p>
          {!auth.profile && <p className="mt-3 text-center text-xs font-bold text-destructive">아이디 정보를 불러오지 못했습니다. 관리자에게 문의해 주세요.</p>}
          <button type="button" onClick={() => void finishLoginNameRecovery()} className="mt-5 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">로그인 화면으로 이동</button>
        </Card>
      </RecoveryLayout>
    );
  }

  if (!auth.loading && auth.user && recoveringPassword) {
    return (
      <RecoveryLayout title="새 비밀번호 설정">
        <Card>
          <form onSubmit={submitNewPassword} className="space-y-4">
            <p className="text-left text-sm font-bold leading-6 text-muted-foreground">이메일 본인 확인이 완료되었습니다. 새 비밀번호를 입력해 주세요.</p>
            <Field label="새 비밀번호"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={72} required autoComplete="new-password" className="input" /></Field>
            <Field label="새 비밀번호 확인"><input type="password" value={newConfirm} onChange={(event) => setNewConfirm(event.target.value)} minLength={8} maxLength={72} required autoComplete="new-password" className="input" /></Field>
            {error && <Message kind="error">{error}</Message>}
            <button disabled={busy} className="w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-black text-primary-foreground disabled:opacity-50">{busy ? '변경 중' : '비밀번호 변경'}</button>
          </form>
        </Card>
      </RecoveryLayout>
    );
  }

  if (!auth.loading && auth.user) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
        <header className="border-b border-card-border px-4 py-4">
          <h1 className="text-center text-xl font-black">계정</h1>
        </header>
        <main className="flex-1 px-4 pb-28 pt-5">
          <Card>
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-8 w-8 text-primary" />
              <div>
                <p className="text-xs text-muted-foreground">로그인 중 · {memberGradeLabel(auth.profile)}</p>
                <p className="text-xl font-black">{auth.displayName ?? '사용자'}</p>
              </div>
            </div>
            <p className="mt-3 break-all text-left text-xs font-bold text-muted-foreground">등록 이메일 · {auth.user.email ?? '확인 불가'}</p>
            {stateMessage && <div className="mt-4 flex gap-2 rounded-2xl bg-warning/10 p-4 text-sm font-bold text-warning"><Clock3 className="h-5 w-5 shrink-0" />{stateMessage}</div>}
            {auth.isApproved && <p className="mt-4 rounded-2xl bg-positive/10 p-4 text-center text-sm font-bold text-positive">승인된 계정입니다.</p>}
            {auth.isAdmin && <button onClick={() => navigate('/admin')} className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">관리자 회원 관리</button>}
            <button onClick={() => void auth.signOut()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold"><LogOut className="h-4 w-4" />로그아웃</button>
          </Card>
        </main>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background px-4 py-6">
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8">
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-primary text-2xl font-black text-primary-foreground">119</div>
          <h1 className="mt-4 text-2xl font-black">지식정보</h1>
        </div>

        {!auth.configured && <Card><p className="text-center font-extrabold text-destructive">로그인 서버 설정이 필요합니다.</p></Card>}
        {auth.loading && <Card><p className="text-center font-bold">계정 상태를 확인하고 있습니다.</p></Card>}

        {!auth.loading && auth.configured && (
          <Card>
            <div className="flex rounded-2xl bg-secondary p-1">
              <TabButton active={tab === 'login'} onClick={() => switchTab('login')}>로그인</TabButton>
              <TabButton active={tab === 'register'} onClick={() => switchTab('register')}>회원가입</TabButton>
              <TabButton active={tab === 'find'} onClick={() => switchTab('find')}>계정찾기</TabButton>
            </div>

            {tab === 'login' && (
              <form onSubmit={submitLogin} className="mt-5 space-y-4">
                <Field label="아이디 또는 이메일">
                  <input name="loginId" value={loginId} onChange={(event) => setLoginId(event.target.value)} minLength={1} maxLength={254} required autoComplete="username" className="input" />
                </Field>
                <Field label="비밀번호">
                  <PasswordInput name="loginPassword" value={loginPassword} onChange={setLoginPassword} show={showLoginPassword} onToggle={() => setShowLoginPassword((v) => !v)} autoComplete="current-password" />
                </Field>
                <label className="flex items-center gap-2 text-xs font-extrabold">
                  <input type="checkbox" checked={keepLogin} onChange={(event) => setKeepLogin(event.target.checked)} className="h-4 w-4 rounded border-card-border" />
                  로그인 상태 유지
                </label>
                {error && <Message kind="error">{error}</Message>}
                {notice && <Message kind="ok">{notice}</Message>}
                <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-black text-primary-foreground disabled:opacity-50">
                  <LogIn className="h-4 w-4" />{busy ? '처리 중' : '로그인'}
                </button>
              </form>
            )}

            {tab === 'register' && (
              <form onSubmit={submitRegister} className="mt-5 space-y-4">
                <Field label="아이디 (2~20자)">
                  <input value={regLoginName} onChange={(event) => setRegLoginName(event.target.value)} minLength={2} maxLength={20} required autoComplete="username" className="input" />
                </Field>
                <Field label="이름">
                  <input value={regDisplayName} onChange={(event) => setRegDisplayName(event.target.value)} minLength={2} maxLength={20} required autoComplete="name" className="input" />
                </Field>
                <Field label="이메일">
                  <input type="email" value={regEmail} onChange={(event) => setRegEmail(event.target.value)} maxLength={254} required autoComplete="email" className="input" />
                </Field>
                <Field label="생년월일 6자리 (예: 900131)">
                  <input value={regBirth6} onChange={(event) => setRegBirth6(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required className="input" placeholder="YYMMDD" />
                </Field>
                <Field label="비밀번호 (8자 이상)">
                  <PasswordInput value={regPassword} onChange={setRegPassword} show={showRegPassword} onToggle={() => setShowRegPassword((v) => !v)} autoComplete="new-password" />
                </Field>
                <Field label="비밀번호 확인">
                  <input type={showRegPassword ? 'text' : 'password'} value={regConfirm} onChange={(event) => setRegConfirm(event.target.value)} minLength={8} maxLength={72} required autoComplete="new-password" className="input" />
                </Field>
                <label className="flex items-start gap-2 text-xs font-extrabold leading-5">
                  <input type="checkbox" checked={agreeTerms} onChange={(event) => setAgreeTerms(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 rounded border-card-border" />
                  <span>이용약관 및 개인정보 처리방침에 동의합니다. 생년월일은 계정찾기 본인확인에만 사용되며 암호화(해시)되어 저장됩니다.</span>
                </label>
                {error && <Message kind="error">{error}</Message>}
                {notice && <Message kind="ok">{notice}</Message>}
                <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-black text-primary-foreground disabled:opacity-50">
                  <UserPlus className="h-4 w-4" />{busy ? '처리 중' : '회원가입 신청'}
                </button>
                <p className="text-left text-[11px] font-bold leading-4 text-muted-foreground">가입 후 이메일 인증과 관리자 승인이 완료되면 서비스를 이용할 수 있습니다.</p>
              </form>
            )}

            {tab === 'find' && (
              <div className="mt-5">
                <div className="flex rounded-2xl bg-secondary p-1">
                  <TabButton active={findTab === 'id'} onClick={() => { setFindTab('id'); resetMessages(); setFoundLoginName(''); }}><Search className="mr-1 inline h-3.5 w-3.5" />아이디 찾기</TabButton>
                  <TabButton active={findTab === 'password'} onClick={() => { setFindTab('password'); resetMessages(); setFoundLoginName(''); }}><KeyRound className="mr-1 inline h-3.5 w-3.5" />비밀번호 찾기</TabButton>
                </div>

                {findTab === 'id' && (
                  <form onSubmit={submitFindId} className="mt-4 space-y-4">
                    <p className="text-left text-xs font-bold leading-5 text-muted-foreground">가입 시 등록한 이름·이메일·생년월일이 모두 일치하면 아이디를 알려드립니다.</p>
                    <Field label="이름"><input value={findName} onChange={(event) => setFindName(event.target.value)} minLength={2} maxLength={20} required className="input" /></Field>
                    <Field label="가입 이메일"><input type="email" value={findEmail} onChange={(event) => setFindEmail(event.target.value)} maxLength={254} required className="input" /></Field>
                    <Field label="생년월일 6자리"><input value={findBirth6} onChange={(event) => setFindBirth6(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required className="input" placeholder="YYMMDD" /></Field>
                    {foundLoginName && (
                      <div className="rounded-2xl bg-primary/10 p-4 text-center">
                        <p className="text-xs font-bold text-muted-foreground">가입 아이디</p>
                        <p className="mt-1 break-all text-xl font-black text-primary">{foundLoginName}</p>
                        <p className="mt-1 text-[11px] font-bold text-muted-foreground">일부는 *로 가려서 표시됩니다.</p>
                      </div>
                    )}
                    {error && <Message kind="error">{error}</Message>}
                    <button disabled={busy} className="w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-black text-primary-foreground disabled:opacity-50">{busy ? '확인 중' : '아이디 찾기'}</button>
                  </form>
                )}

                {findTab === 'password' && (
                  <form onSubmit={submitFindPassword} className="mt-4 space-y-4">
                    <p className="text-left text-xs font-bold leading-5 text-muted-foreground">본인 확인 후 가입 이메일로 비밀번호 재설정 링크를 보냅니다.</p>
                    <Field label="아이디 또는 이메일"><input value={findIdentifier} onChange={(event) => setFindIdentifier(event.target.value)} minLength={1} maxLength={254} required className="input" /></Field>
                    <Field label="이름"><input value={findName} onChange={(event) => setFindName(event.target.value)} minLength={2} maxLength={20} required className="input" /></Field>
                    <Field label="생년월일 6자리 (기존 회원은 비워도 됩니다)"><input value={findBirth6} onChange={(event) => setFindBirth6(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} inputMode="numeric" maxLength={6} className="input" placeholder="YYMMDD" /></Field>
                    {error && <Message kind="error">{error}</Message>}
                    {notice && <Message kind="ok">{notice}</Message>}
                    <button disabled={busy} className="w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-black text-primary-foreground disabled:opacity-50">{busy ? '전송 중' : '재설정 이메일 보내기'}</button>
                  </form>
                )}
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex-1 rounded-xl py-2.5 text-sm font-black', active && 'bg-card shadow')}>
      {children}
    </button>
  );
}

function PasswordInput({ name, value, onChange, show, onToggle, autoComplete }: {
  name?: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete: string;
}) {
  return (
    <div className="relative">
      <input name={name} type={show ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} minLength={8} maxLength={72} required autoComplete={autoComplete} className="input pr-11" />
      <button type="button" onClick={onToggle} aria-label={show ? '비밀번호 숨기기' : '비밀번호 표시'} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Message({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={cn('rounded-xl p-3 text-left text-sm font-bold', kind === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive')}>
      {children}
    </p>
  );
}

function RecoveryLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-background px-4 py-6">
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8">
        <h1 className="mb-5 text-center text-xl font-black">{title}</h1>
        {children}
      </main>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">{children}</section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-left text-xs font-extrabold">{label}</span>{children}</label>;
}
