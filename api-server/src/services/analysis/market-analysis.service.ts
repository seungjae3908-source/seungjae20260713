// GET /api/market/analysis/(kr|us|coin) 백엔드 서비스.
// 실제 확보 가능한 데이터만 표기. 없는 항목은 unavailable 사유. 가짜 분석 금지.

import { cached } from '../../lib/cache';
import { MarketDataService, type SummaryItem } from '../market-data.service';
import { RankingMoversService } from '../ranking-movers.service';
import { SectorPopularService } from '../sector-popular.service';
import * as yahoo from '../../providers/yahoo';
import { fetchAllUpbitTickers, fetchBitgetTickers, fetchPublicJson } from './crypto-source';

const ANALYSIS_TTL = 4 * 60 * 1000; // 3~5분

export interface AnalysisItem {
  label: string;
  value: string | null;
  note?: string;
  tone?: 'up' | 'down' | 'flat';
}

export interface AnalysisSection {
  key: string;
  title: string;
  items: AnalysisItem[];
  highlight?: boolean;
  unavailable?: string;
}

export interface MarketAnalysisResult {
  ok: boolean;
  market: string;
  dataAsOf: string;
  sections: AnalysisSection[];
}

function toneOf(pct: number | null | undefined): 'up' | 'down' | 'flat' {
  if (pct == null || !Number.isFinite(pct)) return 'flat';
  if (pct > 0.05) return 'up';
  if (pct < -0.05) return 'down';
  return 'flat';
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

function summaryMap(items: SummaryItem[]): Map<string, SummaryItem> {
  return new Map(items.map((i) => [i.key, i]));
}

// Asia/Seoul 시간 기준 장 상태
function krMarketPhase(now: Date): { label: string; key: string } {
  const seoul = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = seoul.getDay();
  const mins = seoul.getHours() * 60 + seoul.getMinutes();
  if (day === 0 || day === 6) return { label: '휴장(주말)', key: 'closed' };
  if (mins < 9 * 60) return { label: '장전(개장 전)', key: 'pre' };
  if (mins < 15 * 60 + 30) return { label: '장중(정규장)', key: 'regular' };
  return { label: '장후(마감)', key: 'post' };
}

function usMarketPhase(now: Date): { label: string; key: string } {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  if (day === 0 || day === 6) return { label: '휴장(주말)', key: 'closed' };
  if (mins < 9 * 60 + 30) return { label: '프리마켓', key: 'pre' };
  if (mins < 16 * 60) return { label: '정규장', key: 'regular' };
  return { label: '애프터마켓', key: 'post' };
}

async function tryYahooQuote(symbol: string): Promise<{ price: number; changePercent: number } | null> {
  try {
    const q = await yahoo.getIndexQuote(symbol);
    return { price: q.price, changePercent: q.changePercent };
  } catch {
    return null;
  }
}

async function buildKr(): Promise<MarketAnalysisResult> {
  const now = new Date();
  const dataAsOf = now.toISOString();
  const phase = krMarketPhase(now);

  const [summaryR, listingsR, sectorR] = await Promise.allSettled([
    MarketDataService.getMarketSummary(),
    RankingMoversService.getMarketListings('KRX'),
    SectorPopularService.getSectorPopular('KR'),
  ]);

  const sections: AnalysisSection[] = [];

  // 지수·환율
  if (summaryR.status === 'fulfilled') {
    const m = summaryMap(summaryR.value);
    const items: AnalysisItem[] = [];
    for (const key of ['kospi', 'kosdaq', 'usdkrw']) {
      const s = m.get(key);
      if (s && s.ok) {
        items.push({
          label: s.label,
          value: `${fmtNum(s.price)} (${fmtPct(s.changePercent)})`,
          tone: toneOf(s.changePercent),
        });
      } else {
        items.push({ label: s?.label ?? key, value: null, note: '데이터 제공처 응답 없음' });
      }
    }
    sections.push({ key: 'index', title: '지수·환율', items });
  } else {
    sections.push({ key: 'index', title: '지수·환율', items: [], unavailable: '지수 데이터를 불러오지 못했습니다.' });
  }

  // 장 상태
  sections.push({
    key: 'phase',
    title: '장 상태',
    highlight: true,
    items: [{ label: '한국 시장', value: phase.label, note: 'Asia/Seoul 기준' }],
  });

  // 등락 종목 수
  if (listingsR.status === 'fulfilled') {
    const l = listingsR.value.listings;
    const all = [...l.gainers, ...l.losers, ...l.popular, ...l.recommended];
    const seen = new Set<string>();
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const row of all) {
      if (seen.has(row.ticker)) continue;
      seen.add(row.ticker);
      if (row.changePercent > 0) up += 1;
      else if (row.changePercent < 0) down += 1;
      else flat += 1;
    }
    if (seen.size > 0) {
      sections.push({
        key: 'breadth',
        title: '등락 종목 수(랭킹 유니버스 기준)',
        items: [
          { label: '상승', value: `${up}종목`, tone: 'up' },
          { label: '하락', value: `${down}종목`, tone: 'down' },
          { label: '보합', value: `${flat}종목`, tone: 'flat' },
        ],
      });
    } else {
      sections.push({ key: 'breadth', title: '등락 종목 수', items: [], unavailable: '분석 가능한 데이터가 없습니다.' });
    }

    // 거래대금 상위 5
    const top = [...l.popular].slice(0, 5);
    if (top.length) {
      sections.push({
        key: 'value',
        title: '거래대금 상위',
        items: top.map((row) => ({
          label: row.name,
          value: `${fmtPct(row.changePercent)}`,
          note: row.tradingValue ? `거래대금 ${fmtNum(row.tradingValue, 0)}` : undefined,
          tone: toneOf(row.changePercent),
        })),
      });
    } else {
      sections.push({ key: 'value', title: '거래대금 상위', items: [], unavailable: '거래대금 데이터를 불러오지 못했습니다.' });
    }
  } else {
    sections.push({ key: 'breadth', title: '등락 종목 수', items: [], unavailable: '시장 목록을 불러오지 못했습니다.' });
    sections.push({ key: 'value', title: '거래대금 상위', items: [], unavailable: '시장 목록을 불러오지 못했습니다.' });
  }

  // 강세/약세 업종
  if (sectorR.status === 'fulfilled' && sectorR.value.sectors.length) {
    const ranked = sectorR.value.sectors
      .map((sec) => {
        const changes = sec.rows.map((r) => r.changePercent).filter((v) => Number.isFinite(v));
        const avgChange = changes.length ? changes.reduce((s, v) => s + v, 0) / changes.length : null;
        return { label: sec.label, avgChange };
      })
      .filter((s) => s.avgChange != null)
      .sort((a, b) => (b.avgChange ?? 0) - (a.avgChange ?? 0));
    if (ranked.length) {
      const strong = ranked.slice(0, 3);
      const weak = ranked.slice(-3).reverse();
      sections.push({
        key: 'sector',
        title: '강세·약세 업종',
        items: [
          ...strong.map((s) => ({ label: `강세 · ${s.label}`, value: fmtPct(s.avgChange), tone: 'up' as const })),
          ...weak.map((s) => ({ label: `약세 · ${s.label}`, value: fmtPct(s.avgChange), tone: 'down' as const })),
        ],
      });
    } else {
      sections.push({ key: 'sector', title: '강세·약세 업종', items: [], unavailable: '업종 등락 데이터가 없습니다.' });
    }
  } else {
    sections.push({ key: 'sector', title: '강세·약세 업종', items: [], unavailable: '업종 데이터를 불러오지 못했습니다.' });
  }

  // 환율 영향
  if (summaryR.status === 'fulfilled') {
    const usd = summaryMap(summaryR.value).get('usdkrw');
    if (usd && usd.ok) {
      const dir = usd.changePercent > 0 ? '원화 약세(환율 상승)' : usd.changePercent < 0 ? '원화 강세(환율 하락)' : '환율 보합';
      sections.push({
        key: 'fx',
        title: '환율 영향',
        items: [
          { label: '원/달러', value: `${fmtNum(usd.price)} (${fmtPct(usd.changePercent)})`, tone: toneOf(usd.changePercent) },
          { label: '방향', value: dir, note: '수출주·수입주 영향은 종목별 상이' },
        ],
      });
    } else {
      sections.push({ key: 'fx', title: '환율 영향', items: [], unavailable: '환율 데이터를 불러오지 못했습니다.' });
    }
  }

  // 금리·수급 전체합계
  sections.push({
    key: 'macro',
    title: '금리·수급',
    items: [],
    unavailable: '데이터 제공처 없음(국내 기준금리·투자자별 수급 전체합계 미제공)',
  });

  return { ok: true, market: 'kr', dataAsOf, sections };
}

