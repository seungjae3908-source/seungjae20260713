// Shared, user-facing Korean explanations for API / runtime error codes.
// Raw developer codes (BACKTEST_EXECUTION_FAILED, HTTP_503, ...) must never be
// the only thing a user sees: every failure shows what failed, why (as far as
// the client can tell), and what to do next. The raw code is kept only for the
// copied diagnostics.

export type ErrorReason = {
  /** One-line summary of what failed. */
  title: string;
  /** Why it most likely failed, in plain Korean. */
  reason: string;
  /** What the user can do next. */
  action: string;
  /** Normalized machine code (for diagnostics only, never the headline). */
  code: string | null;
  /** Whether trying again can plausibly help. */
  retryable: boolean;
};

type ReasonEntry = Omit<ErrorReason, 'code'>;

const RETRY_LATER = '잠시 후 다시 시도해 주세요.';

const CODE_REASONS: Record<string, ReasonEntry> = {
  // Generic transport / HTTP
  NETWORK_ERROR: { title: '서버에 연결하지 못했습니다', reason: '인터넷 연결이 끊겼거나 서버가 응답하지 않습니다.', action: '네트워크 상태를 확인한 뒤 다시 시도해 주세요.', retryable: true },
  REQUEST_TIMEOUT: { title: '응답 시간이 초과되었습니다', reason: '데이터 제공처 또는 서버 응답이 제한 시간 안에 오지 않았습니다.', action: RETRY_LATER, retryable: true },
  RATE_LIMITED: { title: '요청이 너무 많습니다', reason: '짧은 시간에 요청이 몰려 데이터 제공처가 일시적으로 제한했습니다.', action: '1~2분 뒤 다시 시도해 주세요.', retryable: true },
  UPSTREAM_ERROR: { title: '데이터 제공처 오류', reason: '외부 시세·공시 제공처가 오류를 돌려주었습니다.', action: RETRY_LATER, retryable: true },
  NOT_CONFIGURED: { title: '데이터 연결이 설정되지 않았습니다', reason: '이 기능에 필요한 API 키가 서버에 설정되어 있지 않습니다.', action: '관리자에게 데이터 연결 설정을 요청해 주세요.', retryable: false },
  UNAVAILABLE: { title: '데이터가 없습니다', reason: '해당 종목에 대해 제공처가 데이터를 주지 않았습니다.', action: '다른 종목이나 기간으로 확인해 주세요.', retryable: false },
  UNKNOWN_TICKER: { title: '종목을 찾을 수 없습니다', reason: '입력한 종목 코드가 지원 목록에 없습니다.', action: '검색에서 종목을 다시 선택해 주세요.', retryable: false },
  API_ROUTE_NOT_FOUND: { title: '지원하지 않는 기능입니다', reason: '앱이 요청한 서버 기능이 현재 서버 버전에 없습니다(배포 버전 불일치 가능).', action: '앱을 새로고침해 최신 버전으로 다시 열어 주세요.', retryable: false },
  HTTP_400: { title: '요청 값이 올바르지 않습니다', reason: '입력값 중 서버가 받을 수 없는 값이 있습니다.', action: '입력값을 확인한 뒤 다시 시도해 주세요.', retryable: false },
  HTTP_401: { title: '로그인이 필요합니다', reason: '로그인 세션이 만료되었습니다.', action: '다시 로그인해 주세요.', retryable: false },
  HTTP_403: { title: '접근 권한이 없습니다', reason: '현재 회원 등급으로는 이 기능을 사용할 수 없습니다.', action: '관리자에게 권한을 요청해 주세요.', retryable: false },
  HTTP_404: { title: '정보를 찾지 못했습니다', reason: '요청한 데이터나 서버 기능이 없습니다.', action: '앱을 새로고침한 뒤 다시 확인해 주세요.', retryable: false },
  HTTP_408: { title: '응답 시간이 초과되었습니다', reason: '서버 응답이 제한 시간 안에 오지 않았습니다.', action: RETRY_LATER, retryable: true },
  HTTP_429: { title: '요청이 너무 많습니다', reason: '요청 한도에 도달했습니다.', action: '1~2분 뒤 다시 시도해 주세요.', retryable: true },
  HTTP_500: { title: '서버 내부 오류', reason: '서버에서 요청을 처리하는 중 오류가 발생했습니다.', action: RETRY_LATER, retryable: true },
  HTTP_502: { title: '데이터 제공처 오류', reason: '서버가 외부 데이터 제공처로부터 정상 응답을 받지 못했습니다.', action: RETRY_LATER, retryable: true },
  HTTP_503: { title: '일시적으로 사용할 수 없습니다', reason: '데이터 제공처가 지연되거나 서버가 점검·과부하 상태입니다.', action: RETRY_LATER, retryable: true },
  HTTP_504: { title: '응답 시간이 초과되었습니다', reason: '서버가 외부 데이터 제공처 응답을 기다리다 시간이 초과되었습니다.', action: RETRY_LATER, retryable: true },

  // Auth / membership
  LOGIN_REQUIRED: { title: '로그인이 필요합니다', reason: '로그인 정보가 없거나 만료되었습니다.', action: '다시 로그인해 주세요.', retryable: false },
  INVALID_SESSION: { title: '로그인 세션이 만료되었습니다', reason: '로그인 정보가 더 이상 유효하지 않습니다.', action: '다시 로그인해 주세요.', retryable: false },
  CAPABILITY_REQUIRED: { title: '접근 권한이 없습니다', reason: '현재 회원 등급으로는 이 기능을 사용할 수 없습니다.', action: '관리자에게 권한을 요청해 주세요.', retryable: false },
  ADMIN_REQUIRED: { title: '관리자 전용 기능입니다', reason: '관리자 계정만 사용할 수 있습니다.', action: '관리자 계정으로 로그인해 주세요.', retryable: false },
  AUTH_PROFILE_BOOTSTRAP_TIMEOUT: { title: '계정 정보를 불러오지 못했습니다', reason: '회원 권한 정보 조회가 제한 시간 안에 끝나지 않았습니다(회원 DB 응답 지연).', action: '다시 시도를 눌러 주세요. 계속되면 잠시 후 다시 접속해 주세요.', retryable: true },
  MEMBER_SCHEMA_NOT_READY: { title: '회원 정보 준비 중', reason: '서버의 회원 정보 저장소가 아직 준비되지 않았습니다.', action: '관리자에게 문의해 주세요.', retryable: false },
  PROFILE_NOT_FOUND: { title: '회원 정보가 없습니다', reason: '로그인한 계정의 회원 정보가 아직 생성되지 않았습니다.', action: '관리자에게 승인을 요청해 주세요.', retryable: false },

  // Stock detail
  INVALID_STOCK_INFO_RESPONSE: { title: '종목 정보 형식이 올바르지 않습니다', reason: '서버가 보낸 종목 정보에 필수 값(종목 코드·이름·가격 등)이 빠져 있거나 다른 종목 값이었습니다.', action: RETRY_LATER, retryable: true },
  AI_ANALYSIS_CONTRACT_INVALID: { title: 'AI 분석 결과 형식이 올바르지 않습니다', reason: '서버가 보낸 분석 결과에 필수 항목이 빠져 있어 표시하지 않았습니다.', action: RETRY_LATER, retryable: true },
  ANALYSIS_INPUT_UNAVAILABLE: { title: 'AI 분석에 필요한 시세가 없습니다', reason: '현재가와 일봉 데이터를 모두 받지 못해 분석을 만들 수 없습니다.', action: '장중이거나 시세가 확인되는 종목에서 다시 시도해 주세요.', retryable: true },
  STOCK_ANALYSIS_ROUTE_ERROR: { title: 'AI 분석 생성 실패', reason: '서버에서 분석을 계산하는 중 오류가 발생했습니다.', action: RETRY_LATER, retryable: true },
  FINANCIAL_PROVIDER_DELAY: { title: '재무 데이터 지연', reason: '재무 데이터 제공기관(DART/SEC)의 응답이 지연되고 있습니다.', action: RETRY_LATER, retryable: true },
  QUOTE_NOT_FOUND: { title: '현재가를 찾지 못했습니다', reason: '시세 제공처에서 이 종목의 현재가를 받지 못했습니다.', action: '장 운영 시간인지 확인한 뒤 다시 시도해 주세요.', retryable: true },

  // Backtest
  BACKTEST_EXECUTION_FAILED: { title: '백테스트를 완료하지 못했습니다', reason: '서버가 과거 시세를 받아오거나 계산하는 중 오류가 났습니다. 주로 거래소 공개 시세 요청이 차단(403/429)되거나 지연될 때 발생합니다.', action: '잠시 후 다시 실행하거나 기간을 줄이고 다른 종목·시간봉으로 시도해 주세요.', retryable: true },
  BACKTEST_TIMEOUT: { title: '백테스트 시간 초과', reason: '계산할 캔들이 많거나 시세 제공처 응답이 늦어 제한 시간을 넘겼습니다.', action: '기간을 줄이거나 더 긴 시간봉으로 다시 실행해 주세요.', retryable: true },
  BACKTEST_BUSY: { title: '다른 백테스트가 실행 중입니다', reason: '서버가 동시에 실행할 수 있는 백테스트 수를 초과했습니다.', action: '진행 중인 백테스트가 끝난 뒤 다시 실행해 주세요.', retryable: true },
  BACKTEST_ABORTED: { title: '백테스트가 중단되었습니다', reason: '요청이 취소되었거나 연결이 끊겼습니다.', action: '다시 실행해 주세요.', retryable: true },
  BACKTEST_CANCELLED: { title: '백테스트가 취소되었습니다', reason: '사용자 또는 서버가 실행을 취소했습니다.', action: '필요하면 다시 실행해 주세요.', retryable: true },
  BACKTEST_LIMITS: { title: '백테스트 범위 초과', reason: '기간이나 캔들 수가 허용 한도를 넘었습니다.', action: '기간을 줄여 다시 실행해 주세요.', retryable: false },
  BACKTEST_DATASET_IDENTITY_MISMATCH: { title: '백테스트 데이터 불일치', reason: '요청한 종목·시간봉과 받은 시세 데이터가 일치하지 않았습니다.', action: RETRY_LATER, retryable: true },

  // Scanner
  SCAN_MARKET_UNSUPPORTED: { title: '지원하지 않는 시장입니다', reason: '선택한 시장은 검색기에서 아직 지원하지 않습니다.', action: '다른 시장을 선택해 주세요.', retryable: false },
  SCAN_STRATEGY_TIMEFRAME_MISMATCH: { title: '전략과 시간봉이 맞지 않습니다', reason: '선택한 전략은 이 시간봉을 지원하지 않습니다.', action: '전략에 맞는 시간봉을 선택해 주세요.', retryable: false },

  // AI chat
  AI_CHAT_NOT_CONFIGURED: { title: 'AI 상담 공급자가 연결되지 않았습니다', reason: '서버에 AI 공급자 키(GEMINI_API_KEY 또는 GROQ_API_KEY)가 설정되어 있지 않습니다.', action: '관리자에게 AI 공급자 키 설정을 요청해 주세요.', retryable: false },
  AI_CHAT_PROVIDER_ERROR: { title: 'AI 공급자 응답 오류', reason: 'AI 공급자(Gemini/Groq)가 정상 응답을 주지 않았습니다.', action: RETRY_LATER, retryable: true },
  AI_CHAT_RATE_LIMITED: { title: 'AI 사용 한도 도달', reason: '무료 AI 사용 한도 또는 요청 한도에 도달했습니다.', action: RETRY_LATER, retryable: true },
  AI_CHAT_TIMEOUT: { title: 'AI 응답 시간 초과', reason: 'AI 응답이 제한 시간 안에 오지 않았습니다.', action: '질문을 짧게 줄여 다시 시도해 주세요.', retryable: true },

  // Client runtime
  CHUNK_LOAD_FAILED: { title: '화면 파일을 불러오지 못했습니다', reason: '앱이 새 버전으로 업데이트되어 이전 화면 파일이 더 이상 없습니다.', action: '새로고침하면 최신 화면으로 열립니다.', retryable: true },
  RENDER_FAILED: { title: '화면을 표시하는 중 오류가 발생했습니다', reason: '받은 데이터 중 화면이 처리하지 못한 값이 있었습니다.', action: '다시 시도를 누르거나 새로고침해 주세요.', retryable: true },
};

