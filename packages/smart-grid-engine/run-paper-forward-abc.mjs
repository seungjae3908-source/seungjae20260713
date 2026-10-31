import fs from 'node:fs';
import path from 'node:path';
import { fetchCandles, fetchFundingRateHistory, fetchContractInfo } from './src/bitget-adapter.mjs';
import { initState as initA, processCandle as procA, applyFunding as fundA, computeMetrics as metricsA } from './src/paper-forward-engine.mjs';
import { initStateB, processCandleB, applyFundingB, computeMetricsB } from './src/paper-forward-trailing.mjs';

for (const k of ['LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED','PRIVATE_TRADING_API_ALLOWED']) {
  if (process.env[k] === 'true') { console.error(`❌ SAFETY: ${k}=true. Refusing.`); process.exit(1); }
}

const ROOT = './paper-abc';
const ACCOUNTS = {
  A: { dir: path.join(ROOT, 'A-baseline'), init: initA, process: procA, funding: fundA, metrics: metricsA },
  B: { dir: path.join(ROOT, 'B-trailing'), init: initStateB, process: processCandleB, funding: applyFundingB, metrics: computeMetricsB },
};

function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function acquireLock(acc, id) {
  fs.mkdirSync(acc.dir, { recursive: true });
  fs.mkdirSync(path.join(acc.dir, 'reports'), { recursive: true });
  const lock = path.join(acc.dir, 'lock'), pidFile = path.join(acc.dir, 'pid');
  if (fs.existsSync(pidFile)) {
    const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (isPidAlive(p)) throw new Error(`[${id}] PID_ALIVE:${p}`);
    console.log(`[${id}] Stale PID ${p} → removing`);
    try { fs.unlinkSync(pidFile); } catch {}
  }
  if (fs.existsSync(lock)) {
    const p = parseInt(fs.readFileSync(lock, 'utf8').trim());
    if (isPidAlive(p)) throw new Error(`[${id}] LOCK_ALIVE:${p}`);
    try { fs.unlinkSync(lock); } catch {}
  }
  fs.writeFileSync(lock, String(process.pid));
  fs.writeFileSync(pidFile, String(process.pid));
}

function releaseLock(acc) {
  try { fs.unlinkSync(path.join(acc.dir, 'lock')); } catch {}
  try { fs.unlinkSync(path.join(acc.dir, 'pid')); } catch {}
}

export function loadState(acc, id) {
  const f = path.join(acc.dir, 'state.json');
  const backup = f + '.backup';
  if (!fs.existsSync(f)) return null;
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const s = JSON.parse(raw);
    if (!s.meta || typeof s.lastCandleTs !== 'number') throw new Error('SCHEMA_INVALID');
    return s;
  } catch (e) {
    console.error(`[${id}] state corrupt: ${e.message}`);
    try { fs.renameSync(f, `${f}.corrupt.${Date.now()}`); } catch {}
    if (fs.existsSync(backup)) {
      try {
        const b = JSON.parse(fs.readFileSync(backup, 'utf8'));
        if (!b.meta || typeof b.lastCandleTs !== 'number') throw new Error('BACKUP_INVALID');
        console.log(`[${id}] RESTORED_FROM_BACKUP`);
        return b;
      } catch (be) {
        throw new Error(`[${id}] FAIL_CLOSED: state corrupt + backup invalid: ${be.message}`);
      }
    }
    throw new Error(`[${id}] FAIL_CLOSED: state corrupt + no backup`);
  }
}

