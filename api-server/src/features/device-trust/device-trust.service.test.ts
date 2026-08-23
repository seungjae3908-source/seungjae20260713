import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import {
  DeviceTrustError,
  DeviceTrustService,
  normalizeDevicePublicKeyJwk,
  type DeviceChallengeRecord,
  type DevicePairingTokenRecord,
  type DevicePublicKeyJwk,
  type DeviceSessionRecord,
  type DeviceTrustRepository,
  type TrustedDeviceRecord,
} from './device-trust.service';

class MemoryDeviceTrustRepository implements DeviceTrustRepository {
  devices = new Map<string, TrustedDeviceRecord>();
  challenges = new Map<string, DeviceChallengeRecord>();
  pairingTokens = new Map<string, DevicePairingTokenRecord>();
  sessions = new Map<string, DeviceSessionRecord>();

  async countActiveDevices(userId: string) {
    return [...this.devices.values()].filter((item) => item.userId === userId && item.status === 'active').length;
  }

  async findUsableDeviceByFingerprint(userId: string, fingerprint: string) {
    return [...this.devices.values()].find((item) => (
      item.userId === userId && item.keyFingerprint === fingerprint && item.status !== 'revoked'
    )) ?? null;
  }

  async getDevice(userId: string, deviceId: string) {
    const item = this.devices.get(deviceId);
    return item?.userId === userId ? item : null;
  }

  async createPendingDevice(device: TrustedDeviceRecord) {
    this.devices.set(device.id, { ...device });
  }

  async activateDevice(userId: string, deviceId: string, verifiedAt: string) {
    const item = await this.getDevice(userId, deviceId);
    if (!item || item.status !== 'pending') throw new Error('activate failed');
    item.status = 'active';
    item.lastVerifiedAt = verifiedAt;
  }

  async touchDevice(userId: string, deviceId: string, verifiedAt: string) {
    const item = await this.getDevice(userId, deviceId);
    if (!item || item.status !== 'active') throw new Error('touch failed');
    item.lastVerifiedAt = verifiedAt;
  }

  async listDevices(userId: string) {
    return [...this.devices.values()].filter((item) => item.userId === userId);
  }

  async revokeDevice(userId: string, deviceId: string, revokedAt: string) {
    const item = await this.getDevice(userId, deviceId);
    if (!item || item.status !== 'active') return false;
    item.status = 'revoked';
    item.revokedAt = revokedAt;
    return true;
  }

  async createChallenge(challenge: DeviceChallengeRecord) {
    this.challenges.set(challenge.id, { ...challenge });
  }

  async getChallenge(userId: string, challengeId: string) {
    const item = this.challenges.get(challengeId);
    return item?.userId === userId ? item : null;
  }

  async consumeChallenge(userId: string, challengeId: string, usedAt: string) {
    const item = await this.getChallenge(userId, challengeId);
    if (!item || item.usedAt || item.expiresAt <= usedAt) return false;
    item.usedAt = usedAt;
    return true;
  }

  async createPairingToken(record: DevicePairingTokenRecord) {
    this.pairingTokens.set(record.tokenHash, { ...record });
  }

  async consumePairingToken(userId: string, tokenHash: string, usedAt: string) {
    const item = this.pairingTokens.get(tokenHash);
    if (!item || item.userId !== userId || item.usedAt || item.expiresAt <= usedAt) return null;
    item.usedAt = usedAt;
    return item;
  }

  async createSession(session: DeviceSessionRecord) {
    this.sessions.set(session.tokenHash, { ...session });
  }

  async getSessionByHash(userId: string, tokenHash: string, now: string) {
    const item = this.sessions.get(tokenHash);
    if (!item || item.userId !== userId || item.revokedAt || item.expiresAt <= now) return null;
    return item;
  }

  async revokeSessionsForDevice(userId: string, deviceId: string, revokedAt: string) {
    for (const item of this.sessions.values()) {
      if (item.userId === userId && item.deviceId === deviceId && !item.revokedAt) item.revokedAt = revokedAt;
    }
  }
}

function newP256Key(): { privateKey: KeyObject; publicKeyJwk: DevicePublicKeyJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const exported = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKeyJwk: normalizeDevicePublicKeyJwk(exported) };
}

