import {
  Router,
  type IRouter,
} from 'express';

import {
  clearKiwoomTokenCache,
  getKiwoomDomesticOrderbook,
  getKiwoomRankings,
  getKiwoomStatus,
  getKiwoomToken,
  kiwoomRequest,
  type KiwoomMarket,
  type KiwoomRankingAssetFilter,
  type KiwoomRankingOptions,
  type KiwoomRankingType,
} from '../providers/kiwoom';
import { requireAdmin, requireMember } from '../middleware/auth';

const router: IRouter =
  Router();

function marketParam(
  value: unknown,
): KiwoomMarket {
  return String(value ?? '')
    .toUpperCase() === 'US'
    ? 'US'
    : 'KR';
}

function rankingTypeParam(
  value: unknown,
): KiwoomRankingType {
  const normalized = String(
    value ?? 'volume',
  );

  if (
    normalized === 'tradingValue' ||
    normalized.toLowerCase() === 'tradingvalue' ||
    normalized === 'value'
  ) {
    return 'tradingValue';
  }

  if (
    normalized === 'gainers'
  ) {
    return 'gainers';
  }

  if (
    normalized === 'losers'
  ) {
    return 'losers';
  }

  return 'volume';
}

function rankingAssetFilterParam(
  value: unknown,
): KiwoomRankingAssetFilter {
  const normalized = String(
    value ?? 'all',
  )
    .trim()
    .toLowerCase();

  if (
    normalized === 'stocks'
  ) {
    return 'stocks';
  }

  if (normalized === 'etp') {
    return 'etp';
  }

  return 'all';
}

function booleanParam(
  value: unknown,
  defaultValue = false,
): boolean {
  if (
    value == null ||
    value === ''
  ) {
    return defaultValue;
  }

  const normalized = String(
    value,
  )
    .trim()
    .toLowerCase();

  if (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'yes' ||
    normalized === 'on'
  ) {
    return true;
  }

  if (
    normalized === 'false' ||
    normalized === '0' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }

  return defaultValue;
}

function limitParam(
  value: unknown,
): number {
  const requestedLimit =
    Number(value ?? 30);

  if (
    !Number.isFinite(
      requestedLimit,
    )
  ) {
    return 30;
  }

  return Math.min(
    Math.max(
      Math.trunc(
        requestedLimit,
      ),
      1,
    ),
    100,
  );
}