export function saveStateAtomic(acc, state) {
  const f = path.join(acc.dir, 'state.json');
  const tmp = `${f}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  if (fs.existsSync(f)) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); fs.copyFileSync(f, f + '.backup'); } catch {}
  }
  fs.renameSync(tmp, f);
}

async function initAccount(acc, id, contract, seedCandle, fundings) {
  const s = acc.init({
    symbol: 'BTCUSDT', startPrice: seedCandle.close, gridCount: 20,
    investmentUsdt: 300, leverage: 2, rangePct: 0.15,
    pricePlace: contract.pricePlace, volumePlace: contract.volumePlace, minTradeNum: contract.minTradeNum,
  });
  s.accountId = id; s.fundingHistory = fundings;
  s.lastFundingTs = fundings.length > 0 ? fundings[fundings.length - 1].fundingTime : 0;
  saveStateAtomic(acc, s);
  return s;
}

async function tickAccount(acc, id, state, candles) {
  try {
    let totalFills = 0;
    for (const c of candles) {
      const r = acc.process(state, c);
      if (r.fills > 0) totalFills += r.fills;
    }
    if (state.fundingHistory && state.fundingHistory.length > 0) {
      const now = Date.now();
      for (const f of state.fundingHistory) {
        if (f.fundingTime > state.lastFundingTs && f.fundingTime <= now) acc.funding(state, f.fundingTime, f.fundingRate);
      }
    }
    saveStateAtomic(acc, state);
    const today = new Date().toISOString().slice(0, 10);
    const rf = path.join(acc.dir, 'reports', `${today}.json`);
    if (!fs.existsSync(rf)) {
      const m = acc.metrics(state);
      fs.writeFileSync(rf, JSON.stringify({ date: today, accountId: id, ts: Date.now(), metrics: m }, null, 2));
    }
    return { ok: true, fills: totalFills };
  } catch (e) {
    console.error(`[${id}] tick error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.log(`=== Paper Forward A/B START (pid ${process.pid}) ===`);
  for (const [id, acc] of Object.entries(ACCOUNTS)) acquireLock(acc, id);

  let running = true;
  const shutdown = () => { running = false; for (const acc of Object.values(ACCOUNTS)) releaseLock(acc); console.log('shutdown → exit'); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

  const contract = await fetchContractInfo('BTCUSDT');
  if (contract.status !== 'online') throw new Error(`NOT_ONLINE:${contract.status}`);
  const seed = await fetchCandles('BTCUSDT', '1m', Date.now() - 300000, undefined, 5);
  if (seed.length === 0) throw new Error('NO_SEED');
  const seedCandle = seed[seed.length - 1];

  let fundings = [];
  try { fundings = await fetchFundingRateHistory('BTCUSDT'); console.log(`Funding: ${fundings.length}건`); }
  catch (e) { console.log(`Funding fail: ${e.message}`); }

  const states = {};
  for (const [id, acc] of Object.entries(ACCOUNTS)) {
    let s = loadState(acc, id);
    if (!s) { s = await initAccount(acc, id, contract, seedCandle, fundings); console.log(`[${id}] new state: start=${s.startPrice}`); }
    else console.log(`[${id}] resumed: candles=${s.processedCandles}, lastTs=${new Date(s.lastCandleTs).toISOString()}`);
    states[id] = s;
  }

  while (running) {
    try {
      const minLastTs = Math.min(...Object.values(states).map(s => s.lastCandleTs || 0));
      const fromTs = minLastTs > 0 ? minLastTs + 1 : (Date.now() - 3600000);
      const candles = await fetchCandles('BTCUSDT', '1m', fromTs, undefined, 200);

      let badData = false;
      for (let i = 0; i < candles.length; i++) {
        if (i > 0 && candles[i].ts <= candles[i - 1].ts) { badData = true; break; }
        if (candles[i].high < candles[i].low || candles[i].close <= 0 || candles[i].low <= 0) { badData = true; break; }
      }

      if (badData) {
        console.error('❌ DATA_ANOMALY → skip tick');
      } else if (candles.length > 0) {
        for (const [id, acc] of Object.entries(ACCOUNTS)) {
          await tickAccount(acc, id, states[id], candles);
        }
      }
    } catch (e) {
      console.error(`Tick loop error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

if (process.env.PAPER_FORWARD_IMPORT_ONLY !== '1') main().catch(e => { console.error(e); for (const acc of Object.values(ACCOUNTS)) releaseLock(acc); process.exit(1); });

