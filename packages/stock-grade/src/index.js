// @workspace/stock-grade — shared stock classification logic

const LARGE_US_TICKERS = new Set([
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO', 'NFLX',
]);
const LARGE_KR_TICKERS = new Set([
  '005930', '000660', '005380', '035420', '035720',
  '373220', '207940', '068270', '051910', '006400',
]);

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').replace(/%/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function flattenText(input) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string') { parts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(push); return; }
    if (value && typeof value === 'object') { Object.values(value).forEach(push); }
  };
  push(input.name); push(input.reasons); push(input.risks);
  push(input.signals); push(input.news); push(input.disclosures); push(input.riskFactors);
  return parts.join(' ').toLowerCase();
}

function removeNegatedRiskText(text) {
  return text
    .replace(/상장폐지\s*(위험|리스크|가능성|우려)?\s*(없음|낮음|해당\s*없음|미해당|아님|없다|낮다)/g, '')
    .replace(/delisting\s*(risk|warning)?\s*(none|low|no|not applicable)/g, '')
    .replace(/no\s*delisting\s*risk/g, '')
    .replace(/희석\s*(위험|리스크|가능성|우려)?\s*(없음|낮음|해당\s*없음|미해당|아님|없다|낮다)/g, '')
    .replace(/atm\s*(없음|해당\s*없음|미해당)/g, '')
    .replace(/offering\s*(none|no)/g, '');
}

function getMarketCapGrade(marketCap, currency, ticker) {
  const t = String(ticker ?? '').toUpperCase();
  if (LARGE_US_TICKERS.has(t) || LARGE_KR_TICKERS.has(t)) return '초대형';
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return '시총확인필요';
  if (currency === 'USD') {
    if (marketCap >= 200_000_000_000) return '초대형';
    if (marketCap >= 10_000_000_000) return '대형';
    if (marketCap >= 2_000_000_000) return '중형';
    if (marketCap >= 300_000_000) return '소형';
    return '초소형';
  }
  if (marketCap >= 50_0000_0000_0000) return '초대형';
  if (marketCap >= 5_0000_0000_0000) return '대형';
  if (marketCap >= 1_0000_0000_0000) return '중형';
  if (marketCap >= 1000_0000_0000) return '소형';
  return '초소형';
}

function buildRiskCaption(label, delistingWarning, dilutionScore) {
  if (label === '잡주') {
    if (delistingWarning) return '⚠️ 상장폐지 위험 종목입니다.';
    if (dilutionScore >= 2) return '⚠️ 주식 희석 위험이 높습니다.';
    return '⚠️ 고위험 종목입니다. 투자에 주의하세요.';
  }
  if (label === '우량주') return '✅ 우량 종목입니다.';
  if (label === '저평가주') return '🔍 저평가 가능성이 있는 종목입니다.';
  return '📊 일반 종목입니다.';
}

export function classifyStock(input) {
  const ai = num(input.aiScore ?? input.score ?? input.rating?.score) ?? 50;
  const change = Math.abs(num(input.changePercent) ?? 0);
  const marketCap = num(input.marketCap);
  const per = num(input.per);
  const pbr = num(input.pbr);
  const roe = num(input.roe);
  const debtRatio = num(input.debtRatio);
  const equity = num(input.equity);

  const marketCapGrade = getMarketCapGrade(marketCap, input.currency, input.ticker);
  const protectedLargeCap = marketCapGrade === '초대형' || marketCapGrade === '대형';

  const allText = flattenText(input);
  const cleanedText = removeNegatedRiskText(allText);

  const delistingWarning = ['상장폐지', 'delisting', '관리종목', '거래정지'].some((k) => cleanedText.includes(k));
  const dilutionScore = ['유상증자', '전환사채', 'cb', 'bw', 'atm', 'offering', '희석'].filter((k) => cleanedText.includes(k)).length;
  const otherRiskScore = ['횡령', '배임', '검찰', '수사', '분식'].filter((k) => cleanedText.includes(k)).length;

  let score = ai;
  const reasons = [];

  if (delistingWarning && !protectedLargeCap) { score -= 30; reasons.push('상장폐지 위험 키워드가 확인됩니다.'); }
  if (dilutionScore >= 2 && !protectedLargeCap) { score -= Math.min(20, dilutionScore * 6); reasons.push('주식 희석 위험 키워드가 다수 확인됩니다.'); }
  else if (dilutionScore === 1 && !protectedLargeCap) { score -= 8; }
  if (debtRatio != null && debtRatio > 300 && !protectedLargeCap) { score -= 10; reasons.push(`부채비율이 ${debtRatio.toFixed(0)}%로 높습니다.`); }
  if (equity != null && equity <= 0) { score -= 15; reasons.push('자본잠식 상태입니다.'); }
  if (roe != null && roe >= 15 && !delistingWarning) { score += 5; }
  if (otherRiskScore > 0) { score -= protectedLargeCap ? Math.min(8, otherRiskScore * 3) : Math.min(18, 8 + otherRiskScore * 5); reasons.push('기타 고위험 키워드가 확인됩니다.'); }
  if (change >= 15) { score -= 8; reasons.push('단기 급등락 변동성이 큽니다.'); }

  const finalScore = clamp(score);
  const undervalued = (pbr != null && pbr > 0 && pbr <= 1.2) || (per != null && per > 0 && per <= 12);

  const trueJunk = !protectedLargeCap && (delistingWarning || (ai < 42 && marketCapGrade === '초소형') || dilutionScore >= 2 || otherRiskScore >= 2 || (equity != null && equity <= 0) || finalScore < 38);
  const bluechip = !trueJunk && protectedLargeCap && ai >= 52 && !delistingWarning && (debtRatio == null || debtRatio <= 280);

  let label, reason;
  if (trueJunk) { label = '잡주'; reason = reasons[0] ?? '시총, 재무, 공시 리스크 기준으로 고위험 종목에 가깝습니다.'; }
  else if (bluechip) { label = '우량주'; reason = '시총, 재무 안정성, 시장 대표성을 기준으로 우량주에 가깝습니다.'; }
  else if (undervalued && finalScore >= 45) {
    label = '저평가주';
    reason = pbr != null && pbr > 0 && pbr <= 1.2
      ? `PBR ${pbr.toFixed(2)}배 기준으로 저평가 가능성이 있습니다.`
      : `PER ${per?.toFixed(1)}배 기준으로 저평가 가능성이 있습니다.`;
  } else { label = '보통주'; reason = '시총, 재무, 차트, 공시 기준으로 우량/저평가/고위험에 강하게 치우치지 않습니다.'; }

  return {
    label,
    score: label === '잡주' ? Math.min(finalScore, 44) : label === '우량주' ? Math.max(finalScore, 70) : finalScore,
    reason,
    reasons: reasons.length ? reasons.slice(0, 6) : ['추가 재무·공시·차트 확인이 필요합니다.'],
    riskCaption: buildRiskCaption(label, delistingWarning, dilutionScore),
    marketCapGrade,
    delistingWarning,
  };
}

export function toStockGrade(classification) {
  return classification;
}

export function stockClassBadgeClass(label) {
  if (label === '우량주') return 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400';
  if (label === '보통주') return 'border-neutral-950 bg-neutral-950 text-white';
  if (label === '저평가주') return 'border-yellow-500/50 bg-yellow-400/20 text-yellow-700 dark:text-yellow-300';
  return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400';
}
