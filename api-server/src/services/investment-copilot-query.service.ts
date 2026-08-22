import {
  executeInvestmentTool,
  type CopilotPortfolioSnapshot,
  type PortfolioShock,
} from './investment-copilot-tools.service.ts';

export type InvestmentCopilotIntent = 'PORTFOLIO_SUMMARY' | 'PORTFOLIO_RISK' | 'PORTFOLIO_WHAT_IF';

export class InvestmentCopilotQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'InvestmentCopilotQueryError';
  }
}

const prohibitedActionPattern = /(?:실제\s*주문|주문\s*(?:실행|전송|취소|정정)|자동매매\s*(?:시작|활성|실행)|포지션\s*(?:종료|청산)|레버리지\s*(?:변경|설정)|출금|송금|transfer\s+funds?|execute\s+(?:buy|sell)|\b(?:buy|sell|close)\s+(?:now|position)\b)/i;
const riskPattern = /(?:위험|리스크|집중|편중|몰려|가장\s*(?:큰|많은)|최대\s*보유|비중\s*(?:높|큰)|concentration|risk)/i;
const summaryPattern = /(?:포트폴리오|요약|총\s*자산|총자산|평가액|현금|손익|수익률|자산\s*현황|portfolio\s*summary)/i;
const negativeShockPattern = /(?:떨어|하락|내리|급락|빠지|감소|down|drop|fall)/i;
const positiveShockPattern = /(?:오르|상승|급등|증가|up|rise|gain)/i;
const shockPattern = /(?:떨어|하락|내리|급락|빠지|감소|오르|상승|급등|증가|변동|충격|what\s*if|scenario|shock)/i;

function cleanMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 1_000);
}

function tickerAliases(ticker: string): Set<string> {
  const normalized = ticker.trim().toUpperCase();
  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith('KRW-') && normalized.length > 4) aliases.add(normalized.slice(4));
  for (const suffix of ['USDT', 'USDC', 'USD'] as const) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length + 1) {
      aliases.add(normalized.slice(0, -suffix.length));
    }
  }
  return aliases;
}

function assetTokens(message: string, percentageText: string | null): string[] {
  const percentageNumber = percentageText?.replace(/[^0-9.]/g, '') ?? '';
  const matches = message.toUpperCase().match(/[A-Z0-9][A-Z0-9.-]{1,19}/g) ?? [];
  return [...new Set(matches.filter((token) => {
    if (token === percentageNumber) return false;
    if (/^\d{1,3}(?:\.\d+)?$/.test(token) && token.length !== 6) return false;
    return true;
  }))];
}

function resolveShockTicker(snapshot: CopilotPortfolioSnapshot, message: string, percentageText: string | null): string {
  const tokens = assetTokens(message, percentageText);
  const matches = snapshot.holdings.filter((holding) => {
    const aliases = tickerAliases(holding.ticker);
    return tokens.some((token) => aliases.has(token));
  });
  if (matches.length === 1) return matches[0].ticker.trim().toUpperCase();
  if (matches.length > 1) {
    throw new InvestmentCopilotQueryError('AMBIGUOUS_ASSET', '시나리오 대상 자산을 하나만 지정해 주세요.');
  }
  if (tokens.length === 1) return tokens[0];
  throw new InvestmentCopilotQueryError('ASSET_REQUIRED', '시나리오를 계산할 종목 또는 자산을 지정해 주세요.');
}

