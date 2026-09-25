import type { PreparedExchangeRequest, BitgetCredentials, UpbitCredentials } from '../../services/trade-exchange-adapters.service';
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
      '/api/v2/mix/position/all-position',
      '/api/v2/mix/order/orders-pending',
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
    if (deadlineExpired) throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
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

  if (response.status === 401) return new AccountReadonlyError('BITGET_AUTH_FAILED');
  if (response.status === 403) return new AccountReadonlyError('BITGET_PERMISSION_DENIED');
  return new AccountReadonlyError('BITGET_REQUEST_REJECTED');
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
      if (signal?.aborted) throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
      throw error;
    }

    if (!response.ok) throw await classifyReadonlyHttpFailure(provider, response);

    try {
      return await response.json();
    } catch {
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
  const tossTokens = new TossTokenManager(tossTransport);
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
