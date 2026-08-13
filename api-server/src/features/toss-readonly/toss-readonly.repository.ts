import { getSupabase } from '../../lib/supabase';
import {
  decryptTradingCredentials,
  encryptTradingCredentials,
} from '../../services/trade-credential-vault.service';
import type { TossReadonlyCredentials } from './toss-readonly.service';

type ConnectionRow = {
  user_id: string;
  encrypted_credentials: string;
  updated_at: string;
};

function validateUserId(userId: string) {
  const value = userId.trim();
  if (!value) throw new Error('TOSS_USER_ID_REQUIRED');
  return value;
}

function normalizeCredentials(credentials: TossReadonlyCredentials): TossReadonlyCredentials {
  const clientId = credentials.clientId.trim();
  const clientSecret = credentials.clientSecret.trim();
  if (!clientId || !clientSecret) throw new Error('TOSS_CREDENTIALS_REQUIRED');
  if (clientId.length > 512 || clientSecret.length > 1024) throw new Error('TOSS_CREDENTIALS_INVALID');
  return { clientId, clientSecret };
}

export async function getTossReadonlyCredentials(userId: string): Promise<TossReadonlyCredentials | null> {
  const owner = validateUserId(userId);
  const { data, error } = await getSupabase()
    .from('toss_readonly_connections')
    .select('user_id,encrypted_credentials,updated_at')
    .eq('user_id', owner)
    .maybeSingle();

  if (error) throw new Error('TOSS_CONNECTION_STORAGE_READ_FAILED');
  if (!data) return null;
  const row = data as ConnectionRow;
  if (row.user_id !== owner) throw new Error('TOSS_CONNECTION_USER_SCOPE_MISMATCH');
  const decrypted = decryptTradingCredentials(row.encrypted_credentials);
  return normalizeCredentials({
    clientId: String(decrypted.clientId ?? ''),
    clientSecret: String(decrypted.clientSecret ?? ''),
  });
}

export async function getTossReadonlyConnectionStatus(userId: string) {
  const owner = validateUserId(userId);
  const { data, error } = await getSupabase()
    .from('toss_readonly_connections')
    .select('user_id,updated_at')
    .eq('user_id', owner)
    .maybeSingle();
  if (error) throw new Error('TOSS_CONNECTION_STORAGE_READ_FAILED');
  if (!data) return { configured: false, updatedAt: null };
  const row = data as Pick<ConnectionRow, 'user_id' | 'updated_at'>;
  if (row.user_id !== owner) throw new Error('TOSS_CONNECTION_USER_SCOPE_MISMATCH');
  return { configured: true, updatedAt: row.updated_at };
}

export async function saveTossReadonlyCredentials(userId: string, credentials: TossReadonlyCredentials) {
  const owner = validateUserId(userId);
  const normalized = normalizeCredentials(credentials);
  const encrypted = encryptTradingCredentials(normalized);
  const updatedAt = new Date().toISOString();
  const { error } = await getSupabase()
    .from('toss_readonly_connections')
    .upsert({
      user_id: owner,
      encrypted_credentials: encrypted,
      updated_at: updatedAt,
    }, { onConflict: 'user_id' });
  if (error) throw new Error('TOSS_CONNECTION_STORAGE_WRITE_FAILED');
  return { configured: true, updatedAt };
}

export async function deleteTossReadonlyCredentials(userId: string) {
  const owner = validateUserId(userId);
  const { error } = await getSupabase()
    .from('toss_readonly_connections')
    .delete()
    .eq('user_id', owner);
  if (error) throw new Error('TOSS_CONNECTION_STORAGE_DELETE_FAILED');
  return { configured: false };
}
