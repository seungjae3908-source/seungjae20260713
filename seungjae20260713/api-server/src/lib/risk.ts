// Builds the market-specific risk breakdown from real filing data:
//  - US  (SEC EDGAR filing history)
//  - KR  (DART disclosure history)
import type { FilingCounts } from '../providers/sec-edgar';
import type { DartRiskCounts } from '../providers/dart';

export type RiskTone = 'positive' | 'neutral' | 'negative';

export interface RiskItem {
  label: string;
  level: '낮음' | '보통' | '높음';
  tone: RiskTone;
  detail: string;
}

function level(count: number, medium: number, high: number): RiskItem['level'] {
  if (count >= high) return '높음';
  if (count >= medium) return '보통';
  return '낮음';
}

function tone(l: RiskItem['level']): RiskTone {
  return l === '높음' ? 'negative' : l === '보통' ? 'neutral' : 'positive';
}

// US risk items derived from SEC filing counts (last 12 months).
export function buildUsRisk(f: FilingCounts): RiskItem[] {
  const atm = level(f.offering, 1, 3);
  const offering = level(f.offering, 2, 4);
  const reverse = f.reverseSplit > 0 ? '높음' : ('낮음' as RiskItem['level']);
  const delist = f.delisting > 0 ? '높음' : ('낮음' as RiskItem['level']);
  const cashBurn = level(f.offering + f.eightK, 4, 8);

  return [
    {
      label: 'ATM 위험도',
      level: atm,
      tone: tone(atm),
      detail: `최근 12개월 증권신고서·설명서 ${f.offering}건 (지분 희석 가능성).`,
    },
    {
      label: '오퍼링 위험도',
      level: offering,
      tone: tone(offering),
      detail: `S-1/S-3/424B 등 자금조달 관련 공시 ${f.offering}건.`,
    },
    {
      label: '리버스 스플릿 위험도',
      level: reverse,
      tone: tone(reverse),
      detail:
        f.reverseSplit > 0
          ? '주식병합 관련 정황이 감지되었습니다.'
          : '주식병합 관련 정황은 없습니다.',
    },
    {
      label: '상장폐지 위험도',
      level: delist,
      tone: tone(delist),
      detail:
        f.delisting > 0
          ? '상장폐지(Form 25) 관련 공시가 있습니다.'
          : '상장폐지 관련 공시는 없습니다.',
    },
    {
      label: '현금 소진 위험도',
      level: cashBurn,
      tone: tone(cashBurn),
      detail: `최근 공시 활동(자금조달·중요사항) ${f.offering + f.eightK}건 기준.`,
    },
  ];
}

// KR risk items derived from DART disclosure counts (last 12 months).
export function buildKrRisk(c: DartRiskCounts): RiskItem[] {
  const rights = level(c.rightsOffering, 1, 2);
  const cb = level(c.cb, 1, 2);
  const bw = level(c.bw, 1, 2);
  const managed = c.managed > 0 ? '높음' : ('낮음' as RiskItem['level']);
  const delist = c.delisting > 0 ? '높음' : ('낮음' as RiskItem['level']);

  return [
    {
      label: '유상증자 위험도',
      level: rights,
      tone: tone(rights),
      detail: `최근 12개월 유상증자 공시 ${c.rightsOffering}건.`,
    },
    {
      label: 'CB 위험도',
      level: cb,
      tone: tone(cb),
      detail: `전환사채(CB) 관련 공시 ${c.cb}건.`,
    },
    {
      label: 'BW 위험도',
      level: bw,
      tone: tone(bw),
      detail: `신주인수권부사채(BW) 관련 공시 ${c.bw}건.`,
    },
    {
      label: '관리종목 위험도',
      level: managed,
      tone: tone(managed),
      detail:
        c.managed > 0
          ? '관리종목 관련 공시가 있습니다.'
          : '관리종목 관련 공시는 없습니다.',
    },
    {
      label: '상장폐지 위험도',
      level: delist,
      tone: tone(delist),
      detail:
        c.delisting > 0
          ? '상장폐지 관련 공시가 있습니다.'
          : '상장폐지 관련 공시는 없습니다.',
    },
  ];
}
