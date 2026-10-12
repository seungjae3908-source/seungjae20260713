import type {
  BitgetCredentials,
  BitgetReadonlyDiagnostic,
  PreparedExchangeRequest,
  UpbitCredentials,
} from '../../services/trade-exchange-adapters.service';
import { decryptTradingCredentials } from '../../services/trade-credential-vault.service';
import { AccountReadonlyError } from './account-readonly.errors';
import {
  createAccountReadonlyCredentialRepository,
  type AccountReadonlyCredentialRepository,
  type ReadonlyCredentialProvider,
} from './account-readonly.repository';
import type { AccountReader, AccountReadScope } from './account-readonly.service';
import {
  readBitgetSnapshot,
  readUpbitSnapshot,
  type SignedReadonlyTransport,
} from './providers/exchange-readonly.providers';
import { KiwoomReadonlyProvider, type KiwoomReadonlyCredentials } from './providers/kiwoom-readonly.provider';
import {
  createTossReadonlyTransport,
  processTossTokenManager,
  TossReadonlyProvider,
  TossTokenManager,
  type TossCredentials,
} from './providers/toss-readonly.provider';

type RepositoryFactory = (userId: string) => AccountReadonlyCredentialRepository;
type CredentialDecryptor = (payload: string) => Record<string, string>;

export const DEFAULT_ACCOUNT_READONLY_PROVIDER_TIMEOUT_MS = 8_000;
const MAX_ACCOUNT_READONLY_PROVIDER_TIMEOUT_MS = 30_000;

export type AccountReadonlyRuntimeOptions = {
  repositoryFactory?: RepositoryFactory;
  decryptCredentials?: CredentialDecryptor;
  fetchImpl?: typeof fetch;
  providerTimeoutMs?: number;
};

const READONLY_TARGETS = {
  upbit: {
    origin: 'https://api.upbit.com',
    paths: new Set(['/v1/accounts', '/v1/orders/open']),
  },
  bitget: {
    origin: 'https://api.bitget.com',
    paths: new Set([
      '/api/v2/mix/account/accounts',
      '/api/v2/mix/account/account',
      '/api/v2/mix/position/all-position',
      '/api/v2/mix/order/orders-pending',
      '/api/v3/account/settings',
      '/api/v3/account/info',
      '/api/v3/account/assets',
      '/api/v3/position/current-position',
      '/api/v3/trade/unfilled-orders',
    ]),
  },
} as const;

function normalizedProviderTimeoutMs(value: number | undefined) {
  if (value == null) return DEFAULT_ACCOUNT_READONLY_PROVIDER_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AccountReadonlyError('ACCOUNT_READONLY_PROVIDER_TIMEOUT_INVALID');
  }
  return Math.min(MAX_ACCOUNT_READONLY_PROVIDER_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

async function withProviderDeadline<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Credential lookup happens before this boundary. If the client disconnected
  // while that storage read was in flight, do not invoke a private provider at all.
  if (callerSignal?.aborted) {
    throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
  }

  const controller = new AbortController();
  let deadlineExpired = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error('PROVIDER_TIMEOUT'));
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (deadlineExpired) {
      if (error instanceof AccountReadonlyError
        && error.code === 'PROVIDER_TIMEOUT'
        && error.bitgetDiagnostic !== null) {
        throw error;
      }
      throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

type ReadonlyHttpProvider = 'upbit' | 'bitget';

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function upbitFailureName(response: Response) {
  try {
    const body: unknown = await response.clone().json();
    const root = objectRecord(body);
    const error = objectRecord(root?.error);
    return typeof error?.name === 'string' ? error.name : '';
  } catch {
    return '';
  }
}

function bitgetApplicationCode(value: unknown): string | null {
  const code = objectRecord(value)?.code;
  const normalized = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
  return /^\d+$/.test(normalized) ? normalized : null;
}

async function bitgetFailureCode(response: Response) {
  try {
    return bitgetApplicationCode(await response.clone().json());
  } catch {
    return null;
  }
}

function classifyBitgetApplicationCode(code: string | null) {
  if (code === '25245' || code === '40084') return new AccountReadonlyError('BITGET_NOT_UTA');
  if (code === '40018' || code === '40038') return new AccountReadonlyError('BITGET_IP_NOT_ALLOWED');
  if (code === '40014' || code === '40025' || code === '40040') return new AccountReadonlyError('BITGET_PERMISSION_DENIED');
  if (code === '40006' || code === '40009' || code === '40012' || code === '40036' || code === '40037') {
    return new AccountReadonlyError('BITGET_AUTH_FAILED');
  }
  if (code === '40008') return new AccountReadonlyError('BITGET_TIMESTAMP_REJECTED', true);
  if (code === '40017' || code === '40034' || code === '400172' || code === '25200') {
    return new AccountReadonlyError('BITGET_PARAMETER_REJECTED');
  }
  if (code === '25003' || code === '25004' || code === '40725' || code === '40808' || code === '45001') {
    return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);
  }
  if (code === '429') return new AccountReadonlyError('RATE_LIMITED', true);
  return null;
}

