import { Router, type IRouter } from 'express';

import type { AuthenticatedRequest } from '../middleware/auth';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../services/trade-automation.repository';
import type {
  ExchangeConnection,
  TradingAccountMode,
  TradingExchange,
} from '../services/trade-automation.types';

export type BrokerProviderId = 'toss' | 'kiwoom' | 'upbit' | 'bitget';
export type BrokerConnectivityStatus =
  | 'configured_unverified'
  | 'not_configured'
  | 'waiting_for_api_access';
export type BrokerCredentialSource = 'vault' | 'none';

export type NormalizedBrokerAccount = {
  provider: BrokerProviderId;
  accountRef: string | null;
  accountMode: TradingAccountMode | 'unavailable';
  currency: 'KRW' | 'USD' | 'USDT' | null;
  status: 'unavailable';
  provenance: 'private_provider_read_disabled';
};

export type NormalizedBrokerAsset = {
  provider: BrokerProviderId;
  assetClass: 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  symbol: string;
  quantity: number;
  currency: 'KRW' | 'USD' | 'USDT';
  status: 'unavailable';
  provenance: 'private_provider_read_disabled';
};

type ProviderDefinition = {
  id: BrokerProviderId;
  displayName: string;
  exchange: TradingExchange | null;
  markets: Array<'KR' | 'US' | 'UPBIT' | 'BITGET'>;
  assetClasses: NormalizedBrokerAsset['assetClass'][];
  currency: 'KRW' | 'USD' | 'USDT';
  publicMarketData: boolean;
};

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'toss',
    displayName: 'Toss Securities',
    exchange: null,
    markets: ['KR', 'US'],
    assetClasses: ['domestic_stock', 'us_stock'],
    currency: 'KRW',
    publicMarketData: false,
  },
  {
    id: 'kiwoom',
    displayName: 'Kiwoom',
    exchange: 'kiwoom',
    markets: ['KR', 'US'],
    assetClasses: ['domestic_stock', 'us_stock'],
    currency: 'KRW',
    publicMarketData: true,
  },
  {
    id: 'upbit',
    displayName: 'Upbit',
    exchange: 'upbit',
    markets: ['UPBIT'],
    assetClasses: ['crypto_spot'],
    currency: 'KRW',
    publicMarketData: true,
  },
  {
    id: 'bitget',
    displayName: 'Bitget',
    exchange: 'bitget',
    markets: ['BITGET'],
    assetClasses: ['crypto_futures'],
    currency: 'USDT',
    publicMarketData: true,
  },
];

export type BrokerProviderStatus = {
  provider: BrokerProviderId;
  displayName: string;
  configured: boolean;
  connected: false;
  connectivityStatus: BrokerConnectivityStatus;
  credentialSource: BrokerCredentialSource;
  accountMode: TradingAccountMode | 'unavailable';
  provenance: 'user_vault_metadata' | 'release_static_boundary';
  markets: ProviderDefinition['markets'];
  assetClasses: ProviderDefinition['assetClasses'];
  capabilities: {
    publicMarketData: boolean;
    readOnlyConnectivityStatus: true;
    normalizedAccountModel: true;
    normalizedAssetModel: true;
    privateAccountRead: false;
    privatePositionRead: false;
    placeOrder: false;
    cancelOrder: false;
    amendOrder: false;
    transfer: false;
    withdraw: false;
  };
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  message: string;
};

type BrokerCommonState = {
  providers: Record<BrokerProviderId, BrokerProviderStatus>;
  accounts: NormalizedBrokerAccount[];
  assets: NormalizedBrokerAsset[];
};

function connectionMap(userId: string, connections: ExchangeConnection[]) {
  const map = new Map<TradingExchange, ExchangeConnection>();
  for (const connection of connections) {
    if (connection.userId !== userId) {
      throw new Error('ACCOUNT_CONNECTION_USER_SCOPE_MISMATCH');
    }
    map.set(connection.exchange, connection);
  }
  return map;
}

function providerStatus(
  definition: ProviderDefinition,
  connections: Map<TradingExchange, ExchangeConnection>,
): BrokerProviderStatus {
  const connection = definition.exchange ? connections.get(definition.exchange) ?? null : null;
  const configured = Boolean(connection?.configured);
  const tossWaiting = definition.id === 'toss';
  const connectivityStatus: BrokerConnectivityStatus = tossWaiting
    ? 'waiting_for_api_access'
    : configured
      ? 'configured_unverified'
      : 'not_configured';

  return {
    provider: definition.id,
    displayName: definition.displayName,
    configured: tossWaiting ? false : configured,
    connected: false,
    connectivityStatus,
    credentialSource: configured ? 'vault' : 'none',
    accountMode: connection?.accountMode ?? 'unavailable',
    provenance: definition.exchange ? 'user_vault_metadata' : 'release_static_boundary',
    markets: [...definition.markets],
    assetClasses: [...definition.assetClasses],
    capabilities: {
      publicMarketData: definition.publicMarketData,
      readOnlyConnectivityStatus: true,
      normalizedAccountModel: true,
      normalizedAssetModel: true,
      privateAccountRead: false,
      privatePositionRead: false,
      placeOrder: false,
      cancelOrder: false,
      amendOrder: false,
      transfer: false,
      withdraw: false,
    },
    lastVerifiedAt: connection?.lastVerifiedAt ?? null,
    lastErrorCode: connection?.lastErrorCode ?? null,
    message: tossWaiting
      ? 'Toss API 접근 승인을 기다리는 중입니다. 이번 Release에서는 private 요청을 보내지 않습니다.'
      : configured
        ? '개인 vault 설정 메타데이터만 확인했습니다. provider private 연결 검증은 이번 Release에서 비활성화되어 있습니다.'
        : '개인 vault 연결이 설정되지 않았습니다.',
  };
}

