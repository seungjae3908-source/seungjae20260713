import { randomUUID } from 'node:crypto';

import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../../services/trade-credential-vault.service';
import type { InvestmentProvider } from './member-investment.contract';

export type CredentialVaultEntry = {
  id: string;
  userId: string;
  provider: InvestmentProvider;
  encryptedPayload: string;
  version: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface CredentialVaultRepository {
  save(entry: CredentialVaultEntry): Promise<void>;
  getForServer(userId: string, reference: string, version: number): Promise<CredentialVaultEntry | null>;
  revoke(userId: string, reference: string, revokedAt: string): Promise<void>;
}

export class InMemoryCredentialVaultRepository implements CredentialVaultRepository {
  private readonly entries = new Map<string, CredentialVaultEntry>();

  async save(entry: CredentialVaultEntry) {
    this.entries.set(entry.id, structuredClone(entry));
  }

  async getForServer(userId: string, reference: string, version: number) {
    const entry = this.entries.get(reference);
    return entry?.userId === userId && entry.version === version ? structuredClone(entry) : null;
  }

  async revoke(userId: string, reference: string, revokedAt: string) {
    const entry = this.entries.get(reference);
    if (!entry || entry.userId !== userId) throw new Error('CREDENTIAL_REFERENCE_NOT_FOUND');
    entry.revokedAt = revokedAt;
    entry.updatedAt = revokedAt;
  }
}

function storageError() {
  return new Error('CREDENTIAL_VAULT_STORAGE_UNAVAILABLE');
}

export function createServerCredentialVaultRepository(): CredentialVaultRepository {
  if (!hasSupabaseServerKey()) throw storageError();
  const client = getSupabase();
  return {
    async save(entry) {
      const { error } = await client.from('credential_vault_entries').insert({
        id: entry.id,
        user_id: entry.userId,
        provider: entry.provider,
        encrypted_payload: entry.encryptedPayload,
        version: entry.version,
        revoked_at: entry.revokedAt,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
      });
      if (error) throw storageError();
    },
    async getForServer(userId, reference, version) {
      const { data, error } = await client.from('credential_vault_entries')
        .select('id,user_id,provider,encrypted_payload,version,revoked_at,created_at,updated_at')
        .eq('id', reference).eq('user_id', userId).eq('version', version).maybeSingle();
      if (error) throw storageError();
      if (!data) return null;
      return {
        id: String(data.id), userId: String(data.user_id), provider: String(data.provider) as InvestmentProvider,
        encryptedPayload: String(data.encrypted_payload), version: Number(data.version),
        revokedAt: typeof data.revoked_at === 'string' ? data.revoked_at : null,
        createdAt: String(data.created_at), updatedAt: String(data.updated_at),
      };
    },
    async revoke(userId, reference, revokedAt) {
      const { data, error } = await client.from('credential_vault_entries')
        .update({ revoked_at: revokedAt, updated_at: revokedAt })
        .eq('id', reference).eq('user_id', userId).select('id').maybeSingle();
      if (error || !data) throw storageError();
    },
  };
}

export class MemberCredentialVault {
  constructor(
    private readonly repository: CredentialVaultRepository,
    private readonly now = () => new Date(),
  ) {}

  async store(userId: string, provider: InvestmentProvider, credentials: Record<string, string>, version = 1) {
    if (!userId.trim()) throw new Error('LOGIN_REQUIRED');
    if (!Number.isInteger(version) || version < 1) throw new Error('CREDENTIAL_VERSION_INVALID');
    const timestamp = this.now().toISOString();
    const reference = randomUUID();
    await this.repository.save({
      id: reference,
      userId,
      provider,
      encryptedPayload: encryptTradingCredentials(credentials),
      version,
      revokedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { credentialReference: reference, credentialVersion: version, credentialsReturned: false as const };
  }

  async resolveForServer(userId: string, reference: string, version: number) {
    const entry = await this.repository.getForServer(userId, reference, version);
    if (!entry || entry.revokedAt) throw new Error('CREDENTIAL_REFERENCE_UNAVAILABLE');
    return decryptTradingCredentials(entry.encryptedPayload);
  }

  async revoke(userId: string, reference: string) {
    await this.repository.revoke(userId, reference, this.now().toISOString());
  }
}
