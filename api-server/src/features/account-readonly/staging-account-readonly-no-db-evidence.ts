import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalAccountSnapshot } from './account-readonly.contract';
import type {
  AccountReadonlyCredentialRepository,
  ReadonlyCredentialProvider,
} from './account-readonly.repository';
import { createVaultBackedAccountReaders } from './account-readonly.runtime';

const EVIDENCE_USER_ID = 'staging-account-readonly-no-db-evidence';
const EVIDENCE_ACCESS_TOKEN = 'NO_DB_EVIDENCE_SCOPE_ONLY';
const TOSS_OAUTH_ORIGIN = 'https://oauth2.tossinvest.com';
const READONLY_PROVIDER_ORIGINS = new Set([
  'https://openapi.tossinvest.com',
  'https://api.upbit.com',
  'https://api.bitget.com',
]);

type CredentialMap = Record<ReadonlyCredentialProvider, Record<string, string>>;

type RequestAudit = {
  oauthTokenPosts: number;
  readonlyGets: number;
  rejectedRequests: number;
};

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`MISSING_REQUIRED_EVIDENCE_ENV:${name}`);
  return value;
}

function credentialMap(): CredentialMap {
  const tossAccountSeq = String(process.env.STAGING_TOSS_ACCOUNT_SEQ ?? '').trim();
  return {
    toss: {
      clientId: requiredEnv('STAGING_TOSS_CLIENT_ID'),
      clientSecret: requiredEnv('STAGING_TOSS_CLIENT_SECRET'),
      ...(tossAccountSeq ? { accountSeq: tossAccountSeq } : {}),
    },
    upbit: {
      accessKey: requiredEnv('STAGING_UPBIT_ACCESS_KEY'),
      secretKey: requiredEnv('STAGING_UPBIT_SECRET_KEY'),
    },
    bitget: {
      apiKey: requiredEnv('STAGING_BITGET_API_KEY'),
      secretKey: requiredEnv('STAGING_BITGET_SECRET_KEY'),
      passphrase: requiredEnv('STAGING_BITGET_PASSPHRASE'),
    },
  };
}

function parseCredentialPayload(payload: string): Record<string, string> {
  const value: unknown = JSON.parse(payload);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('EVIDENCE_CREDENTIAL_PAYLOAD_INVALID');
  }
  const parsed: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string') throw new Error('EVIDENCE_CREDENTIAL_PAYLOAD_INVALID');
    parsed[key] = child;
  }
  return parsed;
}

function createReadOnlyMemoryRepository(
  credentials: CredentialMap,
  audit: { reads: number; writeAttempts: number },
): AccountReadonlyCredentialRepository {
  return {
    async get(userId, provider) {
      if (userId !== EVIDENCE_USER_ID) throw new Error('EVIDENCE_USER_SCOPE_MISMATCH');
      audit.reads += 1;
      return {
        userId,
        provider,
        configured: true,
        encryptedCredentials: JSON.stringify(credentials[provider]),
        lastVerifiedAt: null,
        lastErrorCode: null,
        updatedAt: new Date(0).toISOString(),
      };
    },
    async save() {
      audit.writeAttempts += 1;
      throw new Error('EVIDENCE_STORAGE_WRITE_REJECTED');
    },
  };
}

function createAuditedFetch(audit: RequestAudit): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (url.origin === TOSS_OAUTH_ORIGIN && url.pathname === '/oauth2/token' && method === 'POST') {
      audit.oauthTokenPosts += 1;
      return fetch(input, init);
    }

    if (READONLY_PROVIDER_ORIGINS.has(url.origin) && method === 'GET') {
      audit.readonlyGets += 1;
      return fetch(input, init);
    }

    audit.rejectedRequests += 1;
    throw new Error('EVIDENCE_NON_READONLY_PROVIDER_REQUEST_REJECTED');
  };
}

function assertReadOnlySnapshot(provider: ReadonlyCredentialProvider, snapshot: CanonicalAccountSnapshot) {
  if (snapshot.provider !== provider || snapshot.readOnly !== true || snapshot.connected !== true || snapshot.status !== 'CONNECTED') {
    throw new Error(`EVIDENCE_PROVIDER_NOT_CONNECTED:${provider}:${snapshot.status}`);
  }
  if (
    snapshot.credentialsReturned !== false
    || snapshot.liveTradingEnabled !== false
    || snapshot.autoTradingEnabled !== false
    || snapshot.orderRequests !== 0
    || snapshot.cancelRequests !== 0
    || snapshot.amendRequests !== 0
    || snapshot.transferRequests !== 0
    || snapshot.withdrawalRequests !== 0
  ) {
    throw new Error(`EVIDENCE_READONLY_INVARIANT_FAILED:${provider}`);
  }
}

