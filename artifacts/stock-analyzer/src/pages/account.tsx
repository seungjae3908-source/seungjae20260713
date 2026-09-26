import {
	useMemo,
	useState,
	type FormEvent,
} from 'react';

import {
	useLocation,
} from 'wouter';

import {
	ArrowLeft,
	LogIn,
	LogOut,
	ShieldCheck,
	UserPlus,
	UserRound,
} from 'lucide-react';

import {
	BottomNav,
} from '@/components/bottom-nav';

import {
	useAuth,
} from '@/lib/auth';

import {
	cn,
} from '@/lib/utils';

function readNextPath(): string {
	const params =
		new URLSearchParams(
			window.location.search,
		);

	const next =
		params.get('next');

	return next?.startsWith('/')
		? next
		: '/portfolio';
}

function readErrorMessage(
	cause: unknown,
	fallback: string,
): string {
	if (
		cause instanceof Error &&
		cause.message
	) {
		return cause.message;
	}

	if (
		typeof cause === 'object' &&
		cause !== null &&
		'message' in cause
	) {
		const message =
			String(
				(
					cause as {
						message?: unknown;
					}
				).message ?? '',
			).trim();

		if (message) {
			return message;
		}
	}

	if (
		typeof cause === 'string' &&
		cause.trim()
	) {
		return cause.trim();
	}

	return fallback;
}

