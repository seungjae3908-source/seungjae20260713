import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export const DEVICE_SESSION_HEADER = 'x-device-session';
const CHALLENGE_TTL_MS = 5 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
const DEVICE_SESSION_TTL_MS = 15 * 60_000;

export type DeviceTrustEnforcement = 'off' | 'required';
export type DeviceStatus = 'pending' | 'active' | 'revoked';
export type DeviceChallengePurpose = 'enroll' | 'verify';

export type DevicePublicKeyJwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
};

export type TrustedDeviceRecord = {
  id: string;
  userId: string;
  publicKeyJwk: DevicePublicKeyJwk;
  keyFingerprint: string;
  label: string;
  platform: string;
  status: DeviceStatus;
  createdAt: string;
  lastVerifiedAt: string | null;
  revokedAt: string | null;
};

export type DeviceChallengeRecord = {
  id: string;
  userId: string;
  deviceId: string;
  purpose: DeviceChallengePurpose;
  challengeHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

export type DevicePairingTokenRecord = {
  id: string;
  userId: string;
  createdByDeviceId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
};

export type DeviceSessionRecord = {
  id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type SafeDeviceSummary = Pick<
  TrustedDeviceRecord,
  'id' | 'label' | 'platform' | 'status' | 'createdAt' | 'lastVerifiedAt' | 'revokedAt'
> & { keyFingerprint: string };

export interface DeviceTrustRepository {
  countActiveDevices(userId: string): Promise<number>;
  findUsableDeviceByFingerprint(userId: string, fingerprint: string): Promise<TrustedDeviceRecord | null>;
  getDevice(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null>;
  createPendingDevice(device: TrustedDeviceRecord): Promise<void>;
  activateDevice(userId: string, deviceId: string, verifiedAt: string): Promise<void>;
  touchDevice(userId: string, deviceId: string, verifiedAt: string): Promise<void>;
  listDevices(userId: string): Promise<TrustedDeviceRecord[]>;
  revokeDevice(userId: string, deviceId: string, revokedAt: string): Promise<boolean>;
  createChallenge(challenge: DeviceChallengeRecord): Promise<void>;
  getChallenge(userId: string, challengeId: string): Promise<DeviceChallengeRecord | null>;
  consumeChallenge(userId: string, challengeId: string, usedAt: string): Promise<boolean>;
  createPairingToken(record: DevicePairingTokenRecord): Promise<void>;
  consumePairingToken(userId: string, tokenHash: string, usedAt: string): Promise<DevicePairingTokenRecord | null>;
  createSession(session: DeviceSessionRecord): Promise<void>;
  getSessionByHash(userId: string, tokenHash: string, now: string): Promise<DeviceSessionRecord | null>;
  revokeSessionsForDevice(userId: string, deviceId: string, revokedAt: string): Promise<void>;
}

export class DeviceTrustError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'DeviceTrustError';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function safeLabel(value: unknown): string {
  const label = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!label) return '등록 기기';
  return label.slice(0, 80);
}

function safePlatform(value: unknown): string {
  const platform = String(value ?? 'web').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(platform)) return 'web';
  return platform;
}

function isBase64UrlCoordinate(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 40 && value.length <= 48 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function normalizeDevicePublicKeyJwk(value: unknown): DevicePublicKeyJwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceTrustError('INVALID_DEVICE_PUBLIC_KEY', 400);
  }
  const input = value as Record<string, unknown>;
  if (input.d !== undefined) {
    throw new DeviceTrustError('PRIVATE_DEVICE_KEY_MUST_NOT_LEAVE_DEVICE', 400);
  }
  if (input.kty !== 'EC' || input.crv !== 'P-256' || !isBase64UrlCoordinate(input.x) || !isBase64UrlCoordinate(input.y)) {
    throw new DeviceTrustError('INVALID_DEVICE_PUBLIC_KEY', 400);
  }
  return { kty: 'EC', crv: 'P-256', x: input.x, y: input.y };
}