function sanitizedProviderSummary(snapshot: CanonicalAccountSnapshot) {
  return {
    provider: snapshot.provider,
    status: snapshot.status,
    connected: snapshot.connected,
    readOnly: snapshot.readOnly,
    accountCount: snapshot.accounts?.length ?? 0,
    balanceCount: snapshot.balances?.length ?? 0,
    positionCount: snapshot.positions?.length ?? 0,
    openOrderCount: snapshot.openOrders?.length ?? 0,
    credentialsReturned: snapshot.credentialsReturned,
    orderRequests: snapshot.orderRequests,
    cancelRequests: snapshot.cancelRequests,
    amendRequests: snapshot.amendRequests,
    transferRequests: snapshot.transferRequests,
    withdrawalRequests: snapshot.withdrawalRequests,
    liveTradingEnabled: snapshot.liveTradingEnabled,
    autoTradingEnabled: snapshot.autoTradingEnabled,
  };
}

async function main() {
  const targetSha = requiredEnv('STAGING_TARGET_SHA');
  const artifactDir = requiredEnv('STAGING_ARTIFACT_DIR');
  const credentials = credentialMap();
  const storageAudit = { reads: 0, writeAttempts: 0 };
  const requestAudit: RequestAudit = { oauthTokenPosts: 0, readonlyGets: 0, rejectedRequests: 0 };
  const repository = createReadOnlyMemoryRepository(credentials, storageAudit);

  const readers = createVaultBackedAccountReaders({
    repositoryFactory: (userId) => {
      if (userId !== EVIDENCE_USER_ID) throw new Error('EVIDENCE_USER_SCOPE_MISMATCH');
      return repository;
    },
    decryptCredentials: parseCredentialPayload,
    fetchImpl: createAuditedFetch(requestAudit),
  });

  const scope = { userId: EVIDENCE_USER_ID, accessToken: EVIDENCE_ACCESS_TOKEN };
  const toss = await readers.toss!(scope);
  const upbit = await readers.upbit!(scope);
  const bitget = await readers.bitget!(scope);

  assertReadOnlySnapshot('toss', toss);
  assertReadOnlySnapshot('upbit', upbit);
  assertReadOnlySnapshot('bitget', bitget);

  if (storageAudit.reads !== 3 || storageAudit.writeAttempts !== 0) {
    throw new Error('EVIDENCE_STORAGE_AUDIT_FAILED');
  }
  if (requestAudit.oauthTokenPosts !== 1 || requestAudit.readonlyGets !== 5 || requestAudit.rejectedRequests !== 0) {
    throw new Error('EVIDENCE_PROVIDER_REQUEST_AUDIT_FAILED');
  }

  const evidence = {
    schemaVersion: 1,
    targetSha,
    mode: 'CANONICAL_ACCOUNT_RUNTIME_NO_DB',
    databaseAccessRequired: false,
    credentialSource: 'ACTIONS_SECRET_MEMORY_ONLY',
    providerResults: [toss, upbit, bitget].map(sanitizedProviderSummary),
    storageAudit: {
      backend: 'READ_ONLY_MEMORY_REPOSITORY',
      credentialReads: storageAudit.reads,
      writeAttempts: storageAudit.writeAttempts,
      persistentRowsCreated: 0,
    },
    requestAudit: {
      tossOauthTokenPosts: requestAudit.oauthTokenPosts,
      providerReadonlyGets: requestAudit.readonlyGets,
      rejectedRequests: requestAudit.rejectedRequests,
      orderRequests: 0,
      cancelRequests: 0,
      amendRequests: 0,
      transferRequests: 0,
      withdrawalRequests: 0,
    },
  };

  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(artifactDir, 'account-readonly-no-db-evidence.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    targetSha,
    mode: evidence.mode,
    providersConnected: 3,
    databaseAccessRequired: false,
    persistentRowsCreated: 0,
    providerReadonlyGets: requestAudit.readonlyGets,
    tossOauthTokenPosts: requestAudit.oauthTokenPosts,
    nonReadonlyRequests: requestAudit.rejectedRequests,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'ACCOUNT_READONLY_NO_DB_EVIDENCE_FAILED';
  console.error(message);
  process.exitCode = 1;
});
