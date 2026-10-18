import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PUMP_FOLLOW_PAPER_V1, closedBarsV1, computePumpFollowLedgerV1, formatPumpFollowPaperKoV1, runPumpFollowPaperV1, verdictVsExpectationV1 } from '../src/pump-follow-paper-v1.mjs';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
function bars(n, seed, pumpAt = null) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let p = 100;
  for (let i = 0; i < n; i += 1) {
    const o = p; let c = o * (1 + ((rnd() - 0.5) * 0.006)); let v = 100;
    if (pumpAt !== null && i === pumpAt) { c = o * 1.07; v = 2000; }
    if (pumpAt !== null && i > pumpAt && i < pumpAt + 40) c = o * 1.012;
    out.push({ timestamp: T0 + (i * H), open: o, close: c, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, volume: v });
    p = c;
  }
  return out;
}

test('only closed bars are used', () => {
  const b = bars(10, 1); const now = b[9].timestamp + (30 * 60_000);
  assert.equal(closedBarsV1(b, now).length, 9);
});

test('no paper trade can open before activation; trades after it are recorded with KRW P&L', () => {
  const n = 1700; const pumpBefore = 1300; const pumpAfter = 1500;
  const a = bars(n, 3, pumpBefore); const b = bars(n, 5, pumpAfter);
  const activatedAt = T0 + (1400 * H); const nowMs = T0 + (n * H);
  const ledger = computePumpFollowLedgerV1({ datasets: [{ symbol: 'AUSDT', candles: a }, { symbol: 'BUSDT', candles: b }], activatedAt, nowMs });
  const all = [...ledger.closedTrades, ...ledger.openPositions];
  assert.ok(all.length >= 1);
  assert.ok(all.every((t) => Date.parse(t.entryAt) >= activatedAt));
  assert.ok(!all.some((t) => t.symbol === 'AUSDT' && Date.parse(t.entryAt) < T0 + (1450 * H)), 'the pre-activation pump is ignored');
  assert.equal(ledger.executionAuthority, 'NONE');
  assert.match(formatPumpFollowPaperKoV1({ ...ledger, symbolsWatched: ['AUSDT', 'BUSDT'], failures: [] }), /종이매매/u);
});

test('verdict waits for the minimum sample, then compares with the backtest', () => {
  assert.equal(verdictVsExpectationV1({ n: 5 }).status, 'COLLECTING');
  assert.equal(verdictVsExpectationV1({ n: 60, winRate: 0.37, avgWinRet: 0.09, avgLossRet: -0.04 }).status, 'CONSISTENT');
  assert.equal(verdictVsExpectationV1({ n: 60, winRate: 0.2, avgWinRet: 0.05, avgLossRet: -0.04 }).status, 'BELOW_EXPECTATION');
});

test('activation is recorded once and reused; failures are reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pfp-'));
  try {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
    const spec = { ...PUMP_FOLLOW_PAPER_V1, symbols: ['BTCUSDT'] };
    const r1 = await runPumpFollowPaperV1({ stateRoot: dir, now: () => T0 + (10.5 * H), fetchImpl, spec });
    const r2 = await runPumpFollowPaperV1({ stateRoot: dir, now: () => T0 + (20.5 * H), fetchImpl, spec });
    assert.equal(r1.activatedAt, r2.activatedAt);
    assert.equal(r1.activatedAt, new Date(T0 + (11 * H)).toISOString());
    assert.ok(r2.failures.length >= 1);
    const saved = JSON.parse(await readFile(join(dir, 'latest', 'pump-follow-paper-v1.json'), 'utf8'));
    assert.equal(saved.liveTrading, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('systemd unit is sandboxed, research-only and keyless', async () => {
  const service = await readFile(new URL('../deploy/research-production-pump-follow-paper.service', import.meta.url), 'utf8');
  const timer = await readFile(new URL('../deploy/research-production-pump-follow-paper.timer', import.meta.url), 'utf8');
  assert.match(service, /^ExecStart=\/usr\/bin\/env node .*research-production\/bin\/pump-follow-paper\.mjs$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/investment-research-production$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.doesNotMatch(service, /API_KEY|SECRET|PASSPHRASE|stock-app-data/u);
  assert.match(timer, /^Unit=research-production-pump-follow-paper\.service$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:03:00 UTC$/m);
});
