const DEVICE_DB_NAME = 'seungjae-device-trust-v1';
const DEVICE_STORE_NAME = 'device-keys';
const DEVICE_STORE_KEY = 'primary';
const DEVICE_SESSION_STORAGE_KEY = 'device-trust-session-v1';

type StoredDeviceKey = {
  deviceId: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  createdAt: string;
};

type PendingDeviceKey = {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
};

export type DeviceTrustStatus = {
  enforcement: 'off' | 'required';
  activeDeviceCount: number;
  maxActiveDevices: number;
  bootstrapEnrollmentAllowed: boolean;
  trustedDeviceSession: boolean;
};

export type TrustedDeviceSummary = {
  id: string;
  label: string;
  platform: string;
  status: 'pending' | 'active' | 'revoked';
  keyFingerprint: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  revokedAt: string | null;
};

export class DeviceTrustClientError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'DeviceTrustClientError';
  }
}

function requireBrowserCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new DeviceTrustClientError('DEVICE_CRYPTO_UNAVAILABLE', 0);
  return subtle;
}

function bytesToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function openDeviceDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new DeviceTrustClientError('DEVICE_STORAGE_UNAVAILABLE', 0));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DEVICE_STORE_NAME)) {
        database.createObjectStore(DEVICE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DeviceTrustClientError('DEVICE_STORAGE_UNAVAILABLE', 0));
  });
}

async function readStoredDevice(): Promise<StoredDeviceKey | null> {
  const database = await openDeviceDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(DEVICE_STORE_NAME, 'readonly');
      const request = transaction.objectStore(DEVICE_STORE_NAME).get(DEVICE_STORE_KEY);
      request.onsuccess = () => resolve((request.result as StoredDeviceKey | undefined) ?? null);
      request.onerror = () => reject(new DeviceTrustClientError('DEVICE_STORAGE_READ_FAILED', 0));
    });
  } finally {
    database.close();
  }
}

async function writeStoredDevice(device: StoredDeviceKey): Promise<void> {
  if (device.privateKey.extractable) {
    throw new DeviceTrustClientError('DEVICE_PRIVATE_KEY_MUST_BE_NON_EXTRACTABLE', 0);
  }
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVICE_STORE_NAME, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new DeviceTrustClientError('DEVICE_STORAGE_WRITE_FAILED', 0));
      transaction.objectStore(DEVICE_STORE_NAME).put(device, DEVICE_STORE_KEY);
    });
  } finally {
    database.close();
  }
}

export async function clearStoredTrustedDevice(): Promise<void> {
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVICE_STORE_NAME, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new DeviceTrustClientError('DEVICE_STORAGE_WRITE_FAILED', 0));
      transaction.objectStore(DEVICE_STORE_NAME).delete(DEVICE_STORE_KEY);
    });
  } finally {
    database.close();
  }
  clearDeviceSession();
}

async function generateStoredNonExtractableP256Key(): Promise<PendingDeviceKey> {
  const subtle = requireBrowserCrypto();
  const generated = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;

  const publicKeyJwk = await subtle.exportKey('jwk', generated.publicKey);
  const temporaryPrivatePkcs8 = await subtle.exportKey('pkcs8', generated.privateKey);
  try {
    const privateKey = await subtle.importKey(
      'pkcs8',
      temporaryPrivatePkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    if (privateKey.extractable) {
      throw new DeviceTrustClientError('DEVICE_PRIVATE_KEY_MUST_BE_NON_EXTRACTABLE', 0);
    }
    return { privateKey, publicKeyJwk };
  } finally {
    // The transient export exists only to re-import the persistent key as
    // non-extractable. It is never serialized, logged, sent, or stored.
    new Uint8Array(temporaryPrivatePkcs8).fill(0);
  }
}

function currentDeviceSession(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(DEVICE_SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveDeviceSession(token: string): void {
  try {
    globalThis.sessionStorage?.setItem(DEVICE_SESSION_STORAGE_KEY, token);
  } catch {
    // Session persistence is an optimization; verification can be repeated.
  }
}

export function clearDeviceSession(): void {
  try {
    globalThis.sessionStorage?.removeItem(DEVICE_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failure.
  }
}

export function deviceTrustRequestHeaders(): Record<string, string> {
  const session = currentDeviceSession();
  return session ? { 'X-Device-Session': session } : {};
}

async function requestJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  const deviceSession = currentDeviceSession();
  if (deviceSession) headers.set('X-Device-Session', deviceSession);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new DeviceTrustClientError(String(payload.error ?? 'DEVICE_TRUST_REQUEST_FAILED'), response.status);
  }
  return payload as T;
}

async function signPayload(privateKey: CryptoKey, signingPayload: string): Promise<string> {
  const signature = await requireBrowserCrypto().sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingPayload),
  );
  return bytesToBase64Url(signature);
}