function signPayload(privateKey: KeyObject, payload: string): string {
  return nodeSign(
    'sha256',
    Buffer.from(payload, 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
}

async function enrollFirstDevice(service: DeviceTrustService, userId: string) {
  const key = newP256Key();
  const challenge = await service.issueEnrollmentChallenge({
    userId,
    publicKeyJwk: key.publicKeyJwk,
    label: 'primary phone',
    platform: 'android',
  });
  const completed = await service.completeChallenge({
    userId,
    deviceId: challenge.deviceId,
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    signature: signPayload(key.privateKey, challenge.signingPayload),
  });
  return { key, challenge, completed };
}

function expectCode(code: string) {
  return (error: unknown) => error instanceof DeviceTrustError && error.code === code;
}

test('device trust first enrollment proves P-256 possession and challenge is one-time', async () => {
  const repository = new MemoryDeviceTrustRepository();
  const service = new DeviceTrustService(repository);
  const userId = '00000000-0000-4000-8000-000000000001';
  const { key, challenge, completed } = await enrollFirstDevice(service, userId);

  const session = await service.requireValidSession(userId, completed.deviceSession);
  assert.equal(session.deviceId, challenge.deviceId);
  assert.equal((await repository.getDevice(userId, challenge.deviceId))?.status, 'active');

  await assert.rejects(
    service.completeChallenge({
      userId,
      deviceId: challenge.deviceId,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      signature: signPayload(key.privateKey, challenge.signingPayload),
    }),
    expectCode('DEVICE_CHALLENGE_ALREADY_USED'),
  );
});

test('forged device signature cannot create a trusted session', async () => {
  const repository = new MemoryDeviceTrustRepository();
  const service = new DeviceTrustService(repository);
  const userId = '00000000-0000-4000-8000-000000000002';
  const enrolled = await enrollFirstDevice(service, userId);
  const challenge = await service.issueVerificationChallenge(userId, enrolled.challenge.deviceId);
  const attacker = newP256Key();

  await assert.rejects(
    service.completeChallenge({
      userId,
      deviceId: challenge.deviceId,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      signature: signPayload(attacker.privateKey, challenge.signingPayload),
    }),
    expectCode('INVALID_DEVICE_SIGNATURE'),
  );
});

test('second device requires a one-time token created by an already trusted device', async () => {
  const repository = new MemoryDeviceTrustRepository();
  const service = new DeviceTrustService(repository);
  const userId = '00000000-0000-4000-8000-000000000003';
  const first = await enrollFirstDevice(service, userId);
  const second = newP256Key();

  await assert.rejects(
    service.issueEnrollmentChallenge({ userId, publicKeyJwk: second.publicKeyJwk, label: 'pc', platform: 'desktop' }),
    expectCode('TRUSTED_DEVICE_PAIRING_REQUIRED'),
  );

  const pairing = await service.createPairingToken(userId, first.completed.deviceSession);
  const secondChallenge = await service.issueEnrollmentChallenge({
    userId,
    publicKeyJwk: second.publicKeyJwk,
    label: 'pc',
    platform: 'desktop',
    pairingToken: pairing.pairingToken,
  });

  const third = newP256Key();
  await assert.rejects(
    service.issueEnrollmentChallenge({
      userId,
      publicKeyJwk: third.publicKeyJwk,
      label: 'shared device',
      platform: 'web',
      pairingToken: pairing.pairingToken,
    }),
    expectCode('INVALID_OR_EXPIRED_PAIRING_TOKEN'),
  );

  const secondCompleted = await service.completeChallenge({
    userId,
    deviceId: secondChallenge.deviceId,
    challengeId: secondChallenge.challengeId,
    challenge: secondChallenge.challenge,
    signature: signPayload(second.privateKey, secondChallenge.signingPayload),
  });
  assert.equal((await service.status(userId, secondCompleted.deviceSession)).activeDeviceCount, 2);
});

test('revoking a device invalidates every device session for it', async () => {
  const repository = new MemoryDeviceTrustRepository();
  const service = new DeviceTrustService(repository);
  const userId = '00000000-0000-4000-8000-000000000004';
  const first = await enrollFirstDevice(service, userId);

  await service.revokeDevice(userId, first.challenge.deviceId, first.completed.deviceSession);
  await assert.rejects(
    service.requireValidSession(userId, first.completed.deviceSession),
    expectCode('INVALID_OR_EXPIRED_DEVICE_SESSION'),
  );
});

test('server rejects any JWK that contains private-key material', () => {
  assert.throws(
    () => normalizeDevicePublicKeyJwk({
      kty: 'EC',
      crv: 'P-256',
      x: 'A'.repeat(43),
      y: 'B'.repeat(43),
      d: 'C'.repeat(43),
    }),
    expectCode('PRIVATE_DEVICE_KEY_MUST_NOT_LEAVE_DEVICE'),
  );
});
