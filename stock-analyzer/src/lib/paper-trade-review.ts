import type { PaperJournalEntry } from './paper-trading';

export type PaperTradeReview = Readonly<{
  outcome: 'PROFIT' | 'LOSS' | 'BREAKEVEN' | 'OPEN' | 'UNVERIFIED';
  exitExplanation: string;
  priceContribution: number | null;
  recordedCosts: number | null;
  netPnl: number | null;
  observedReasons: readonly string[];
  unknownFactors: readonly string[];
}>;

/**
 * Deterministic, evidence-first Manual Paper post-trade explanation.
 * No fabricated RVOL/CVD/news causes or unsupported claims that a profitable
 * target was the true reason for price movement. It never submits orders.
 */
export function explainManualPaperTrade(entry: PaperJournalEntry): PaperTradeReview {
  const labels: Record<string,string> = {
    take_profit:'설정한 익절 목표가에서 모의청산',
    stop_loss:'설정한 손절 조건으로 모의청산',
    liquidation:'추정 격리증거금 강제청산',
    manual_close:'사용자가 직접 모의청산',
    partial_close:'일부 수량 모의청산',
    market:'시장가 체결',limit:'지정가 체결',
    stop_trigger:'스탑 주문 조건 체결',
  };
  const unknownFactors = [
    'CVD·거래량·호가 불균형·뉴스가 수익/손실의 원인인지는 추가 당시 시점 데이터가 필요합니다.',
    '실제 시장 호가 체결·펀딩 등과 모의체결은 다를 수 있습니다.',
  ] as const;
  if (entry.status !== 'closed') {
    return {outcome:'OPEN',exitExplanation:'포지션이 종료되지 않았습니다.',
      priceContribution:null,recordedCosts:null,netPnl:null,
      observedReasons:[],unknownFactors};
  }
  const gross=entry.grossPnl;
  const net=entry.netPnl;
  const items=[entry.entryFee,entry.exitFee,entry.slippageCost,entry.fundingCost];
  if (![gross,net,...items].every(v=>typeof v === 'number' && Number.isFinite(v))
    // Signed funding can legitimately be a credit. Only commissions and
    // the slippage estimate are nonnegative charges.
    || items.slice(0,3).some(v=>v<0)) {
    return {outcome:'UNVERIFIED',exitExplanation:'손익 또는 비용 증거가 불완전합니다.',
      priceContribution:null,recordedCosts:null,netPnl:null,
      observedReasons:[],unknownFactors};
  }
  const cost=items.reduce((sum,v)=>sum+v,0);
  const outcome=net>0?'PROFIT':net<0?'LOSS':'BREAKEVEN';
  const facts=[labels[entry.exitReason??'']??'청산 유형 미확인'];
  if(gross>0)facts.push('진입·청산 기준 가격 변화가 포지션 방향에 유리했습니다.');
  else if(gross<0)facts.push('진입·청산 기준 가격 변화가 포지션 방향에 불리했습니다.');
  if(gross>0 && net<0)facts.push('가격 기준 이익보다 기록된 거래 비용·기타 조정이 커 순손실로 마감했습니다.');
  if(cost!==0)facts.push('기록 순비용: 진입·청산 수수료, 슬리피지 및 부호 있는 펀딩 정산 포함.');
  // Canonical/manual journal entries may include adjustments not reducible
  // to these four displayed components. Never silently attribute a mismatch.
  const balanced=Math.abs((gross-cost)-net)<=Math.max(0.02,Math.abs(net)*0.0001);
  if(!balanced)facts.push('총손익과 표시 비용 합계가 일치하지 않아 추가 정산 근거 확인이 필요합니다.');
  return Object.freeze({
    outcome,exitExplanation:labels[entry.exitReason??'']??'청산 사유 미확인',
    priceContribution:gross,recordedCosts:cost,netPnl:net,
    observedReasons:Object.freeze(facts),
    unknownFactors,
  });
}
