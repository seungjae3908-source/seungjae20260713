// Paper Forward Orchestrator - 30-day run
import fs from 'node:fs';
import path from 'node:path';
import { fetchCandles, fetchFundingRateHistory, fetchContractInfo } from './src/bitget-adapter.mjs';
import { initState, processCandle, applyFunding, computeMetrics } from './src/paper-forward-engine.mjs';

// SAFETY GATE: refuse to run if LIVE/AUTO/REAL_ORDER enabled
for (const envKey of ['LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED']) {
  if (process.env[envKey] === 'true') {
    console.error(`❌ SAFETY: ${envKey}=true. Refusing to start.`);
    process.exit(1);
  }
}

const STATE_DIR = './paper-state';
const REPORT_DIR = './paper-reports';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events.log');
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const PID_FILE = path.join(STATE_DIR, 'pid');

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

// Lock + PID 이중 검증
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
if (fs.existsSync(PID_FILE)) {
  const stalePid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (isPidAlive(stalePid)) { console.error(`❌ PID ${stalePid} alive. Refusing.`); process.exit(1); }
  console.log(`Stale PID ${stalePid} → removing`);
  try { fs.unlinkSync(PID_FILE); } catch {}
}
if (fs.existsSync(LOCK_FILE)) {
  const lockPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
  if (isPidAlive(lockPid)) { console.error(`❌ Lock PID ${lockPid} alive. Refusing.`); process.exit(1); }
  console.log(`Stale lock ${lockPid} → removing`);
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
fs.writeFileSync(PID_FILE, String(process.pid));

let state = null;
let running = true;

function saveState() { if (state) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function shutdown(sig) {
  console.log(`\n[shutdown] ${sig} → saving state...`);
  running = false;
  saveState();
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log(`[resume] Loaded: ${state.processedCandles} candles, realized=${state.realizedPnl.toFixed(2)}, lastTs=${new Date(state.lastCandleTs).toISOString()}`);
    } catch (e) { console.error('Load fail:', e.message); state = null; }
  }
}

async function init() {
  const contract = await fetchContractInfo('BTCUSDT');
  if (contract.status !== 'online') throw new Error(`NOT_ONLINE:${contract.status}`);
  const seed = await fetchCandles('BTCUSDT', '1m', Date.now() - 300000, undefined, 5);
  if (seed.length === 0) throw new Error('NO_SEED');
  const startPrice = seed[seed.length - 1].close;
  state = initState({ symbol: 'BTCUSDT', startPrice, gridCount: 20, investmentUsdt: 300, leverage: 2, rangePct: 0.15,
    pricePlace: contract.pricePlace, volumePlace: contract.volumePlace, minTradeNum: contract.minTradeNum });
  try {
    const fundings = await fetchFundingRateHistory('BTCUSDT');
    state.fundingHistory = fundings;
    state.lastFundingTs = fundings.length > 0 ? fundings[fundings.length - 1].fundingTime : 0;
    console.log(`[init] Funding: ${fundings.length} records`);
  } catch (e) { console.log(`[init] Funding fetch fail: ${e.message}`); }
  saveState();
  console.log(`[init] start=${startPrice} levels=${state.levels.length} qty=${state.quantity} range=${state.lowerPrice.toFixed(2)}~${state.upperPrice.toFixed(2)}`);
}

async function tick() {
  if (!running) return;
  try {
    if (!state) await init();
    const fromTs = state.lastCandleTs > 0 ? state.lastCandleTs + 1 : (Date.now() - 3600000);
    const candles = await fetchCandles('BTCUSDT', '1m', fromTs, undefined, 200);
    if (candles.length === 0) return;
    let totalFills = 0;
    for (const c of candles) {
      const r = processCandle(state, c);
      if (r.fills > 0) {
        fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: c.ts, fills: r.fills, events: r.events }) + '\n');
        totalFills += r.fills;
      }
    }
    if (state.fundingHistory && state.fundingHistory.length > 0) {
      const now = Date.now();
      for (const f of state.fundingHistory) {
        if (f.fundingTime > state.lastFundingTs && f.fundingTime <= now) {
          const cost = applyFunding(state, f.fundingTime, f.fundingRate);
          if (cost > 0) fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: f.fundingTime, type: 'FUNDING', rate: f.fundingRate, cost: +cost.toFixed(4) }) + '\n');
        }
      }
    }
    saveState();
    const today = new Date().toISOString().slice(0, 10);
    const reportFile = path.join(REPORT_DIR, `${today}.json`);
    if (!fs.existsSync(reportFile)) {
      const m = computeMetrics(state);
      fs.writeFileSync(reportFile, JSON.stringify({ date: today, ts: Date.now(), metrics: m }, null, 2));
      console.log(`[report] ${today}: Net=${m.netPnl}U PF=${m.profitFactor} MDD=${m.maxDD}% Liq=${m.liquidations}`);
    }
    if (totalFills > 0) {
      const m = computeMetrics(state);
      console.log(`[tick] ${candles.length} candles, ${totalFills} fills | Net=${m.netPnl}U PF=${m.profitFactor} Trades=${m.trades}`);
    }
  } catch (e) { console.error(`[tick] ${e.message}`); }
}

console.log(`=== Paper Forward START (pid ${process.pid}) ===`);
console.log(`Safety: LIVE=${process.env.LIVE_TRADING || 'unset'} AUTO=${process.env.AUTO_TRADING || 'unset'}`);
loadState();
if (!state) await init();
await tick();
setInterval(tick, 30 * 1000);
console.log('[running] Tick every 30s. Ctrl+C to stop gracefully.');