export function buildBrokerCommonState(userId: string, connections: ExchangeConnection[]): BrokerCommonState {
  const byExchange = connectionMap(userId, connections);
  const providers = Object.fromEntries(
    PROVIDERS.map((definition) => [definition.id, providerStatus(definition, byExchange)]),
  ) as Record<BrokerProviderId, BrokerProviderStatus>;

  // The model contract is live now, but private provider account/position reads are
  // deliberately disabled for Release V4.2. Never fabricate balances or positions.
  return {
    providers,
    accounts: [],
    assets: [],
  };
}

type RepositoryFactory = (accessToken: string, userId: string) => Pick<TradingRepository, 'getConnections'>;

let repositoryFactory: RepositoryFactory = (accessToken, userId) =>
  createSupabaseTradingRepository(accessToken, userId);

export function setAccountConnectionRepositoryFactoryForTests(factory: RepositoryFactory | null) {
  repositoryFactory = factory ?? ((accessToken, userId) => createSupabaseTradingRepository(accessToken, userId));
}

async function stateForRequest(req: AuthenticatedRequest): Promise<BrokerCommonState> {
  const userId = req.member?.id ?? '';
  const accessToken = req.accessToken ?? '';
  if (!userId || !accessToken) throw new Error('LOGIN_REQUIRED');
  const repository = repositoryFactory(accessToken, userId);
  const connections = await repository.getConnections(userId);
  return buildBrokerCommonState(userId, connections);
}

function legacySnapshot(status: BrokerProviderStatus) {
  return {
    ok: false,
    configured: status.configured,
    connected: false,
    credentialSource: status.credentialSource,
    currency: status.provider === 'bitget' ? 'USDT' : status.provider === 'toss' ? 'KRW' : status.provider === 'upbit' ? 'KRW' : 'KRW',
    totalBalance: 0,
    available: 0,
    holdings: [],
    positions: [],
    error: status.provider === 'toss'
      ? 'TOSS_API_ACCESS_WAITING'
      : status.configured
        ? 'PRIVATE_PROVIDER_READ_DISABLED'
        : 'ACCOUNT_NOT_CONFIGURED',
    message: status.message,
  };
}

function baseResponse(state: BrokerCommonState) {
  return {
    ok: true,
    readOnly: true,
    connectivityMode: 'vault_metadata_only' as const,
    mutationsAllowed: false,
    credentialsReturned: false,
    serverCredentialFallback: false,
    privateProviderRequests: 0,
    orderSubmitted: false,
    exchangeRequestSent: false,
    userScope: 'self' as const,
    providerProvenance: 'self_scoped_vault_metadata_only' as const,
    providers: state.providers,
    normalizedAccounts: state.accounts,
    normalizedAssets: state.assets,
    checkedAt: new Date().toISOString(),
  };
}

const router: IRouter = Router();

router.get('/contract', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const state = await stateForRequest(req);
    return res.json(baseResponse(state));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ACCOUNT_CONNECTION_STATUS_UNAVAILABLE';
    const status = code === 'LOGIN_REQUIRED' ? 401 : code === 'ACCOUNT_CONNECTION_USER_SCOPE_MISMATCH' ? 403 : 503;
    return res.status(status).json({
      ok: false,
      error: code,
      readOnly: true,
      mutationsAllowed: false,
      credentialsReturned: false,
      serverCredentialFallback: false,
      privateProviderRequests: 0,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
});

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const state = await stateForRequest(req);
    return res.json(baseResponse(state));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ACCOUNT_CONNECTION_STATUS_UNAVAILABLE';
    const status = code === 'LOGIN_REQUIRED' ? 401 : code === 'ACCOUNT_CONNECTION_USER_SCOPE_MISMATCH' ? 403 : 503;
    return res.status(status).json({
      ok: false,
      error: code,
      readOnly: true,
      mutationsAllowed: false,
      credentialsReturned: false,
      serverCredentialFallback: false,
      privateProviderRequests: 0,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
});

router.get('/snapshot', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const state = await stateForRequest(req);
    const response = baseResponse(state);
    return res.json({
      ...response,
      providers: {
        kiwoom: legacySnapshot(state.providers.kiwoom),
        upbit: legacySnapshot(state.providers.upbit),
        bitget: legacySnapshot(state.providers.bitget),
        toss: legacySnapshot(state.providers.toss),
      },
      providerContract: state.providers,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ACCOUNT_CONNECTION_STATUS_UNAVAILABLE';
    const status = code === 'LOGIN_REQUIRED' ? 401 : code === 'ACCOUNT_CONNECTION_USER_SCOPE_MISMATCH' ? 403 : 503;
    return res.status(status).json({
      ok: false,
      error: code,
      readOnly: true,
      mutationsAllowed: false,
      credentialsReturned: false,
      serverCredentialFallback: false,
      privateProviderRequests: 0,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
});

export default router;
