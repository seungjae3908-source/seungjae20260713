import type { UnifiedTradeCycle } from './unified-trade-journal.service';

export type VerifiedPaperTradeAttribution = Readonly<{
  mode: 'AUTOMATIC_PAPER_RESEARCH_ONLY';
  status: 'VERIFIED_NATIVE_PNL' | 'BLOCKED_EVIDENCE';
  outcome: 'PROFIT' | 'LOSS' | 'FLAT' | 'UNKNOWN';
  currency: 'KRW' | 'USD' | 'USDT';
  grossPriceEffect: number | null;
  fees: number | null;
  tax: number | null;
  netPnlNative: number | null;
  exitPriceProximity: 'NEAR_STOP_PRICE' | 'NEAR_TARGET_PRICE' | 'OTHER' | 'UNKNOWN';
  observedAtEntry: readonly string[];
  factualAttribution: readonly string[];
  unknownReasons: readonly string[];
  causalImpactProven: false;
  profitabilityProven: false;
  externalAiCalled: false;
}>;

const FRESH_PRETRADE_MAX_MS = 15 * 60_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const PREFIX: VerifiedPaperTradeAttribution['mode']='AUTOMATIC_PAPER_RESEARCH_ONLY';
const unknownReasons=Object.freeze([
  '신호가 실제 수익/손실의 원인인지 판단하려면 같은 시점의 주문흐름·체결·시장 대비 통제가 필요합니다.',
  '슬리피지, 펀딩, 매매 시점 환율의 별도 증거가 없다면 전체 KRW 순수익으로 단정할 수 없습니다.',
]);
function getExitPriceProximity(trade: UnifiedTradeCycle): VerifiedPaperTradeAttribution['exitPriceProximity'] {
  if (!finite(trade.exitPrice)) return 'UNKNOWN';
  if (finite(trade.stopLossPrice) && trade.stopLossPrice > 0
    && Math.abs(trade.exitPrice-trade.stopLossPrice)/trade.stopLossPrice < 0.001) return 'NEAR_STOP_PRICE';
  if (finite(trade.targetPrice) && trade.targetPrice > 0
    && Math.abs(trade.exitPrice-trade.targetPrice)/trade.targetPrice < 0.001) return 'NEAR_TARGET_PRICE';
  return 'OTHER';
}

/** Read-only facts about the Paper-only canonical trade, never AI causation.
 * All numeric PnL stays in original quoted currency until an independent
 * close-time FX+full-cost attested KRW ledger is available.
 */
export function explainAutomaticPaperTrade(trade: UnifiedTradeCycle): VerifiedPaperTradeAttribution {
  const closed=trade.source==='APP_PAPER' && trade.status==='CLOSED'
    && finite(Date.parse(trade.closedAt??''))
    && finite(trade.entryPrice) && trade.entryPrice>0
    && finite(trade.exitPrice) && trade.exitPrice>0
    && finite(trade.grossPnl) && finite(trade.netPnl)
    && finite(trade.fees) && trade.fees>=0
    && finite(trade.tax) && trade.tax>=0
    && trade.costEvidence.status==='READY';
  const outcome: VerifiedPaperTradeAttribution['outcome']=!closed?'UNKNOWN'
    :trade.netPnl!>0?'PROFIT':trade.netPnl!<0?'LOSS':'FLAT';
  const reasons: string[]=[];
  const observations: string[]=[];
  const signal=trade.technicalSnapshot;
  if (closed) {
    const entryTime=Date.parse(trade.openedAt),observedTime=Date.parse(signal.capturedAt??'');
    if (signal.contextSource==='PRE_TRADE_SNAPSHOT'
      && Number.isFinite(observedTime) && Number.isFinite(entryTime)
      && observedTime<=entryTime && entryTime-observedTime<=FRESH_PRETRADE_MAX_MS) {
      if (finite(signal.volumeRatio)) observations.push('진입 전 거래량 배수 관측 '+signal.volumeRatio.toFixed(2));
      if (finite(signal.rsi)) observations.push('진입 전 RSI 관측 '+signal.rsi.toFixed(1));
      if (finite(signal.macd) && finite(signal.macdSignal)) {
        observations.push('진입 전 MACD '+(signal.macd>signal.macdSignal?'상향':'비상향')+' 상태 관측');
      }
      if (signal.marketRegime) observations.push('진입 당시 기록된 시장 국면 분류 존재');
    }
    reasons.push(trade.grossPnl>0?'가격 변화가 포지션 방향에 유리했습니다.':
      trade.grossPnl<0?'가격 변화가 포지션 방향에 불리했습니다.':
      '가격 변화에 의한 총손익은 0이었습니다.');
    if (trade.fees!+trade.tax!>0) reasons.push('기록 수수료·세금이 가격 손익을 감소시켰습니다.');
    if (trade.grossPnl>0 && trade.netPnl!<0) {
      reasons.push('가격 기준 수익에도 검증된 순손익은 손실이었습니다.');
    }
    if (Math.abs(trade.grossPnl-trade.fees!-trade.tax!-trade.netPnl!)>
      Math.max(0.02,Math.abs(trade.netPnl!)*0.0001)) {
      reasons.push('가격 총손익과 기본 수수료·세금 외 추가 정산 차이가 있어 원인 단정이 불가합니다.');
    }
  }
  return Object.freeze({
    mode:PREFIX, status:closed?'VERIFIED_NATIVE_PNL' as const:'BLOCKED_EVIDENCE' as const,
    outcome,currency:trade.currency,
    grossPriceEffect:closed?trade.grossPnl:null,
    fees:closed?trade.fees:null,tax:closed?trade.tax:null,
    netPnlNative:closed?trade.netPnl:null,
    // Price proximity does not prove the order was *caused* by target/stop.
    exitPriceProximity:closed?getExitPriceProximity(trade):'UNKNOWN' as const,
    observedAtEntry:Object.freeze(observations),
    factualAttribution:Object.freeze(reasons),unknownReasons,
    causalImpactProven:false as const,profitabilityProven:false as const,
    externalAiCalled:false as const,
  });
}
