import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth';
import {
  credentialConfigurationStatus,
  encryptTradingCredentials,
} from '../../services/trade-credential-vault.service';
import type { AccountProvider } from './account-readonly.contract';
import {
  createAccountReadonlyCredentialRepository,
  type AccountReadonlyCredentialRepository,
  type ReadonlyCredentialProvider,
} from './account-readonly.repository';
import { AccountReadonlyService } from './account-readonly.service';

const PROVIDERS = new Set<AccountProvider>(['toss', 'upbit', 'bitget']);
const CREDENTIAL_PROVIDERS = new Set<ReadonlyCredentialProvider>(['toss', 'upbit', 'bitget']);
const CREDENTIAL_FIELDS: Record<ReadonlyCredentialProvider, { required: readonly string[]; optional: readonly string[] }> = {
  toss: { required: ['clientId', 'clientSecret'], optional: ['accountSeq'] },
  upbit: { required: ['accessKey', 'secretKey'], optional: [] },
  bitget: { required: ['apiKey', 'secretKey', 'passphrase'], optional: [] },
};
const FORBIDDEN_PERMISSION_PATTERN = /(trade|order|write|withdraw|transfer|매매|주문|출금|이체)/i;

type CredentialRepositoryFactory = (userId: string) => AccountReadonlyCredentialRepository;
let credentialRepositoryFactoryForTests: CredentialRepositoryFactory | null = null;

export function setAccountReadonlyCredentialRepositoryFactoryForTests(factory: CredentialRepositoryFactory | null) {
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
  return { ok: false, errorCode, ...safetyCounters() } as const;
}

function authScope(req: AuthenticatedRequest) {
  return { userId: req.member?.id ?? '', accessToken: req.accessToken ?? '' };
}

function credentialRepository(userId: string): AccountReadonlyCredentialRepository {
  return credentialRepositoryFactoryForTests?.(userId)
    ?? createAccountReadonlyCredentialRepository(userId);
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
  const schema = CREDENTIAL_FIELDS[provider];
  const allowedKeys = [...schema.required, ...schema.optional];
  if (Object.keys(credentials).some((key) => !allowedKeys.includes(key))) {
    throw new Error('UNEXPECTED_CREDENTIAL_FIELD');
  }

  const normalized = Object.fromEntries(
    allowedKeys.map((key) => [key, String(credentials[key] ?? '').trim()]),
  );
  if (schema.required.some((key) => !normalized[key])) throw new Error('CREDENTIALS_INCOMPLETE');
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== ''));
}

export async function saveReadonlyCredentialConfiguration(
  repository: AccountReadonlyCredentialRepository,
  userId: string,
  provider: ReadonlyCredentialProvider,
  credentials: Record<string, string>,
) {
  await repository.save({
    userId,
    provider,
    configured: true,
    encryptedCredentials: encryptTradingCredentials(credentials),
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  return { provider, configured: true } as const;
}

function credentialErrorStatus(errorCode: string) {
  if (errorCode === 'LOGIN_REQUIRED') return 401;
  if (errorCode.includes('MASTER_KEY') || errorCode.includes('STORAGE_UNAVAILABLE')) return 503;
  if (errorCode === 'ACCOUNT_READONLY_USER_SCOPE_MISMATCH') return 403;
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
      supportedProviders: ['toss', 'upbit', 'bitget'],
      hiddenProviders: ['kiwoom'],
      storage: 'user_scoped_account_readonly_encrypted_vault',
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
        credentialRepository(userId),
        userId,
        provider,
        credentials,
      );
      return res.json({
        ok: true,
        provider,
        configured: saved.configured,
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
    if (!userId || !accessToken) return res.status(401).json(deniedResponse('LOGIN_REQUIRED'));

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
