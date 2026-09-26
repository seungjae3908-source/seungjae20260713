import type {
  ScannerSignalCard,
  ScannerThemeSwingSummary,
} from './scanner-signal.types';

export interface ScannerThemeTag {
  key: string;
  label: string;
  source: 'CATALOG' | 'CURATED_CRYPTO';
}

type TaggedCard = {
  card: ScannerSignalCard;
  tags: readonly ScannerThemeTag[];
};

type ThemeSwingNewsDisclosure = {
  status?: string;
  eventCount?: number;
  analyzedCount?: number;
  officialRiskEvents?: string[];
  events?: Array<{
    freshness?: string;
    aiStatus?: string;
    catalystFlags?: string[];
  }>;
};

type ThemeSwingMarketIntelligence = {
  status?: string;
  scanner?: {
    intelligenceScore?: number | null;
    bullishScore?: number | null;
    bearishScore?: number | null;
  };
  autoTrading?: {
    mode?: string;
    hardBlockReason?: string | null;
  };
};

type ThemeSwingCryptoPublicEvent = {
  status?: string;
  marketWarning?: boolean | null;
  tradingStatus?: string | null;
  events?: Array<{ kind?: string }>;
  verifiedCoinNews?: { connected?: boolean };
};

type ThemeSwingCard = ScannerSignalCard & {
  newsDisclosureIntelligence?: ThemeSwingNewsDisclosure;
  marketIntelligence?: ThemeSwingMarketIntelligence;
  cryptoPublicEventContext?: ThemeSwingCryptoPublicEvent;
};

const VERSION = 'theme-swing-v1' as const;