function parseShock(snapshot: CopilotPortfolioSnapshot, message: string): PortfolioShock {
  const percentageMatch = message.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!percentageMatch) {
    throw new InvestmentCopilotQueryError('PERCENT_REQUIRED', 'What-if 시나리오에는 변동률(%)이 필요합니다.');
  }
  const magnitude = Math.abs(Number(percentageMatch[1]));
  if (!Number.isFinite(magnitude) || magnitude > 100) {
    throw new InvestmentCopilotQueryError('INVALID_PERCENT', '시나리오 변동률은 -100%에서 100% 사이여야 합니다.');
  }
  const explicitlyNegative = Number(percentageMatch[1]) < 0;
  const negative = explicitlyNegative || negativeShockPattern.test(message);
  const positive = !explicitlyNegative && positiveShockPattern.test(message);
  if (!negative && !positive) {
    throw new InvestmentCopilotQueryError('DIRECTION_REQUIRED', '상승 또는 하락 방향을 명확히 지정해 주세요.');
  }
  if (negative && positive) {
    throw new InvestmentCopilotQueryError('AMBIGUOUS_DIRECTION', '상승과 하락 방향을 동시에 지정할 수 없습니다.');
  }
  const ticker = resolveShockTicker(snapshot, message, percentageMatch[0]);
  return { ticker, changePercent: negative ? -magnitude : magnitude };
}

export function queryInvestmentCopilot(snapshot: CopilotPortfolioSnapshot, rawMessage: unknown) {
  const message = cleanMessage(rawMessage);
  if (!message) throw new InvestmentCopilotQueryError('EMPTY_QUERY', '포트폴리오 질문을 입력해 주세요.');
  if (prohibitedActionPattern.test(message)) {
    throw new InvestmentCopilotQueryError(
      'ACTION_NOT_ALLOWED',
      '이 경로는 읽기 전용 분석과 순수 시뮬레이션만 지원합니다.',
      403,
    );
  }

  if (shockPattern.test(message) || /-?\d+(?:\.\d+)?\s*%/.test(message)) {
    const shock = parseShock(snapshot, message);
    const toolResult = executeInvestmentTool(snapshot, {
      tool: 'runPortfolioWhatIf',
      arguments: { shocks: [shock] },
    });
    return {
      mode: 'portfolio-copilot-tool' as const,
      intent: 'PORTFOLIO_WHAT_IF' as const,
      request: { tool: 'runPortfolioWhatIf' as const, arguments: { shocks: [shock] } },
      toolResult,
      assistantContext: {
        dataQuality: toolResult.status,
        asOf: toolResult.asOf,
        evidence: toolResult.evidence,
        warnings: toolResult.warnings,
        facts: toolResult.data,
      },
      safety: {
        ...toolResult.safety,
        externalAiCalled: false as const,
        orderSubmitted: false as const,
        privateTradingApiRequests: 0 as const,
      },
    };
  }

  if (riskPattern.test(message)) {
    const toolResult = executeInvestmentTool(snapshot, { tool: 'getPortfolioRisk' });
    return {
      mode: 'portfolio-copilot-tool' as const,
      intent: 'PORTFOLIO_RISK' as const,
      request: { tool: 'getPortfolioRisk' as const },
      toolResult,
      assistantContext: {
        dataQuality: toolResult.status,
        asOf: toolResult.asOf,
        evidence: toolResult.evidence,
        warnings: toolResult.warnings,
        facts: toolResult.data,
      },
      safety: {
        ...toolResult.safety,
        externalAiCalled: false as const,
        orderSubmitted: false as const,
        privateTradingApiRequests: 0 as const,
      },
    };
  }

  if (summaryPattern.test(message)) {
    const toolResult = executeInvestmentTool(snapshot, { tool: 'getPortfolioSummary' });
    return {
      mode: 'portfolio-copilot-tool' as const,
      intent: 'PORTFOLIO_SUMMARY' as const,
      request: { tool: 'getPortfolioSummary' as const },
      toolResult,
      assistantContext: {
        dataQuality: toolResult.status,
        asOf: toolResult.asOf,
        evidence: toolResult.evidence,
        warnings: toolResult.warnings,
        facts: toolResult.data,
      },
      safety: {
        ...toolResult.safety,
        externalAiCalled: false as const,
        orderSubmitted: false as const,
        privateTradingApiRequests: 0 as const,
      },
    };
  }

  throw new InvestmentCopilotQueryError(
    'UNSUPPORTED_QUERY',
    '현재는 포트폴리오 요약, 위험/집중도, 단일 자산 What-if 질문만 지원합니다.',
    422,
  );
}
