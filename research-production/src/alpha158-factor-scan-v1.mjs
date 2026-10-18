// Stock factor scan in the style of Microsoft Qlib's Alpha158 (MIT licensed;
// only the public factor formulas are re-implemented here, no Qlib code).
//
// Question: which simple price/volume factors have actually ranked our KR and
// US stocks by their next-week return, out of sample?
//
//   * ~64 factors per stock per day, computed from the closed daily candle only
//   * target: 5-trading-day forward return (used for measurement, never as input)
//   * cross-sectional rank IC per date on selection symbols, measured every 5th
//     date so the overlapping 5-day targets do not inflate the t-statistic
//   * discovery = first 60% of dates, validation = last 40%
//   * every fourth symbol (stable hash) never takes part in selection; a factor
//     must keep its sign there too (time-series rank IC per symbol)
//   * Benjamini-Hochberg over all factors of a market, decided before results
//
// Data: the combination-research daily cache (pre-2026 only). Research only.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const ALPHA158_SCAN_CONTRACT_V1 = 'alpha158-factor-scan/v1';
export const ALPHA158_SCAN_VERSION_V1 = '1.0.0';
const HOLDOUT_START = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

export const ALPHA158_SCAN_POLICY_V1 = Object.freeze({
  horizon: 5,
  sampleEvery: 5,
  discoveryFraction: 0.6,
  minimumCrossSection: 8,
  minimumDates: 30,
  unseenStride: 4,
  falseDiscoveryRate: 0.10,
  minimumUnseenSymbols: 3,
  refreshDays: 7,
});

export const ALPHA158_SOURCES_V1 = Object.freeze({
  KR_STOCK: 'YAHOO_KR_1D',
  US_STOCK: 'YAHOO_US_1D',
});

const WINDOWS = Object.freeze([5, 10, 20, 30, 60]);

const FACTOR_LABELS_KO = Object.freeze({
  KMID: '당일 몸통((종가-시가)/시가)', KLEN: '당일 변동폭((고가-저가)/시가)', KUP: '윗꼬리 비율', KLOW: '아랫꼬리 비율',
  ROC: 'N일 전 종가/현재 종가(낮을수록 많이 오름)', MA: 'N일 평균/종가', STD: 'N일 변동성/종가', MAX: 'N일 최고가/종가', MIN: 'N일 최저가/종가',
  QTLU: 'N일 80% 분위/종가', QTLD: 'N일 20% 분위/종가', RSV: 'N일 범위 안 위치(0~1)', CNTP: 'N일 중 상승일 비율',
  SUMP: 'N일 상승폭 합/전체 변동 합', VMA: 'N일 평균 거래량/오늘 거래량', VSTD: 'N일 거래량 변동성/오늘 거래량', CORR: 'N일 종가-로그거래량 상관',
});

export function factorLabelKoV1(id) {
  const match = /^([A-Z]+)(\d*)$/u.exec(id);
  if (!match) return id;
  const base = FACTOR_LABELS_KO[match[1]] ?? match[1];
  return match[2] ? `${base.replace('N일', `${match[2]}일`)}` : base;
}

export const ALPHA158_FACTOR_IDS_V1 = Object.freeze([
  'KMID', 'KLEN', 'KUP', 'KLOW',
  ...['ROC', 'MA', 'STD', 'MAX', 'MIN', 'QTLU', 'QTLD', 'RSV', 'CNTP', 'SUMP', 'VMA', 'VSTD', 'CORR']
    .flatMap((name) => WINDOWS.map((w) => `${name}${w}`)),
]);

// ---------- pure math ----------

function finiteRatio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null;
}

function windowSlice(values, end, w) {
  return end - w + 1 < 0 ? null : values.slice(end - w + 1, end + 1);
}

