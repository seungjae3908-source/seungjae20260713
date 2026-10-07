import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const scriptUrl = new URL('../deploy/activate-server.sh', import.meta.url);

test('Research server activation validates explicit supplemental cost transport path', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH must be a normalized absolute path/);
  assert.match(script, /!isAbsolute\(supplemental\)/);
  assert.match(script, /resolve\(supplemental\) !== supplemental/);
});

test('Research release rotation preserves existing supplemental transport path only when no replacement is supplied', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /if \[\[ -z "\$\{PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH:-\}" \]\]; then/);
  assert.match(script, /grep -E '\^PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH='/);
  assert.match(script, /printf 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH="%s"\\n'/);
});

test('Research server activation does not weaken live or private trading safety while preserving cost transport', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  for (const token of [
    'LIVE_TRADING=false',
    'LIVE_TRADING_ENABLED=false',
    'REAL_ORDER_ENABLED=false',
    'PRIVATE_API_ENABLED=false',
    'PRIVATE_ACCOUNT_ACCESS=false',
    'PRIVATE_TRADING_API_ALLOWED=false',
    'ORDER_AUTHORITY=false',
    'ORDER_SUBMISSION_ENABLED=false',
  ]) assert.match(script, new RegExp(token));
  assert.doesNotMatch(script, /LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true/);
});
