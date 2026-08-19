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
import {
  createTossReadonlyTransport,
  TossReadonlyProvider,
  TossTokenManager,
  type TossCredentials,
} from './providers/toss-readonly.provider';

type RepositoryFactory = (userId: string) => AccountReadonlyCredentialRepository;
type CredentialDecryptor = (payload: string) => Record<string, string>;

export type AccountReadonlyRuntimeOptions = {
  repositoryFactory?: RepositoryFactory;
  decryptCredentials?: CredentialDecryptor;
  fetchImpl?: typeof fetch;
};

const READONLY_TARGETS = {
  upbit: {
    origin: 'https://api.upbit.com',
    paths: new Set(['/v1/accounts']),
  },
  bitget: {
    origin: 'https://api.bitget.com',
    paths: new Set([
      '/api/v2/mix/account/accounts',
      '/api/v2/mix/position/all-position',
    ]),
  },
} as const;

function createReadonlyTransport(
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

    if (response.status === 401 || response.status === 403) throw new AccountReadonlyError('AUTH_FAILED');
    if (response.status === 429) throw new AccountReadonlyError('RATE_LIMITED', true);
    if (!response.ok) throw new AccountReadonlyError('PROVIDER_UNAVAILABLE', response.status >= 500);

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
): Partial<Record<'toss' | 'upbit' | 'bitget', AccountReader>> {
  const repositoryFactory = options.repositoryFactory ?? createAccountReadonlyCredentialRepository;
  const decryptCredentials = options.decryptCredentials ?? decryptTradingCredentials;
  const fetchImpl = options.fetchImpl ?? fetch;

  const upbitTransport = createReadonlyTransport(
    READONLY_TARGETS.upbit.origin,
    READONLY_TARGETS.upbit.paths,
    fetchImpl,
  );
  const bitgetTransport = createReadonlyTransport(
    READONLY_TARGETS.bitget.origin,
    READONLY_TARGETS.bitget.paths,
    fetchImpl,
  );
  const tossTransport = createTossReadonlyTransport(fetchImpl);
  const tossTokens = new TossTokenManager(tossTransport);
  const tossProvider = new TossReadonlyProvider(tossTransport, tossTokens);

  return {
    toss: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'toss', repositoryFactory, decryptCredentials);
      const credentials: TossCredentials = {
        clientId: requireCredential(raw, 'clientId'),
        clientSecret: requireCredential(raw, 'clientSecret'),
        accountSeq: String(raw.accountSeq ?? '').trim() || undefined,
      };
      return tossProvider.snapshot(credentials, signal);
    },
    upbit: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'upbit', repositoryFactory, decryptCredentials);
      const credentials: UpbitCredentials = {
        accessKey: requireCredential(raw, 'accessKey'),
        secretKey: requireCredential(raw, 'secretKey'),
      };
      return readUpbitSnapshot(credentials, upbitTransport, signal);
    },
    bitget: async (scope, signal) => {
      const raw = await loadCredentials(scope, 'bitget', repositoryFactory, decryptCredentials);
      const credentials: BitgetCredentials = {
        apiKey: requireCredential(raw, 'apiKey'),
        secretKey: requireCredential(raw, 'secretKey'),
        passphrase: requireCredential(raw, 'passphrase'),
      };
      return readBitgetSnapshot(credentials, bitgetTransport, signal);
    },
  };
}