function mean(values) { return values.reduce((s, v) => s + v, 0) / values.length; }
function std(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + ((v - m) ** 2), 0) / (values.length - 1));
}
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * (pos - lo));
}
function pearson(a, b) {
  if (a.length < 3) return null;
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Average ranks (1-based), ties share the mean rank. */
export function rankV1(values) {
  const order = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

export function spearmanV1(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  return pearson(rankV1(pairs.map((p) => p[0])), rankV1(pairs.map((p) => p[1])));
}

function normalUpperTail(z) {
  // Abramowitz-Stegun 7.1.26 on erfc
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - (erfc / 2);
}

export function benjaminiHochbergV1(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { p, i } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    q[i] = running;
  }
  return q;
}

/** Factor values for every date of one symbol. Uses only candles up to that date. */
export function computeAlpha158FactorsV1(candles) {
  const n = candles.length;
  const close = candles.map((c) => c.close);
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume);
  const out = Object.fromEntries(ALPHA158_FACTOR_IDS_V1.map((id) => [id, new Array(n).fill(null)]));
  for (let t = 0; t < n; t += 1) {
    const c = close[t]; const o = open[t];
    out.KMID[t] = finiteRatio(c - o, o);
    out.KLEN[t] = finiteRatio(high[t] - low[t], o);
    out.KUP[t] = finiteRatio(high[t] - Math.max(o, c), o);
    out.KLOW[t] = finiteRatio(Math.min(o, c) - low[t], o);
    for (const w of WINDOWS) {
      const cw = windowSlice(close, t, w);
      if (!cw) continue;
      const hw = windowSlice(high, t, w); const lw = windowSlice(low, t, w); const vw = windowSlice(volume, t, w);
      out[`ROC${w}`][t] = t - w >= 0 ? finiteRatio(close[t - w], c) : null;
      out[`MA${w}`][t] = finiteRatio(mean(cw), c);
      out[`STD${w}`][t] = finiteRatio(std(cw), c);
      const hh = Math.max(...hw); const ll = Math.min(...lw);
      out[`MAX${w}`][t] = finiteRatio(hh, c);
      out[`MIN${w}`][t] = finiteRatio(ll, c);
      out[`QTLU${w}`][t] = finiteRatio(quantile(cw, 0.8), c);
      out[`QTLD${w}`][t] = finiteRatio(quantile(cw, 0.2), c);
      out[`RSV${w}`][t] = finiteRatio(c - ll, hh - ll + 1e-12);
      if (t - w >= 0) {
        const changes = Array.from({ length: w }, (_, k) => close[t - w + 1 + k] - close[t - w + k]);
        out[`CNTP${w}`][t] = changes.filter((d) => d > 0).length / w;
        const abs = changes.reduce((s, d) => s + Math.abs(d), 0);
        out[`SUMP${w}`][t] = finiteRatio(changes.reduce((s, d) => s + Math.max(d, 0), 0), abs + 1e-12);
      }
      out[`VMA${w}`][t] = volume[t] > 0 ? finiteRatio(mean(vw), volume[t]) : null;
      out[`VSTD${w}`][t] = volume[t] > 0 ? finiteRatio(std(vw), volume[t]) : null;
      out[`CORR${w}`][t] = vw.every((v) => v > 0) ? pearson(cw, vw.map((v) => Math.log(v))) : null;
    }
  }
  return out;
}

export function forwardReturnsV1(candles, horizon) {
  return candles.map((c, t) => (t + horizon < candles.length ? finiteRatio(candles[t + horizon].close, c.close) - 1 : null));
}

export function isUnseenSymbolV1(symbol, stride = ALPHA158_SCAN_POLICY_V1.unseenStride) {
  return Number.parseInt(createHash('sha256').update(String(symbol)).digest('hex').slice(0, 8), 16) % stride === stride - 1;
}

function icStats(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return { n: v.length, meanIc: v.length ? v[0] : null, icir: null, tStat: null };
  const m = mean(v); const s = std(v);
  return { n: v.length, meanIc: m, icir: s > 0 ? m / s : null, tStat: s > 0 ? (m / s) * Math.sqrt(v.length) : null };
}

const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/**
 * Pure evaluation over one market's datasets: [{ symbol, candles }].
 * Returns every factor with discovery/validation IC, unseen-symbol IC and a verdict.
 */
