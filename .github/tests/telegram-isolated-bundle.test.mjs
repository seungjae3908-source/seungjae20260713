import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('isolated Telegram artifact is standalone and fails closed before any sender starts',()=>{
  const source=path.resolve('api-server/dist/telegram-isolated-worker.mjs');
  assert.ok(statSync(source).isFile());
  const dir=mkdtempSync(path.join(tmpdir(),'telegram-standalone-bundle-'));
  try{
    const standalone=path.join(dir,'worker.mjs');
    copyFileSync(source,standalone);
    const child=spawnSync(process.execPath,[standalone],{
      cwd:dir,
      env:{NODE_ENV:'production',PATH:process.env.PATH??''},
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:32_768,
    });
    assert.equal(child.error,undefined);
    assert.equal(child.status,14,
      'isolated worker must execute from a zero-node_modules directory and refuse unapproved start');
    assert.match(child.stderr,/TELEGRAM_ISOLATED_OWNER_OR_LEASE_NOT_APPROVED/u);
    assert.doesNotMatch(child.stdout+child.stderr,/ERR_MODULE_NOT_FOUND|Cannot find package/u);
    assert.doesNotMatch(child.stdout+child.stderr,/Telegram Bot API|trade order|private API/u);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
