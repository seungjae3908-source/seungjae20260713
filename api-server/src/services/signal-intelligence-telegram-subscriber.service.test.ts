import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveSignalIntelligenceTelegramEndpoint,
  SignalIntelligenceTelegramDeliveryState,
  SignalIntelligenceTelegramSubscriber,
} from './signal-intelligence-telegram-subscriber.service';

test('V3 Telegram source is local exact public endpoint only', () => {
  assert.equal(resolveSignalIntelligenceTelegramEndpoint('http://127.0.0.1:8790/v1/signals'),
    'http://127.0.0.1:8790/v1/signals');
  assert.equal(resolveSignalIntelligenceTelegramEndpoint('http://[::1]:8790/v1/signals'),
    'http://[::1]:8790/v1/signals');
  for (const url of [
    'http://127.0.0.1:8790/admin', 'http://127.0.0.1:8790/health',
    'http://127.0.0.1:8790/v1/signals?private=1',
    'http://127.0.0.1:8790/v1/signals#token',
    'http://user:pass@127.0.0.1:8790/v1/signals',
    'https://127.0.0.1:8790/v1/signals',
    'http://evil.example/v1/signals', 'file:///etc/passwd', 'bad-value',
  ]) assert.throws(() => resolveSignalIntelligenceTelegramEndpoint(url),
    /SIGNAL_INTELLIGENCE_SUBSCRIBER_(LOOPBACK_ONLY|ENDPOINT_INVALID)/);
});

test('V3 Telegram corrupt and linked dedupe files block rather than erase', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'signal-tg-ledger-'));
  try {
    const file = path.join(directory, 'corrupt.json');
    await writeFile(file, '{BROKEN');
    const bad = new SignalIntelligenceTelegramDeliveryState(file);
    await assert.rejects(bad.ready(), /LEDGER_UNREADABLE/);
    await assert.rejects(bad.has('signal-intelligence-v3:old'), /LEDGER_UNREADABLE/);
    assert.equal(await readFile(file, 'utf8'), '{BROKEN');
    const linked = path.join(directory, 'linked.json');
    await symlink(file, linked);
    await assert.rejects(new SignalIntelligenceTelegramDeliveryState(linked).ready(), /LEDGER_UNREADABLE/);
    const empty = new SignalIntelligenceTelegramDeliveryState(path.join(directory, 'new.json'));
    const key = 'signal-intelligence-v3:'+'a'.repeat(40)+':NEW_CANDIDATE:test::';
    assert.equal(await empty.has(key), false);
    await empty.mark(key, new Date('2026-10-11T00:00:00.000Z'));
    assert.equal(await new SignalIntelligenceTelegramDeliveryState(path.join(directory, 'new.json')).has(key),true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('V3 corrupt state prevents member and public sends even with valid source event', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'signal-tg-sends-'));
  const before=process.env.SIGNAL_INTELLIGENCE_URL;
  try {
    const file=path.join(dir,'bad.json'); await writeFile(file,'{BAD');
    process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
    let marketSends=0,memberSends=0;
    const sha='a'.repeat(40);
    const fake={ok:true,serviceSha:sha,executionAuthority:'NONE',
      snapshot:{serviceSha:sha,safety:{executionAuthority:'NONE',
        privateTradingApiAllowed:false,realOrderAllowed:false},
        events:[{id:'1',type:'NEW_CANDIDATE',market:'US_STOCK',symbol:'TEST',
          strategy:'SWING',timeframe:'5m',direction:'BUY'}]}};
    const service=new SignalIntelligenceTelegramSubscriber(
      new SignalIntelligenceTelegramDeliveryState(file),
      async()=>{marketSends++;return {ok:true as const,attempts:1};},
      async()=>new Response(JSON.stringify(fake),{status:200}),
      async()=>{memberSends++;return {attempted:0,delivered:0,deduped:0,skipped:0,failed:0};});
    assert.equal((await service.runOnce()).sourceStatus,'LEDGER_UNREADABLE');
    assert.equal((await service.runOnce()).sourceStatus,'LEDGER_UNREADABLE');
    assert.equal(marketSends,0); assert.equal(memberSends,0);
    assert.equal(await readFile(file,'utf8'),'{BAD');
  } finally {
    if(before===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
    else process.env.SIGNAL_INTELLIGENCE_URL=before;
    await rm(dir,{recursive:true,force:true});
  }
});

test('V3 HTTP 503 and unsafe source remain distinct with zero Telegram sends',async()=>{
  const before=process.env.SIGNAL_INTELLIGENCE_URL;
  let sends=0;
  const service=new SignalIntelligenceTelegramSubscriber(
    new SignalIntelligenceTelegramDeliveryState('/nonexistent-test-ledger-v3.json'),
    async()=>{sends++;return {ok:true as const,attempts:1};},
    async()=>new Response('',{status:503}),
    async()=>({attempted:0,delivered:0,deduped:0,skipped:0,failed:0}));
  try {
    process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
    assert.equal((await service.runOnce()).sourceStatus,'HTTP_503');
    process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/admin';
    assert.equal((await service.runOnce()).sourceStatus,'UNSAFE_ENDPOINT');
    assert.equal(sends,0);
  } finally {
    if(before===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
    else process.env.SIGNAL_INTELLIGENCE_URL=before;
  }
});