export function evaluateAlpha158MarketV1({ datasets, policy = ALPHA158_SCAN_POLICY_V1 }) {
  const seen = datasets.filter((d) => !isUnseenSymbolV1(d.symbol, policy.unseenStride));
  const unseen = datasets.filter((d) => isUnseenSymbolV1(d.symbol, policy.unseenStride));
  const prepared = (rows) => rows.map((d) => {
    const factors = computeAlpha158FactorsV1(d.candles);
    const target = forwardReturnsV1(d.candles, policy.horizon);
    const byTime = new Map(d.candles.map((c, i) => [c.timestamp, i]));
    return { symbol: d.symbol, candles: d.candles, factors, target, byTime };
  });
  const seenRows = prepared(seen);
  const unseenRows = prepared(unseen);
  const dates = [...new Set(seenRows.flatMap((r) => r.candles.map((c) => c.timestamp)))].sort((a, b) => a - b);
  const usable = dates.filter((_, k) => k % policy.sampleEvery === 0);
  const split = usable[Math.floor(usable.length * policy.discoveryFraction)] ?? Infinity;

  const results = ALPHA158_FACTOR_IDS_V1.map((id) => {
    const discovery = []; const validation = []; const spreads = [];
    for (const ts of usable) {
      const xs = []; const ys = [];
      for (const r of seenRows) {
        const i = r.byTime.get(ts);
        if (i === undefined) continue;
        const x = r.factors[id][i]; const y = r.target[i];
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      }
      if (xs.length < policy.minimumCrossSection) continue;
      const ic = spearmanV1(xs, ys);
      if (!Number.isFinite(ic)) continue;
      (ts < split ? discovery : validation).push(ic);
      if (ts >= split) {
        const ranks = rankV1(xs); const k = Math.max(1, Math.floor(xs.length / 5));
        const order = ranks.map((r, i) => [r, ys[i]]).sort((a, b) => a[0] - b[0]);
        spreads.push(mean(order.slice(-k).map((p) => p[1])) - mean(order.slice(0, k).map((p) => p[1])));
      }
    }
    const d = icStats(discovery); const v = icStats(validation);
    const unseenIcs = [];
    for (const r of unseenRows) {
      const xs = []; const ys = [];
      const startIndex = r.candles.findIndex((c) => c.timestamp >= split);
      if (startIndex < 0) continue;
      for (let i = startIndex; i < r.candles.length; i += policy.sampleEvery) {
        const x = r.factors[id][i]; const y = r.target[i];
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      }
      const ic = xs.length >= policy.minimumDates ? spearmanV1(xs, ys) : null;
      if (Number.isFinite(ic)) unseenIcs.push(ic);
    }
    const unseenMean = unseenIcs.length ? mean(unseenIcs) : null;
    const pValue = Number.isFinite(v.tStat) && v.n >= policy.minimumDates ? 2 * normalUpperTail(Math.abs(v.tStat)) : 1;
    return {
      factorId: id, label: factorLabelKoV1(id),
      discovery: { dates: d.n, meanIc: round(d.meanIc), icir: round(d.icir, 3) },
      validation: { dates: v.n, meanIc: round(v.meanIc), icir: round(v.icir, 3), tStat: round(v.tStat, 3) },
      validationTopMinusBottom: round(spreads.length ? mean(spreads) : null, 5),
      unseen: { symbols: unseenIcs.length, meanIc: round(unseenMean) },
      pValue,
    };
  });
  const q = benjaminiHochbergV1(results.map((r) => r.pValue));
  const classified = results.map((r, i) => {
    const sameSign = Number.isFinite(r.discovery.meanIc) && Number.isFinite(r.validation.meanIc)
      && Math.sign(r.discovery.meanIc) === Math.sign(r.validation.meanIc) && r.validation.meanIc !== 0;
    const unseenAgrees = r.unseen.symbols >= policy.minimumUnseenSymbols && Number.isFinite(r.unseen.meanIc)
      && Math.sign(r.unseen.meanIc) === Math.sign(r.validation.meanIc);
    const passed = q[i] <= policy.falseDiscoveryRate && sameSign && unseenAgrees;
    return Object.freeze({
      ...r, pValue: round(r.pValue, 6), qValue: round(q[i], 6),
      direction: !Number.isFinite(r.validation.meanIc) ? null : r.validation.meanIc > 0 ? 'HIGH_IS_BETTER' : 'LOW_IS_BETTER',
      verdict: passed ? 'CANDIDATE' : sameSign ? 'WATCH' : 'REJECT',
    });
  });
  classified.sort((a, b) => (a.qValue - b.qValue) || (Math.abs(b.validation.meanIc ?? 0) - Math.abs(a.validation.meanIc ?? 0)));
  return Object.freeze({
    symbols: { seen: seen.map((d) => d.symbol), unseen: unseen.map((d) => d.symbol) },
    sampledDates: usable.length,
    splitDate: Number.isFinite(split) ? new Date(split).toISOString().slice(0, 10) : null,
    factors: Object.freeze(classified),
    candidates: classified.filter((r) => r.verdict === 'CANDIDATE').length,
  });
}

