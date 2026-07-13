import {
	useMemo,
	useState,
	type FormEvent,
} from 'react';
import { useLocation } from 'wouter';
import {
	ArrowLeft,
	LogIn,
	LogOut,
	ShieldCheck,
	UserPlus,
	UserRound,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

type AccountMode =
	| 'signup'
	| 'login';

function readNextPath(): string {
	const params =
		new URLSearchParams(
			window.location.search,
		);

	const next =
		params.get('next');

	if (
		next &&
		next.startsWith('/')
	) {
		return next;
	}

	return '/portfolio';
}

export default function AccountPage() {
	const [, navigate] =
		useLocation();

	const auth =
		useAuth();

	const nextPath =
		useMemo(
			readNextPath,
			[],
		);

	/*
	 * 처음 들어오면 계정 등록 화면을 바로 보여줍니다.
	 */
	const [
		mode,
		setMode,
	] =
		useState<AccountMode>(
			'signup',
		);

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
		confirmPassword,
		setConfirmPassword,
	] =
		useState('');

	const [
		busy,
		setBusy,
	] =
		useState(false);

	const [
		errorMessage,
		setErrorMessage,
	] =
		useState('');

	const [
		successMessage,
		setSuccessMessage,
	] =
		useState('');

	function changeMode(
		nextMode: AccountMode,
	) {
		setMode(nextMode);
		setPassword('');
		setConfirmPassword('');
		setErrorMessage('');
		setSuccessMessage('');
	}

	async function handleSubmit(
		event:
			FormEvent<HTMLFormElement>,
	) {
		event.preventDefault();

		if (busy) {
			return;
		}

		setErrorMessage('');
		setSuccessMessage('');

		const trimmedName =
			loginName.trim();

		if (
			trimmedName.length < 2
		) {
			setErrorMessage(
				'이름을 2자 이상 입력해 주세요.',
			);

			return;
		}

		if (
			password.length < 6
		) {
			setErrorMessage(
				'비밀번호를 6자 이상 입력해 주세요.',
			);

			return;
		}

		if (
			mode === 'signup' &&
			password !==
				confirmPassword
		) {
			setErrorMessage(
				'비밀번호 확인이 일치하지 않습니다.',
			);

			return;
		}

		setBusy(true);

		try {
			if (
				mode === 'signup'
			) {
				await auth.signUp(
					trimmedName,
					password,
				);

				setSuccessMessage(
					'계정 등록이 완료되었습니다.',
				);
			} else {
				await auth.signIn(
					trimmedName,
					password,
				);

				setSuccessMessage(
					'로그인되었습니다.',
				);
			}

			window.setTimeout(
				() => {
					navigate(
						nextPath,
					);
				},
				300,
			);
		} catch (cause) {
			setErrorMessage(
				cause instanceof Error
					? cause.message
					: mode ===
							'signup'
						? '계정 등록에 실패했습니다.'
						: '로그인에 실패했습니다.',
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
		setErrorMessage('');
		setSuccessMessage('');

		try {
			await auth.signOut();

			setLoginName('');
			setPassword('');
			setConfirmPassword('');
			setMode('login');

			setSuccessMessage(
				'로그아웃되었습니다.',
			);
		} catch (cause) {
			setErrorMessage(
				cause instanceof Error
					? cause.message
					: '로그아웃에 실패했습니다.',
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-[100dvh] flex-col bg-background">
			<header className="sticky top-0 z-30 shrink-0 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
				<div className="flex items-center gap-3">
					<button
						type="button"
						aria-label="뒤로가기"
						onClick={() =>
							navigate('/')
						}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<ArrowLeft className="h-5 w-5" />
					</button>

					<div className="min-w-0">
						<h1 className="text-xl font-extrabold">
							내 계정
						</h1>

						<p className="mt-1 break-keep text-xs font-semibold text-muted-foreground">
							이름과 비밀번호만으로 간편하게 이용합니다.
						</p>
					</div>
				</div>
			</header>

			<main className="flex-1 px-4 pb-28 pt-5">
				{!auth.configured && (
					<section className="rounded-3xl border border-destructive/30 bg-card p-5">
						<p className="text-base font-extrabold text-destructive">
							계정 저장 설정이 필요합니다
						</p>

						<p className="mt-2 break-keep text-sm font-semibold leading-6 text-muted-foreground">
							Replit에 VITE_SUPABASE_URL과
							VITE_SUPABASE_ANON_KEY가 등록되어 있는지
							확인해 주세요.
						</p>
					</section>
				)}

				{auth.configured &&
					auth.loading && (
						<section className="rounded-3xl border border-card-border bg-card p-8 text-center">
							<p className="text-sm font-bold text-muted-foreground">
								계정 상태를 확인하는 중입니다.
							</p>
						</section>
					)}

				{auth.configured &&
					!auth.loading &&
					auth.user && (
						<section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
							<div className="flex items-center gap-3">
								<div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
									<UserRound className="h-7 w-7" />
								</div>

								<div className="min-w-0">
									<p className="text-xs font-bold text-muted-foreground">
										로그인 중
									</p>

									<p className="mt-1 truncate text-xl font-extrabold">
										{auth.displayName ??
											'사용자'}
									</p>
								</div>
							</div>

							<div className="mt-4 rounded-2xl bg-secondary/60 p-4">
								<div className="flex items-start gap-2">
									<ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-positive" />

									<p className="break-keep text-xs font-semibold leading-5 text-muted-foreground">
										관심종목, 자산, 매수·매도 내역이 이 계정에
										분리해서 저장됩니다.
									</p>
								</div>
							</div>

							<button
								type="button"
								onClick={() =>
									navigate(
										'/portfolio',
									)
								}
								className="mt-5 w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground"
							>
								내 자산 · 거래내역 열기
							</button>

							<button
								type="button"
								disabled={busy}
								onClick={
									handleSignOut
								}
								className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-background px-4 py-3.5 text-sm font-extrabold disabled:opacity-50"
							>
								<LogOut className="h-4 w-4" />

								{busy
									? '처리 중...'
									: '로그아웃'}
							</button>
						</section>
					)}

				{auth.configured &&
					!auth.loading &&
					!auth.user && (
						<section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
							<div className="grid grid-cols-2 rounded-2xl bg-secondary p-1">
								<button
									type="button"
									onClick={() =>
										changeMode(
											'signup',
										)
									}
									className={cn(
										'rounded-xl px-3 py-3 text-sm font-extrabold transition',

										mode ===
											'signup'
											? 'bg-primary text-primary-foreground shadow-sm'
											: 'text-muted-foreground',
									)}
								>
									계정 등록
								</button>

								<button
									type="button"
									onClick={() =>
										changeMode(
											'login',
										)
									}
									className={cn(
										'rounded-xl px-3 py-3 text-sm font-extrabold transition',

										mode ===
											'login'
											? 'bg-primary text-primary-foreground shadow-sm'
											: 'text-muted-foreground',
									)}
								>
									로그인
								</button>
							</div>

							<div className="mt-5 rounded-2xl bg-primary/10 p-4">
								<div className="flex items-start gap-2">
									{mode ===
									'signup' ? (
										<UserPlus className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
									) : (
										<LogIn className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
									)}

									<div>
										<p className="text-sm font-extrabold text-primary">
											{mode ===
											'signup'
												? '간편 계정 등록'
												: '계정 로그인'}
										</p>

										<p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">
											{mode ===
											'signup'
												? '이름과 비밀번호를 입력하면 바로 계정이 만들어집니다.'
												: '등록할 때 사용한 이름과 비밀번호를 입력해 주세요.'}
										</p>
									</div>
								</div>
							</div>

							<form
								onSubmit={
									handleSubmit
								}
								className="mt-5"
							>
								<label className="block">
									<span className="text-xs font-extrabold text-muted-foreground">
										이름
									</span>

									<input
										type="text"
										value={
											loginName
										}
										onChange={(
											event,
										) =>
											setLoginName(
												event.target
													.value,
											)
										}
										minLength={2}
										maxLength={20}
										required
										autoComplete="username"
										placeholder="예: 승재3908"
										className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary"
									/>
								</label>

								<label className="mt-4 block">
									<span className="text-xs font-extrabold text-muted-foreground">
										비밀번호
									</span>

									<input
										type="password"
										value={
											password
										}
										onChange={(
											event,
										) =>
											setPassword(
												event.target
													.value,
											)
										}
										minLength={6}
										maxLength={72}
										required
										autoComplete={
											mode ===
											'signup'
												? 'new-password'
												: 'current-password'
										}
										placeholder="6자 이상"
										className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary"
									/>
								</label>

								{mode ===
									'signup' && (
									<label className="mt-4 block">
										<span className="text-xs font-extrabold text-muted-foreground">
											비밀번호 확인
										</span>

										<input
											type="password"
											value={
												confirmPassword
											}
											onChange={(
												event,
											) =>
												setConfirmPassword(
													event.target
														.value,
												)
											}
											minLength={6}
											maxLength={72}
											required
											autoComplete="new-password"
											placeholder="비밀번호를 다시 입력"
											className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary"
										/>
									</label>
								)}

								{errorMessage && (
									<div className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3">
										<p className="break-keep text-sm font-bold leading-6 text-destructive">
											{errorMessage}
										</p>
									</div>
								)}

								{successMessage && (
									<div className="mt-4 rounded-2xl bg-positive/10 px-4 py-3">
										<p className="break-keep text-sm font-bold leading-6 text-positive">
											{successMessage}
										</p>
									</div>
								)}

								<button
									type="submit"
									disabled={busy}
									className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
								>
									{mode ===
									'signup' ? (
										<UserPlus className="h-4 w-4" />
									) : (
										<LogIn className="h-4 w-4" />
									)}

									{busy
										? '처리 중...'
										: mode ===
												'signup'
											? '계정 등록하기'
											: '로그인'}
								</button>
							</form>
						</section>
					)}
			</main>

			<BottomNav />
		</div>
	);
}