const FALLBACK: ReasonEntry = {
  title: '데이터를 불러오지 못했습니다',
  reason: '서버 또는 데이터 제공처에서 알 수 없는 오류가 발생했습니다.',
  action: RETRY_LATER,
  retryable: true,
};

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;
const CHUNK_ERROR_PATTERN = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk [\w-]+ failed|Unable to preload CSS|is not a valid JavaScript MIME type/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return name === 'ChunkLoadError' || CHUNK_ERROR_PATTERN.test(message);
}

/** Extract a normalized machine code from any thrown value. */
export function errorCodeOf(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return CODE_PATTERN.test(error.trim()) ? error.trim() : null;
  if (isChunkLoadError(error)) return 'CHUNK_LOAD_FAILED';
  if (typeof error === 'object') {
    const record = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
    if (typeof record.code === 'string' && CODE_PATTERN.test(record.code)) return record.code;
    if (record.name === 'AbortError' || record.name === 'TimeoutError') return 'REQUEST_TIMEOUT';
    if (typeof record.message === 'string') {
      const message = record.message.trim();
      if (CODE_PATTERN.test(message)) return message;
      if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return 'NETWORK_ERROR';
      if (/timeout|timed out/i.test(message)) return 'REQUEST_TIMEOUT';
    }
    if (typeof record.status === 'number' && record.status >= 400) return `HTTP_${record.status}`;
  }
  return null;
}

