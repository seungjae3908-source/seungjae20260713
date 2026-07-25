// Risk analysis sample generator. US and KR markets get their required risk
// dimensions, each with a 0-100 score, level and explanation.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { seeded, qualityScore, type Rng } from './rng';
import { getQuote } from './market';
import { getFinancials } from './financials';
import type { RiskAnalysis, RiskItem, RiskLevel } from './types';

function levelOf(score: number): RiskLevel {
  return score >= 66 ? 'HIGH' : score >= 34 ? 'MEDIUM' : 'LOW';
}

function levelKo(level: RiskLevel): string {
  return level === 'HIGH' ? '높음' : level === 'MEDIUM' ? '보통' : '낮음';
}

interface Dim {
  label: string;
  explain: (level: RiskLevel) => string;
}

const US_DIMS: Dim[] = [
  { label: 'ATM 위험', explain: (l) => `상시 지분매출(ATM) 프로그램으로 인한 희석 가능성이 ${levelKo(l)} 수준입니다.` },
  { label: '오퍼링 위험', explain: (l) => `추가 공모(오퍼링)를 통한 자금조달 가능성이 ${levelKo(l)}으로 평가됩니다.` },
  { label: '리버스 스플릿 위험', explain: (l) => `주가 유지를 위한 액면병합(리버스 스플릿) 위험이 ${levelKo(l)}입니다.` },
  { label: '상장폐지 위험', explain: (l) => `상장 유지 요건 미달로 인한 상장폐지 위험이 ${levelKo(l)}입니다.` },
  { label: '현금 소진 위험', explain: (l) => `보유 현금 대비 소진 속도를 고려한 유동성 위험이 ${levelKo(l)}입니다.` },
];

const KR_DIMS: Dim[] = [
  { label: '유상증자 위험', explain: (l) => `유상증자를 통한 지분 희석 가능성이 ${levelKo(l)} 수준입니다.` },
  { label: '전환사채(CB) 위험', explain: (l) => `전환사채(CB) 전환에 따른 오버행 위험이 ${levelKo(l)}입니다.` },
  { label: '신주인수권부사채(BW) 위험', explain: (l) => `BW 행사에 따른 희석 위험이 ${levelKo(l)}으로 평가됩니다.` },
  { label: '관리종목 위험', explain: (l) => `재무·감사 요건과 관련한 관리종목 지정 위험이 ${levelKo(l)}입니다.` },
  { label: '상장폐지 위험', explain: (l) => `상장 유지 요건을 고려한 상장폐지 위험이 ${levelKo(l)}입니다.` },
];

function score(rng: Rng, bias: number): number {
  // bias raises risk; result 0-100
  const base = rng() * 60; // 0-60
  return Math.max(0, Math.min(100, Math.round(base + bias)));
}

export function getRisk(ticker: string): RiskAnalysis | null {
  const entry = getCatalogEntry(ticker) as CatalogEntry | undefined;
  if (!entry) return null;
  const quote = getQuote(ticker);
  const fin = getFinancials(ticker);
  const q = qualityScore(entry.ticker);
  const rng = seeded(entry.ticker, 'risk');

  // Lower quality + low price => riskier. Cash-burn adds to liquidity risk.
  const qualityBias = (60 - q) * 0.5; // -20 .. +30
  const pennyBias = quote && quote.price < (entry.market === 'KR' ? 2000 : 5) ? 25 : 0;
  const burning = fin?.cashBurn.survivalQuarters !== null;

  const dims = entry.market === 'KR' ? KR_DIMS : US_DIMS;
  const items: RiskItem[] = dims.map((dim) => {
    let bias = qualityBias + pennyBias;
    if ((dim.label === '현금 소진 위험' || dim.label === '유상증자 위험') && burning) bias += 25;
    const s = score(rng, bias);
    const level = levelOf(s);
    return { label: dim.label, score: s, level, explanation: dim.explain(level) };
  });

  const overallScore = Math.round(items.reduce((a, b) => a + b.score, 0) / items.length);
  const overallLevel = levelOf(overallScore);
  const highs = items.filter((i) => i.level === 'HIGH').map((i) => i.label);
  const explanation =
    highs.length > 0
      ? `${highs.join(', ')} 항목에서 높은 위험이 감지되어 종합 위험도는 ${levelKo(overallLevel)}입니다.`
      : `주요 위험 항목이 관리 가능한 수준으로, 종합 위험도는 ${levelKo(overallLevel)}입니다.`;

  return { market: entry.market, items, overallScore, overallLevel, explanation };
}
