import type { PreparedExchangeRequest, BitgetCredentials, UpbitCredentials } from '../../services/trade-exchange-adapters.service';
import { decryptTradingCredentials } from '../../services/trade-credential-vault.service';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../../services/trade-automation.repository';
import type { TradingExchange } from '../../services/trade-automation.types';
import { AccountReadonlyError } from './account-readonly.errors';
import type { AccountReader, AccountReadScope } from './account-readonly.service';
import {
  readBitgetSnapshot,
  readUpbitSnapshot,
  type SignedReadonlyTransport,
} from './providers/exchange-readonly.providers';

type ConnectionRepository = Pick<TradingRepository, 'getConnection'>;
type RepositoryFactory = (accessToken: string, userId: string) => ConnectionRepository;
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

    if (response.status === 401 || response.status === 403) {
      throw new AccountReadonlyError('AUTH_FAILED');
    }
    if (response.status === 429) {
      throw new AccountReadonlyError('RATE_LIMITED', true);
    }
    if (!response.ok) {
      throw new AccountReadonlyError('PROVIDER_UNAVAILABLE', response.status >= 500);
    }

    try {
      return await response.json();
    } catch {
      throw new AccountReadonlyError('PROVIDER_RESPONSE_INVALID');
    }
  };
}

async function loadCredentials(
  scope: AccountReadScope,
  exchange: TradingExchange,
  repositoryFactory: RepositoryFactory,
  decryptCredentials: CredentialDecryptor,
) {
  const repository = repositoryFactory(scope.accessToken, scope.userId);
  const connection = await repository.getConnection(scope.userId, exchange);
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
): Partial<Record<'upbit' | 'bitget', AccountReader>> {
  const repositoryFactory = options.repositoryFactory ?? createSupabaseTradingRepository;
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

  return {
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
