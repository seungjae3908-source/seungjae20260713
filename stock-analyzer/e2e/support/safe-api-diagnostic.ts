export type SafeApiDiagnostic = {
  testStep: string;
  requestPath: string;
  status: number;
  errorCode: string | null;
  safeMessage: string | null;
  externalAiCalled: boolean | null;
  orderSubmitted: boolean | null;
  exchangeRequestSent: boolean | null;
};

type JsonResponse = {
  status(): number;
  json(): Promise<unknown>;
};

const SAFE_PATHS = new Set(['/api/paper-journal/ai-review/preview']);
const SAFE_STEPS = new Set(['regular-ai-preview']);
const SAFE_ERROR_MESSAGES = new Map<string, string>([
  ['JOURNAL_STORAGE_UNAVAILABLE', '거래일지 저장소를 처리하지 못했습니다.'],
  ['CAPABILITY_REQUIRED', 'AI 거래 복기는 정회원과 관리자만 사용할 수 있습니다.'],
  ['LOGIN_REQUIRED', '로그인이 필요합니다.'],
  ['INVALID_SESSION', '유효하지 않은 로그인 세션입니다.'],
  ['CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.'],
  ['REQUEST_TOO_LARGE', '요청 크기가 제한을 초과했습니다.'],
  ['AI_REVIEW_PERIOD_INVALID', '분석 기간은 최대 90일입니다.'],
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function safeError(body: Record<string, unknown> | null, status: number) {
  if (status < 400) return { errorCode: null, safeMessage: null };
  const nested = asRecord(body?.error);
  const candidate = typeof nested?.code === 'string'
    ? nested.code
    : typeof body?.code === 'string'
      ? body.code
      : typeof body?.error === 'string'
        ? body.error
        : null;
  if (!candidate || !SAFE_ERROR_MESSAGES.has(candidate)) {
    return { errorCode: 'UNRECOGNIZED_ERROR_CODE', safeMessage: null };
  }
  const expectedMessage = SAFE_ERROR_MESSAGES.get(candidate) ?? null;
  const candidateMessage = typeof nested?.message === 'string'
    ? nested.message
    : typeof body?.message === 'string'
      ? body.message
      : null;
  return {
    errorCode: candidate,
    safeMessage: candidateMessage === expectedMessage ? expectedMessage : null,
  };
}

export async function collectSafeApiDiagnostic(
  response: JsonResponse,
  input: { testStep: string; requestPath: string },
): Promise<SafeApiDiagnostic> {
  const testStep = SAFE_STEPS.has(input.testStep) ? input.testStep : 'unrecognized-step';
  const requestPath = SAFE_PATHS.has(input.requestPath) ? input.requestPath : 'unrecognized-path';
  const status = response.status();
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(await response.json());
  } catch {
    return {
      testStep,
      requestPath,
      status,
      errorCode: status >= 400 ? 'NON_JSON_RESPONSE' : null,
      safeMessage: null,
      externalAiCalled: null,
      orderSubmitted: null,
      exchangeRequestSent: null,
    };
  }

  const safe = safeError(body, status);
  return {
    testStep,
    requestPath,
    status,
    errorCode: safe.errorCode,
    safeMessage: safe.safeMessage,
    externalAiCalled: booleanOrNull(body?.externalAiCalled),
    orderSubmitted: booleanOrNull(body?.orderSubmitted),
    exchangeRequestSent: booleanOrNull(body?.exchangeRequestSent),
  };
}