type ChallengeResponse = {
  ok: true;
  mode: 'enroll' | 'verify';
  deviceId: string;
  challengeId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: string;
};

type CompleteResponse = {
  ok: true;
  deviceId: string;
  deviceSession: string;
  expiresAt: string;
  enforcement: 'off' | 'required';
};

async function completeChallenge(
  accessToken: string,
  key: CryptoKey,
  challenge: ChallengeResponse,
): Promise<CompleteResponse> {
  const signature = await signPayload(key, challenge.signingPayload);
  const result = await requestJson<CompleteResponse>('/api/device-trust/challenge/complete', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: challenge.deviceId,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      signature,
    }),
  });
  saveDeviceSession(result.deviceSession);
  return result;
}

export async function getDeviceTrustStatus(accessToken: string): Promise<DeviceTrustStatus> {
  const result = await requestJson<{ ok: true } & DeviceTrustStatus>('/api/device-trust/status', accessToken);
  return {
    enforcement: result.enforcement,
    activeDeviceCount: result.activeDeviceCount,
    maxActiveDevices: result.maxActiveDevices,
    bootstrapEnrollmentAllowed: result.bootstrapEnrollmentAllowed,
    trustedDeviceSession: result.trustedDeviceSession,
  };
}

export async function verifyCurrentTrustedDevice(accessToken: string): Promise<CompleteResponse> {
  const stored = await readStoredDevice();
  if (!stored?.deviceId || !stored.privateKey) {
    throw new DeviceTrustClientError('LOCAL_TRUSTED_DEVICE_NOT_FOUND', 0);
  }
  const challenge = await requestJson<ChallengeResponse>('/api/device-trust/verify/challenge', accessToken, {
    method: 'POST',
    body: JSON.stringify({ deviceId: stored.deviceId }),
  });
  return completeChallenge(accessToken, stored.privateKey, challenge);
}

export async function enrollCurrentDevice(
  accessToken: string,
  options: { label?: string; platform?: string; pairingToken?: string } = {},
): Promise<CompleteResponse> {
  const existing = await readStoredDevice();
  if (existing?.deviceId && existing.privateKey) {
    return verifyCurrentTrustedDevice(accessToken);
  }

  const generated = await generateStoredNonExtractableP256Key();
  const challenge = await requestJson<ChallengeResponse>('/api/device-trust/enroll/challenge', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      publicKeyJwk: generated.publicKeyJwk,
      label: options.label ?? '현재 브라우저',
      platform: options.platform ?? 'web',
      pairingToken: options.pairingToken,
    }),
  });
  const result = await completeChallenge(accessToken, generated.privateKey, challenge);
  await writeStoredDevice({
    deviceId: result.deviceId,
    privateKey: generated.privateKey,
    publicKeyJwk: generated.publicKeyJwk,
    createdAt: new Date().toISOString(),
  });
  return result;
}

export async function createTrustedDevicePairingToken(accessToken: string): Promise<{
  pairingToken: string;
  expiresAt: string;
}> {
  const result = await requestJson<{ ok: true; pairingToken: string; expiresAt: string }>(
    '/api/device-trust/pairing-token',
    accessToken,
    { method: 'POST' },
  );
  return { pairingToken: result.pairingToken, expiresAt: result.expiresAt };
}

export async function listTrustedDevices(accessToken: string): Promise<TrustedDeviceSummary[]> {
  const result = await requestJson<{ ok: true; devices: TrustedDeviceSummary[] }>(
    '/api/device-trust/devices',
    accessToken,
  );
  return result.devices;
}

export async function revokeTrustedDevice(accessToken: string, deviceId: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/device-trust/devices/${encodeURIComponent(deviceId)}`, accessToken, {
    method: 'DELETE',
  });
  const local = await readStoredDevice();
  if (local?.deviceId === deviceId) await clearStoredTrustedDevice();
}
