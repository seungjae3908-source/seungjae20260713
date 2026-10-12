import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const adapter = fs.readFileSync('api-server/src/services/trade-exchange-adapters.service.ts', 'utf8');
const provider = fs.readFileSync('api-server/src/features/account-readonly/providers/exchange-readonly.providers.ts', 'utf8');
const runtime = fs.readFileSync('api-server/src/features/account-readonly/account-readonly.runtime.ts', 'utf8');
const accountWorkflow = fs.readFileSync('.github/workflows/production-account-readonly-live-qa.yml', 'utf8');
const diagnosticParser = fs.readFileSync('stock-analyzer/e2e/production-account-readonly-live-qa-diagnostic.ts', 'utf8');

test('Bitget Classic position mode uses the authoritative read-only single-account endpoint', () => {
  assert.match(adapter, /export function prepareBitgetClassicAccountSettings\(/);
  assert.match(
    adapter,
    /credentials, 'GET', '\/api\/v2\/mix\/account\/account', null, query, timestamp,/,
  );
  assert.match(adapter, /symbol=\$\{encodeURIComponent\(normalizedSymbol\)\}/);
  assert.match(adapter, /productType=USDT-FUTURES/);
  assert.match(adapter, /marginCoin=\$\{encodeURIComponent\(normalizedMarginCoin\)\}/);
  assert.match(adapter, /bitgetReadonlyDiagnostic\(credentials, 'CLASSIC', 'ACCOUNT_SETTINGS'\)/);

  assert.match(provider, /transport\(prepareBitgetClassicAccountSettings\(credentials\), signal\)/);
  assert.match(provider, /accountSettingsRaw\.data\.posMode/);
  assert.doesNotMatch(provider, /data\(accountRaw\)[\s\S]{0,600}\.posMode/);
  assert.match(provider, /normalized !== 'one_way_mode' && normalized !== 'hedge_mode'/);
});

test('Bitget Classic single-account probe stays inside the runtime and QA read-only allowlists', () => {
  for (const source of [runtime, accountWorkflow, diagnosticParser]) {
    assert.match(source, /'\/api\/v2\/mix\/account\/account'/);
  }
  assert.match(runtime, /request\.method !== 'GET' \|\| request\.body !== null/);
});
