import { getSupabase, hasSupabaseServerKey } from '../../lib/supabase';
import type {
  DeviceChallengeRecord,
  DevicePairingTokenRecord,
  DeviceSessionRecord,
  DeviceTrustRepository,
  TrustedDeviceRecord,
} from './device-trust.service';

function requireServerDatabase() {
  if (!hasSupabaseServerKey()) {
    throw new Error('DEVICE_TRUST_SERVER_DATABASE_NOT_CONFIGURED');
  }
  return getSupabase();
}

function failIfError(error: unknown, operation: string): void {
  if (error) throw new Error(`DEVICE_TRUST_STORAGE_${operation}_FAILED`);
}

function mapDevice(row: any): TrustedDeviceRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    publicKeyJwk: row.public_key_jwk,
    keyFingerprint: String(row.key_fingerprint),
    label: String(row.label),
    platform: String(row.platform),
    status: row.status,
    createdAt: String(row.created_at),
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

function mapChallenge(row: any): DeviceChallengeRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    purpose: row.purpose,
    challengeHash: String(row.challenge_hash),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at ? String(row.used_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapPairingToken(row: any): DevicePairingTokenRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    createdByDeviceId: String(row.created_by_device_id),
    tokenHash: String(row.token_hash),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at ? String(row.used_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapSession(row: any): DeviceSessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    tokenHash: String(row.token_hash),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
  };
}

export class SupabaseDeviceTrustRepository implements DeviceTrustRepository {
  async countActiveDevices(userId: string): Promise<number> {
    const { count, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active');
    failIfError(error, 'COUNT_DEVICES');
    return count ?? 0;
  }

  async findUsableDeviceByFingerprint(userId: string, fingerprint: string): Promise<TrustedDeviceRecord | null> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('key_fingerprint', fingerprint)
      .neq('status', 'revoked')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    failIfError(error, 'FIND_DEVICE');
    return data ? mapDevice(data) : null;
  }

  async getDevice(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('id', deviceId)
      .maybeSingle();
    failIfError(error, 'GET_DEVICE');
    return data ? mapDevice(data) : null;
  }

  async createPendingDevice(device: TrustedDeviceRecord): Promise<void> {
    const { error } = await requireServerDatabase().from('member_trusted_devices').insert({
      id: device.id,
      user_id: device.userId,
      public_key_jwk: device.publicKeyJwk,
      key_fingerprint: device.keyFingerprint,
      label: device.label,
      platform: device.platform,
      status: 'pending',
      created_at: device.createdAt,
    });
    failIfError(error, 'CREATE_DEVICE');
  }

  async activateDevice(userId: string, deviceId: string, verifiedAt: string): Promise<void> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .update({ status: 'active', last_verified_at: verifiedAt, revoked_at: null })
      .eq('user_id', userId)
      .eq('id', deviceId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    failIfError(error, 'ACTIVATE_DEVICE');
    if (!data) throw new Error('DEVICE_TRUST_STORAGE_ACTIVATE_DEVICE_FAILED');
  }

  async touchDevice(userId: string, deviceId: string, verifiedAt: string): Promise<void> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .update({ last_verified_at: verifiedAt })
      .eq('user_id', userId)
      .eq('id', deviceId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    failIfError(error, 'TOUCH_DEVICE');
    if (!data) throw new Error('DEVICE_TRUST_STORAGE_TOUCH_DEVICE_FAILED');
  }

  async listDevices(userId: string): Promise<TrustedDeviceRecord[]> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    failIfError(error, 'LIST_DEVICES');
    return (data ?? []).map(mapDevice);
  }

  async revokeDevice(userId: string, deviceId: string, revokedAt: string): Promise<boolean> {
    const { data, error } = await requireServerDatabase()
      .from('member_trusted_devices')
      .update({ status: 'revoked', revoked_at: revokedAt })
      .eq('user_id', userId)
      .eq('id', deviceId)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    failIfError(error, 'REVOKE_DEVICE');
    return Boolean(data);
  }

  async createChallenge(challenge: DeviceChallengeRecord): Promise<void> {
    const { error } = await requireServerDatabase().from('member_device_challenges').insert({
      id: challenge.id,
      user_id: challenge.userId,
      device_id: challenge.deviceId,
      purpose: challenge.purpose,
      challenge_hash: challenge.challengeHash,
      expires_at: challenge.expiresAt,
      used_at: challenge.usedAt,
      created_at: challenge.createdAt,
    });
    failIfError(error, 'CREATE_CHALLENGE');
  }

  async getChallenge(userId: string, challengeId: string): Promise<DeviceChallengeRecord | null> {
    const { data, error } = await requireServerDatabase()
      .from('member_device_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('id', challengeId)
      .maybeSingle();
    failIfError(error, 'GET_CHALLENGE');
    return data ? mapChallenge(data) : null;
  }

  async consumeChallenge(userId: string, challengeId: string, usedAt: string): Promise<boolean> {
    const { data, error } = await requireServerDatabase()
      .from('member_device_challenges')
      .update({ used_at: usedAt })
      .eq('user_id', userId)
      .eq('id', challengeId)
      .is('used_at', null)
      .gt('expires_at', usedAt)
      .select('id')
      .maybeSingle();
    failIfError(error, 'CONSUME_CHALLENGE');
    return Boolean(data);
  }

  async createPairingToken(record: DevicePairingTokenRecord): Promise<void> {
    const { error } = await requireServerDatabase().from('member_device_pairing_tokens').insert({
      id: record.id,
      user_id: record.userId,
      created_by_device_id: record.createdByDeviceId,
      token_hash: record.tokenHash,
      expires_at: record.expiresAt,
      used_at: record.usedAt,
      created_at: record.createdAt,
    });
    failIfError(error, 'CREATE_PAIRING_TOKEN');
  }

  async consumePairingToken(userId: string, tokenHash: string, usedAt: string): Promise<DevicePairingTokenRecord | null> {
    const { data, error } = await requireServerDatabase()
      .from('member_device_pairing_tokens')
      .update({ used_at: usedAt })
      .eq('user_id', userId)
      .eq('token_hash', tokenHash)
      .is('used_at', null)
      .gt('expires_at', usedAt)
      .select('*')
      .maybeSingle();
    failIfError(error, 'CONSUME_PAIRING_TOKEN');
    return data ? mapPairingToken(data) : null;
  }

  async createSession(session: DeviceSessionRecord): Promise<void> {
    const { error } = await requireServerDatabase().from('member_device_sessions').insert({
      id: session.id,
      user_id: session.userId,
      device_id: session.deviceId,
      token_hash: session.tokenHash,
      expires_at: session.expiresAt,
      revoked_at: session.revokedAt,
      created_at: session.createdAt,
    });
    failIfError(error, 'CREATE_SESSION');
  }

  async getSessionByHash(userId: string, tokenHash: string, now: string): Promise<DeviceSessionRecord | null> {
    const { data, error } = await requireServerDatabase()
      .from('member_device_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .gt('expires_at', now)
      .maybeSingle();
    failIfError(error, 'GET_SESSION');
    return data ? mapSession(data) : null;
  }

  async revokeSessionsForDevice(userId: string, deviceId: string, revokedAt: string): Promise<void> {
    const { error } = await requireServerDatabase()
      .from('member_device_sessions')
      .update({ revoked_at: revokedAt })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .is('revoked_at', null);
    failIfError(error, 'REVOKE_SESSIONS');
  }
}
