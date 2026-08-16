import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../../services/trade-automation.repository';
import {
  credentialConfigurationStatus,
  encryptTradingCredentials,
} from '../../services/trade-credential-vault.service';
import type { AccountProvider } from './account-readonly.contract';
import { AccountReadonlyService } from './account-readonly.service';

const PROVIDERS = new Set<AccountProvider>(['toss', 'upbit', 'bitget']);
const CREDENTIAL_PROVIDERS = new Set<ReadonlyCredentialProvider>(['upbit', 'bitget']);
const CREDENTIAL_KEYS: Record<ReadonlyCredentialProvider, readonly string[]> = {
  upbit: ['accessKey', 'secretKey'],
  bitget: ['apiKey', 'secretKey', 'passphrase'],
};
const FORBIDDEN_PERMISSION_PATTERN = /(trade|order|write|withdraw|transfer|매매|주문|출금|이체)/i;

type ReadonlyCredentialProvider = 'upbit' | 'bitget';
type CredentialRepository = Pick<TradingRepository, 'getConnection' | 'saveConnection'>;

let credentialRepositoryFactoryForTests: ((userId: string, accessToken: string) => CredentialRepository) | null = null;

export function setAccountReadonlyCredentialRepositoryFactoryForTests(
  factory: ((userId: string, accessToken: string) => CredentialRepository) | null,
) {
  credentialRepositoryFactoryForTests = factory;
}

export function accountReadFlags(environment: NodeJS.ProcessEnv = process.env) {
  return {
    toss: environment.TOSS_ACCOUNT_READ_ENABLED === 'true',
    upbit: environment.UPBIT_ACCOUNT_READ_ENABLED === 'true',
    bitget: environment.BITGET_ACCOUNT_READ_ENABLED === 'true',
  } as const;
}

function safetyCounters() {
  return {
    credentialsReturned: false,
    privateProviderRequests: 0,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    liveTradingEnabled: false,
    autoTradingEnabled: false,
  } as const;
}

function deniedResponse(errorCode: string) {
  return {
    ok: false,
    errorCode,
    ...safetyCounters(),
  } as const;
}

function authScope(req: AuthenticatedRequest) {
  return {
    userId: req.member?.id ?? '',
    accessToken: req.accessToken ?? '',
  };
}

function credentialRepository(userId: string, accessToken: string): CredentialRepository {
  if (credentialRepositoryFactoryForTests) return credentialRepositoryFactoryForTests(userId, accessToken);
  return createSupabaseTradingRepository(accessToken, userId);
}

export function parseReadonlyCredentialRequest(
  provider: ReadonlyCredentialProvider,
  body: unknown,
): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('READONLY_CREDENTIAL_BODY_REQUIRED');
  const input = body as Record<string, unknown>;
  if (input.purpose !== 'read_only') throw new Error('READONLY_PURPOSE_CONFIRMATION_REQUIRED');

  const permissions = Array.isArray(input.permissions) ? input.permissions.map(String) : [];
  if (permissions.some((permission) => FORBIDDEN_PERMISSION_PATTERN.test(permission))) {
    throw new Error('MUTATION_PERMISSION_NOT_ALLOWED');
  }

  const rawCredentials = input.credentials;
  if (!rawCredentials || typeof rawCredentials !== 'object' || Array.isArray(rawCredentials)) {
    throw new Error('CREDENTIALS_REQUIRED');
  }
  const credentials = rawCredentials as Record<string, unknown>;
  const allowedKeys = CREDENTIAL_KEYS[provider];
  if (Object.keys(credentials).some((key) => !allowedKeys.includes(key))) {
    throw new Error('UNEXPECTED_CREDENTIAL_FIELD');
  }

  const normalized = Object.fromEntries(
    allowedKeys.map((key) => [key, String(credentials[key] ?? '').trim()]),
  );
  if (Object.values(normalized).some((value) => !value)) throw new Error('CREDENTIALS_INCOMPLETE');
  return normalized;
}

export async function saveReadonlyCredentialConfiguration(
  repository: CredentialRepository,
  userId: string,
  provider: ReadonlyCredentialProvider,
  credentials: Record<string, string>,
) {
  const existing = await repository.getConnection(userId, provider);
  const accountMode = existing?.accountMode ?? 'paper';
  await repository.saveConnection({
    userId,
    exchange: provider,
    accountMode,
    configured: true,
    encryptedCredentials: encryptTradingCredentials(credentials),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  return { accountMode } as const;
}

function credentialErrorStatus(errorCode: string) {
  if (errorCode === 'LOGIN_REQUIRED') return 401;
  if (errorCode.includes('MASTER_KEY')) return 503;
  return 400;
}

export function createAccountReadonlyRouter(service: AccountReadonlyService): IRouter {
  const router: IRouter = Router();

  router.get('/credentials/status', (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const { userId, accessToken } = authScope(req);
    if (!userId || !accessToken) return res.status(401).json(deniedResponse('LOGIN_REQUIRED'));
    const vault = credentialConfigurationStatus();
    return res.json({
      ok: true,
      encryptionConfigured: vault.encryptionConfigured,
      supportedProviders: ['upbit', 'bitget'],
      tossCredentialSetupSupported: false,
      storage: 'user_scoped_encrypted_vault',
      ...safetyCounters(),
    });
  });

  router.put('/credentials/:provider', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const { userId, accessToken } = authScope(req);
    if (!userId || !accessToken) return res.status(401).json(deniedResponse('LOGIN_REQUIRED'));

    const provider = String(req.params.provider ?? '').toLowerCase() as ReadonlyCredentialProvider;
    if (!CREDENTIAL_PROVIDERS.has(provider)) {
      return res.status(404).json(deniedResponse('READONLY_CREDENTIAL_PROVIDER_NOT_SUPPORTED'));
    }

    try {
      if (!credentialConfigurationStatus().encryptionConfigured) {
        throw new Error('TRADING_CREDENTIAL_MASTER_KEY_INVALID');
      }
      const credentials = parseReadonlyCredentialRequest(provider, req.body);
      const saved = await saveReadonlyCredentialConfiguration(
        credentialRepository(userId, accessToken),
        userId,
        provider,
        credentials,
      );
      return res.json({
        ok: true,
        provider,
        configured: true,
        accountMode: saved.accountMode,
        purpose: 'read_only',
        ...safetyCounters(),
      });
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(':')[0] : 'READONLY_CREDENTIAL_SAVE_FAILED';
      return res.status(credentialErrorStatus(errorCode)).json(deniedResponse(errorCode));
    }
  });

  router.get('/:provider', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const provider = String(req.params.provider ?? '').toLowerCase() as AccountProvider;
    if (!PROVIDERS.has(provider)) {
      return res.status(404).json(deniedResponse('ACCOUNT_PROVIDER_NOT_SUPPORTED'));
    }

    const { userId, accessToken } = authScope(req);
    if (!userId || !accessToken) {
      return res.status(401).json(deniedResponse('LOGIN_REQUIRED'));
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try {
      const snapshot = await service.read({ userId, accessToken }, provider, controller.signal);
      if (!res.writableEnded) return res.json(snapshot);
    } finally {
      req.removeListener('aborted', abort);
    }
  });
  return router;
}
