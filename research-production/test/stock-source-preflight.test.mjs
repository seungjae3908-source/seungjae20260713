import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectStockInputs, readVerifiedStockSource, STOCK_PREFLIGHT_CONTRACT,
} from '../bin/stock-source-preflight.mjs';

const NOW = Date.parse('2026-10-10T06:00:00.000Z');
const DIR = 'market-watch-input';
function input(market, completeUniverse = false) {
  return {
    schemaVersion: 'research-stock-public-snapshot-v1',
    market, source: market === 'KR_STOCK' ? 'KRX_PUBLIC_V1' : 'US_PUBLIC_V1',
    asOf: new Date(NOW - 2_000).toISOString(),
    completeUniverse,
    quotes: [{
      symbol: market === 'KR_STOCK' ? '005930' : 'MSFT',
      price: 100, turnover24h: 2_000_000_000,
      change24hPercent: 1.2,
      asOf: new Date(NOW - 3_000).toISOString(),
    }],
  };
}
async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), 'stock-preflight-'));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root, market, value) {
  await writeFile(join(root, DIR, market + '.json'), JSON.stringify(value), { mode: 0o600 });
}

test('missing stock sources remain incomplete, never 4-market or 24h proven', async () => {
  await withRoot(async root => {
    const report = await inspectStockInputs(root, NOW);
    assert.equal(report.contract, STOCK_PREFLIGHT_CONTRACT);
    assert.equal(report.status, 'INCOMPLETE');
    assert.deepEqual(report.markets.map(m => m.status), ['MISSING', 'MISSING']);
    assert.equal(report.fullUniverseVerified, false);
    assert.equal(report.independentProviderVerified, false);
    assert.equal(report.executionAuthority, 'NONE');
  });
});

test('KR/US fresh well-formed files are only format evidence, not a provider or coverage attestation', async () => {
  await withRoot(async root => {
    await mkdir(join(root, DIR), { mode: 0o700 });
    await put(root, 'KR_STOCK', input('KR_STOCK'));
    await put(root, 'US_STOCK', input('US_STOCK', true));
    const report = await inspectStockInputs(root, NOW);
    assert.equal(report.status, 'FORMAT_VALID_ONLY');
    assert.deepEqual(report.markets.map(m => m.status), [
      'FRESH_SUBSET_UNVERIFIED', 'FRESH_COMPLETE_CLAIM_UNVERIFIED',
    ]);
    assert.equal(report.markets[0].source, 'KRX_PUBLIC_V1');
    assert.equal(report.markets[0].observedCount, 1);
    for (const flag of ['independentProviderVerified', 'marketDataRightsVerified',
      'fullUniverseVerified', 'continuous24hProven', 'profitabilityProven',
      'paperExecutionProven']) assert.equal(report[flag], false);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('005930'), false);
    assert.equal(serialized.includes('MSFT'), false);
    assert.equal(serialized.includes(root), false);
    assert.equal(report.executionAuthority, 'NONE');
  });
});

test('invalid source IDs, stale snapshots and missing counterpart stay fail-closed', async () => {
  await withRoot(async root => {
    await mkdir(join(root, DIR), { mode: 0o700 });
    await put(root, 'KR_STOCK', { ...input('KR_STOCK'), source: 'KRX.V1' });
    let report = await inspectStockInputs(root, NOW);
    assert.equal(report.status, 'INVALID');
    assert.deepEqual(report.markets.map(m => m.status), ['INVALID', 'MISSING']);
    await put(root, 'KR_STOCK', { ...input('KR_STOCK'),
      asOf: new Date(NOW - 500_000).toISOString() });
    report = await inspectStockInputs(root, NOW);
    assert.equal(report.status, 'INCOMPLETE');
    assert.deepEqual(report.markets.map(m => m.status), ['STALE', 'MISSING']);
  });
});

