// Classifies real news / disclosures into 호재 (positive) and 악재 (negative).
import type { RawNews } from '../providers/finnhub';
import type { Disclosure } from '../providers/dart';

export interface NewsItem {
  title: string;
  source: string;
  time: string;
  url: string;
  tone: 'positive' | 'negative';
}

export interface ClassifiedNews {
  positive: NewsItem[];
  negative: NewsItem[];
}

const POS_EN = [
  'beat', 'beats', 'surge', 'jump', 'soar', 'upgrade', 'record', 'growth',
  'gain', 'gains', 'rally', 'profit', 'win', 'wins', 'boost', 'raise', 'raises',
  'outperform', 'strong', 'buy', 'bullish', 'top', 'expand', 'partnership',
];
const NEG_EN = [
  'miss', 'misses', 'plunge', 'fall', 'falls', 'drop', 'drops', 'downgrade',
  'loss', 'losses', 'decline', 'cut', 'cuts', 'lawsuit', 'probe', 'warning',
  'weak', 'sell', 'bearish', 'slump', 'recall', 'halt', 'lower', 'concern',
];

function scoreEn(text: string): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of POS_EN) if (t.includes(w)) s++;
  for (const w of NEG_EN) if (t.includes(w)) s--;
  return s;
}

function usTime(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function classifyUsNews(news: RawNews[]): ClassifiedNews {
  const positive: NewsItem[] = [];
  const negative: NewsItem[] = [];
  for (const n of news) {
    const s = scoreEn(`${n.headline} ${n.summary}`);
    const item: NewsItem = {
      title: n.headline,
      source: n.source,
      time: usTime(n.datetime),
      url: n.url,
      tone: s >= 0 ? 'positive' : 'negative',
    };
    (item.tone === 'positive' ? positive : negative).push(item);
  }
  return { positive: positive.slice(0, 8), negative: negative.slice(0, 8) };
}

const POS_KR = [
  '자기주식취득', '자기주식 취득', '자사주', '무상증자', '흑자전환', '현금배당',
  '주식배당', '단일판매', '공급계약', '신규시설투자', '최대주주변경', '자기주식소각',
];
const NEG_KR = [
  '유상증자', '전환사채', '신주인수권부사채', '감자', '상장폐지', '관리종목',
  '소송', '횡령', '배임', '적자', '불성실공시', '거래정지',
];

function krTime(ymd: string): string {
  if (ymd?.length !== 8) return ymd ?? '';
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

export function classifyKrDisclosures(list: Disclosure[]): ClassifiedNews {
  const positive: NewsItem[] = [];
  const negative: NewsItem[] = [];
  for (const d of list) {
    const name = d.reportName;
    const isNeg = NEG_KR.some((w) => name.includes(w));
    const isPos = POS_KR.some((w) => name.includes(w));
    if (!isNeg && !isPos) continue; // skip routine/neutral disclosures
    const item: NewsItem = {
      title: name.trim(),
      source: `DART · ${d.filer}`,
      time: krTime(d.date),
      url: '',
      tone: isNeg ? 'negative' : 'positive',
    };
    (item.tone === 'positive' ? positive : negative).push(item);
  }
  return { positive: positive.slice(0, 8), negative: negative.slice(0, 8) };
}
