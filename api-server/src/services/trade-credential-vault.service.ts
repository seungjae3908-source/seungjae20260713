import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type EncryptedEnvelope = {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
};

function encryptionKey(encodedKey = process.env.TRADING_CREDENTIAL_MASTER_KEY ?? '') {
  const key = Buffer.from(encodedKey.trim(), 'base64');
  if (key.length !== 32) throw new Error('TRADING_CREDENTIAL_MASTER_KEY_INVALID');
  return key;
}
export function encryptTradingCredentials(credentials: Record<string, string>, encodedKey?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

export function decryptTradingCredentials(value: string, encodedKey?: string) {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as EncryptedEnvelope;
  } catch {
    throw new Error('TRADING_CREDENTIAL_PAYLOAD_INVALID');
  }
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('TRADING_CREDENTIAL_PAYLOAD_INVALID');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm', encryptionKey(encodedKey), Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRADING_CREDENTIAL_PAYLOAD_INVALID');
  }
  return parsed as Record<string, string>;
}

export function credentialConfigurationStatus() {
  return {
    encryptionConfigured: (() => {
      try { encryptionKey(); return true; } catch { return false; }
    })(),
    keyValueExposed: false,
  };
}