// ---------- runner over the combination-research cache ----------

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function loadSource(root, source) {
  const dir = join(root, 'combination-research', 'datasets', source);
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.endsWith('.failure.json')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const out = [];
  for (const name of names.sort()) {
    const cached = await readJson(join(dir, name));
    const candles = (cached?.candles ?? []).filter((c) => c.timestamp < HOLDOUT_START
      && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.close > 0);
    if (candles.length >= 250) out.push({ symbol: cached.symbol ?? name.replace(/\.json$/u, ''), candles });
  }
  return out;
}

export async function runAlpha158FactorScanV1({
  stateRoot, researchCodeSha = null, now = () => new Date().toISOString(),
  sources = ALPHA158_SOURCES_V1, policy = ALPHA158_SCAN_POLICY_V1, force = false,
} = {}) {
  if (!stateRoot) throw new Error('ALPHA158_STATE_ROOT_REQUIRED');
  const root = resolve(String(stateRoot));
  const observedAt = now();
  const latestPath = join(root, 'latest', 'alpha158-factor-scan-v1.json');
  const prior = await readJson(latestPath);
  const markets = {};
  for (const [market, source] of Object.entries(sources)) {
    const datasets = await loadSource(root, source);
    const key = createHash('sha256').update([ALPHA158_SCAN_VERSION_V1, researchCodeSha ?? '',
      ...datasets.map((d) => `${d.symbol}:${d.candles.length}:${d.candles.at(-1)?.timestamp}`)].join('|')).digest('hex').slice(0, 24);
    const old = prior?.markets?.[market];
    if (!force && old?.key === key && Date.parse(observedAt) - Date.parse(old.computedAt) < policy.refreshDays * DAY) {
      markets[market] = old;
      continue;
    }
    if (datasets.length < policy.minimumCrossSection + policy.minimumUnseenSymbols) {
      markets[market] = { status: 'WAITING_FOR_DATA', symbols: datasets.length, key, computedAt: observedAt };
      continue;
    }
    markets[market] = { status: 'COMPLETE', key, computedAt: observedAt, source, ...evaluateAlpha158MarketV1({ datasets, policy }) };
  }
  const result = Object.freeze({
    contract: ALPHA158_SCAN_CONTRACT_V1, version: ALPHA158_SCAN_VERSION_V1, observedAt, researchCodeSha,
    policy, markets, holdoutRead: false, liveTrading: false, realOrder: false, executionAuthority: 'NONE',
  });
  await atomicJson(latestPath, result);
  return result;
}

// ---------- Korean report ----------

const MARKET_KO = { KR_STOCK: '국내주식', US_STOCK: '미국주식' };
const ic = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}` : '-');

export function formatAlpha158ReportKoV1(result, { top = 8 } = {}) {
  const lines = ['주식 팩터 탐색 (Qlib Alpha158 방식, 2025년까지 데이터, 2026 봉인 미사용)',
    'IC = 팩터 순위와 다음 5거래일 수익 순위의 상관. +0.03 이상이면 의미 있는 편, 부호가 방향.', ''];
  for (const [market, row] of Object.entries(result.markets ?? {})) {
    lines.push(`■ ${MARKET_KO[market] ?? market}`);
    if (row.status !== 'COMPLETE') { lines.push(`  대기: 데이터 ${row.symbols ?? 0}종목`, ''); continue; }
    lines.push(`  종목 ${row.symbols.seen.length}개 선택용 + ${row.symbols.unseen.length}개 처음 보는 종목 · 검증 시작 ${row.splitDate} · 후보 ${row.candidates}개 / ${row.factors.length}개`);
    for (const f of row.factors.slice(0, top)) {
      const mark = f.verdict === 'CANDIDATE' ? '후보' : f.verdict === 'WATCH' ? '관찰' : '탈락';
      lines.push(`  [${mark}] ${f.factorId} ${f.label} · ${f.direction === 'LOW_IS_BETTER' ? '낮을수록 좋음' : '높을수록 좋음'}`);
      lines.push(`     검증 IC ${ic(f.validation.meanIc)} (탐색 ${ic(f.discovery.meanIc)}, 처음 보는 종목 ${ic(f.unseen.meanIc)}) · 상위-하위 20% 차이 ${Number.isFinite(f.validationTopMinusBottom) ? `${(f.validationTopMinusBottom * 100).toFixed(2)}%` : '-'} · q=${f.qValue}`);
    }
    lines.push('');
  }
  lines.push('후보 = 우연 보정(q ≤ 0.10) 통과 + 탐색·검증·처음 보는 종목 모두 같은 방향. 연구 결과일 뿐 주문 권한은 없습니다.');
  return lines.join('\n');
}
