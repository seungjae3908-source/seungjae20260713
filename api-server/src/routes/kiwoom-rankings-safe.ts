import {
  Router,
  type IRouter,
} from 'express';
import {
  getKiwoomRankings,
  isKiwoomConfigured,
  type KiwoomMarket,
  type KiwoomRankingAssetFilter,
  type KiwoomRankingOptions,
  type KiwoomRankingType,
} from '../providers/kiwoom';
import {
  getFallbackKiwoomRankingRows,
  type KiwoomFallbackRankingRow,
} from '../services/kiwoom-ranking-fallback.service';

interface KiwoomRankingsDependencies {
  isConfigured: () => boolean;
  getPrimaryRows: typeof getKiwoomRankings;
  getFallbackRows: (
    market: KiwoomMarket,
    type: KiwoomRankingType,
    limit: number,
    options: KiwoomRankingOptions,
  ) => Promise<KiwoomFallbackRankingRow[]>;
}

const defaultDependencies: KiwoomRankingsDependencies = {
  isConfigured: isKiwoomConfigured,
  getPrimaryRows: getKiwoomRankings,
  getFallbackRows: getFallbackKiwoomRankingRows,
};

function marketParam(value: unknown): KiwoomMarket {
  return String(value ?? '').toUpperCase() === 'US' ? 'US' : 'KR';
}

function rankingTypeParam(value: unknown): KiwoomRankingType {
  const normalized = String(value ?? 'volume').trim();
  if (
    normalized === 'tradingValue' ||
    normalized.toLowerCase() === 'tradingvalue' ||
    normalized === 'value'
  ) {
    return 'tradingValue';
  }
  if (normalized === 'gainers') return 'gainers';
  if (normalized === 'losers') return 'losers';
  return 'volume';
}

function rankingAssetFilterParam(value: unknown): KiwoomRankingAssetFilter {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  if (normalized === 'stocks') return 'stocks';
  if (normalized === 'etp') return 'etp';
  return 'all';
}

function booleanParam(value: unknown, defaultValue = false): boolean {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function limitParam(value: unknown): number {
  const requestedLimit = Number(value ?? 30);
  if (!Number.isFinite(requestedLimit)) return 30;
  return Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
}

export function createKiwoomRankingsSafeRouter(
  dependencies: KiwoomRankingsDependencies = defaultDependencies,
): IRouter {
  const router: IRouter = Router();

  router.get('/rankings', async (req, res) => {
    const market = marketParam(req.query.market);
    const type = rankingTypeParam(req.query.type);
    const limit = limitParam(req.query.limit);
    const assetFilter = rankingAssetFilterParam(req.query.assetFilter);
    const excludeHighRisk = booleanParam(req.query.excludeHighRisk);
    const recommendationEligibleOnly = booleanParam(
      req.query.recommendationEligibleOnly,
    );
    const options: KiwoomRankingOptions = {
      assetFilter,
      excludeHighRisk,
      recommendationEligibleOnly,
    };
    const filters = {
      assetFilter,
      excludeHighRisk,
      recommendationEligibleOnly,
    };
    const configured = dependencies.isConfigured();
    let providerErrorCode = configured
      ? 'KIWOOM_RANKING_PROVIDER_ERROR'
      : 'KIWOOM_NOT_CONFIGURED';

    if (configured) {
      try {
        const rows = await dependencies.getPrimaryRows(
          market,
          type,
          limit,
          options,
        );

        return res.json({
          ok: true,
          status: 'ready',
          available: true,
          partial: false,
          fallbackUsed: false,
          provider: 'kiwoom',
          market,
          type,
          limit,
          filters,
          count: rows.length,
          rows,
          missingData: [],
          updatedAt: new Date().toISOString(),
        });
      } catch {
        providerErrorCode = 'KIWOOM_RANKING_PROVIDER_ERROR';
      }
    }

    try {
      const rows = await dependencies.getFallbackRows(
        market,
        type,
        limit,
        options,
      );

      return res.status(200).json({
        ok: false,
        status: 'partial',
        available: false,
        partial: true,
        fallbackUsed: true,
        provider: 'kiwoom',
        fallbackProvider: 'live-market-providers',
        providerErrorCode,
        message:
          '키움 랭킹 공급자를 사용할 수 없어 실제 대체 시장데이터를 표시합니다.',
        market,
        type,
        limit,
        filters,
        count: rows.length,
        rows,
        missingData: ['kiwoom_rankings'],
        delayStatus: 'provider-dependent',
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return res.status(502).json({
        ok: false,
        status: 'provider_error',
        available: false,
        partial: false,
        fallbackUsed: false,
        provider: 'kiwoom',
        fallbackProvider: 'live-market-providers',
        providerErrorCode,
        error: 'RANKING_PROVIDERS_UNAVAILABLE',
        message:
          '키움 랭킹과 실제 대체 시장데이터 공급자를 모두 사용할 수 없습니다.',
        market,
        type,
        limit,
        filters,
        count: 0,
        rows: [],
        missingData: ['kiwoom_rankings', 'fallback_market_rankings'],
        updatedAt: new Date().toISOString(),
      });
    }
  });

  return router;
}

export default createKiwoomRankingsSafeRouter();
