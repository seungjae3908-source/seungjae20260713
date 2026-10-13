import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const url=new URL('../deploy/research-production-public-crypto-ws.service',import.meta.url);
const unit=readFileSync(url,'utf8');
const worker=readFileSync(new URL('../bin/public-crypto-websocket-worker.mjs',import.meta.url),'utf8');
const get=name=>{
  const lines=unit.split(/\r?\n/u).filter(line=>line.startsWith(name+'='));
  assert.equal(lines.length,1,'exactly one '+name);
  return lines[0].slice(name.length+1);
};

test('WebSocket unit is truly dormant and cannot silently join core activation',()=>{
  assert.doesNotMatch(unit,/^\[Install\]/mu);
  assert.doesNotMatch(unit,/^WantedBy=/mu);
  assert.doesNotMatch(unit,/\b(?:systemctl|pm2|curl|wget|ssh|sudo)\b/u);
  assert.equal(get('Type'),'exec');
  assert.equal(get('User'),'investment-research');
  assert.equal(get('Group'),'investment-research');
  assert.equal(get('WorkingDirectory'),'/opt/investment-research/current');
  assert.equal(get('EnvironmentFile'),'/etc/investment-research/research-public-ws.env');
  assert.equal(get('UMask'),'0077');
  assert.equal(get('NoNewPrivileges'),'true');
  assert.equal(get('ProtectSystem'),'strict');
  assert.equal(get('ProtectHome'),'true');
  assert.equal(get('PrivateDevices'),'true');
  assert.equal(get('CapabilityBoundingSet'),'');
  assert.equal(get('AmbientCapabilities'),'');
  assert.equal(get('ReadWritePaths'),'/var/lib/investment-research-production/public-ws');
  assert.equal(get('RestrictAddressFamilies'),'AF_INET AF_INET6 AF_UNIX');
});

test('one research-only flock owns the fixed sidecar root and roster; no private/order permission',()=>{
  const command=get('ExecStart');
  assert.ok(command.startsWith('/usr/bin/flock -n -E 75 /var/lib/investment-research-production/public-ws/.worker.lock /usr/bin/env '));
  assert.ok(command.endsWith(' node --max-old-space-size=160 research-production/bin/public-crypto-websocket-worker.mjs --execute'));
  for(const marker of [
    'LIVE_TRADING=false','AUTO_TRADING=false','REAL_ORDER_ENABLED=false',
    'PRIVATE_API_ENABLED=false','ORDER_AUTHORITY=false',
    'RESEARCH_PUBLIC_WS_SIDECAR_ROOT=/var/lib/investment-research-production/public-ws',
    'RESEARCH_PUBLIC_WS_ROSTER_MANIFEST=/etc/investment-research/research-public-ws-roster.json',
  ]) assert.ok(command.includes(' '+marker+' '),'fixed environment '+marker);
  for(const approval of [
    'RESEARCH_PUBLIC_WS_LIVE_ENABLED',
    'RESEARCH_PUBLIC_WS_OPERATOR_APPROVED',
    'RESEARCH_PUBLIC_WS_SOURCE_RIGHTS_CONFIRMED',
    'RESEARCH_PUBLIC_WS_HOST_CAPACITY_CONFIRMED',
    'RESEARCH_PUBLIC_WS_PRODUCER_SHA',
  ]) assert.ok(worker.includes(approval),'worker keeps required approval '+approval);
  assert.equal(get('Restart'),'on-abnormal');
  assert.equal(get('RestartPreventExitStatus'),'2 75');
  assert.equal(get('StartLimitBurst'),'3');
  assert.equal(get('StartLimitIntervalSec'),'600');
  assert.equal(get('TimeoutStopSec'),'45s');
  assert.equal(get('CPUQuota'),'40%');
  assert.equal(get('MemoryMax'),'512M');
  assert.equal(get('MemorySwapMax'),'64M');
  assert.equal(get('LimitNOFILE'),'4096');
});

test('systemd parses static source-only unit before any server installation',t=>{
  const result=spawnSync('systemd-analyze',['verify',new URL(url).pathname],{
    encoding:'utf8',timeout:15000,
  });
  if(result.error?.code==='ENOENT')return t.skip('systemd-analyze unavailable outside Linux CI');
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr||result.stdout);
});