export default function AccountPage() {
	const [
		,
		navigate,
	] =
		useLocation();

	const auth =
		useAuth();

	const [
		mode,
		setMode,
	] =
		useState<
			'login' | 'signup'
		>('login');

	const [
		loginName,
		setLoginName,
	] =
		useState('');

	const [
		password,
		setPassword,
	] =
		useState('');

	const [
		busy,
		setBusy,
	] =
		useState(false);

	const [
		message,
		setMessage,
	] =
		useState('');

	const [
		error,
		setError,
	] =
		useState('');

	const nextPath =
		useMemo(
			readNextPath,
			[],
		);

	function changeMode(
		nextMode:
			| 'login'
			| 'signup',
	) {
		setMode(nextMode);
		setError('');
		setMessage('');
	}

	async function submit(
		event:
			FormEvent<HTMLFormElement>,
	) {
		event.preventDefault();

		if (busy) {
			return;
		}

		setBusy(true);
		setError('');
		setMessage('');

		try {
			if (mode === 'signup') {
				await auth.signUp(
					loginName,
					password,
				);

				setMessage(
					'계정 등록이 완료되었습니다.',
				);
			} else {
				await auth.signIn(
					loginName,
					password,
				);

				setMessage(
					'로그인되었습니다.',
				);
			}

			setPassword('');

			navigate(
				nextPath,
			);
		} catch (cause) {
			const fallback =
				mode === 'signup'
					? '계정 등록에 실패했습니다.'
					: '로그인에 실패했습니다.';

			setError(
				readErrorMessage(
					cause,
					fallback,
				),
			);
		} finally {
			setBusy(false);
		}
	}

	async function handleSignOut() {
		if (busy) {
			return;
		}

		setBusy(true);
		setError('');
		setMessage('');

		try {
			await auth.signOut();

			setPassword('');

			setMessage(
				'로그아웃되었습니다.',
			);
		} catch (cause) {
			setError(
				readErrorMessage(
					cause,
					'로그아웃에 실패했습니다.',
				),
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="min-h-[100dvh] bg-background pb-24">
			<header className="sticky top-0 z-20 flex items-center gap-3 border-b border-card-border bg-background/90 px-4 py-4 backdrop-blur-xl">
				<button
					type="button"
					onClick={() =>
						window.history.back()
					}
					className="rounded-xl p-2 active:bg-muted"
					aria-label="뒤로 가기"
				>
					<ArrowLeft className="h-5 w-5" />
				</button>

				<div className="min-w-0">
					<h1 className="text-xl font-extrabold">
						내 계정
					</h1>

					<p className="mt-0.5 break-keep text-xs leading-relaxed text-muted-foreground">
						이름과 비밀번호만으로 간편하게 이용합니다.
					</p>
				</div>
			</header>

			<section className="space-y-4 p-4">
				{!auth.configured ? (
					<div className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
						<h2 className="font-extrabold">
							계정 저장 설정이 필요합니다
						</h2>

						<p className="mt-2 break-keep text-sm leading-6 text-muted-foreground">
							Replit Secrets에
							VITE_SUPABASE_URL과
							VITE_SUPABASE_ANON_KEY를
							등록해 주세요.
						</p>
					</div>
				) : auth.loading ? (
					<div className="rounded-3xl border border-card-border bg-card p-6 text-center text-sm font-bold text-muted-foreground">
						로그인 상태를 확인하고 있습니다.
					</div>
				) : auth.user ? (
					<div className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
						<div className="flex items-center gap-3">
							<div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
								<UserRound className="h-6 w-6" />
							</div>

							<div className="min-w-0">
								<p className="text-xs font-bold text-muted-foreground">
									로그인 중
								</p>

								<p className="mt-1 truncate text-lg font-extrabold">
									{auth.displayName ??
										'사용자'}
								</p>
							</div>
						</div>

						<div className="mt-4 rounded-2xl bg-secondary/60 px-4 py-3">
							<div className="flex items-start gap-2">
								<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-positive" />

								<p className="break-keep text-xs font-semibold leading-5 text-muted-foreground">
									계정별로 포트폴리오와 거래내역을
									분리해서 저장합니다. 비밀번호는
									화면이나 데이터 표에 그대로 저장되지
									않습니다.
								</p>
							</div>
						</div>

						{error && (
							<p className="mt-4 break-keep rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-bold leading-6 text-destructive">
								{error}
							</p>
						)}

						{message && (
							<p className="mt-4 break-keep rounded-2xl bg-positive/10 px-4 py-3 text-sm font-bold leading-6 text-positive">
								{message}
							</p>
						)}

						<button
							type="button"
							onClick={() =>
								navigate(
									'/portfolio',
								)
							}
							className="mt-5 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
						>
							내 자산 · 거래내역 열기
						</button>

						<button
							type="button"
							onClick={
								handleSignOut
							}
							disabled={
								busy
							}
							className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold disabled:opacity-50"
						>
							<LogOut className="h-4 w-4" />

							{busy
								? '처리 중...'
								: '로그아웃'}
						</button>
					</div>
				) : (
					<form
						onSubmit={
							submit
						}
						className="rounded-3xl border border-card-border bg-card p-5 shadow-sm"
					>
						<div className="mb-5 grid grid-cols-2 rounded-2xl bg-muted p-1">
							<button
								type="button"
								onClick={() =>
									changeMode(
										'login',
									)
								}
								className={cn(
									'rounded-xl px-3 py-2.5 text-sm font-extrabold',

									mode === 'login'
										? 'bg-background text-foreground shadow-sm'
										: 'text-muted-foreground',
								)}
							>
								로그인
							</button>

							<button
								type="button"
								onClick={() =>
									changeMode(
										'signup',
									)
								}
								className={cn(
									'rounded-xl px-3 py-2.5 text-sm font-extrabold',

									mode === 'signup'
										? 'bg-background text-foreground shadow-sm'
										: 'text-muted-foreground',
								)}
							>
								계정 등록
							</button>
						</div>

						<div className="mb-5 rounded-2xl bg-primary/10 px-4 py-3">
							<div className="flex items-start gap-2">
								{mode === 'signup' ? (
									<UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
								) : (
									<LogIn className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
								)}

								<p className="break-keep text-xs font-bold leading-5 text-primary">
									{mode === 'signup'
										? '사용할 이름과 비밀번호를 입력하면 바로 계정이 만들어집니다.'
										: '등록할 때 사용한 이름과 비밀번호를 입력해 주세요.'}
								</p>
							</div>
						</div>

						<label className="block text-xs font-extrabold text-muted-foreground">
							이름

							<input
								type="text"
								value={
									loginName
								}
								onChange={(
									event,
								) =>
									setLoginName(
										event.target.value,
									)
								}
								required
								minLength={2}
								maxLength={20}
								autoComplete="username"
								autoCapitalize="none"
								spellCheck={false}
								className="mt-2 w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-base font-bold outline-none focus:border-primary"
								placeholder="예: 승재3908"
							/>
						</label>

						<p className="mt-2 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
							한글, 영문, 숫자, 마침표, 밑줄, 하이픈을
							사용할 수 있습니다. 띄어쓰기는 사용할 수
							없습니다.
						</p>

						<label className="mt-4 block text-xs font-extrabold text-muted-foreground">
							비밀번호

							<input
								type="password"
								value={
									password
								}
								onChange={(
									event,
								) =>
									setPassword(
										event.target.value,
									)
								}
								required
								minLength={6}
								maxLength={72}
								autoComplete={
									mode === 'login'
										? 'current-password'
										: 'new-password'
								}
								className="mt-2 w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-base font-bold outline-none focus:border-primary"
								placeholder="6자 이상"
							/>
						</label>

						{error && (
							<p className="mt-4 whitespace-pre-line break-keep rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-bold leading-6 text-destructive">
								{error}
							</p>
						)}

						{message && (
							<p className="mt-4 break-keep rounded-2xl bg-positive/10 px-4 py-3 text-sm font-bold leading-6 text-positive">
								{message}
							</p>
						)}

						<button
							type="submit"
							disabled={
								busy
							}
							className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
						>
							{mode === 'signup' ? (
								<UserPlus className="h-4 w-4" />
							) : (
								<LogIn className="h-4 w-4" />
							)}

							{busy
								? '처리 중...'
								: mode === 'signup'
									? '이 이름으로 계정 등록'
									: '로그인'}
						</button>
					</form>
				)}
			</section>

			<BottomNav />
		</main>
	);
}