function classifyBitgetHttpFailure(status: number, applicationCode: string | null) {
  if (status === 429) return new AccountReadonlyError('RATE_LIMITED', true);
  if (status >= 500) return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);

  const application = classifyBitgetApplicationCode(applicationCode);
  if (application) return application;
  if (status === 401) return new AccountReadonlyError('BITGET_AUTH_FAILED');
  if (status === 403) return new AccountReadonlyError('BITGET_PERMISSION_DENIED');
  return new AccountReadonlyError('BITGET_REQUEST_REJECTED');
}

function classifyBitgetTransportFailure(value: unknown, aborted: boolean) {
  const root = objectRecord(value);
  const cause = objectRecord(root?.cause);
  const rawCode = cause?.code ?? root?.code;
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';

  if (aborted || code.includes('TIMEOUT') || code === 'ETIMEDOUT') {
    return {
      error: new AccountReadonlyError('PROVIDER_TIMEOUT', true),
      sanitizedClassification: 'BITGET_TRANSPORT_TIMEOUT',
    } as const;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') {
    return {
      error: new AccountReadonlyError('PROVIDER_UNAVAILABLE', false),
      sanitizedClassification: 'BITGET_TRANSPORT_DNS',
    } as const;
  }
  if (code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) {
    return {
      error: new AccountReadonlyError('PROVIDER_UNAVAILABLE', false),
      sanitizedClassification: 'BITGET_TRANSPORT_TLS',
    } as const;
  }
  if ([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_SOCKET',
  ].includes(code)) {
    return {
      error: new AccountReadonlyError('PROVIDER_UNAVAILABLE', false),
      sanitizedClassification: 'BITGET_TRANSPORT_CONNECT',
    } as const;
  }
  return {
    error: new AccountReadonlyError('PROVIDER_UNAVAILABLE', false),
    sanitizedClassification: 'BITGET_TRANSPORT_NETWORK',
  } as const;
}

function withBitgetFailureDiagnostic(
  error: AccountReadonlyError,
  request: PreparedExchangeRequest,
  expectedOrigin: string,
  httpStatus: number | null,
  applicationCode: string | null,
  sanitizedClassificationOverride?: string,
) {
  const metadata = request.bitgetReadonlyDiagnostic;
  if (!metadata || metadata.provider !== 'bitget') return error;

  const diagnostic: BitgetReadonlyDiagnostic = {
    provider: 'bitget',
    requestMethod: 'GET',
    requestPath: request.path,
    endpointFamily: metadata.endpointFamily,
    probe: metadata.probe,
    httpStatus,
    applicationCode,
    sanitizedClassification: sanitizedClassificationOverride
      ?? (error.code === 'BITGET_AUTH_FAILED'
        && httpStatus === 401
        && applicationCode === null
        ? 'BITGET_HTTP_401_NO_APPLICATION_CODE'
        : error.code),
    fallbackAttempted: metadata.fallbackAttempted === true,
    timestampRejected: error.code === 'BITGET_TIMESTAMP_REJECTED',
    productionHost: expectedOrigin === 'https://api.bitget.com',
    credentialPresence: {
      key: metadata.credentialPresence.key === true,
      secret: metadata.credentialPresence.secret === true,
      passphrase: metadata.credentialPresence.passphrase === true,
    },
  };
  return new AccountReadonlyError(error.code, error.retryable, error.retryAfterMs, diagnostic);
}

async function classifyReadonlyHttpFailure(provider: ReadonlyHttpProvider, response: Response) {
  if (response.status === 429 || (provider === 'upbit' && response.status === 418)) {
    return new AccountReadonlyError('RATE_LIMITED', true);
  }
  if (response.status >= 500) {
    return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);
  }

  if (provider === 'upbit') {
    const failureName = await upbitFailureName(response);
    if (response.status === 401) {
      if (failureName === 'no_authorization_ip') return new AccountReadonlyError('UPBIT_IP_NOT_ALLOWED');
      return new AccountReadonlyError('UPBIT_AUTH_FAILED');
    }
    if (response.status === 403) {
      return new AccountReadonlyError('UPBIT_PERMISSION_DENIED');
    }
    return new AccountReadonlyError('UPBIT_REQUEST_REJECTED');
  }

  return classifyBitgetHttpFailure(response.status, await bitgetFailureCode(response));
}

