import type { NewsData, NewsItem } from '../sample/types';

export type NewsTone = 'positive' | 'negative' | 'neutral';

const POS_EN = [
  'beat', 'beats', 'surge', 'rise', 'gain', 'growth',
  'upgrade', 'strong', 'record', 'profit', 'buy', 'jump', 'soar',
];
const NEG_EN = [
  'miss', 'fall', 'drop', 'loss', 'lawsuit', 'probe',
  'downgrade', 'weak', 'sell', 'offering', 'dilution', 'plunge', 'cut',
];
const POS_KO = [
  '상승', '급등', '호실적', '최대', '수주', '흑자', '성장', '돌파',
  '신고가', '상향', '매수', '개선', '호재', '강세', '기대',
];
const NEG_KO = [
  '하락', '급락', '적자', '감소', '하향', '손실', '우려', '약세',
  '매도', '유상증자', '횡령', '악재', '부진', '리스크', '경고',
];

export function toneFromNewsText(text: string, kr: boolean): NewsTone {
  const lower = text.toLowerCase();
  const positiveMatches = (kr ? POS_KO : POS_EN)
    .filter((word) => lower.includes(word.toLowerCase())).length;
  const negativeMatches = (kr ? NEG_KO : NEG_EN)
    .filter((word) => lower.includes(word.toLowerCase())).length;

  if (positiveMatches === negativeMatches) return 'neutral';
  return positiveMatches > negativeMatches ? 'positive' : 'negative';
}

export function summarizeNewsSentiment(items: NewsItem[]): NewsData {
  const positive = items.filter((item) => item.tone === 'positive');
  const negative = items.filter((item) => item.tone === 'negative');
  const total = items.length;

  return {
    positive,
    negative,
    news: items,
    sentimentScore: total > 0
      ? Math.round(((positive.length - negative.length) / total) * 100)
      : 0,
  };
}
