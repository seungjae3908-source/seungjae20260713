import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('../deploy/activate-ai-research.sh', import.meta.url);

test('AI Research activation is fail-closed and exact-SHA bound', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /TARGET_SHA must be an exact lowercase 40-character SHA/);
  assert.match(script, /AI_RESEARCH_CURRENT_SHA_MISMATCH/);
  assert.match(script, /\/opt\/investment-research\/releases\/[^\n]*\$TARGET_SHA/);
  assert.match(script, /AI_RESEARCH_ACTIVATION_FAILED_SAFE_DISABLED=true/);
  assert.match(script, /systemctl disable --now/);
});

test('provider readiness is proven before timer activation and secrets are not printed', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const preflight = script.indexOf('provider_preflight');
  const materialize = script.indexOf('research-provider-bootstrap.mjs" materialize');
  const enable = script.indexOf('systemctl enable --now');
  assert.ok(preflight >= 0 && materialize > preflight && enable > materialize);
  assert.match(script, /fullStackReady !== true/);
  assert.match(script, /providers\.youtube !== 'PRESENT'/);
  assert.match(script, /providers\.gemini !== 'PRESENT'/);
  assert.match(script, /providers\.groq !== 'PRESENT'/);
  assert.doesNotMatch(script, /echo .*API_KEY|printf .*API_KEY/);
});


test('existing isolated Research provider env is reused before app or PM2 bootstrap', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const ready = script.indexOf('provider_env_ready()');
  const fallback = script.indexOf('research-provider-bootstrap.mjs" preflight');
  const materialize = script.indexOf('materialize_or_reuse_provider_env');
  assert.ok(ready >= 0 && fallback > ready && materialize > ready);
  assert.match(script, /EXISTING_RESEARCH_PROVIDER_ENV/);
  assert.match(script, /credentialValuesExposed: false/);
  assert.match(script, /executionAuthority: 'NONE'/);
  assert.doesNotMatch(script, /source\s+"\$PROVIDER_ENV"|\.\s+"\$PROVIDER_ENV"/);
});

test('provider env is readable by the isolated Research service user', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  assert.match(script, /chown root:investment-research/);
  assert.match(script, /chmod 0640/);
  assert.match(script, /runuser -u investment-research -- test -r/);
});

test('one-shot workers must succeed before recurring timers are enabled', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  const ai = script.indexOf('systemctl start research-production-ai-review.service');
  const video = script.indexOf('systemctl start research-production-video-discovery.service');
  const enable = script.indexOf('systemctl enable --now');
  assert.ok(ai >= 0 && video > ai && enable > video);
  assert.match(script, /AI_RESEARCH_ONE_SHOT_FAILED/);
  assert.match(script, /AI_REVIEW_ONE_SHOT=success/);
  assert.match(script, /VIDEO_DISCOVERY_ONE_SHOT=success/);
});

test('AI activation preserves no-trading authority contract', async () => {
  const script = await readFile(scriptUrl, 'utf8');
  for (const token of [
    'LIVE_TRADING=false',
    'PRIVATE_TRADING_API_ALLOWED=false',
    'REAL_ORDER_ENABLED=false',
    'executionAuthority=NONE',
    'REAL_ORDER_SUBMITTED=false',
  ]) assert.match(script, new RegExp(token));
  assert.doesNotMatch(script, /LIVE_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true|executionAuthority=LIVE/);
});
