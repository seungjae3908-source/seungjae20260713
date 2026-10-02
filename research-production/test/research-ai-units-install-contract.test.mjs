import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AI research unit installer installs only and never activates timers', async () => {
  const script=await readFile(new URL('../deploy/install-ai-research-units.sh', import.meta.url),'utf8');
  assert.match(script,/systemd-analyze verify/);
  assert.match(script,/systemctl daemon-reload/);
  assert.match(script,/AI_REVIEW_TIMER_ENABLED=false/);
  assert.match(script,/VIDEO_DISCOVERY_TIMER_ENABLED=false/);
  assert.doesNotMatch(script,/systemctl\s+(?:enable|start|restart|reload)\b/);
  assert.doesNotMatch(script,/enable\s+--now|--now\s+enable/);
  assert.doesNotMatch(script,/pm2\s+(?:start|restart|reload)/);
  assert.doesNotMatch(script,/LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true/);
  const preflightIndex=script.indexOf('systemctl is-enabled --quiet');
  const installIndex=script.indexOf('install -o root -g root -m 0644');
  assert.ok(preflightIndex >= 0 && installIndex >= 0 && preflightIndex < installIndex,
    'active/enabled timer preflight must occur before unit-file mutation');
});

test('AI and video services reuse one provider-only Research environment file', async () => {
  const ai=await readFile(new URL('../deploy/research-production-ai-review.service', import.meta.url),'utf8');
  const video=await readFile(new URL('../deploy/research-production-video-discovery.service', import.meta.url),'utf8');
  for(const unit of [ai,video])assert.match(unit,/EnvironmentFile=-\/etc\/investment-research\/research-providers\.env/);
});

test('AI service marks timer contract but does not self-claim timer proof', async () => {
  const unit=await readFile(new URL('../deploy/research-production-ai-review.service', import.meta.url),'utf8');
  assert.match(unit,/Environment=RESEARCH_AI_INVOCATION_MODE=SYSTEMD_TIMER/);
  assert.doesNotMatch(unit,/scheduledInvocationObserved=true/);
});
