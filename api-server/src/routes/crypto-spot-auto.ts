import { Router, type Request } from 'express';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const router = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const APPROVAL_TTL_MS = 10 * 60_000;

type SpotSide = 'BUY' | 'SELL';

type SpotOrderPlan = {
  kind: 'SPOT_ORDER';
  memberId: string;
  symbol: string;
  market: string;
  side: SpotSide;
  currentPrice: number;
  amountKRW: number | null;
  volume: number | null;
  availableKRW: number;
  availableAsset: number;
  estimatedVolume: number | null;
  estimatedAmountKRW: number | null;
  identifier: string;
  createdAt: string;
};

type ApprovalRecord = {
  token: string;
  memberId: string;
  plan: SpotOrderPlan;
  expiresAt: number;
  used: boolean;
};

const approvals = new Map<string, ApprovalRecord>();

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createUpbitToken(accessKey: string, secretKey: string, query = '') {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: Record<string, string> = {
    access_key: accessKey,
    nonce: randomUUID(),
  };

  if (query) {
    claims.query_hash = createHash('sha512').update(query).digest('hex');
    claims.query_hash_alg = 'SHA512';
  }

  const payload = base64Url(JSON.stringify(claims));
  const signature = base64Url(
    createHmac('sha256', secretKey)
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${signature}`;
}

function memberId(req: Request) {
  return String(
    (req as Request & { member?: { id?: string } }).member?.id ?? 'unknown',
  );
}

function normalizeExecutionKey(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/^['"`]|['"`]$/g, '');
}

function configuredExecutionKey() {
  return normalizeExecutionKey(
    process.env.CRYPTO_SPOT_AUTO_TRADE_KEY ??
      process.env.CRYPTO_AUTO_TRADE_KEY ??
      process.env.KIWOOM_AUTO_TRADE_KEY ??
      '',
  );
}

function constantTimeEqual(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function executionKeyValid(req: Request) {
  const configured = configuredExecutionKey();
  const supplied = normalizeExecutionKey(
    req.header('X-Crypto-Auto-Trade-Key') ??
      req.header('X-Auto-Trade-Key') ??
      '',
  );
  return Boolean(
    configured && supplied && constantTimeEqual(configured, supplied),
  );
}

function tradingEnabled() {
  return (
    String(process.env.CRYPTO_SPOT_AUTO_TRADE_ENABLED ?? '').toLowerCase() ===
      'true' &&
    String(process.env.UPBIT_AUTO_TRADE_ENABLED ?? '').toLowerCase() === 'true'
  );
}

function credentials() {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? '').trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? '').trim();
  if (!accessKey || !secretKey) {
    throw new Error('UPBIT_PRIVATE_KEYS_NOT_CONFIGURED');
  }
  return { accessKey, secretKey };
}

