import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from '../../../services/trade-automation.repository';
import { decryptTradingCredentials } from '../../../services/trade-credential-vault.service';
import {
  parseReadonlyCredentialRequest,
  saveReadonlyCredentialConfiguration,
} from '../account-readonly.route';

const TEST_MASTER_KEY = Buffer.alloc(32, 19).toString('base64');

function withMasterKey<T>(run: () => Promise<T>) {
  const previous = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = TEST_MASTER_KEY;
  return run().finally(() => {
    if (previous === undefined) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previous;
  });
}

test('read-only credential parser accepts exact Upbit and Bitget fields without returning extras', () => {
  assert.deepEqual(parseReadonlyCredentialRequest('upbit', {
    purpose: 'read_only',
    permissions: ['read'],
    credentials: { accessKey: 'upbit-access-test', secretKey: 'upbit-secret-test' },
  }), {
    accessKey: 'upbit-access-test',
    secretKey: 'upbit-secret-test',
  });

  assert.deepEqual(parseReadonlyCredentialRequest('bitget', {
    purpose: 'read_only',
    permissions: ['read'],
    credentials: {
      apiKey: 'bitget-api-test',
      secretKey: 'bitget-secret-test',
      passphrase: 'bitget-passphrase-test',
    },
  }), {
    apiKey: 'bitget-api-test',
    secretKey: 'bitget-secret-test',
    passphrase: 'bitget-passphrase-test',
  });
});

test('read-only credential parser rejects mutation permissions and unexpected credential fields', () => {
  assert.throws(() => parseReadonlyCredentialRequest('upbit', {
    purpose: 'read_only',
    permissions: ['read', 'order'],
    credentials: { accessKey: 'a', secretKey: 'b' },
  }), /MUTATION_PERMISSION_NOT_ALLOWED/);

  assert.throws(() => parseReadonlyCredentialRequest('bitget', {
    purpose: 'read_only',
    credentials: { apiKey: 'a', secretKey: 'b', passphrase: 'c', withdrawalKey: 'd' },
  }), /UNEXPECTED_CREDENTIAL_FIELD/);

  assert.throws(() => parseReadonlyCredentialRequest('upbit', {
    purpose: 'live',
    credentials: { accessKey: 'a', secretKey: 'b' },
  }), /READONLY_PURPOSE_CONFIRMATION_REQUIRED/);
});

test('saving read-only credentials encrypts at rest and defaults a new connection to paper mode', async () => {
  await withMasterKey(async () => {
    const repository = new InMemoryTradingRepository();
    const credentials = { accessKey: 'UPBIT_ACCESS_SAVE_TEST', secretKey: 'UPBIT_SECRET_SAVE_TEST' };
    const result = await saveReadonlyCredentialConfiguration(repository, 'user-a', 'upbit', credentials);
    const stored = await repository.getConnection('user-a', 'upbit');

    assert.equal(result.accountMode, 'paper');
    assert.equal(stored?.configured, true);
    assert.equal(stored?.accountMode, 'paper');
    assert.ok(stored?.encryptedCredentials);
    assert.equal(stored?.encryptedCredentials?.includes(credentials.accessKey), false);
    assert.deepEqual(decryptTradingCredentials(stored!.encryptedCredentials!, TEST_MASTER_KEY), credentials);
    assert.equal(stored?.lastVerifiedAt, null);
  });
});

test('saving read-only credentials preserves an existing account mode and never changes trading policy', async () => {
  await withMasterKey(async () => {
    const repository = new InMemoryTradingRepository();
    await repository.saveConnection({
      userId: 'user-b',
      exchange: 'bitget',
      accountMode: 'mock',
      configured: true,
      encryptedCredentials: null,
      lastVerifiedAt: null,
      lastErrorCode: null,
      updatedAt: '2026-08-16T00:00:00.000Z',
    });
    const beforePolicy = await repository.getPolicy('user-b');

    const result = await saveReadonlyCredentialConfiguration(repository, 'user-b', 'bitget', {
      apiKey: 'BITGET_API_SAVE_TEST',
      secretKey: 'BITGET_SECRET_SAVE_TEST',
      passphrase: 'BITGET_PASSPHRASE_SAVE_TEST',
    });
    const afterPolicy = await repository.getPolicy('user-b');

    assert.equal(result.accountMode, 'mock');
    assert.deepEqual(afterPolicy, beforePolicy);
    assert.equal(afterPolicy.automaticEnabled, false);
    assert.deepEqual(afterPolicy.exchangeEnabled, { bitget: false, upbit: false, kiwoom: false });
  });
});
