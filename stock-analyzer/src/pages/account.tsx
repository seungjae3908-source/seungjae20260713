import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Clock3, LogIn, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { BrokerageAccountConnections } from '@/components/brokerage-account-connections';
import { CenteredPageHeader } from '@/components/centered-page-header';
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

  const backButton = auth.isApproved ? (
    <button type="button" aria-label="뒤로 가기" onClick={() => navigate('/settings')} className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card">
      <ArrowLeft className="h-5 w-5" />
    </button>
  ) : undefined;

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
    <CenteredPageHeader
      title="계정"
      leading={backButton}
      infoTitle="계정 안내"
      infoItems={[
        '회원가입, 승인 상태와 로그인 정보를 관리합니다.',
        '실계좌 연결은 조회 전용 경로만 사용합니다.',
      ]}
    />
    <main className="mx-auto w-full max-w-3xl min-w-0 flex-1 px-3 pb-28 pt-4 sm:px-5 sm:pt-5">
      {!auth.configured && <Card><p className="text-center font-bold text-destructive">계정 저장소 설정이 필요합니다.</p><p className="mt-2 text-center text-sm text-muted-foreground">계정 저장소 연결 정보를 관리자 설정에 등록해 주세요.</p></Card>}
      {auth.loading && <Card><p className="text-center text-sm font-medium">계정 상태를 확인하고 있습니다.</p></Card>}
      {!auth.loading && auth.user ? <Card>
        <div className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><ShieldCheck className="h-6 w-6" /></span>
          <p className="mt-3 text-xs font-medium text-muted-foreground">로그인 중</p>
          <p className="mt-1 truncate text-xl font-bold">{auth.displayName ?? '사용자'}</p>
          <span data-testid="membership-label" className="mt-2 inline-flex rounded-full bg-secondary px-3 py-1 text-xs font-semibold">{MEMBER_TIER_LABELS[auth.membershipLevel]}</span>
        </div>
        {stateMessage && <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-warning/10 p-4 text-center text-sm font-semibold text-warning"><Clock3 className="h-5 w-5 shrink-0" /><span className="min-w-0 break-words">{stateMessage}</span></div>}
        {auth.isApproved && <p className="mt-4 rounded-2xl bg-positive/10 p-4 text-center text-sm font-semibold text-positive">현재 등급에 허용된 기능을 사용할 수 있습니다.</p>}
        {auth.isAdmin && <button type="button" onClick={() => navigate('/admin')} className="mt-4 min-h-11 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">회원 관리</button>}
        <button type="button" onClick={() => void auth.signOut()} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-semibold"><LogOut className="h-4 w-4" />로그아웃</button>
      </Card> : !auth.loading && auth.configured && <Card>
        <div className="flex rounded-2xl bg-secondary p-1"><button type="button" aria-label="로그인 탭" aria-pressed={!register} onClick={() => setRegister(false)} className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${!register ? 'bg-card shadow' : ''}`}>로그인</button><button type="button" aria-label="회원가입 탭" aria-pressed={register} onClick={() => setRegister(true)} className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${register ? 'bg-card shadow' : ''}`}>회원가입</button></div>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label="아이디"><input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={20} required autoComplete="username" className="input" placeholder="한글·영문·숫자 2~20자" /></Field>
          <Field label="비밀번호"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={72} required autoComplete={register ? 'new-password' : 'current-password'} className="input" placeholder="8자 이상" /></Field>
          {register && <Field label="비밀번호 확인"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required className="input" placeholder="비밀번호 다시 입력" /></Field>}
          <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{register ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}{busy ? '처리 중...' : register ? '가입 신청' : '로그인'}</button>
        </form>
      </Card>}
      {!auth.loading && auth.user && auth.can('canAccessBasicInfo') ? <BrokerageAccountConnections canAccessSpot={auth.can('canAccessSpot')} canAccessFutures={auth.can('canAccessFutures')} /> : null}
      {!auth.loading && auth.user && auth.can('canConnectPersonalTelegram') ? <div className="mt-4"><UserBrokerTelegramPanel /></div> : null}
      {(notice || error) && <p role={error ? 'alert' : 'status'} className={`mt-3 break-words rounded-2xl p-4 text-center text-sm font-semibold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
    </main>{auth.isApproved && <BottomNav />}
  </div>;
}

function Card({ children }: { children: React.ReactNode }) { return <section className="min-w-0 rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5">{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block min-w-0"><span className="text-xs font-semibold text-muted-foreground">{label}</span><div className="mt-2 min-w-0 [&_.input]:h-12 [&_.input]:w-full [&_.input]:min-w-0 [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-card-border [&_.input]:bg-background [&_.input]:px-4 [&_.input]:text-sm [&_.input]:font-medium [&_.input]:outline-none [&_.input]:focus:border-primary">{children}</div></label>; }