const CRYPTO_THEME_MAP: ReadonlyArray<{
  key: string;
  label: string;
  symbols: readonly string[];
}> = Object.freeze([
  { key: 'crypto-l1', label: 'L1·메이저', symbols: ['BTC', 'ETH', 'SOL', 'ADA', 'AVAX', 'SUI', 'APT', 'TON', 'NEAR', 'SEI'] },
  { key: 'crypto-l2', label: 'L2·확장성', symbols: ['ARB', 'OP', 'STRK', 'ZK', 'MNT', 'IMX', 'METIS'] },
  { key: 'crypto-defi', label: 'DeFi', symbols: ['UNI', 'AAVE', 'MKR', 'CRV', 'LDO', 'SNX', 'COMP', '1INCH', 'JUP', 'ENA', 'PENDLE', 'DYDX'] },
  { key: 'crypto-ai-data', label: 'AI·데이터', symbols: ['FET', 'TAO', 'RNDR', 'RENDER', 'ARKM', 'GRT', 'WLD', 'AKT', 'IO'] },
  { key: 'crypto-meme', label: '밈', symbols: ['DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'BOME', 'BRETT'] },
  { key: 'crypto-rwa', label: 'RWA', symbols: ['ONDO', 'OM', 'CFG', 'POLYX', 'MPL'] },
  { key: 'crypto-gaming', label: '게임·메타버스', symbols: ['IMX', 'AXS', 'SAND', 'MANA', 'GALA', 'BEAM', 'RON'] },
  { key: 'crypto-oracle', label: '오라클·인프라', symbols: ['LINK', 'PYTH', 'API3', 'BAND'] },
  { key: 'crypto-exchange', label: '거래소', symbols: ['BNB', 'OKB', 'GT', 'CRO'] },
  { key: 'crypto-payments', label: '결제·송금', symbols: ['XRP', 'XLM', 'HBAR'] },
  { key: 'crypto-storage', label: '스토리지', symbols: ['FIL', 'AR', 'STORJ'] },
  { key: 'crypto-privacy', label: '프라이버시', symbols: ['XMR', 'ZEC'] },
]);

function clamp(value: number, minimum = 0, maximum = 100): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(value: number | null | undefined, values: readonly number[]): number {
  if (value == null || !Number.isFinite(value) || values.length === 0) return 0;
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  if (finite.length === 1) return 100;
  let belowOrEqual = 0;
  for (const item of finite) if (item <= value) belowOrEqual += 1;
  return clamp(((belowOrEqual - 1) / (finite.length - 1)) * 100);
}

function cryptoBaseSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  for (const suffix of ['USDT', 'USDC', 'KRW', 'USD'] as const) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

export function inferCryptoThemeTags(card: Pick<ScannerSignalCard, 'symbol' | 'assetClass'>): ScannerThemeTag[] {
  if (card.assetClass !== 'coin_spot' && card.assetClass !== 'coin_futures') return [];
  const symbol = cryptoBaseSymbol(card.symbol);
  return CRYPTO_THEME_MAP
    .filter((theme) => theme.symbols.includes(symbol))
    .map((theme) => ({ key: theme.key, label: theme.label, source: 'CURATED_CRYPTO' as const }));
}

function catalystScore(card: ScannerSignalCard): number {
  const enriched = card as ThemeSwingCard;
  const news = enriched.newsDisclosureIntelligence;
  if (news && (news.status === 'READY' || news.status === 'PARTIAL')) {
    const events = Array.isArray(news.events) ? news.events : [];
    const freshCatalysts = events.filter((event) =>
      (event.freshness === 'FRESH' || event.freshness === 'AGING')
      && Array.isArray(event.catalystFlags)
      && event.catalystFlags.length > 0,
    );
    if (freshCatalysts.some((event) => event.aiStatus === 'ANALYZED')) return 100;
    if (freshCatalysts.length > 0) return 85;
    if ((news.analyzedCount ?? 0) > 0) return 65;
    if ((news.eventCount ?? 0) > 0) return 55;
  }

  const marketIntelligence = enriched.marketIntelligence;
  if (marketIntelligence?.status === 'READY') {
    const directional = card.direction === 'SHORT'
      ? marketIntelligence.scanner?.bearishScore
      : marketIntelligence.scanner?.bullishScore;
    if (typeof directional === 'number' && Number.isFinite(directional)) return clamp(directional);
    const intelligenceScore = marketIntelligence.scanner?.intelligenceScore;
    if (typeof intelligenceScore === 'number' && Number.isFinite(intelligenceScore)) return clamp(intelligenceScore);
  }

  const cryptoPublic = enriched.cryptoPublicEventContext;
  if ((cryptoPublic?.status === 'READY' || cryptoPublic?.status === 'PARTIAL')
    && cryptoPublic.verifiedCoinNews?.connected === true) {
    return 55;
  }

  const matched = card.evidence.filter((item) => item.status === 'matched');
  const eventEvidence = matched.some((item) =>
    /news|filing|disclosure|공시|뉴스|event|catalyst/i.test(`${item.source} ${item.label} ${item.reasons.join(' ')}`),
  );
  if (eventEvidence) return 70;
  if (card.aiValidation?.status === 'PASS') return 60;
  if (matched.length >= 3) return 50;
  if (matched.length > 0) return 35;
  return 20;
}

function intelligenceRiskBlockers(card: ScannerSignalCard): string[] {
  const enriched = card as ThemeSwingCard;
  const blockers: string[] = [];
  if ((enriched.newsDisclosureIntelligence?.officialRiskEvents?.length ?? 0) > 0) {
    blockers.push('OFFICIAL_EVENT_RISK_BLOCK');
  }
  if (enriched.marketIntelligence?.autoTrading?.mode === 'BLOCKED_RISK') {
    blockers.push('MARKET_INTELLIGENCE_RISK_BLOCK');
  }
  const publicEvent = enriched.cryptoPublicEventContext;
  if (publicEvent?.marketWarning === true
    || publicEvent?.events?.some((event) => event.kind === 'EXCHANGE_WARNING' || event.kind === 'TRADING_STATUS')) {
    blockers.push('CRYPTO_PUBLIC_EVENT_RISK_BLOCK');
  }
  return blockers;
}

function triggerFor(card: ScannerSignalCard): ScannerThemeSwingSummary['trigger'] {
  const haystack = [...card.matched, ...card.evidence.flatMap((item) => [item.key, item.label, ...item.reasons])]
    .join(' ')
    .toLowerCase();
  if (/pullback|눌림|retest|리테스트/.test(haystack)) return 'PULLBACK';
  if (/breakout|돌파|new high|신고가/.test(haystack)) return 'BREAKOUT';
  const quant = card.quantScore;
  if (quant && quant.trend >= 68 && quant.marketRegime >= 62) return 'TREND_CONTINUATION';
  return 'UNCONFIRMED';
}

function selectPrimaryTheme(card: ScannerSignalCard, tags: readonly ScannerThemeTag[], groups: Map<string, TaggedCard[]>): ScannerThemeTag | null {
  if (tags.length === 0) return null;
  const scored = tags.map((tag) => {
    const members = groups.get(tag.key) ?? [];
    const breadth = members.length
      ? members.filter((item) => (item.card.changePercent ?? 0) > 0).length / members.length
      : 0;
    const scoreValues = members.map((item) => item.card.score);
    const rank = percentile(card.score, scoreValues);
    return { tag, value: breadth * 70 + rank * 0.3 };
  });
  scored.sort((a, b) => b.value - a.value || a.tag.key.localeCompare(b.tag.key));
  return scored[0]?.tag ?? null;
}

function summaryFor(card: ScannerSignalCard, tags: readonly ScannerThemeTag[], groups: Map<string, TaggedCard[]>): ScannerThemeSwingSummary {
  const primary = selectPrimaryTheme(card, tags, groups);
  if (!primary) {
    return {
      contract: 'ScannerThemeSwingV1',
      version: VERSION,
      state: 'UNCLASSIFIED',
      score: 0,
      themeKey: null,
      themeLabel: null,
      classificationSource: 'UNCLASSIFIED',
      memberCount: 0,
      positiveBreadthPercent: null,
      leaderRank: null,
      leader: false,
      trigger: 'UNCONFIRMED',
      breakdown: {
        themeMomentum: 0,
        leaderStrength: 0,
        trendStructure: 0,
        volumeParticipation: 0,
        catalystEvidence: 0,
        liquidityQuality: 0,
        riskQuality: 0,
      },
      reasons: [],
      blockers: ['THEME_UNCLASSIFIED'],
      executionAuthority: 'NONE',
      orderSubmitted: false,
      exchangeRequestSent: false,
    };
  }

  const members = groups.get(primary.key) ?? [];
  const changes = members.map((item) => item.card.changePercent ?? 0);
  const tradingValues = members.map((item) => item.card.tradingValue ?? 0);
  const scores = members.map((item) => item.card.score);
  const positiveCount = members.filter((item) => (item.card.changePercent ?? 0) > 0).length;
  const positiveBreadthPercent = members.length ? positiveCount / members.length * 100 : 0;
  const averageChange = mean(changes);

  const themeMomentumRaw = clamp(positiveBreadthPercent * 0.72 + clamp(50 + averageChange * 5) * 0.28);
  const scorePct = percentile(card.score, scores);
  const changePct = percentile(card.changePercent ?? 0, changes);
  const valuePct = percentile(card.tradingValue ?? 0, tradingValues);
  const leaderStrengthRaw = clamp(scorePct * 0.45 + changePct * 0.3 + valuePct * 0.25);

  const quant = card.quantScore;
  const trendStructureRaw = quant
    ? clamp(mean([quant.trend, quant.technical, quant.marketRegime]))
    : clamp(card.score);
  const volumeParticipationRaw = quant
    ? clamp(quant.volume * 0.6 + valuePct * 0.4)
    : clamp(valuePct);
  const catalystEvidenceRaw = catalystScore(card);
  const liquidityQualityRaw = quant
    ? clamp(quant.liquidity * 0.7 + valuePct * 0.3)
    : clamp(valuePct);

  const riskComplement = card.riskScore == null ? 35 : clamp(100 - card.riskScore);
  const dataQuality = card.dataQuality?.score ?? card.dataCompleteness;
  const rr = card.pricePlan.riskReward == null ? 35 : clamp(card.pricePlan.riskReward / 3 * 100);
  const riskQualityRaw = clamp(riskComplement * 0.45 + dataQuality * 0.35 + rr * 0.2);

  const breakdown = {
    themeMomentum: Math.round(themeMomentumRaw * 22 / 100),
    leaderStrength: Math.round(leaderStrengthRaw * 18 / 100),
    trendStructure: Math.round(trendStructureRaw * 16 / 100),
    volumeParticipation: Math.round(volumeParticipationRaw * 14 / 100),
    catalystEvidence: Math.round(catalystEvidenceRaw * 12 / 100),
    liquidityQuality: Math.round(liquidityQualityRaw * 10 / 100),
    riskQuality: Math.round(riskQualityRaw * 8 / 100),
  };
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const sortedMembers = [...members].sort((left, right) => (
    right.card.score - left.card.score
    || (right.card.changePercent ?? -Infinity) - (left.card.changePercent ?? -Infinity)
    || (right.card.tradingValue ?? -Infinity) - (left.card.tradingValue ?? -Infinity)
    || left.card.symbol.localeCompare(right.card.symbol)
  ));
  const leaderRank = Math.max(1, sortedMembers.findIndex((item) => item.card.signalId === card.signalId) + 1);
  const leader = leaderRank === 1;
  const trigger = triggerFor(card);

  const blockers: string[] = [];
  if (members.length < 2) blockers.push('THEME_BREADTH_SAMPLE_TOO_SMALL');
  if (positiveBreadthPercent < 50) blockers.push('THEME_BREADTH_WEAK');
  if (card.direction !== 'LONG') blockers.push('LONG_THEME_MOMENTUM_REQUIRED');
  if (score < 72) blockers.push('THEME_SWING_SCORE_BELOW_72');
  if ((card.riskScore ?? 101) > 55) blockers.push('RISK_SCORE_ABOVE_55');
  if (card.dataState !== 'complete' || card.dataQuality?.state === 'DATA_UNTRUSTED') blockers.push('DATA_NOT_TRUSTED_COMPLETE');
  if ((card.pricePlan.riskReward ?? 0) < 1.5) blockers.push('RISK_REWARD_BELOW_1_5');
  if (trigger === 'UNCONFIRMED') blockers.push('ENTRY_TRIGGER_UNCONFIRMED');
  blockers.push(...intelligenceRiskBlockers(card));

  const state: ScannerThemeSwingSummary['state'] = blockers.length === 0
    ? 'ELIGIBLE'
    : score >= 60 ? 'WATCH' : 'REJECT';

  const reasons = [
    `테마 확산 ${Math.round(positiveBreadthPercent)}%`,
    `테마 내 상대강도 ${Math.round(leaderStrengthRaw)}`,
    `추세구조 ${Math.round(trendStructureRaw)}`,
    `거래량·거래대금 ${Math.round(volumeParticipationRaw)}`,
    `촉매근거 ${Math.round(catalystEvidenceRaw)}`,
    leader ? '테마 리더 1위' : `테마 리더 순위 ${leaderRank}/${members.length}`,
    `진입트리거 ${trigger}`,
  ];

  return {
    contract: 'ScannerThemeSwingV1',
    version: VERSION,
    state,
    score,
    themeKey: primary.key,
    themeLabel: primary.label,
    classificationSource: primary.source,
    memberCount: members.length,
    positiveBreadthPercent: Math.round(positiveBreadthPercent),
    leaderRank,
    leader,
    trigger,
    breakdown,
    reasons,
    blockers,
    executionAuthority: 'NONE',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

export function applyThemeSwingOverlay(
  cards: readonly ScannerSignalCard[],
  themeTagsForCard: (card: ScannerSignalCard) => readonly ScannerThemeTag[],
  groupUniverse: readonly ScannerSignalCard[] = cards,
): ScannerSignalCard[] {
  const tagged: TaggedCard[] = groupUniverse
    .filter((card) => card.strategyMode === 'swing')
    .map((card) => ({ card, tags: themeTagsForCard(card) }));

  if (tagged.length === 0) return [...cards];

  const groups = new Map<string, TaggedCard[]>();
  for (const row of tagged) {
    for (const tag of row.tags) {
      const bucket = groups.get(tag.key) ?? [];
      bucket.push(row);
      groups.set(tag.key, bucket);
    }
  }

  return cards.map((card) => {
    if (card.strategyMode !== 'swing') return card;
    const tags = themeTagsForCard(card);
    const themeSwing = summaryFor(card, tags, groups);
    return { ...card, themeSwing };
  });
}