function createReadonlyTransport(
  provider: ReadonlyHttpProvider,
  origin: string,
  allowedPaths: ReadonlySet<string>,
  fetchImpl: typeof fetch,
): SignedReadonlyTransport {
  const expectedOrigin = new URL(origin).origin;

  return async (request: PreparedExchangeRequest, signal?: AbortSignal) => {
    if (request.method !== 'GET' || request.body !== null || !allowedPaths.has(request.path)) {
      throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
    }

    const url = new URL(request.path, expectedOrigin);
    if (request.query) url.search = request.query;
    if (url.origin !== expectedOrigin || !allowedPaths.has(url.pathname)) {
      throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: request.headers,
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (error) {
      if (provider === 'bitget') {
        const failure = classifyBitgetTransportFailure(error, signal?.aborted === true);
        throw withBitgetFailureDiagnostic(
          failure.error,
          request,
          expectedOrigin,
          null,
          null,
          failure.sanitizedClassification,
        );
      }
      if (signal?.aborted) throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
      throw error;
    }

    if (!response.ok) {
      if (provider === 'bitget') {
        const applicationCode = await bitgetFailureCode(response);
        throw withBitgetFailureDiagnostic(
          classifyBitgetHttpFailure(response.status, applicationCode),
          request,
          expectedOrigin,
          response.status,
          applicationCode,
        );
      }
      throw await classifyReadonlyHttpFailure(provider, response);
    }

    try {
      const payload: unknown = await response.json();
      if (provider === 'bitget') {
        const applicationCode = bitgetApplicationCode(payload);
        if (applicationCode !== null && applicationCode !== '00000') {
          const error = classifyBitgetApplicationCode(applicationCode)
            ?? new AccountReadonlyError('BITGET_REQUEST_REJECTED');
          throw withBitgetFailureDiagnostic(error, request, expectedOrigin, response.status, applicationCode);
        }
      }
      return payload;
    } catch (error) {
      if (error instanceof AccountReadonlyError) throw error;
      throw new AccountReadonlyError('PROVIDER_RESPONSE_INVALID');
    }
  };
}

async function loadCredentials(
  scope: AccountReadScope,
  provider: ReadonlyCredentialProvider,
  repositoryFactory: RepositoryFactory,
  decryptCredentials: CredentialDecryptor,
) {
  const repository = repositoryFactory(scope.userId);
  const connection = await repository.get(scope.userId, provider);
  if (!connection?.configured || !connection.encryptedCredentials) {
    throw new AccountReadonlyError('ACCOUNT_NOT_CONFIGURED');
  }

  try {
    return decryptCredentials(connection.encryptedCredentials);
  } catch {
    throw new AccountReadonlyError('CREDENTIALS_UNAVAILABLE');
  }
}

function requireCredential(credentials: Record<string, string>, key: string) {
  const value = String(credentials[key] ?? '').trim();
  if (!value) throw new AccountReadonlyError('CREDENTIALS_UNAVAILABLE');
  return value;
}

export function createVaultBackedAccountReaders(
  options: AccountReadonlyRuntimeOptions = {},
): Partial<Record<'toss' | 'kiwoom' | 'upbit' | 'bitget', AccountReader>> {
  const repositoryFactory = options.repositoryFactory ?? createAccountReadonlyCredentialRepository;
  const decryptCredentials = options.decryptCredentials ?? decryptTradingCredentials;
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerTimeoutMs = normalizedProviderTimeoutMs(options.providerTimeoutMs);

  const upbitTransport = createReadonlyTransport(
    'upbit',
    READONLY_TARGETS.upbit.origin,
    READONLY_TARGETS.upbit.paths,
    fetchImpl,
  );
  const bitgetTransport = createReadonlyTransport(
    'bitget',
    READONLY_TARGETS.bitget.origin,
    READONLY_TARGETS.bitget.paths,
    fetchImpl,
  );
  const tossTransport = createTossReadonlyTransport(fetchImpl);
  const tossTokens = options.fetchImpl
    ? new TossTokenManager(tossTransport)
    : processTossTokenManager();
  const tossProvider = new TossReadonlyProvider(tossTransport, tossTokens);
  const kiwoomProvider = new KiwoomReadonlyProvider(fetchImpl);

  return {
    toss: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'toss', repositoryFactory, decryptCredentials);
      const credentials: TossCredentials = {
        clientId: requireCredential(raw, 'clientId'),
        clientSecret: requireCredential(raw, 'clientSecret'),
        accountSeq: String(raw.accountSeq ?? '').trim() || undefined,
      };
      return withProviderDeadline(signal, providerTimeoutMs, (boundedSignal) => tossProvider.snapshot(credentials, boundedSignal));
    },
    kiwoom: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'kiwoom', repositoryFactory, decryptCredentials);
      const credentials: KiwoomReadonlyCredentials = {
        appKey: requireCredential(raw, 'appKey'),
        appSecret: requireCredential(raw, 'appSecret'),
      };
      return withProviderDeadline(signal, providerTimeoutMs, (boundedSignal) => kiwoomProvider.snapshot(credentials, boundedSignal));
    },
    upbit: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'upbit', repositoryFactory, decryptCredentials);
      const credentials: UpbitCredentials = {
        accessKey: requireCredential(raw, 'accessKey'),
        secretKey: requireCredential(raw, 'secretKey'),
      };
      return withProviderDeadline(signal, providerTimeoutMs, (boundedSignal) => readUpbitSnapshot(credentials, upbitTransport, boundedSignal));
    },
    bitget: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'bitget', repositoryFactory, decryptCredentials);
      const credentials: BitgetCredentials = {
        apiKey: requireCredential(raw, 'apiKey'),
        secretKey: requireCredential(raw, 'secretKey'),
        passphrase: requireCredential(raw, 'passphrase'),
      };
      return withProviderDeadline(signal, providerTimeoutMs, (boundedSignal) => readBitgetSnapshot(credentials, bitgetTransport, boundedSignal));
    },
  };
}