const US_TECH: string[] = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'];
const US_SECTOR_ETF: Array<{ symbol: string; label: string }> = [
  { symbol: 'XLK', label: '기술' },
  { symbol: 'XLF', label: '금융' },
  { symbol: 'XLE', label: '에너지' },
  { symbol: 'XLV', label: '헬스케어' },
  { symbol: 'XLY', label: '경기소비재' },
  { symbol: 'XLP', label: '필수소비재' },
  { symbol: 'XLI', label: '산업재' },
  { symbol: 'XLU', label: '유틸리티' },
  { symbol: 'XLB', label: '소재' },
  { symbol: 'XLRE', label: '부동산' },
  { symbol: 'XLC', label: '커뮤니케이션' },
];

async function buildUs(): Promise<MarketAnalysisResult> {
  const now = new Date();
  const dataAsOf = now.toISOString();
  const phase = usMarketPhase(now);

  const summaryR = await MarketDataService.getMarketSummary().catch(() => null);
  const sections: AnalysisSection[] = [];

  // 지수 + VIX
  if (summaryR) {
    const m = summaryMap(summaryR);
    const items: AnalysisItem[] = [];
    for (const key of ['dow', 'sp500', 'nasdaq', 'vix']) {
      const s = m.get(key);
      if (s && s.ok) {
        items.push({ label: s.label, value: `${fmtNum(s.price)} (${fmtPct(s.changePercent)})`, tone: toneOf(s.changePercent) });
      } else {
        items.push({ label: s?.label ?? key, value: null, note: '데이터 제공처 응답 없음' });
      }
    }
    sections.push({ key: 'index', title: '지수·변동성', items });
  } else {
    sections.push({ key: 'index', title: '지수·변동성', items: [], unavailable: '지수 데이터를 불러오지 못했습니다.' });
  }

  // 세션 상태
  sections.push({
    key: 'phase',
    title: '세션 상태',
    highlight: true,
    items: [{ label: '미국 시장', value: phase.label, note: 'America/New_York 기준' }],
  });

  // 주요 기술주
  const techRows = await Promise.allSettled(US_TECH.map((t) => MarketDataService.getQuoteRow(t)));
  const techItems: AnalysisItem[] = [];
  US_TECH.forEach((t, i) => {
    const r = techRows[i];
    if (r.status === 'fulfilled' && r.value) {
      techItems.push({
        label: `${r.value.name} (${t})`,
        value: `${fmtNum(r.value.price)} (${fmtPct(r.value.changePercent)})`,
        tone: toneOf(r.value.changePercent),
      });
    } else {
      techItems.push({ label: t, value: null, note: '시세 조회 실패' });
    }
  });
  sections.push({ key: 'tech', title: '주요 기술주', items: techItems });

  // 10년물 국채 + 달러인덱스
  const [tnx, dxy] = await Promise.all([tryYahooQuote('^TNX'), tryYahooQuote('DX-Y.NYB')]);
  const macroItems: AnalysisItem[] = [];
  if (tnx) macroItems.push({ label: '미국채 10년물(^TNX)', value: `${fmtNum(tnx.price)}% (${fmtPct(tnx.changePercent)})`, tone: toneOf(tnx.changePercent) });
  else macroItems.push({ label: '미국채 10년물(^TNX)', value: null, note: '데이터 제공처 응답 없음' });
  if (dxy) macroItems.push({ label: '달러인덱스(DXY)', value: `${fmtNum(dxy.price)} (${fmtPct(dxy.changePercent)})`, tone: toneOf(dxy.changePercent) });
  else macroItems.push({ label: '달러인덱스(DXY)', value: null, note: '데이터 제공처 응답 없음' });
  sections.push({ key: 'rates', title: '금리·달러', items: macroItems });

  // 섹터별 등락 (섹터 ETF)
  const sectorRows = await Promise.allSettled(US_SECTOR_ETF.map((s) => tryYahooQuote(s.symbol)));
  const sectorItems: AnalysisItem[] = [];
  US_SECTOR_ETF.forEach((s, i) => {
    const r = sectorRows[i];
    const q = r.status === 'fulfilled' ? r.value : null;
    if (q) sectorItems.push({ label: `${s.label} (${s.symbol})`, value: fmtPct(q.changePercent), tone: toneOf(q.changePercent) });
  });
  if (sectorItems.length) {
    sectorItems.sort((a, b) => (a.tone === 'up' ? -1 : 1));
    sections.push({ key: 'sector', title: '섹터별 등락(ETF)', items: sectorItems });
  } else {
    sections.push({ key: 'sector', title: '섹터별 등락(ETF)', items: [], unavailable: '섹터 ETF 시세를 불러오지 못했습니다.' });
  }

  // 경제지표 일정
  sections.push({
    key: 'calendar',
    title: '경제지표 일정',
    items: [],
    unavailable: '데이터 제공처 없음(경제지표 일정 미제공)',
  });

  return { ok: true, market: 'us', dataAsOf, sections };
}

