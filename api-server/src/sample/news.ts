// News sample generator: deterministic positive/negative headlines + a
// sentiment score. Each item carries a source, source domain (for logos), a
// published date and a URL. Since headlines are synthetic, the URL points at a
// live news search for the headline so the link opens a relevant real article.
// API-ready: a real NewsService can return the same shape with real article URLs.
import { getCatalogEntry, type Market } from '../data/catalog';
import { seeded, rangeInt, qualityScore, ANCHOR_MS, type Rng } from './rng';
import type { NewsData, NewsItem } from './types';

interface Source {
  name: string;
  domain: string;
}

const KR_SOURCES: Source[] = [
  { name: '한국경제', domain: 'hankyung.com' },
  { name: '매일경제', domain: 'mk.co.kr' },
  { name: '연합인포맥스', domain: 'einfomax.co.kr' },
  { name: '서울경제', domain: 'sedaily.com' },
  { name: '전자신문', domain: 'etnews.com' },
  { name: '이데일리', domain: 'edaily.co.kr' },
];

const US_SOURCES: Source[] = [
  { name: 'Bloomberg', domain: 'bloomberg.com' },
  { name: 'Reuters', domain: 'reuters.com' },
  { name: 'CNBC', domain: 'cnbc.com' },
  { name: 'MarketWatch', domain: 'marketwatch.com' },
  { name: 'The Wall Street Journal', domain: 'wsj.com' },
];

const POSITIVE = [
  '{n}, 시장 예상 상회하는 분기 실적 발표',
  '{n}, 신제품 출시로 매출 성장 기대감 확대',
  '증권가, {n} 목표주가 상향 조정',
  '{n}, 대규모 신규 수주 계약 체결',
  '{n}, 자사주 매입 결정으로 주주가치 제고',
  '외국인·기관, {n} 동반 순매수 지속',
  '{n}, 신규 시장 진출로 성장 동력 확보',
  '{n}, 영업이익률 개선세 뚜렷',
];

const NEGATIVE = [
  '{n}, 시장 기대 밑도는 실적에 투자심리 위축',
  '증권가, {n} 투자의견 하향',
  '{n}, 경쟁 심화에 따른 마진 압박 우려',
  '{n}, 대규모 유상증자 검토설에 주가 약세',
  '{n}, 원가 상승으로 수익성 부담 확대',
  '외국인, {n} 매도세 지속',
  '{n}, 규제 리스크 부각에 변동성 확대',
  '{n}, 부채비율 상승 우려 제기',
];

function recentDate(rng: Rng, i: number): string {
  const d = new Date(ANCHOR_MS);
  d.setUTCDate(d.getUTCDate() - (i + rangeInt(rng, 0, 2)));
  return d.toISOString().slice(0, 10);
}

function articleUrl(title: string, market: Market): string {
  const q = encodeURIComponent(title);
  return `https://search.naver.com/search.naver?where=news&sm=tab_jum&sort=1&query=${q}`;
}

export function getNews(ticker: string): NewsData | null {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;

  const rng = seeded(entry.ticker, 'news');
  const sources = entry.market === 'KR' ? KR_SOURCES : US_SOURCES;
  const q = qualityScore(entry.ticker);

  const posCount = Math.max(2, Math.round((q / 100) * 4) + rangeInt(rng, 1, 2));
  const negCount = Math.max(1, 5 - Math.round((q / 100) * 3));

  const pickUnique = (
    pool: string[],
    count: number,
    tone: 'positive' | 'negative',
  ): NewsItem[] => {
    const items: NewsItem[] = [];
    const avail = [...pool];

    for (let i = 0; i < count && avail.length > 0; i++) {
      const idx = Math.floor(rng() * avail.length);
      const tpl = avail.splice(idx, 1)[0];
      const title = tpl.replace('{n}', entry.name);
      const src = sources[Math.floor(rng() * sources.length)];

      items.push({
        title,
        source: src.name,
        sourceDomain: src.domain,
        date: recentDate(rng, i),
        url: articleUrl(title, entry.market),
        tone,
      });
    }

    return items;
  };

  const positive = pickUnique(POSITIVE, posCount, 'positive');
  const negative = pickUnique(NEGATIVE, negCount, 'negative');
  const total = positive.length + negative.length;
  const sentimentScore = Math.round(((positive.length - negative.length) / total) * 100);

  return { positive, negative, sentimentScore };
}