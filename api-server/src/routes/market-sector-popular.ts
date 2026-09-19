import type { Request, Response } from 'express';
import { SectorPopularService } from '../services/sector-popular.service';

type Market = 'KR' | 'US';

type SectorPopularProviderUnavailableCode =
  | 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE'
  | 'SECTOR_POPULAR_CLASSIFICATION_UNAVAILABLE';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function classifySectorPopularUnavailable(
  error: unknown,
): SectorPopularProviderUnavailableCode | null {
  const message = messageOf(error);
  if (message.startsWith('SECTOR_POPULAR_PROVIDER_EVIDENCE_UNAVAILABLE:')) {
    return 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE';
  }
  if (message.startsWith('SECTOR_POPULAR_CLASSIFICATION_EVIDENCE_UNAVAILABLE:')) {
    return 'SECTOR_POPULAR_CLASSIFICATION_UNAVAILABLE';
  }
  return null;
}

export function sectorPopularUnavailableBody(
  market: Market,
  errorCode: SectorPopularProviderUnavailableCode,
  updatedAt = new Date().toISOString(),
) {
  return {
    ok: false,
    available: false,
    partial: false,
    dataState: 'provider_error' as const,
    retryable: true,
    market,
    sortBasis: '거래대금 기준',
    sectors: [],
    updatedAt,
    error: errorCode,
    errorCode,
    message: errorCode === 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE'
      ? '섹터 인기종목 공개 공급자의 실데이터 응답을 확인하지 못했습니다.'
      : '실데이터를 섹터로 분류할 충분한 근거를 확인하지 못했습니다.',
  };
}

export function createSectorPopularHandler(
  service: Pick<typeof SectorPopularService, 'getSectorPopular'> = SectorPopularService,
) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const market: Market =
      String(req.query.market ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';

    try {
      const result = await service.getSectorPopular(market);
      return res.json(result);
    } catch (error) {
      const unavailable = classifySectorPopularUnavailable(error);
      if (unavailable) {
        return res.status(200).json(sectorPopularUnavailableBody(market, unavailable));
      }

      console.error('market sector-popular error:', error);
      return res.status(502).json({
        market,
        sortBasis: '거래대금 기준',
        sectors: [],
        error: 'SECTOR_POPULAR_PROVIDER_ERROR',
      });
    }
  };
}