async function requestPublicIp(): Promise<string> {
  const providers = [
    {
      url: 'https://api.ipify.org?format=json',
      parse: async (
        response: Response,
      ) => {
        const result =
          (await response.json()) as {
            ip?: string;
          };

        return (
          result.ip?.trim() ??
          ''
        );
      },
    },
    {
      url: 'https://checkip.amazonaws.com/',
      parse: async (
        response: Response,
      ) => {
        return (
          await response.text()
        ).trim();
      },
    },
  ];

  let lastError:
    Error | null = null;

  for (const provider of providers) {
    const controller =
      new AbortController();

    const timeout = setTimeout(
      () =>
        controller.abort(),
      10_000,
    );

    try {
      const response =
        await fetch(
          provider.url,
          {
            method: 'GET',
            headers: {
              Accept:
                'application/json,text/plain',
              'Cache-Control':
                'no-cache',
            },
            signal:
              controller.signal,
          },
        );

      if (!response.ok) {
        throw new Error(
          `외부 IP 확인 실패: HTTP ${response.status}`,
        );
      }

      const ip =
        await provider.parse(
          response,
        );

      if (!ip) {
        throw new Error(
          '외부 IP 확인 결과가 비어 있습니다.',
        );
      }

      return ip;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(
              '외부 IP 확인 실패',
            );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (
    lastError ??
    new Error(
      'Replit 외부 IP를 확인하지 못했습니다.',
    )
  );
}

router.get(
  '/egress-ip',
  requireMember,
  requireAdmin,
  async (_req, res) => {
    try {
      const egressIp =
        await requestPublicIp();

      return res.json({
        ok: true,
        provider:
          'server-egress-check',
        egressIp,
        message:
          '이 IP를 키움 REST API 계좌 App Key 관리 화면에 등록하세요.',
        warning:
          'Replit 재시작 또는 서버 환경 변경 후 IP가 바뀔 수 있습니다.',
        checkedAt:
          new Date().toISOString(),
      });
    } catch (error) {
      return res
        .status(502)
        .json({
          ok: false,
          error:
            error instanceof
            Error
              ? error.message
              : 'Replit 외부 IP 확인 실패',
        });
    }
  },
);

router.get(
  '/status',
  (_req, res) => {
    return res.json({
      ok: true,
      ...getKiwoomStatus(),
    });
  },
);

router.get(
  '/token-test',
  requireMember,
  requireAdmin,
  async (_req, res) => {
    try {
      const token =
        await getKiwoomToken();

      return res.json({
        ok: true,
        provider: 'kiwoom',
        message:
          '키움 접근토큰 발급 성공',
        tokenReceived:
          Boolean(token),
        tokenLength:
          token.length,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          provider: 'kiwoom',
          error:
            error instanceof
            Error
              ? error.message
              : '키움 토큰 발급 실패',
        });
    }
  },
);

router.get(
  '/test',
  requireMember,
  requireAdmin,
  async (_req, res) => {
    try {
      const data =
        await getKiwoomDomesticOrderbook(
          '005930',
        );

      return res.json({
        ok: true,
        provider: 'kiwoom',
        market: 'KR',
        ticker: '005930',
        name: '삼성전자',
        data,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          provider: 'kiwoom',
          error:
            error instanceof
            Error
              ? error.message
              : '키움 조회 실패',
        });
    }
  },
);

router.get(
  '/quote/:ticker',
  async (req, res) => {
    try {
      const ticker = String(
        req.params.ticker ??
          '',
      )
        .trim()
        .toUpperCase();

      const data =
        await getKiwoomDomesticOrderbook(
          ticker,
        );

      return res.json({
        ok: true,
        provider: 'kiwoom',
        market: 'KR',
        ticker,
        data,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          provider: 'kiwoom',
          ticker: String(
            req.params.ticker ??
              '',
          ),
          error:
            error instanceof
            Error
              ? error.message
              : '키움 종목 조회 실패',
        });
    }
  },
);

router.get(
  '/rankings',
  async (req, res) => {
    const market =
      marketParam(
        req.query.market,
      );

    const type =
      rankingTypeParam(
        req.query.type,
      );

    const limit =
      limitParam(
        req.query.limit,
      );

    const assetFilter =
      rankingAssetFilterParam(
        req.query.assetFilter,
      );

    const excludeHighRisk =
      booleanParam(
        req.query
          .excludeHighRisk,
      );

    const recommendationEligibleOnly =
      booleanParam(
        req.query
          .recommendationEligibleOnly,
      );

    const options:
      KiwoomRankingOptions = {
      assetFilter,
      excludeHighRisk,
      recommendationEligibleOnly,
    };

    try {
      const rows =
        await getKiwoomRankings(
          market,
          type,
          limit,
          options,
        );

      return res.json({
        ok: true,
        provider: 'kiwoom',
        market,
        type,
        limit,
        filters: {
          assetFilter,
          excludeHighRisk,
          recommendationEligibleOnly,
        },
        count: rows.length,
        rows,
        updatedAt:
          new Date().toISOString(),
      });
    } catch (error) {
      return res
        .status(502)
        .json({
          ok: false,
          provider: 'kiwoom',
          market,
          type,
          limit,
          filters: {
            assetFilter,
            excludeHighRisk,
            recommendationEligibleOnly,
          },
          count: 0,
          rows: [],
          error:
            error instanceof
            Error
              ? error.message
              : '키움 랭킹 조회 실패',
        });
    }
  },
);

router.get(
  '/raw-ranking',
  requireMember,
  requireAdmin,
  async (req, res) => {
    const market =
      marketParam(
        req.query.market,
      );

    const type =
      rankingTypeParam(
        req.query.type,
      );

    try {
      const request =
        market === 'KR'
          ? type === 'volume'
            ? {
                apiId:
                  'ka10030',
                path:
                  '/api/dostk/rkinfo',
                body: {
                  mrkt_tp:
                    '000',
                  sort_tp: '1',
                  mang_stk_incls:
                    '0',
                  crd_tp: '0',
                  trde_qty_tp:
                    '0',
                  pric_tp: '0',
                  trde_prica_tp:
                    '0',
                  mrkt_open_tp:
                    '0',
                  stex_tp: '1',
                },
              }
            : type ===
                'tradingValue'
              ? {
                  apiId:
                    'ka10032',
                  path:
                    '/api/dostk/rkinfo',
                  body: {
                    mrkt_tp:
                      '000',
                    mang_stk_incls:
                      '0',
                    stex_tp:
                      '1',
                  },
                }
              : {
                  apiId:
                    'ka10027',
                  path:
                    '/api/dostk/rkinfo',
                  body: {
                    mrkt_tp:
                      '000',
                    sort_tp:
                      type ===
                      'losers'
                        ? '3'
                        : '1',
                    trde_qty_cnd:
                      '0000',
                    stk_cnd:
                      '0',
                    crd_cnd:
                      '0',
                    updown_incls:
                      '1',
                    pric_cnd:
                      '0',
                    trde_prica_cnd:
                      '0',
                    stex_tp:
                      '1',
                  },
                }
          : {
              apiId:
                type ===
                'volume'
                  ? 'usa20512'
                  : type ===
                      'tradingValue'
                    ? 'usa20531'
                    : 'usa20881',

              path:
                '/api/us/rkinfo',

              body: {
                excd: '000',
                item_tp: '1',
                sort_tp:
                  type ===
                  'losers'
                    ? '2'
                    : '1',
              },
            };

      const result =
        await kiwoomRequest(
          request,
        );

      return res.json({
        ok: true,
        market,
        type,
        request,
        continuation: {
          contYn:
            result.contYn,
          nextKey:
            result.nextKey,
        },
        data: result.data,
      });
    } catch (error) {
      return res
        .status(502)
        .json({
          ok: false,
          market,
          type,
          error:
            error instanceof
            Error
              ? error.message
              : '키움 원문 조회 실패',
        });
    }
  },
);

router.post(
  '/token/refresh',
  requireMember,
  requireAdmin,
  async (_req, res) => {
    try {
      clearKiwoomTokenCache();

      const token =
        await getKiwoomToken();

      return res.json({
        ok: true,
        provider: 'kiwoom',
        message:
          '키움 접근토큰 갱신 성공',
        tokenReceived:
          Boolean(token),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          provider: 'kiwoom',
          error:
            error instanceof
            Error
              ? error.message
              : '키움 토큰 갱신 실패',
        });
    }
  },
);

export default router;