function entryFor(code: string | null): ReasonEntry | null {
  if (!code) return null;
  const direct = CODE_REASONS[code];
  if (direct) return direct;
  if (/TIMEOUT|DEADLINE/.test(code)) return CODE_REASONS.REQUEST_TIMEOUT;
  if (/RATE_LIMIT/.test(code)) return CODE_REASONS.RATE_LIMITED;
  if (/NOT_CONFIGURED/.test(code)) return CODE_REASONS.NOT_CONFIGURED;
  if (/FORBIDDEN|CAPABILITY/.test(code)) return CODE_REASONS.CAPABILITY_REQUIRED;
  if (/NOT_FOUND/.test(code)) return CODE_REASONS.HTTP_404;
  const http = code.match(/^HTTP_(\d{3})$/);
  if (http) return Number(http[1]) >= 500 ? CODE_REASONS.HTTP_500 : CODE_REASONS.HTTP_400;
  return null;
}

/** True when a string looks like a developer code that should not be a headline. */
export function looksLikeDeveloperCode(text: string | null | undefined): boolean {
  if (!text) return false;
  const value = text.trim();
  if (CODE_PATTERN.test(value)) return true;
  // e.g. "REQUEST TIMEOUT · unavailable", "HTTP_503 upstream" — no Korean, has an upper-case token.
  return !/[가-힣]/.test(value) && /[A-Z_]{4,}/.test(value);
}

