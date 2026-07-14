import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, LogIn, LogOut, ShieldCheck, UserPlus, UserRound, X } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { useAuth } from "@/lib/auth";

function readNextPath(): string {
	const next = new URLSearchParams(window.location.search).get("next");
	return next?.startsWith("/") ? next : "/portfolio";
}

export default function AccountPage() {
	const [, navigate] = useLocation();
	const auth = useAuth();
	const nextPath = useMemo(readNextPath, []);
	const [registerOpen, setRegisterOpen] = useState(false);
	const [loginName, setLoginName] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const resetMessages = () => {
		setMessage("");
		setError("");
	};

	async function submitLogin(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		resetMessages();
		setBusy(true);
		try {
			await auth.signIn(loginName.trim(), password);
			setMessage("로그인되었습니다.");
			window.setTimeout(() => navigate(nextPath), 250);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "로그인에 실패했습니다.");
		} finally {
			setBusy(false);
		}
	}

	async function submitRegister(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		resetMessages();
		if (password !== confirmPassword) {
			setError("비밀번호 확인이 일치하지 않습니다.");
			return;
		}
		setBusy(true);
		try {
			await auth.signUp(loginName.trim(), password);
			setMessage("계정 등록이 완료되었습니다.");
			setRegisterOpen(false);
			window.setTimeout(() => navigate(nextPath), 250);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "계정 등록에 실패했습니다.");
		} finally {
			setBusy(false);
		}
	}

	async function signOut() {
		if (busy) return;
		setBusy(true);
		resetMessages();
		try {
			await auth.signOut();
			setLoginName("");
			setPassword("");
			setMessage("로그아웃되었습니다.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "로그아웃에 실패했습니다.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
			<header className="relative z-30 shrink-0 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
				<div className="flex items-center gap-3">
					<button type="button" aria-label="뒤로가기" onClick={() => navigate("/more")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card">
						<ArrowLeft className="h-5 w-5" />
					</button>
					<div className="min-w-0">
						<h1 className="text-xl font-extrabold">내 계정</h1>
						<p className="mt-1 break-keep text-xs font-semibold text-muted-foreground">설정 화면에서만 로그인과 계정 등록을 관리합니다.</p>
					</div>
				</div>
			</header>

			<main className="flex-none px-4 pb-28 pt-5">
				{!auth.configured && (
					<section className="rounded-3xl border border-destructive/30 bg-card p-5">
						<p className="text-base font-extrabold text-destructive">계정 저장 설정이 필요합니다</p>
						<p className="mt-2 break-keep text-sm font-semibold leading-6 text-muted-foreground">Replit Secrets에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 등록해 주세요.</p>
					</section>
				)}

				{auth.configured && auth.loading && (
					<section className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">계정 상태를 확인하는 중입니다.</section>
				)}

				{auth.configured && !auth.loading && auth.user && (
					<section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
						<div className="flex items-center gap-3">
							<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><UserRound className="h-7 w-7" /></div>
							<div className="min-w-0"><p className="text-xs font-bold text-muted-foreground">로그인 중</p><p className="mt-1 truncate text-xl font-extrabold">{auth.displayName ?? "사용자"}</p></div>
						</div>
						<div className="mt-4 flex items-start gap-2 rounded-2xl bg-secondary/60 p-4"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-positive" /><p className="break-keep text-xs font-semibold leading-5 text-muted-foreground">관심종목과 포트폴리오가 이 계정에 분리 저장됩니다.</p></div>
						<button type="button" onClick={() => navigate("/portfolio")} className="mt-5 w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground">내 포트폴리오 열기</button>
						<button type="button" disabled={busy} onClick={() => void signOut()} className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-background px-4 py-3.5 text-sm font-extrabold disabled:opacity-50"><LogOut className="h-4 w-4" />{busy ? "처리 중..." : "로그아웃"}</button>
					</section>
				)}

				{auth.configured && !auth.loading && !auth.user && (
					<section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
						<div className="flex items-start gap-2 rounded-2xl bg-primary/10 p-4"><LogIn className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-extrabold text-primary">계정 로그인</p><p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">등록한 이름과 비밀번호를 입력해 주세요.</p></div></div>
						<form onSubmit={submitLogin} className="mt-5">
							<AccountFields loginName={loginName} password={password} setLoginName={setLoginName} setPassword={setPassword} />
							<button type="submit" disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50"><LogIn className="h-4 w-4" />{busy ? "로그인 중..." : "로그인"}</button>
						</form>
						<button type="button" onClick={() => { resetMessages(); setConfirmPassword(""); setRegisterOpen(true); }} className="mt-4 w-full text-center text-sm font-extrabold text-primary">계정등록</button>
					</section>
				)}

				{(message || error) && <p className={`mt-3 rounded-2xl px-4 py-3 text-sm font-bold ${error ? "bg-destructive/10 text-destructive" : "bg-positive/10 text-positive"}`}>{error || message}</p>}
			</main>
			<BottomNav />

			{registerOpen && !auth.user && (
				<div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-3 sm:items-center">
					<button type="button" className="absolute inset-0" aria-label="닫기" onClick={() => setRegisterOpen(false)} />
					<section className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-card p-5 shadow-2xl">
						<div className="flex items-start justify-between gap-3"><div><p className="text-xs font-extrabold text-primary">새 계정</p><h2 className="mt-1 text-xl font-black">계정 등록</h2></div><button type="button" onClick={() => setRegisterOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary"><X className="h-4 w-4" /></button></div>
						<form onSubmit={submitRegister} className="mt-5">
							<AccountFields loginName={loginName} password={password} setLoginName={setLoginName} setPassword={setPassword} />
							<label className="mt-4 block"><span className="text-xs font-extrabold text-muted-foreground">비밀번호 확인</span><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={6} maxLength={72} required autoComplete="new-password" placeholder="비밀번호 다시 입력" className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary" /></label>
							<button type="submit" disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50"><UserPlus className="h-4 w-4" />{busy ? "등록 중..." : "계정 등록 완료"}</button>
						</form>
						{error && <p className="mt-3 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">{error}</p>}
					</section>
				</div>
			)}
		</div>
	);
}

function AccountFields({ loginName, password, setLoginName, setPassword }: { loginName: string; password: string; setLoginName: (value: string) => void; setPassword: (value: string) => void }) {
	return <>
		<label className="block"><span className="text-xs font-extrabold text-muted-foreground">이름</span><input type="text" value={loginName} onChange={(e) => setLoginName(e.target.value)} minLength={2} maxLength={20} required autoComplete="username" placeholder="예: 승재3908" className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary" /></label>
		<label className="mt-4 block"><span className="text-xs font-extrabold text-muted-foreground">비밀번호</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} maxLength={72} required autoComplete="current-password" placeholder="6자 이상" className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary" /></label>
	</>;
}