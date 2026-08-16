import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeChildEnv } from '../src/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const installerPath = resolve(here, '../deploy/activate-server.sh');

test('Research Git ownership exception is exact-release and process scoped', async () => {
  const script = await readFile(installerPath, 'utf8');

  assert.match(script, /GIT_CONFIG_COUNT=1/);
  assert.match(script, /GIT_CONFIG_KEY_0=safe\.directory/);
  assert.match(script, /GIT_CONFIG_VALUE_0=\$RELEASE/);
  assert.match(script, /GIT_CONFIG_VALUE_0="\$RELEASE"/);

  assert.doesNotMatch(script, /safe\.directory=\*/);
  assert.doesNotMatch(script, /git\s+config\s+--global[^\n]*safe\.directory/);
  assert.doesNotMatch(script, /git\s+config\s+--system[^\n]*safe\.directory/);
});

test('Git config ownership exception never propagates into research child tasks', () => {
  const child = sanitizeChildEnv({
    PATH: '/usr/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '/opt/investment-research/releases/example',
  });

  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.GIT_CONFIG_COUNT, undefined);
  assert.equal(child.GIT_CONFIG_KEY_0, undefined);
  assert.equal(child.GIT_CONFIG_VALUE_0, undefined);
});
