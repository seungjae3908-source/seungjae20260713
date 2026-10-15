import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Regression: OnUnitActiveSec stopped re-arming after a missed run and the
// Signal V3 scanner cycle stalled from 2026-09-28 (timer next=n/a).
test('Signal V3 cycle timer runs on a wall-clock schedule every five minutes', () => {
  const script = readFileSync('signal-intelligence-release/deploy/activate-server.sh', 'utf8');
  const timer = script.slice(script.indexOf('cat > "$timer_tmp"'), script.indexOf('write_unit "/etc/systemd/system/$SERVICE_NAME"'));
  assert.match(timer, /^OnCalendar=\*:0\/5$/mu);
  assert.match(timer, /^Persistent=true$/mu);
  assert.doesNotMatch(timer, /OnUnitActiveSec|OnBootSec/u);
  assert.match(script, /SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE/u);
  assert.match(script, /LIVE_TRADING=false/u);
});
