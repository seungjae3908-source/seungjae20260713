import {
  loadAutoTradeSettings as loadLegacyAutoTradeSettings,
  saveAutoTradeSettings as saveLegacyAutoTradeSettings,
  type AutoTradeCandidate,
  type AutoTradeExitSignal,
  type AutoTradeRunResult,
  type AutoTradeSettings,
} from './auto-trading-legacy';

export * from './auto-trading-legacy';

export const LEGACY_AUTO_TRADE_DISABLED_MESSAGE =
  '기존 검색기 실전 주문 경로는 안전을 위해 비활성화됐습니다. 승인형 주문 화면에서 Paper·모의 주문 계획을 확인해 주세요.';

function disabledSettings(settings: AutoTradeSettings): AutoTradeSettings {
  return {
    ...settings,
    enabled: false,
    liveTrading: false,
    executionKey: '',
  };
}

export function loadAutoTradeSettings(): AutoTradeSettings {
  return disabledSettings(loadLegacyAutoTradeSettings());
}

export function saveAutoTradeSettings(settings: AutoTradeSettings): AutoTradeSettings {
  return saveLegacyAutoTradeSettings(disabledSettings(settings));
}

export function getAutoTradeSignal(_ticker: string) {
  return null;
}

export async function executeAutoTradeCandidates(
  _candidates: AutoTradeCandidate[],
  _settings: AutoTradeSettings,
): Promise<AutoTradeRunResult> {
  return {
    ok: false,
    dryRun: true,
    message: LEGACY_AUTO_TRADE_DISABLED_MESSAGE,
    results: [],
  };
}

export async function monitorAutoTradePositions(
  _settings: AutoTradeSettings,
): Promise<AutoTradeRunResult & { activePositions?: number }> {
  return {
    ok: false,
    dryRun: true,
    message: LEGACY_AUTO_TRADE_DISABLED_MESSAGE,
    results: [],
    activePositions: 0,
  };
}

export async function closeAutoTradePosition(
  _settings: AutoTradeSettings,
  signal: AutoTradeExitSignal,
): Promise<{
  ok: boolean;
  message: string;
  ticker: string;
  market: AutoTradeExitSignal['market'];
}> {
  return {
    ok: false,
    message: LEGACY_AUTO_TRADE_DISABLED_MESSAGE,
    ticker: signal.ticker,
    market: signal.market,
  };
}