/**
 * Explain an error for users. `fallbackTitle` lets a page name what failed
 * ("백테스트를 완료하지 못했습니다") when the code itself is unknown.
 * A server-provided Korean `message` is preferred as the reason when present.
 */
export function describeError(
  error: unknown,
  options: { fallbackTitle?: string; message?: string | null } = {},
): ErrorReason {
  const code = errorCodeOf(error);
  const entry = entryFor(code);
  const serverMessage = options.message?.trim();
  const usableServerMessage = serverMessage && !looksLikeDeveloperCode(serverMessage) ? serverMessage : null;
  const base = entry ?? FALLBACK;
  const title = entry ? base.title : options.fallbackTitle ?? base.title;
  const strip = (text: string) => text.replace(/[.。!\s]+$/u, '');
  // A server message that only repeats the title ("백테스트를 완료하지 못했습니다.") adds no reason.
  const reason = usableServerMessage && strip(usableServerMessage) !== strip(title) && strip(usableServerMessage) !== strip(base.title)
    ? usableServerMessage
    : base.reason;
  return { title, reason, action: base.action, code, retryable: base.retryable };
}

/** Single-line Korean text (title + reason + action) for places that only show a string. */
export function describeErrorText(
  error: unknown,
  options: { fallbackTitle?: string; message?: string | null } = {},
): string {
  const described = describeError(error, options);
  return `${described.title}: ${described.reason} ${described.action}`;
}
