import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, LogIn, LogOut, UserRound } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';

function readNextPath(): string {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  return next?.startsWith('/') ? next : '/portfolio';
}

export default function AccountPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const nextPath = useMemo(readNextPath, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');

    try {
      if (mode === 'signup') {
        const result = await auth.signUp(email, password);
        setMessage(result);
      } else {
        await auth.signIn(email, password);
        navigate(nextPath);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '로그인 처리에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    setError('');
    try {
      await auth.signOut();
      setMessage('로그아웃되었습니다.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '로그아웃 실패');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-[100dvh] pb-24">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-card-border bg-background/90 px-4 py-4 backdrop-blur-xl">
        <button
          type="button"
          onClick={() => history.back()}
          className="rounded-xl p-2 active:bg-muted"
          aria-label="뒤로 가기"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-xl font-extrabold">내 계정</h1>
          <p className="text-xs text-muted-foreground">
            관심종목·알림·포트폴리오를 계정에 저장합니다.
          </p>
        </div>
      </header>

      <section className="space-y-4 p-4">
        {!auth.configured ? (
          <div className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
            <h2 className="font-extrabold">Supabase 설정이 필요합니다</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Replit Secrets에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를
              등록하면 이메일 로그인을 사용할 수 있습니다.
            </p>
          </div>
        ) : auth.loading ? (
          <div className="rounded-3xl border border-card-border bg-card p-6 text-center text-sm text-muted-foreground">
            로그인 상태를 확인하고 있습니다.
          </div>
        ) : auth.user ? (
          <div className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                <UserRound className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-muted-foreground">로그인 계정</p>
                <p className="truncate font-extrabold">{auth.user.email}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate('/portfolio')}
              className="mt-5 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
            >
              내 포트폴리오 열기
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={busy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" /> 로그아웃
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="rounded-3xl border border-card-border bg-card p-5 shadow-sm"
          >
            <div className="mb-5 flex rounded-2xl bg-muted p-1">
              {(['login', 'signup'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setMode(item);
                    setError('');
                    setMessage('');
                  }}
                  className={`flex-1 rounded-xl px-3 py-2 text-sm font-extrabold ${
                    mode === item ? 'bg-background shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  {item === 'login' ? '로그인' : '회원가입'}
                </button>
              ))}
            </div>

            <label className="block text-xs font-extrabold text-muted-foreground">
              이메일
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                className="mt-2 w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                placeholder="email@example.com"
              />
            </label>

            <label className="mt-4 block text-xs font-extrabold text-muted-foreground">
              비밀번호
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={6}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="mt-2 w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                placeholder="6자 이상"
              />
            </label>

            {error && (
              <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
                {error}
              </p>
            )}
            {message && (
              <p className="mt-4 rounded-2xl bg-primary/10 px-4 py-3 text-sm font-bold text-primary">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
            >
              <LogIn className="h-4 w-4" />
              {busy
                ? '처리 중...'
                : mode === 'login'
                  ? '로그인'
                  : '회원가입'}
            </button>
          </form>
        )}
      </section>

      <BottomNav />
    </main>
  );
}
