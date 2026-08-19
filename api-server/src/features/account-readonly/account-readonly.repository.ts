import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';

export type ReadonlyCredentialProvider = 'toss' | 'upbit' | 'bitget';

export type ReadonlyCredentialRecord = {
  userId: string;
  provider: ReadonlyCredentialProvider;
  configured: boolean;
  encryptedCredentials: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

export type AccountReadonlyCredentialRepository = {
  get(userId: string, provider: ReadonlyCredentialProvider): Promise<ReadonlyCredentialRecord | null>;
  save(record: ReadonlyCredentialRecord): Promise<void>;
};

function storageUnavailable() {
  return new Error('ACCOUNT_READONLY_CREDENTIAL_STORAGE_UNAVAILABLE');
}

function toRecord(row: Record<string, unknown>): ReadonlyCredentialRecord {
  return {
    userId: String(row.user_id ?? ''),
    provider: String(row.provider ?? '') as ReadonlyCredentialProvider,
    configured: row.configured === true,
    encryptedCredentials: typeof row.encrypted_credentials === 'string' ? row.encrypted_credentials : null,
    lastVerifiedAt: typeof row.last_verified_at === 'string' ? row.last_verified_at : null,
    lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(0).toISOString(),
  };
}

export class InMemoryAccountReadonlyCredentialRepository implements AccountReadonlyCredentialRepository {
  private readonly rows = new Map<string, ReadonlyCredentialRecord>();

  private key(userId: string, provider: ReadonlyCredentialProvider) {
    return `${userId}:${provider}`;
  }

  async get(userId: string, provider: ReadonlyCredentialProvider) {
    const row = this.rows.get(this.key(userId, provider));
    return row ? { ...row } : null;
  }

  async save(record: ReadonlyCredentialRecord) {
    this.rows.set(this.key(record.userId, record.provider), { ...record });
  }
}

export function createAccountReadonlyCredentialRepository(
  authenticatedUserId: string,
): AccountReadonlyCredentialRepository {
  const owner = authenticatedUserId.trim();
  if (!owner) throw new Error('LOGIN_REQUIRED');
  if (!hasSupabaseServerKey()) throw storageUnavailable();
  const client = getSupabase();
  const assertOwner = (userId: string) => {
    if (userId !== owner) throw new Error('ACCOUNT_READONLY_USER_SCOPE_MISMATCH');
  };

  return {
    async get(userId, provider) {
      assertOwner(userId);
      const { data, error } = await client.from('account_readonly_credentials')
        .select('user_id,provider,configured,encrypted_credentials,last_verified_at,last_error_code,updated_at')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (error) throw storageUnavailable();
      return data ? toRecord(data as Record<string, unknown>) : null;
    },
    async save(record) {
      assertOwner(record.userId);
      const { error } = await client.from('account_readonly_credentials').upsert({
        user_id: record.userId,
        provider: record.provider,
        configured: record.configured,
        encrypted_credentials: record.encryptedCredentials,
        last_verified_at: record.lastVerifiedAt,
        last_error_code: record.lastErrorCode,
        updated_at: record.updatedAt,
      }, { onConflict: 'user_id,provider' });
      if (error) throw storageUnavailable();
    },
  };
}
