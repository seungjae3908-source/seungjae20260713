import { clamp, round } from "./contracts.js";

function addContribution(state, value, reason) {
  state.score += value;
  if (Math.abs(value) >= 4) state.reasons.push(reason);
}

export function evaluateRules(input, featureBundle) {
  const { market } = input;
  const { features, indicators } = featureBundle;
  const state = { score: 0, reasons: [], warnings: [] };

  addContribution(state, clamp(features.emaGap * 900, -18, 18),
    features.emaGap >= 0 ? "중기 이동평균 추세가 우상향입니다." : "중기 이동평균 추세가 우하향입니다.");
  addContribution(state, clamp(features.macdHistogramPct * 3500, -14, 14),
    features.macdHistogramPct >= 0 ? "MACD 모멘텀이 개선되고 있습니다." : "MACD 모멘텀이 약화되고 있습니다.");
  addContribution(state, clamp(features.return5 * 120, -10, 10),
    features.return5 >= 0 ? "최근 5개 봉 수익률이 양수입니다." : "최근 5개 봉 수익률이 음수입니다.");

  const volumeDirection = Math.sign(features.return1 || features.return5);
  addContribution(state, clamp((features.volumeRatio - 1) * 10 * volumeDirection, -10, 10),
    volumeDirection >= 0 ? "가격 상승에 거래량이 동반되고 있습니다." : "가격 하락에 거래량이 동반되고 있습니다.");

  if (indicators.rsi14 >= 75) {
    state.score -= 6;
    state.warnings.push("RSI 과열 구간으로 추격 진입 위험이 있습니다.");
  } else if (indicators.rsi14 <= 25) {
    state.score += 5;
    state.warnings.push("RSI 과매도 구간이지만 추가 하락 가능성도 확인해야 합니다.");
  }

  addContribution(state, clamp(features.sentimentScore * 10, -10, 10),
    features.sentimentScore >= 0 ? "뉴스·이벤트 점수가 긍정적입니다." : "뉴스·이벤트 점수가 부정적입니다.");
  addContribution(state, clamp(features.benchmarkReturn * 80, -8, 8),
    features.benchmarkReturn >= 0 ? "시장 기준자산 흐름이 우호적입니다." : "시장 기준자산 흐름이 비우호적입니다.");

  if (market === "KR_STOCK" || market === "US_STOCK") {
    addContribution(state, clamp((features.foreignNetRatio + features.institutionNetRatio) * 8, -12, 12),
      (features.foreignNetRatio + features.institutionNetRatio) >= 0
        ? "주요 수급 주체의 흐름이 긍정적입니다."
        : "주요 수급 주체의 흐름이 부정적입니다.");
  }

  if (market === "CRYPTO_FUTURES") {
    const trendSign = Math.sign(features.return5 || features.return1);
    addContribution(state, clamp(features.openInterestChange * trendSign * 18, -12, 12),
      trendSign >= 0 ? "가격과 미결제약정 흐름이 상승 추세를 지지합니다." : "가격과 미결제약정 흐름이 하락 압력을 지지합니다.");

    if (features.fundingRate >= 0.01) {
      state.score -= 7;
      state.warnings.push("펀딩비가 높아 롱 포지션 과열과 급청산 위험이 있습니다.");
    } else if (features.fundingRate <= -0.01) {
      state.score += 5;
      state.warnings.push("음의 펀딩비로 숏 쏠림과 숏 스퀴즈 가능성이 있습니다.");
    }

    if (Math.abs(features.longShortBias) >= 0.7) {
      state.warnings.push("롱·숏 포지션 편향이 커 반대 방향 변동성에 주의해야 합니다.");
    }
  }

  if (features.atrPct >= 0.05) {
    state.warnings.push("최근 변동성이 매우 높아 예상 범위가 크게 벌어질 수 있습니다.");
  }
  if (features.distanceToResistance <= features.atrPct) {
    state.warnings.push("현재가가 주요 저항 범위에 근접했습니다.");
  }
  if (features.distanceToSupport <= features.atrPct) {
    state.warnings.push("현재가가 주요 지지 범위에 근접했습니다.");
  }

  const score = round(clamp(state.score, -100, 100), 4);
  return Object.freeze({
    score,
    reasons: Object.freeze([...new Set(state.reasons)].slice(0, 8)),
    warnings: Object.freeze([...new Set(state.warnings)].slice(0, 8)),
  });
}

export function scoreToProbabilities(score) {
  const normalized = clamp(score / 35, -3, 3);
  const bullishLogit = normalized;
  const bearishLogit = -normalized;
  const neutralLogit = 0.65 - Math.abs(normalized) * 0.25;
  const maxLogit = Math.max(bullishLogit, bearishLogit, neutralLogit);
  const exps = [bullishLogit, neutralLogit, bearishLogit].map((value) => Math.exp(value - maxLogit));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    bullish: exps[0] / total,
    neutral: exps[1] / total,
    bearish: exps[2] / total,
  });
}