function safeSymbol(value: unknown) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function upbitRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const { accessKey, secretKey } = credentials();
  const query = new URLSearchParams(params).toString();
  const token = createUpbitToken(accessKey, secretKey, query);
  const url =
    method === 'GET' && query
      ? `${UPBIT_BASE}${path}?${query}`
      : `${UPBIT_BASE}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
      },
      body: method === 'POST' ? JSON.stringify(params) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message =
        payload?.error?.message ?? payload?.message ?? `HTTP_${response.status}`;
      throw new Error(String(message));
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function publicTicker(symbol: string) {
  const response = await fetch(
    `${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(`KRW-${symbol}`)}`,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'seungjae-investment-app/1.0',
      },
    },
  );
  if (!response.ok) throw new Error('UPBIT_TICKER_UNAVAILABLE');
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  const currentPrice = positiveNumber(rows[0]?.trade_price);
  if (currentPrice == null) throw new Error('UPBIT_PRICE_INVALID');
  return currentPrice;
}

function cleanupApprovals() {
  const now = Date.now();
  for (const [token, record] of approvals) {
    if (record.used || record.expiresAt <= now) approvals.delete(token);
  }
}

function issueApproval(plan: SpotOrderPlan) {
  cleanupApprovals();
  const token = randomBytes(32).toString('base64url');
  approvals.set(token, {
    token,
    memberId: plan.memberId,
    plan,
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    used: false,
  });
  return {
    approvalToken: token,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  };
}

function consumeApproval(req: Request) {
  cleanupApprovals();
  const token = String(req.body?.approvalToken ?? '').trim();
  const record = approvals.get(token);
  if (!record) throw new Error('승인 토큰이 없거나 만료됐습니다.');
  if (record.used) throw new Error('이미 사용된 승인 토큰입니다.');
  if (record.memberId !== memberId(req)) {
    throw new Error('다른 사용자의 승인 토큰입니다.');
  }
  record.used = true;
  approvals.delete(token);
  return record.plan;
}

router.get('/status', (_req, res) => {
  return res.json({
    ok: true,
    exchange: 'UPBIT',
    enabled: tradingEnabled(),
    credentialsConfigured: Boolean(
      process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY,
    ),
    executionKeyConfigured: Boolean(configuredExecutionKey()),
    approvalRequired: true,
    orderType: 'MARKET',
  });
});

router.post('/plan', async (req, res) => {
  if (!tradingEnabled()) {
    return res.status(503).json({
      ok: false,
      error: 'UPBIT_SPOT_REAL_TRADING_DISABLED',
      message:
        '코인 현물 실제 주문 환경변수가 꺼져 있습니다. 관리자 설정을 확인하세요.',
    });
  }
  if (!executionKeyValid(req)) {
    return res.status(403).json({
      ok: false,
      error: 'INVALID_EXECUTION_KEY',
      message: '자동매매 실행키가 일치하지 않습니다.',
    });
  }

  const symbol = safeSymbol(req.body?.symbol);
  const side = String(req.body?.side ?? '').toUpperCase() as SpotSide;
  const amountKRW = positiveNumber(req.body?.amountKRW);
  const volume = positiveNumber(req.body?.volume);
  if (!symbol || !['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({
      ok: false,
      message: '종목과 매수·매도 방향을 확인하세요.',
    });
  }

  try {
    const market = `KRW-${symbol}`;
    const [chance, currentPrice] = await Promise.all([
      upbitRequest<any>('GET', '/v1/orders/chance', { market }),
      publicTicker(symbol),
    ]);
    const availableKRW = Number(chance?.bid_account?.balance ?? 0);
    const availableAsset = Number(chance?.ask_account?.balance ?? 0);
    const maxKRW = Math.max(
      5_000,
      Number(process.env.UPBIT_AUTO_TRADE_MAX_KRW ?? 1_000_000),
    );

    if (side === 'BUY') {
      if (amountKRW == null || amountKRW < 5_000) {
        throw new Error('시장가 매수금액은 5,000원 이상 입력하세요.');
      }
      if (amountKRW > maxKRW) {
        throw new Error(
          `1회 주문 상한 ${maxKRW.toLocaleString('ko-KR')}원을 초과했습니다.`,
        );
      }
      if (amountKRW > availableKRW) {
        throw new Error('주문 가능 원화 잔액보다 매수금액이 큽니다.');
      }
    } else {
      if (volume == null) throw new Error('시장가 매도수량을 입력하세요.');
      if (volume > availableAsset) {
        throw new Error('주문 가능한 코인 수량보다 매도수량이 큽니다.');
      }
    }

    const plan: SpotOrderPlan = {
      kind: 'SPOT_ORDER',
      memberId: memberId(req),
      symbol,
      market,
      side,
      currentPrice,
      amountKRW: side === 'BUY' ? amountKRW : null,
      volume: side === 'SELL' ? volume : null,
      availableKRW,
      availableAsset,
      estimatedVolume:
        side === 'BUY' && amountKRW != null ? amountKRW / currentPrice : null,
      estimatedAmountKRW:
        side === 'SELL' && volume != null ? volume * currentPrice : null,
      identifier: `sj-spot-${Date.now()}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };

    return res.json({ ok: true, plan, ...issueApproval(plan) });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message:
        error instanceof Error ? error.message : '현물 주문계획 생성에 실패했습니다.',
    });
  }
});

router.post('/execute', async (req, res) => {
  if (!tradingEnabled()) {
    return res.status(503).json({
      ok: false,
      message: '코인 현물 실제 주문 기능이 꺼져 있습니다.',
    });
  }
  if (!executionKeyValid(req)) {
    return res.status(403).json({
      ok: false,
      message: '자동매매 실행키가 일치하지 않습니다.',
    });
  }

  try {
    const plan = consumeApproval(req);
    const params: Record<string, string> =
      plan.side === 'BUY'
        ? {
            market: plan.market,
            side: 'bid',
            ord_type: 'price',
            price: String(plan.amountKRW),
            identifier: plan.identifier,
          }
        : {
            market: plan.market,
            side: 'ask',
            ord_type: 'market',
            volume: String(plan.volume),
            identifier: plan.identifier,
          };

    const order = await upbitRequest<any>('POST', '/v1/orders', params);
    return res.status(201).json({
      ok: true,
      exchange: 'UPBIT',
      message: `${plan.symbol} 현물 ${plan.side === 'BUY' ? '매수' : '매도'} 주문을 전송했습니다.`,
      plan,
      order: {
        uuid: String(order?.uuid ?? ''),
        identifier: String(order?.identifier ?? plan.identifier),
        market: String(order?.market ?? plan.market),
        side: String(order?.side ?? ''),
        ordType: String(order?.ord_type ?? ''),
        state: String(order?.state ?? ''),
        price: order?.price ?? null,
        volume: order?.volume ?? null,
        createdAt: String(order?.created_at ?? new Date().toISOString()),
      },
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message:
        error instanceof Error ? error.message : '코인 현물 실제 주문에 실패했습니다.',
    });
  }
});

export default router;
