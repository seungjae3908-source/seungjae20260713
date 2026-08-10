export const AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS = 8_000;
export const AUTH_PROFILE_BOOTSTRAP_TIMEOUT_MS = 8_000;
export const APP_API_SESSION_TIMEOUT_MS = 8_000;
export const APP_API_REQUEST_TIMEOUT_MS = 12_000;

export type AuthBootstrapTimeoutCode =
  | 'AUTH_SESSION_TIMEOUT'
  | 'AUTH_PROFILE_TIMEOUT'
  | 'APP_API_SESSION_TIMEOUT';

export class FiniteDeadlineError extends Error {
  readonly code: AuthBootstrapTimeoutCode;

  constructor(code: AuthBootstrapTimeoutCode) {
    super(code);
    this.name = 'FiniteDeadlineError';
    this.code = code;
  }
}

export async function withFiniteDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: AuthBootstrapTimeoutCode,
  onTimeout?: (error: FiniteDeadlineError) => void,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid finite deadline: ${timeoutMs}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new FiniteDeadlineError(code);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runFiniteAuthBootstrap<TSession>(input: {
  getSession: () => Promise<TSession>;
  applySession: (session: TSession) => void;
  loadProfile: (session: TSession, signal: AbortSignal) => Promise<void>;
  sessionTimeoutMs?: number;
  profileTimeoutMs?: number;
}): Promise<void> {
  const session = await withFiniteDeadline(
    input.getSession(),
    input.sessionTimeoutMs ?? AUTH_SESSION_BOOTSTRAP_TIMEOUT_MS,
    'AUTH_SESSION_TIMEOUT',
  );
  input.applySession(session);

  const profileController = new AbortController();
  await withFiniteDeadline(
    input.loadProfile(session, profileController.signal),
    input.profileTimeoutMs ?? AUTH_PROFILE_BOOTSTRAP_TIMEOUT_MS,
    'AUTH_PROFILE_TIMEOUT',
    (error) => profileController.abort(error),
  );
}

export function authBootstrapErrorMessage(cause: unknown): string {
  const code = cause instanceof FiniteDeadlineError ? cause.code : '';
  if (code === 'AUTH_SESSION_TIMEOUT') {
    return '로그인 세션 확인이 지연되고 있습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  if (code === 'AUTH_PROFILE_TIMEOUT') {
    return '사용자 권한 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return '초기 계정 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
}