export function fingerprintDevicePublicKey(jwk: DevicePublicKeyJwk): string {
  return sha256Hex(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

export function buildDeviceSigningPayload(input: {
  purpose: DeviceChallengePurpose;
  userId: string;
  deviceId: string;
  challengeId: string;
  challenge: string;
}): string {
  return [
    'device-trust:v1',
    input.purpose,
    input.userId,
    input.deviceId,
    input.challengeId,
    input.challenge,
  ].join('\n');
}

export function verifyDeviceSignature(
  publicKeyJwk: DevicePublicKeyJwk,
  signingPayload: string,
  signatureBase64Url: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(signatureBase64Url)) return false;
  try {
    const key = createPublicKey({ key: publicKeyJwk as any, format: 'jwk' });
    return verifySignature(
      'sha256',
      Buffer.from(signingPayload, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureBase64Url, 'base64url'),
    );
  } catch {
    return false;
  }
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function maxActiveDevices(): number {
  const raw = Number.parseInt(process.env.DEVICE_TRUST_MAX_ACTIVE_DEVICES ?? '2', 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(5, Math.max(1, raw));
}

export function deviceTrustEnforcement(): DeviceTrustEnforcement {
  return process.env.DEVICE_TRUST_ENFORCEMENT === 'required' ? 'required' : 'off';
}

export class DeviceTrustService {
  constructor(
    private readonly repository: DeviceTrustRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private nowIso(): string {
    return this.now().toISOString();
  }

  private futureIso(ttlMs: number): string {
    return new Date(this.now().getTime() + ttlMs).toISOString();
  }

  private async issueChallenge(
    userId: string,
    device: TrustedDeviceRecord,
    purpose: DeviceChallengePurpose,
  ) {
    const challenge = randomToken(32);
    const challengeId = randomUUID();
    const createdAt = this.nowIso();
    const record: DeviceChallengeRecord = {
      id: challengeId,
      userId,
      deviceId: device.id,
      purpose,
      challengeHash: sha256Hex(challenge),
      expiresAt: this.futureIso(CHALLENGE_TTL_MS),
      usedAt: null,
      createdAt,
    };
    await this.repository.createChallenge(record);
    return {
      mode: purpose,
      deviceId: device.id,
      challengeId,
      challenge,
      expiresAt: record.expiresAt,
      signingPayload: buildDeviceSigningPayload({
        purpose,
        userId,
        deviceId: device.id,
        challengeId,
        challenge,
      }),
    } as const;
  }

  async status(userId: string, rawSessionToken?: string | null) {
    const activeDeviceCount = await this.repository.countActiveDevices(userId);
    let trusted = false;
    if (rawSessionToken) {
      try {
        await this.requireValidSession(userId, rawSessionToken);
        trusted = true;
      } catch (error) {
        if (!(error instanceof DeviceTrustError)) throw error;
      }
    }
    return {
      enforcement: deviceTrustEnforcement(),
      activeDeviceCount,
      maxActiveDevices: maxActiveDevices(),
      bootstrapEnrollmentAllowed: activeDeviceCount === 0,
      trustedDeviceSession: trusted,
    };
  }

  async issueEnrollmentChallenge(input: {
    userId: string;
    publicKeyJwk: unknown;
    label?: unknown;
    platform?: unknown;
    pairingToken?: unknown;
  }) {
    const publicKeyJwk = normalizeDevicePublicKeyJwk(input.publicKeyJwk);
    const keyFingerprint = fingerprintDevicePublicKey(publicKeyJwk);
    const existing = await this.repository.findUsableDeviceByFingerprint(input.userId, keyFingerprint);
    if (existing?.status === 'active') {
      return this.issueChallenge(input.userId, existing, 'verify');
    }

    const activeDeviceCount = await this.repository.countActiveDevices(input.userId);
    if (activeDeviceCount >= maxActiveDevices()) {
      throw new DeviceTrustError('DEVICE_LIMIT_REACHED', 409);
    }

    if (activeDeviceCount > 0 && !existing) {
      const rawPairingToken = typeof input.pairingToken === 'string' ? input.pairingToken.trim() : '';
      if (!rawPairingToken || rawPairingToken.length < 32 || rawPairingToken.length > 128) {
        throw new DeviceTrustError('TRUSTED_DEVICE_PAIRING_REQUIRED', 403);
      }
      const consumed = await this.repository.consumePairingToken(
        input.userId,
        sha256Hex(rawPairingToken),
        this.nowIso(),
      );
      if (!consumed) {
        throw new DeviceTrustError('INVALID_OR_EXPIRED_PAIRING_TOKEN', 403);
      }
    }

    let device = existing;
    if (!device) {
      const createdAt = this.nowIso();
      device = {
        id: randomUUID(),
        userId: input.userId,
        publicKeyJwk,
        keyFingerprint,
        label: safeLabel(input.label),
        platform: safePlatform(input.platform),
        status: 'pending',
        createdAt,
        lastVerifiedAt: null,
        revokedAt: null,
      };
      await this.repository.createPendingDevice(device);
    }
    return this.issueChallenge(input.userId, device, 'enroll');
  }

  async issueVerificationChallenge(userId: string, deviceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
      throw new DeviceTrustError('INVALID_DEVICE_ID', 400);
    }
    const device = await this.repository.getDevice(userId, deviceId);
    if (!device || device.status !== 'active') {
      throw new DeviceTrustError('TRUSTED_DEVICE_NOT_FOUND', 404);
    }
    return this.issueChallenge(userId, device, 'verify');
  }

  async completeChallenge(input: {
    userId: string;
    deviceId: string;
    challengeId: string;
    challenge: string;
    signature: string;
  }) {
    const record = await this.repository.getChallenge(input.userId, input.challengeId);
    if (!record || record.deviceId !== input.deviceId) {
      throw new DeviceTrustError('DEVICE_CHALLENGE_NOT_FOUND', 404);
    }
    if (record.usedAt) throw new DeviceTrustError('DEVICE_CHALLENGE_ALREADY_USED', 409);
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new DeviceTrustError('DEVICE_CHALLENGE_EXPIRED', 410);
    }
    if (!sameHash(record.challengeHash, sha256Hex(input.challenge))) {
      throw new DeviceTrustError('DEVICE_CHALLENGE_MISMATCH', 403);
    }

    const device = await this.repository.getDevice(input.userId, input.deviceId);
    if (!device || device.status === 'revoked') {
      throw new DeviceTrustError('TRUSTED_DEVICE_NOT_FOUND', 404);
    }
    if (record.purpose === 'verify' && device.status !== 'active') {
      throw new DeviceTrustError('TRUSTED_DEVICE_NOT_ACTIVE', 403);
    }

    const signingPayload = buildDeviceSigningPayload({
      purpose: record.purpose,
      userId: input.userId,
      deviceId: input.deviceId,
      challengeId: input.challengeId,
      challenge: input.challenge,
    });
    if (!verifyDeviceSignature(device.publicKeyJwk, signingPayload, input.signature)) {
      throw new DeviceTrustError('INVALID_DEVICE_SIGNATURE', 403);
    }

    const consumed = await this.repository.consumeChallenge(input.userId, input.challengeId, this.nowIso());
    if (!consumed) throw new DeviceTrustError('DEVICE_CHALLENGE_ALREADY_USED', 409);

    const verifiedAt = this.nowIso();
    if (record.purpose === 'enroll') {
      await this.repository.activateDevice(input.userId, input.deviceId, verifiedAt);
    } else {
      await this.repository.touchDevice(input.userId, input.deviceId, verifiedAt);
    }

    const rawSessionToken = randomToken(32);
    const session: DeviceSessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: sha256Hex(rawSessionToken),
      expiresAt: this.futureIso(DEVICE_SESSION_TTL_MS),
      revokedAt: null,
      createdAt: verifiedAt,
    };
    await this.repository.createSession(session);

    return {
      deviceId: input.deviceId,
      deviceSession: rawSessionToken,
      expiresAt: session.expiresAt,
      enforcement: deviceTrustEnforcement(),
    };
  }

  async requireValidSession(userId: string, rawSessionToken?: string | null): Promise<DeviceSessionRecord> {
    const token = String(rawSessionToken ?? '').trim();
    if (!token || token.length < 32 || token.length > 128) {
      throw new DeviceTrustError('DEVICE_SESSION_REQUIRED', 428);
    }
    const session = await this.repository.getSessionByHash(userId, sha256Hex(token), this.nowIso());
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= this.now().getTime()) {
      throw new DeviceTrustError('INVALID_OR_EXPIRED_DEVICE_SESSION', 428);
    }
    const device = await this.repository.getDevice(userId, session.deviceId);
    if (!device || device.status !== 'active') {
      throw new DeviceTrustError('INVALID_OR_EXPIRED_DEVICE_SESSION', 428);
    }
    return session;
  }

  async createPairingToken(userId: string, currentDeviceSession?: string | null) {
    const session = await this.requireValidSession(userId, currentDeviceSession);
    const activeDeviceCount = await this.repository.countActiveDevices(userId);
    if (activeDeviceCount >= maxActiveDevices()) {
      throw new DeviceTrustError('DEVICE_LIMIT_REACHED', 409);
    }
    const rawToken = randomToken(32);
    const createdAt = this.nowIso();
    const record: DevicePairingTokenRecord = {
      id: randomUUID(),
      userId,
      createdByDeviceId: session.deviceId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: this.futureIso(PAIRING_TTL_MS),
      usedAt: null,
      createdAt,
    };
    await this.repository.createPairingToken(record);
    return { pairingToken: rawToken, expiresAt: record.expiresAt };
  }

  async listDevices(userId: string, currentDeviceSession?: string | null): Promise<SafeDeviceSummary[]> {
    await this.requireValidSession(userId, currentDeviceSession);
    const devices = await this.repository.listDevices(userId);
    return devices.map((device) => ({
      id: device.id,
      label: device.label,
      platform: device.platform,
      status: device.status,
      keyFingerprint: device.keyFingerprint.slice(0, 16),
      createdAt: device.createdAt,
      lastVerifiedAt: device.lastVerifiedAt,
      revokedAt: device.revokedAt,
    }));
  }

  async revokeDevice(userId: string, deviceId: string, currentDeviceSession?: string | null) {
    await this.requireValidSession(userId, currentDeviceSession);
    const device = await this.repository.getDevice(userId, deviceId);
    if (!device || device.status !== 'active') {
      throw new DeviceTrustError('TRUSTED_DEVICE_NOT_FOUND', 404);
    }
    const revokedAt = this.nowIso();
    const revoked = await this.repository.revokeDevice(userId, deviceId, revokedAt);
    if (!revoked) throw new DeviceTrustError('TRUSTED_DEVICE_NOT_FOUND', 404);
    await this.repository.revokeSessionsForDevice(userId, deviceId, revokedAt);
    return { revoked: true, deviceId };
  }
}
