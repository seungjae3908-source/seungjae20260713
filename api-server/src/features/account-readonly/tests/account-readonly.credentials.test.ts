import assert from 'node:assert/strict';
import test from 'node:test';
import { isStagingReadonlyCredentialRuntime, resolveApiBindHost } from '../../../lib/api-bind-host';
import { decryptTradingCredentials } from '../../../services/trade-credential-vault.service';
import { InMemoryAccountReadonlyCredentialRepository } from '../account-readonly.repository';
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

function privateReadRuntime() {
  return {
    APP_ENV: 'staging',
    TRADING_CREDENTIAL_MASTER_KEY: TEST_MASTER_KEY,
    TOSS_ACCOUNT_READ_ENABLED: 'true',
    UPBIT_ACCOUNT_READ_ENABLED: 'true',
    BITGET_ACCOUNT_READ_ENABLED: 'true',
    LIVE_TRADING_ENABLED: 'false',
    AUTO_TRADING_ENABLED: 'false',
    TOSS_ORDER_ENABLED: 'false',
    UPBIT_ORDER_ENABLED: 'false',
    BITGET_ORDER_ENABLED: 'false',
    TRANSFER_ENABLED: 'false',
    WITHDRAWAL_ENABLED: 'false',
  };
}

test('read-only credential parser accepts only Toss, Upbit and Bitget credential shapes', () => {
  assert.deepEqual(parseReadonlyCredentialRequest('toss', {
    purpose: 'read_only', permissions: ['read'],
    credentials: { clientId: 'toss-client-test', clientSecret: 'toss-secret-test' },
  }), { clientId: 'toss-client-test', clientSecret: 'toss-secret-test' });
  assert.deepEqual(parseReadonlyCredentialRequest('toss', {
    purpose: 'read_only', permissions: ['read'],
    credentials: { clientId: 'toss-client-test', clientSecret: 'toss-secret-test', accountSeq: '12345678' },
  }), { clientId: 'toss-client-test', clientSecret: 'toss-secret-test', accountSeq: '12345678' });
  assert.deepEqual(parseReadonlyCredentialRequest('upbit', {
    purpose: 'read_only', permissions: ['read'],
    credentials: { accessKey: 'upbit-access-test', secretKey: 'upbit-secret-test' },
  }), { accessKey: 'upbit-access-test', secretKey: 'upbit-secret-test' });
  assert.deepEqual(parseReadonlyCredentialRequest('bitget', {
    purpose: 'read_only', permissions: ['read'],
    credentials: { apiKey: 'bitget-api-test', secretKey: 'bitget-secret-test', passphrase: 'bitget-passphrase-test' },
  }), { apiKey: 'bitget-api-test', secretKey: 'bitget-secret-test', passphrase: 'bitget-passphrase-test' });
});

test('read-only credential parser rejects mutation permissions, missing Toss secrets and unexpected fields', () => {
  assert.throws(() => parseReadonlyCredentialRequest('toss', {
    purpose: 'read_only', permissions: ['read', 'order'],
    credentials: { clientId: 'a', clientSecret: 'b' },
  }), /MUTATION_PERMISSION_NOT_ALLOWED/);
  assert.throws(() => parseReadonlyCredentialRequest('toss', {
    purpose: 'read_only', credentials: { clientId: 'a' },
  }), /CREDENTIALS_INCOMPLETE/);
  assert.throws(() => parseReadonlyCredentialRequest('bitget', {
    purpose: 'read_only', credentials: { apiKey: 'a', secretKey: 'b', passphrase: 'c', withdrawalKey: 'd' },
  }), /UNEXPECTED_CREDENTIAL_FIELD/);
  assert.throws(() => parseReadonlyCredentialRequest('upbit', {
    purpose: 'live', credentials: { accessKey: 'a', secretKey: 'b' },
  }), /READONLY_PURPOSE_CONFIRMATION_REQUIRED/);
});

test('three-provider credentials are encrypted in the account-readonly vault and never stored in trading policy state', async () => {
  await withMasterKey(async () => {
    const repository = new InMemoryAccountReadonlyCredentialRepository();
    const fixtures = {
      toss: { clientId: 'TOSS_CLIENT_SAVE_TEST', clientSecret: 'TOSS_SECRET_SAVE_TEST' },
      upbit: { accessKey: 'UPBIT_ACCESS_SAVE_TEST', secretKey: 'UPBIT_SECRET_SAVE_TEST' },
      bitget: { apiKey: 'BITGET_API_SAVE_TEST', secretKey: 'BITGET_SECRET_SAVE_TEST', passphrase: 'BITGET_PASS_SAVE_TEST' },
    } as const;

    for (const [provider, credentials] of Object.entries(fixtures) as Array<[keyof typeof fixtures, Record<string, string>]>) {
      const result = await saveReadonlyCredentialConfiguration(repository, 'user-a', provider, credentials);
      const stored = await repository.get('user-a', provider);
      assert.equal(result.configured, true);
      assert.equal(stored?.configured, true);
      assert.ok(stored?.encryptedCredentials);
      for (const value of Object.values(credentials)) assert.equal(stored!.encryptedCredentials!.includes(value), false);
      assert.deepEqual(decryptTradingCredentials(stored!.encryptedCredentials!, TEST_MASTER_KEY), credentials);
      assert.equal(stored?.lastVerifiedAt, null);
    }

    assert.equal(await repository.get('user-a', 'toss') !== null, true);
    assert.equal(await repository.get('user-a', 'upbit') !== null, true);
    assert.equal(await repository.get('user-a', 'bitget') !== null, true);
  });
});

test('secret-bearing staging private-read runtime defaults to loopback for Toss, Upbit or Bitget', () => {
  const runtime = privateReadRuntime();
  assert.equal(isStagingReadonlyCredentialRuntime({}), false);
  assert.equal(isStagingReadonlyCredentialRuntime({ APP_ENV: 'staging' }), false);
  assert.equal(isStagingReadonlyCredentialRuntime(runtime), true);
  assert.equal(resolveApiBindHost({ ...runtime, UPBIT_ACCOUNT_READ_ENABLED: 'false', BITGET_ACCOUNT_READ_ENABLED: 'false' }), '127.0.0.1');
  assert.equal(resolveApiBindHost({}), '0.0.0.0');
});

test('secret-bearing staging private-read runtime cannot be widened by API_BIND_HOST', () => {
  const runtime = privateReadRuntime();
  assert.equal(resolveApiBindHost({ ...runtime, API_BIND_HOST: '0.0.0.0' }), '127.0.0.1');
  assert.equal(resolveApiBindHost({ ...runtime, API_BIND_HOST: '::1' }), '127.0.0.1');
  assert.equal(resolveApiBindHost({ ...runtime, API_BIND_HOST: 'example.com' }), '127.0.0.1');
});

test('normal-runtime bind host override remains restricted to known listener addresses', () => {
  assert.equal(resolveApiBindHost({ API_BIND_HOST: '127.0.0.1' }), '127.0.0.1');
  assert.equal(resolveApiBindHost({ API_BIND_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveApiBindHost({ API_BIND_HOST: '::1' }), '::1');
  assert.throws(() => resolveApiBindHost({ API_BIND_HOST: 'example.com' }), /API_BIND_HOST_INVALID/);
});
