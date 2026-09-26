import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../ops/server-safe-disk-cleanup.sh', import.meta.url), 'utf8');

test('optional cleanup metadata tolerates only safely stale in-root targets', () => {
  assert.match(source, /\[\[ "\$raw" == \/\* \]\] \|\| fail "\$label metadata path must be absolute" 16/);
  assert.match(source, /parent_real="\$\(realpath -e -- "\$parent" 2>\/dev\/null\)" \|\| fail "\$label metadata parent is missing or unsafe" 16/);
  assert.match(source, /"\$root_real"\|"\$root_real"\/\*\) ;;/);
  assert.match(source, /\[\[ ! -e "\$candidate" && ! -L "\$candidate" \]\]/);
  assert.match(source, /metadata target is stale; ignoring missing optional path/);
  assert.match(source, /canonical_child "\$root_real" "\$candidate"/);
  assert.match(source, /metadata escaped its allowed root/);
});

test('required current release and last backup remain strict', () => {
  assert.match(source, /CURRENT_RELEASE="\$\(read_required_state_path/);
  assert.match(source, /LAST_BACKUP="\$\(read_required_state_path/);
  assert.match(source, /flock -n 8 \|\| fail 'staging deployment is active; cleanup aborted before deletion'/);
  assert.match(source, /flock -n 9 \|\| fail 'production deployment is active; cleanup aborted before deletion'/);
  assert.match(source, /PM2_AFTER="\$\(pm2_snapshot\)"/);
  assert.match(source, /\[\[ "\$PM2_AFTER" == "\$PM2_BEFORE" \]\]/);
});
