import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../deploy/activate-server.sh', import.meta.url), 'utf8');

test('successful activation disarms EXIT rollback trap before local state leaves scope', () => {
  const probeIndex = script.indexOf('probe_dashboard');
  const disarmIndex = script.indexOf('trap - EXIT', probeIndex);
  const successIndex = script.indexOf("'RESEARCH_DASHBOARD_ACTIVATED=true'", disarmIndex);
  assert.ok(probeIndex >= 0, 'probe_dashboard must remain part of activation');
  assert.ok(disarmIndex > probeIndex, 'EXIT trap must be disarmed only after dashboard probes');
  assert.ok(successIndex > disarmIndex, 'success evidence must be emitted only after trap is disarmed');
});