interface CoinGeckoGlobal {
  data?: {
    total_market_cap?: { usd?: number };
    market_cap_percentage?: { btc?: number };
    market_cap_change_percentage_24h_usd?: number;
  };
}

interface FngResponse {
  data?: Array<{ value?: string; value_classification?: string }>;
}

async function buildCoin(): Promise<MarketAnalysisResult> {
  const now = new Date();
  const dataAsOf = now.toISOString();
  const sections: AnalysisSection[] = [];

  const [upbitR, globalR, fngR, bitgetR] = await Promise.allSettled([
    fetchAllUpbitTickers(),
    fetchPublicJson<CoinGeckoGlobal>('https://api.coingecko.com/api/v3/global'),
    fetchPublicJson<FngResponse>('https://api.alternative.me/fng/'),
    fetchBitgetTickers(),
  ]);

  // BTC/ETH 시세 (업비트)
  const priceItems: AnalysisItem[] = [];
  if (upbitR.status === 'fulfilled') {
    for (const sym of ['BTC', 'ETH']) {
      const t = upbitR.value.find((x) => x.symbol === sym);
      if (t && t.price != null) {
        priceItems.push({
          label: sym === 'BTC' ? '비트코인(BTC)' : '이더리움(ETH)',
          value: `${fmtNum(t.price, 0)}원 (${fmtPct(t.changePercent)})`,
          tone: toneOf(t.changePercent),
        });
      }
    }
  }
  if (priceItems.length) sections.push({ key: 'price', title: '주요 코인 시세(업비트)', items: priceItems });
  else sections.push({ key: 'price', title: '주요 코인 시세', items: [], unavailable: '업비트 시세를 불러오지 못했습니다.' });

  // 전체 시총 · BTC 도미넌스
  if (globalR.status === 'fulfilled' && globalR.value.data) {
    const g = globalR.value.data;
    const items: AnalysisItem[] = [];
    if (g.total_market_cap?.usd != null) {
      items.push({
        label: '전체 시총',
        value: `$${fmtNum(g.total_market_cap.usd / 1e12, 2)}조 (${fmtPct(g.market_cap_change_percentage_24h_usd)})`,
        tone: toneOf(g.market_cap_change_percentage_24h_usd),
      });
    }
    if (g.market_cap_percentage?.btc != null) {
      items.push({ label: 'BTC 도미넌스', value: `${g.market_cap_percentage.btc.toFixed(1)}%` });
    }
    sections.push({ key: 'global', title: '시장 규모', items, unavailable: items.length ? undefined : '시총 데이터를 불러오지 못했습니다.' });
  } else {
    sections.push({ key: 'global', title: '시장 규모', items: [], unavailable: '시총·도미넌스 데이터를 불러오지 못했습니다.' });
  }

  // 상승/하락 코인 수
  if (upbitR.status === 'fulfilled' && upbitR.value.length) {
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const t of upbitR.value) {
      if (t.changePercent == null) continue;
      if (t.changePercent > 0) up += 1;
      else if (t.changePercent < 0) down += 1;
      else flat += 1;
    }
    const total = up + down + flat;
    sections.push({
      key: 'breadth',
      title: '상승·하락 코인 수(업비트 KRW)',
      items: [
        { label: '상승', value: `${up}개 (${total ? ((up / total) * 100).toFixed(0) : 0}%)`, tone: 'up' },
        { label: '하락', value: `${down}개 (${total ? ((down / total) * 100).toFixed(0) : 0}%)`, tone: 'down' },
        { label: '보합', value: `${flat}개`, tone: 'flat' },
      ],
    });
  } else {
    sections.push({ key: 'breadth', title: '상승·하락 코인 수', items: [], unavailable: '업비트 데이터를 불러오지 못했습니다.' });
  }

  // 펀딩비·미결제약정 (비트겟 BTC/ETH)
  if (bitgetR.status === 'fulfilled') {
    const items: AnalysisItem[] = [];
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      const t = bitgetR.value.find((x) => x.symbol === sym);
      if (t) {
        items.push({
          label: `${sym.replace('USDT', '')} 펀딩비`,
          value: t.fundingRatePercent != null ? `${t.fundingRatePercent.toFixed(4)}%` : null,
          tone: toneOf(t.fundingRatePercent),
          note: t.openInterest != null ? `미결제약정 ${fmtNum(t.openInterest, 0)}` : undefined,
        });
      }
    }
    sections.push({ key: 'futures', title: '선물 펀딩비·미결제약정(비트겟)', items, unavailable: items.length ? undefined : '비트겟 선물 데이터를 불러오지 못했습니다.' });
  } else {
    sections.push({ key: 'futures', title: '선물 펀딩비·미결제약정', items: [], unavailable: '비트겟 선물 데이터를 불러오지 못했습니다.' });
  }

  // 공포탐욕지수
  if (fngR.status === 'fulfilled' && fngR.value.data?.[0]?.value != null) {
    const d = fngR.value.data[0];
    sections.push({
      key: 'fng',
      title: '공포탐욕지수',
      highlight: true,
      items: [{ label: '오늘', value: `${d.value} (${d.value_classification ?? ''})` }],
    });
  } else {
    sections.push({ key: 'fng', title: '공포탐욕지수', items: [], unavailable: '공포탐욕지수를 불러오지 못했습니다.' });
  }

  // 롱숏비율·청산규모
  sections.push({
    key: 'liquidation',
    title: '롱숏비율·청산규모',
    items: [],
    unavailable: '데이터 제공처 없음(공개 롱숏비율·청산 집계 미제공)',
  });

  return { ok: true, market: 'coin', dataAsOf, sections };
}

export async function getMarketAnalysis(market: 'kr' | 'us' | 'coin'): Promise<MarketAnalysisResult> {
  return cached(`market-analysis:v1:${market}`, ANALYSIS_TTL, async () => {
    if (market === 'kr') return buildKr();
    if (market === 'us') return buildUs();
    return buildCoin();
  });
}
