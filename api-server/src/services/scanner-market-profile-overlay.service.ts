import type { Candle } from '../sample/types';
import { buildScannerIndicatorSnapshot } from './scanner-indicator-library.service';
import type { ScannerEvidence, ScannerSignalCard, ScannerSignalGrade } from './scanner-signal.types';
import type { ScannerStrategyMode } from './scanner-quant-strategy.service';

export type ScannerMarketProfile = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export interface ScannerMarketProfileInput {
  card: ScannerSignalCard;
  profile: ScannerMarketProfile;
  candles: Candle[];
  strategyMode: ScannerStrategyMode;
  fundingRate?: number | null;
  openInterest?: number | null;
}

const PROFILE_KEY = 'market-profile-v1';

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function demoteStrongGrade(grade: ScannerSignalGrade | undefined): ScannerSignalGrade | undefined {
  return grade === 'S' || grade === 'A' ? 'B' : grade;
}

function timestamp(value: Candle['time']): number | null {
  if (typeof value === 'number') {
    const normalized = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(normalized) ? normalized : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wallClock(value: Candle['time'], timeZone: string): { minuteOfDay: number; weekday: string } | null {
  const at = timestamp(value);
  if (at == null) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  const weekday = values.get('weekday') ?? '';
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { minuteOfDay: hour * 60 + minute, weekday };
}

function krSession(candle: Candle | undefined): 'regular' | 'outside' | 'unknown' {
  if (!candle) return 'unknown';
  const wall = wallClock(candle.time, 'Asia/Seoul');
  if (!wall) return 'unknown';
  if (wall.weekday === 'Sat' || wall.weekday === 'Sun') return 'outside';
  return wall.minuteOfDay >= 9 * 60 && wall.minuteOfDay < 15 * 60 + 30 ? 'regular' : 'outside';
}

function usSession(candle: Candle | undefined): 'premarket' | 'regular' | 'after-hours' | 'outside' | 'unknown' {
  if (!candle) return 'unknown';
  const wall = wallClock(candle.time, 'America/New_York');
  if (!wall) return 'unknown';
  if (wall.weekday === 'Sat' || wall.weekday === 'Sun') return 'outside';
  if (wall.minuteOfDay >= 4 * 60 && wall.minuteOfDay < 9 * 60 + 30) return 'premarket';
  if (wall.minuteOfDay >= 9 * 60 + 30 && wall.minuteOfDay < 16 * 60) return 'regular';
  if (wall.minuteOfDay >= 16 * 60 && wall.minuteOfDay < 20 * 60) return 'after-hours';
  return 'outside';
}

function discontinuityPercent(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const current = candles.at(-1)!;
  const previous = candles.at(-2)!;
  if (!(previous.close > 0)) return null;
  return Math.abs(current.open / previous.close - 1) * 100;
}

interface ProfileEvaluation {
  label: string;
  source: string;
  confirmed: boolean;
  hardBlocked: boolean;
  unverified: boolean;
  reasons: string[];
  warnings: string[];
}

function stockEvaluation(input: ScannerMarketProfileInput, market: 'KR' | 'US'): ProfileEvaluation {
  const { card, candles, strategyMode } = input;
  const indicator = buildScannerIndicatorSnapshot(candles);
  const quant = card.quantScore;
  const intraday = strategyMode === 'scalping';
  const liquidityFloor = market === 'KR' ? (intraday ? 62 : 52) : (intraday ? 68 : 56);
  const volumeFloor = intraday ? 58 : 48;
  const trendFloor = intraday ? 52 : 58;
  const momentumFloor = intraday ? 55 : 48;
  const volatilityFloor = intraday ? 52 : 42;
  const change = Math.abs(card.changePercent ?? 0);
  const gap = discontinuityPercent(candles);
  const session = market === 'KR' ? krSession(candles.at(-1)) : usSession(candles.at(-1));
  const sessionVerified = !intraday || session !== 'unknown';
  const regularSession = !intraday || session === 'regular';
  const relativeVolume = indicator.relativeVolume20;
  const relativeVolumePass = relativeVolume == null ? false : relativeVolume >= (intraday ? 1.05 : 0.8);
  const trendPass = quant != null && quant.trend >= trendFloor;
  const momentumPass = quant != null && quant.momentum >= momentumFloor;
  const liquidityPass = quant != null && quant.liquidity >= liquidityFloor;
  const volatilityPass = quant != null && quant.volatility >= volatilityFloor;
  const riskPass = card.riskScore != null && card.riskScore <= (market === 'KR' ? 48 : 45);
  const gapPass = gap == null || gap <= (market === 'KR' ? 5 : 7);
  const chasePass = change <= (market === 'KR' ? 15 : 18);
  const confirmations = [trendPass, momentumPass, liquidityPass, volatilityPass, relativeVolumePass, riskPass, gapPass]
    .filter(Boolean).length;
  const hardBlocked = (card.riskScore ?? 101) > 65
    || (quant != null && quant.liquidity < 30)
    || change > (market === 'KR' ? 25 : 30)
    || (gap != null && gap > (market === 'KR' ? 10 : 12))
    || (intraday && session === 'outside');
  // Premarket/after-hours remain visible for US research but cannot become strong
  // signals without an explicit spread/depth contract. Regular-session data is the
  // only US intraday profile allowed to preserve S/A eligibility in V1.
  const sessionStrongPass = market === 'KR' ? regularSession : !intraday || session === 'regular';
  const confirmed = !hardBlocked
    && confirmations >= (intraday ? 5 : 4)
    && liquidityPass
    && riskPass
    && sessionStrongPass;
  const unverified = quant == null || card.riskScore == null || !sessionVerified || (intraday && relativeVolume == null);

  const reasons = [
    `시장 ${market} · ${intraday ? '단타' : '스윙'} profile`,
    `추세 ${quant?.trend == null ? '미확인' : Math.round(quant.trend)} / 기준 ${trendFloor}`,
    `모멘텀 ${quant?.momentum == null ? '미확인' : Math.round(quant.momentum)} / 기준 ${momentumFloor}`,
    `유동성 ${quant?.liquidity == null ? '미확인' : Math.round(quant.liquidity)} / 기준 ${liquidityFloor}`,
    `변동성 적합도 ${quant?.volatility == null ? '미확인' : Math.round(quant.volatility)} / 기준 ${volatilityFloor}`,
    `상대거래량 ${relativeVolume == null ? '미확인' : `${relativeVolume.toFixed(2)}배`}`,
    `연속봉 갭 ${gap == null ? '미확인' : `${gap.toFixed(2)}%`}`,
    `등락 추격위험 ${change.toFixed(2)}%`,
    `세션 ${session}`,
    `확인항목 ${confirmations}/7`,
    '시장 profile은 기존 Quant 신호를 승격하지 않고 확인/강등만 합니다.',
  ];
  const warnings: string[] = [];
  if (market === 'US' && intraday && (session === 'premarket' || session === 'after-hours')) {
    warnings.push('미국 프리/애프터마켓은 V1에서 호가 깊이 검증이 없어 강한 신호로 승격하지 않습니다.');
  }
  if (!gapPass) warnings.push('갭/가격 불연속 위험이 시장별 허용 범위를 초과했습니다.');
  if (!chasePass) warnings.push('급등락 추격 위험이 시장별 허용 범위를 초과했습니다.');
  return {
    label: market === 'KR' ? '국내주식 시장최적화 확인' : '미국주식 시장최적화 확인',
    source: market === 'KR' ? 'kr-stock-market-profile-v1' : 'us-stock-market-profile-v1',
    confirmed: confirmed && chasePass,
    hardBlocked,
    unverified,
    reasons,
    warnings,
  };
}

function cryptoEvaluation(input: ScannerMarketProfileInput, futures: boolean): ProfileEvaluation {
  const { card, candles, strategyMode } = input;
  const indicator = buildScannerIndicatorSnapshot(candles);
  const quant = card.quantScore;
  const intraday = strategyMode === 'scalping';
  const spreadLimit = futures ? 0.25 : 0.35;
  const riskLimit = futures ? 45 : 50;
  const liquidityFloor = futures ? 65 : 58;
  const volatilityFloor = intraday ? 55 : 45;
  const relativeVolume = indicator.relativeVolume20;
  const spreadPass = card.spreadPercent != null && card.spreadPercent <= spreadLimit;
  const liquidityPass = quant != null && quant.liquidity >= liquidityFloor;
  const volatilityPass = quant != null && quant.volatility >= volatilityFloor;
  const riskPass = card.riskScore != null && card.riskScore <= riskLimit;
  const volumePass = relativeVolume != null && relativeVolume >= (intraday ? 1.0 : 0.75);
  const directionPass = futures ? card.direction !== 'NEUTRAL' : card.direction === 'LONG';
  const trendPass = quant != null && (card.direction === 'SHORT' ? quant.trend < 50 : quant.trend > 50);
  const momentumPass = quant != null && (card.direction === 'SHORT' ? quant.momentum < 50 : quant.momentum > 50);
  const funding = finite(input.fundingRate);
  const openInterest = finite(input.openInterest);
  const derivativesVerified = !futures || (funding != null && openInterest != null && openInterest > 0);
  const crowdedFunding = futures && funding != null && (
    (card.direction === 'LONG' && funding > 0.0008)
    || (card.direction === 'SHORT' && funding < -0.0008)
    || Math.abs(funding) > 0.0015
  );
  const confirmations = [spreadPass, liquidityPass, volatilityPass, riskPass, volumePass, directionPass, trendPass, momentumPass]
    .filter(Boolean).length;
  const hardBlocked = !directionPass
    || (card.riskScore ?? 101) > 65
    || (card.spreadPercent != null && card.spreadPercent > (futures ? 0.65 : 0.8))
    || Math.abs(card.changePercent ?? 0) > 30
    || crowdedFunding;
  const confirmed = !hardBlocked
    && confirmations >= (intraday ? 6 : 5)
    && spreadPass
    && liquidityPass
    && riskPass
    && derivativesVerified;
  const unverified = quant == null
    || card.spreadPercent == null
    || card.riskScore == null
    || relativeVolume == null
    || !derivativesVerified;
  const reasons = [
    `시장 ${futures ? '코인선물' : '코인현물'} · ${intraday ? '단타' : '스윙'} profile`,
    `방향 ${card.direction}${futures ? ' (LONG/SHORT)' : ' (현물 LONG only)'}`,
    `스프레드 ${card.spreadPercent == null ? '미확인' : `${card.spreadPercent.toFixed(3)}%`} / 기준 ${spreadLimit}%`,
    `유동성 ${quant?.liquidity == null ? '미확인' : Math.round(quant.liquidity)} / 기준 ${liquidityFloor}`,
    `변동성 적합도 ${quant?.volatility == null ? '미확인' : Math.round(quant.volatility)} / 기준 ${volatilityFloor}`,
    `상대거래량 ${relativeVolume == null ? '미확인' : `${relativeVolume.toFixed(2)}배`}`,
    `리스크 ${card.riskScore == null ? '미확인' : card.riskScore} / 기준 ${riskLimit}`,
    ...(futures ? [
      `펀딩비 ${funding == null ? '미확인' : `${(funding * 100).toFixed(4)}%`}`,
      `미결제약정 ${openInterest == null ? '미확인' : openInterest.toFixed(2)}`,
    ] : []),
    `확인항목 ${confirmations}/8`,
    '24시간 시장 profile은 세션 가정 없이 공개 시세·캔들·호가만 사용합니다.',
    '시장 profile은 기존 Quant 신호를 승격하지 않고 확인/강등만 합니다.',
  ];
  const warnings: string[] = [];
  if (!futures && card.direction === 'SHORT') warnings.push('코인 현물 SHORT는 금지됩니다.');
  if (crowdedFunding) warnings.push('펀딩 쏠림이 포지션 방향과 겹쳐 추격 위험이 큽니다.');
  if (futures && !derivativesVerified) warnings.push('펀딩비·미결제약정 확인 전에는 선물 강한 신호를 허용하지 않습니다.');
  if (futures) warnings.push('Shadow 승격에는 별도 사용자 레버리지·청산가 검증이 추가로 필요합니다.');
  return {
    label: futures ? '코인선물 시장최적화 확인' : '코인현물 시장최적화 확인',
    source: futures ? 'crypto-futures-market-profile-v1' : 'crypto-spot-market-profile-v1',
    confirmed,
    hardBlocked,
    unverified,
    reasons,
    warnings,
  };
}

function evaluate(input: ScannerMarketProfileInput): ProfileEvaluation {
  if (input.profile === 'KR_STOCK') return stockEvaluation(input, 'KR');
  if (input.profile === 'US_STOCK') return stockEvaluation(input, 'US');
  if (input.profile === 'CRYPTO_SPOT') return cryptoEvaluation(input, false);
  return cryptoEvaluation(input, true);
}

function evidenceLists(evidence: ScannerEvidence[]) {
  return {
    matched: [...new Set(evidence.filter((item) => item.status === 'matched').map((item) => item.label))],
    notMatched: [...new Set(evidence.filter((item) => item.status === 'not_matched').map((item) => item.label))],
    unverified: [...new Set(evidence.filter((item) => item.status === 'unverified').map((item) => item.label))],
  };
}

export function applyScannerMarketProfile(input: ScannerMarketProfileInput): ScannerSignalCard {
  const evaluation = evaluate(input);
  const profileEvidence: ScannerEvidence = {
    key: `${PROFILE_KEY}:${input.profile}`,
    label: evaluation.label,
    status: evaluation.unverified ? 'unverified' : evaluation.confirmed ? 'matched' : 'not_matched',
    source: evaluation.source,
    observedAt: input.card.observedAt,
    reasons: evaluation.reasons,
  };
  const evidence = [
    ...input.card.evidence.filter((item) => !item.key.startsWith(`${PROFILE_KEY}:`)),
    profileEvidence,
  ];
  const lists = evidenceLists(evidence);
  const keepStrong = input.card.strongSignalEligible && evaluation.confirmed && !evaluation.hardBlocked;
  const demote = !evaluation.confirmed || evaluation.hardBlocked || evaluation.unverified;
  const scoreCap = evaluation.hardBlocked ? 64 : demote ? 74 : 100;
  const score = Math.round(clamp(Math.min(input.card.score, scoreCap)));
  const warnings = [
    ...input.card.warnings,
    ...evaluation.warnings,
    ...(demote ? [`${evaluation.label}: 강한 신호 보존 조건 미충족`] : []),
    '시장별 최적화 V1은 수익률 최적값이 아니라 fail-closed 확인 게이트입니다.',
  ];

  return {
    ...input.card,
    score,
    strongSignalEligible: keepStrong,
    signalGrade: demote ? demoteStrongGrade(input.card.signalGrade) : input.card.signalGrade,
    signalState: demote && input.card.signalState !== 'INVALIDATED' ? 'CANDIDATE' : input.card.signalState,
    evidence,
    matched: lists.matched,
    notMatched: lists.notMatched,
    unverified: lists.unverified,
    dataSources: [...new Set([...input.card.dataSources, evaluation.source])],
    warnings: [...new Set(warnings)],
  };
}