test('unsafe root, directory, symlink, hardlink and write permissions cannot be used as evidence', async () => {
  assert.equal((await inspectStockInputs('/', NOW)).status, 'INVALID');
  await withRoot(async root => {
    await symlink('/tmp', join(root, DIR));
    assert.equal((await inspectStockInputs(root, NOW)).status, 'INVALID');
    await rm(join(root, DIR));
    await mkdir(join(root, DIR), { mode: 0o700 });
    await put(root, 'KR_STOCK', input('KR_STOCK'));
    const file = join(root, DIR, 'KR_STOCK.json');
    await link(file, join(root, DIR, 'linked.json'));
    assert.equal((await inspectStockInputs(root, NOW)).markets[0].status, 'INVALID');
    await rm(join(root, DIR, 'linked.json'));
    await chmod(file, 0o666);
    assert.equal((await inspectStockInputs(root, NOW)).markets[0].status, 'INVALID');
  });
});



test('actual watcher stock read enforces the same owner and source contract', async () => {
  await withRoot(async root => {
    await mkdir(join(root, DIR), { mode: 0o700 });
    await put(root, 'KR_STOCK', input('KR_STOCK'));
    await put(root, 'US_STOCK', input('US_STOCK', true));
    for (const market of ['KR_STOCK', 'US_STOCK']) {
      const actual = await readVerifiedStockSource(root, market, NOW);
      const diag = await inspectStockInputs(root, NOW);
      assert.equal(actual.source, market === 'KR_STOCK' ? 'KRX_PUBLIC_V1' : 'US_PUBLIC_V1');
      assert.equal(actual.status, 'PARTIAL_UNIVERSE');
      assert.equal(actual.quotes.length, diag.markets.find(v => v.market === market).observedCount);
      assert.equal(diag.fullUniverseVerified, false);
    }
    await assert.rejects(
      readVerifiedStockSource(root, '../account', NOW), /STOCK_SOURCE_ARGUMENT_INVALID/,
    );
    await assert.rejects(
      readVerifiedStockSource('/', 'KR_STOCK', NOW), /STOCK_SOURCE_ARGUMENT_INVALID/,
    );
    const stockFile = join(root, DIR, 'KR_STOCK.json');
    await chmod(stockFile, 0o666);
    await assert.rejects(
      readVerifiedStockSource(root, 'KR_STOCK', NOW), /UNSAFE_STOCK_INPUT/,
    );
    await chmod(stockFile, 0o600);
    await link(stockFile, join(root, DIR, 'hardlink-stock.json'));
    await assert.rejects(
      readVerifiedStockSource(root, 'KR_STOCK', NOW), /UNSAFE_STOCK_INPUT/,
    );
    await rm(join(root, DIR, 'hardlink-stock.json'));
    await rm(stockFile);
    await symlink(join(root, DIR, 'US_STOCK.json'), stockFile);
    await assert.rejects(
      readVerifiedStockSource(root, 'KR_STOCK', NOW), /UNSAFE_STOCK_INPUT/,
    );
  });
});

test('watcher uses verified KR/US stock reader instead of bypassing preflight checks', async () => {
  const script = await readFile(new URL('../bin/lightweight-market-watch.mjs', import.meta.url), 'utf8');
  assert.match(script, /import \{ readVerifiedStockSource \} from '\.\/stock-source-preflight\.mjs'/);
  assert.match(script, /return await readVerifiedStockSource\(root, market, Date\.now\(\)\)/);
  assert.doesNotMatch(script, /normalizeStockFeed\(JSON\.parse\(contents\), market, Date\.now\(\)\)/);
});

test('stock input diagnostics invoked via a symlinked checkout still run directly',async()=>{
  await withRoot(async root=>{
    const target=new URL('../bin/stock-source-preflight.mjs',import.meta.url).pathname;
    const linkPath=join(root,'linked-stock-source-preflight.mjs');
    await symlink(target,linkPath);
    const run=spawnSync(process.execPath,[linkPath],{
      encoding:'utf8',timeout:20000,
      env:{...process.env,RESEARCH_STATE_ROOT:root},
    });
    assert.equal(run.status,0,run.stderr+' '+run.stdout);
    const result=JSON.parse(run.stdout);
    assert.equal(result.contract,STOCK_PREFLIGHT_CONTRACT);
    assert.equal(result.status,'INCOMPLETE');
    assert.deepEqual(result.markets.map(x=>x.status),['MISSING','MISSING']);
    assert.equal(result.executionAuthority,'NONE');
  });
});
