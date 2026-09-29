import { createHash } from 'node:crypto';
import { nullableNumber, emptySnapshot, type CanonicalAccountSnapshot, type CanonicalReadonlyOrder } from '../account-readonly.contract';
import { AccountReadonlyError } from '../account-readonly.errors';

export type KiwoomReadonlyCredentials = {
  appKey: string;
  appSecret: string;
};

type Row = Record<string, unknown>;
type KiwoomPage = { body: Row; contYn: string | null; nextKey: string | null };
type TokenRecord = { token: string; expiresAtMs: number };
type KiwoomApiId =
  | 'kt00001' | 'kt00018' | 'ka10075'
  | 'ka10170'
  | 'ust21050' | 'ust21070' | 'ust21110'
  | 'ust21150' | 'ust21180';
type KiwoomListKey = 'acnt_evlt_remn_indv_tot' | 'oso' | 'tdy_trde_diary' | 'result_list';

export type KiwoomJournalHistory = {
  domesticDaily: Array<{ date: string; rows: Row[] }>;
  usDaily: Array<{ date: string; rows: Row[] }>;
  usPeriodRows: number;
};

const KIWOOM_REAL_ORIGIN = 'https://api.kiwoom.com';
const KIWOOM_TOKEN_PATH = '/oauth2/token';
const KIWOOM_DOMESTIC_ACCOUNT_PATH = '/api/dostk/acnt';
const KIWOOM_US_ACCOUNT_PATH = '/api/us/acnt';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_READONLY_PAGES = 10;
const KIWOOM_NO_DATA_CODE = 20;
const KIWOOM_RATE_LIMIT_CODES = new Set([1700, 1701, 1702]);
const KIWOOM_AUTH_CODES = new Set([
  8001, 8002, 8003, 8005, 8006, 8009, 8010, 8011, 8012, 8015, 8016,
  8030, 8031, 8040, 8050, 8103,
]);

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown, code: string): Row[] {
  if (!Array.isArray(value) || !value.every(record)) throw new AccountReadonlyError(code);
  return value;
}

function normalizeReturnCode(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function embeddedReturnCode(value: unknown) {
  const match = /\[(\d{3,5}):|CODE=(\d{3,5})/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

function classifyPayloadFailure(payload: Row) {
  const topLevel = normalizeReturnCode(payload.return_code);
  if (topLevel === null) return new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
  const embedded = embeddedReturnCode(payload.return_msg);
  const effective = KIWOOM_RATE_LIMIT_CODES.has(topLevel) || KIWOOM_AUTH_CODES.has(topLevel)
    ? topLevel
    : embedded ?? topLevel;
  if (KIWOOM_RATE_LIMIT_CODES.has(effective)) return new AccountReadonlyError('RATE_LIMITED', true);
  if (KIWOOM_AUTH_CODES.has(effective)) return new AccountReadonlyError('KIWOOM_AUTH_OR_IP_REJECTED');
  return new AccountReadonlyError('KIWOOM_REQUEST_REJECTED');
}

function safeJson(response: Response, code: string) {
  return response.json().catch(() => {
    throw new AccountReadonlyError(code);
  });
}

function classifyHttpFailure(response: Response) {
  if (response.status === 401 || response.status === 403) {
    return new AccountReadonlyError('KIWOOM_AUTH_OR_IP_REJECTED');
  }
  if (response.status === 429) return new AccountReadonlyError('RATE_LIMITED', true);
  if (response.status >= 500) return new AccountReadonlyError('PROVIDER_UNAVAILABLE', true);
  return new AccountReadonlyError('KIWOOM_REQUEST_REJECTED');
}

function parseExpiresAt(value: unknown) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) {
    throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const timestamp = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  if (!Number.isFinite(timestamp)) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
  return timestamp;
}

function credentialFingerprint(credentials: KiwoomReadonlyCredentials) {
  return createHash('sha256')
    .update(credentials.appKey)
    .update('\0')
    .update(credentials.appSecret)
    .digest('hex');
}

function normalizeDomesticSymbol(value: unknown) {
  if (typeof value !== 'string') throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_INVALID');
  const raw = value.trim().toUpperCase();
  const symbol = /^A\d{6}$/.test(raw) ? raw.slice(1) : raw;
  if (!/^\d{6}$/.test(symbol)) throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_INVALID');
  return symbol;
}

function normalizeUsSymbol(value: unknown) {
  if (typeof value !== 'string') throw new AccountReadonlyError('KIWOOM_US_POSITION_IDENTITY_INVALID');
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) {
    throw new AccountReadonlyError('KIWOOM_US_POSITION_IDENTITY_INVALID');
  }
  return symbol;
}

function nonNegative(value: unknown, code: string) {
  const number = nullableNumber(value);
  if (number === null || number < 0) throw new AccountReadonlyError(code);
  return number;
}

function nonNegativeOrNull(value: unknown, code: string) {
  if (value == null || value === '') return null;
  return nonNegative(value, code);
}

function requiredText(value: unknown, code: string) {
  if (typeof value !== 'string' || !value.trim()) throw new AccountReadonlyError(code);
  return value.trim();
}

function absoluteNumberOrNull(value: unknown) {
  const number = nullableNumber(value);
  return number === null ? null : Math.abs(number);
}

function side(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (normalized === '1') return 'SELL';
  if (normalized === '2') return 'BUY';
  throw new AccountReadonlyError('KIWOOM_OPEN_ORDER_SIDE_INVALID');
}

export class KiwoomReadonlyProvider {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly tokenInflight = new Map<string, Promise<TokenRecord>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => Date.now(),
    private readonly onRequest: (() => void) | null = null,
  ) {}

  private async requestToken(credentials: KiwoomReadonlyCredentials, signal?: AbortSignal): Promise<TokenRecord> {
    this.onRequest?.();
    const response = await this.fetchImpl(new URL(KIWOOM_TOKEN_PATH, KIWOOM_REAL_ORIGIN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: credentials.appKey,
        secretkey: credentials.appSecret,
      }),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw classifyHttpFailure(response);
    const body = await safeJson(response, 'KIWOOM_TOKEN_RESPONSE_INVALID');
    if (!record(body)) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    const returnCode = normalizeReturnCode(body.return_code);
    if (returnCode === null) throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    if (returnCode !== 0) throw classifyPayloadFailure(body);
    if (typeof body.token !== 'string' || !body.token.trim()) {
      throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    }
    const recordValue = { token: body.token.trim(), expiresAtMs: parseExpiresAt(body.expires_dt) };
    if (recordValue.expiresAtMs <= this.now() + TOKEN_REFRESH_SKEW_MS) {
      throw new AccountReadonlyError('KIWOOM_TOKEN_RESPONSE_INVALID');
    }
    return recordValue;
  }

  private async token(credentials: KiwoomReadonlyCredentials, signal?: AbortSignal) {
    const key = credentialFingerprint(credentials);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAtMs > this.now() + TOKEN_REFRESH_SKEW_MS) return cached.token;

    const active = this.tokenInflight.get(key);
    if (active) return (await active).token;

    const pending = this.requestToken(credentials, signal);
    this.tokenInflight.set(key, pending);
    try {
      const issued = await pending;
      this.tokens.set(key, issued);
      return issued.token;
    } finally {
      this.tokenInflight.delete(key);
    }
  }

  private async page(
    token: string,
    apiId: KiwoomApiId,
    body: Readonly<Record<string, string>>,
    continuation: { contYn: string; nextKey: string } | null,
    signal?: AbortSignal,
  ): Promise<KiwoomPage> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': apiId,
    };
    if (continuation) {
      headers['cont-yn'] = continuation.contYn;
      headers['next-key'] = continuation.nextKey;
    }

    const accountPath = apiId.startsWith('ust') ? KIWOOM_US_ACCOUNT_PATH : KIWOOM_DOMESTIC_ACCOUNT_PATH;
    this.onRequest?.();
    const response = await this.fetchImpl(new URL(accountPath, KIWOOM_REAL_ORIGIN), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw classifyHttpFailure(response);
    const payload = await safeJson(response, 'KIWOOM_ACCOUNT_RESPONSE_INVALID');
    if (!record(payload)) throw new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
    const returnCode = normalizeReturnCode(payload.return_code);
    if (returnCode === null) throw new AccountReadonlyError('KIWOOM_ACCOUNT_RESPONSE_INVALID');
    if (returnCode !== 0 && returnCode !== KIWOOM_NO_DATA_CODE) throw classifyPayloadFailure(payload);
    const contYn = returnCode === KIWOOM_NO_DATA_CODE ? 'N' : response.headers.get('cont-yn');
    const nextKey = returnCode === KIWOOM_NO_DATA_CODE ? null : response.headers.get('next-key');
    return { body: payload, contYn, nextKey };
  }

  private async collect(
    token: string,
    apiId: Exclude<KiwoomApiId, 'kt00001'>,
    body: Readonly<Record<string, string>>,
    listKey: KiwoomListKey,
    signal?: AbortSignal,
  ) {
    const result: Row[] = [];
    let continuation: { contYn: string; nextKey: string } | null = null;
    let firstBody: Row | null = null;

    for (let pageIndex = 0; pageIndex < MAX_READONLY_PAGES; pageIndex += 1) {
      const page = await this.page(token, apiId, body, continuation, signal);
      firstBody ??= page.body;
      if (normalizeReturnCode(page.body.return_code) === KIWOOM_NO_DATA_CODE) {
        return { rows: result, firstBody };
      }
      result.push(...rows(page.body[listKey], 'KIWOOM_ACCOUNT_RESPONSE_INVALID'));
      if (page.contYn !== 'Y') return { rows: result, firstBody };
      if (!page.nextKey) throw new AccountReadonlyError('KIWOOM_CONTINUATION_INVALID');
      continuation = { contYn: 'Y', nextKey: page.nextKey };
    }
    throw new AccountReadonlyError('KIWOOM_CONTINUATION_LIMIT_REACHED');
  }

  async journalHistory(
    credentials: KiwoomReadonlyCredentials,
    input: {
      domesticDates: readonly string[];
      usStartDate: string;
      usEndDate: string;
    },
    signal?: AbortSignal,
  ): Promise<KiwoomJournalHistory> {
    const token = await this.token(credentials, signal);
    const domesticDaily: KiwoomJournalHistory['domesticDaily'] = [];

    for (const date of input.domesticDates) {
      const result = await this.collect(
        token,
        'ka10170',
        { ottks_tp: '2', ch_crd_tp: '1', base_dt: date },
        'tdy_trde_diary',
        signal,
      );
      domesticDaily.push({ date, rows: result.rows });
    }

    const period = await this.collect(
      token,
      'ust21180',
      {
        strt_dt: input.usStartDate,
        end_dt: input.usEndDate,
        slby_tp: '0',
        stex_tp: '',
        stk_cd: '',
        oppo_trde_tp: '%',
      },
      'result_list',
      signal,
    );

    const fillDates = [...new Set(period.rows
      .filter((row) => {
        const quantity = nonNegativeOrNull(row.cntr_qty, 'KIWOOM_US_HISTORY_FILL_QTY_INVALID');
        return quantity != null && quantity > 0;
      })
      .map((row) => requiredText(row.ord_dt, 'KIWOOM_US_HISTORY_DATE_INVALID'))
      .filter((date) => /^\d{8}$/.test(date)))]
      .sort();

    const usDaily: KiwoomJournalHistory['usDaily'] = [];
    for (const date of fillDates) {
      const result = await this.collect(
        token,
        'ust21150',
        {
          query_tp: '5',
          slby_tp: '0',
          ord_dt: date,
          stex_tp: '',
          stk_cd: '',
          oppo_trde_tp: '%',
          fr_ord_no: '',
        },
        'result_list',
        signal,
      );
      usDaily.push({ date, rows: result.rows });
    }

    return { domesticDaily, usDaily, usPeriodRows: period.rows.length };
  }

  async snapshot(
    credentials: KiwoomReadonlyCredentials,
    signal?: AbortSignal,
    now = new Date(),
  ): Promise<CanonicalAccountSnapshot> {
    const token = await this.token(credentials, signal);

    // Official read-only domestic account endpoints. No /api/dostk/ordr request
    // can be produced by this provider.
    const [deposit, holdings, open, usDeposit, usHoldings, usOpen] = await Promise.all([
      this.page(token, 'kt00001', { qry_tp: '3' }, null, signal),
      this.collect(token, 'kt00018', { qry_tp: '1', dmst_stex_tp: 'KRX' }, 'acnt_evlt_remn_indv_tot', signal),
      this.collect(token, 'ka10075', { all_stk_tp: '0', trde_tp: '0', stex_tp: '0' }, 'oso', signal),
      this.collect(token, 'ust21110', {}, 'result_list', signal),
      this.collect(token, 'ust21070', { stex_tp: '', stk_cd: '' }, 'result_list', signal),
      this.collect(token, 'ust21050', { ord_dt: '', slby_tp: '0', stex_tp: '', stk_cd: '' }, 'result_list', signal),
    ]);

    const positions = holdings.rows.map((row) => {
      const quantity = nonNegative(row.rmnd_qty, 'KIWOOM_POSITION_QUANTITY_INVALID');
      const availableQuantity = nonNegative(row.trde_able_qty, 'KIWOOM_POSITION_AVAILABLE_QUANTITY_INVALID');
      return {
        market: 'KR',
        symbol: normalizeDomesticSymbol(row.stk_cd),
        quantity,
        availableQuantity,
        averageEntryPrice: absoluteNumberOrNull(row.pur_pric),
        currentPrice: absoluteNumberOrNull(row.cur_prc),
        marketValue: absoluteNumberOrNull(row.evlt_amt),
        unrealizedPnl: nullableNumber(row.evltv_prft),
        unrealizedPnlPercent: nullableNumber(row.prft_rt),
        leverage: null,
        liquidationPrice: null,
        marginMode: null,
        side: null,
      };
    });
    if (new Set(positions.map((row) => row.symbol)).size !== positions.length) {
      throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_DUPLICATE');
    }

    const openOrders: CanonicalReadonlyOrder[] = open.rows.map((row) => {
      const quantity = nonNegative(row.ord_qty, 'KIWOOM_OPEN_ORDER_QUANTITY_INVALID');
      const remainingQuantity = nonNegative(row.oso_qty, 'KIWOOM_OPEN_ORDER_REMAINING_INVALID');
      if (remainingQuantity > quantity) throw new AccountReadonlyError('KIWOOM_OPEN_ORDER_REMAINING_EXCEEDS_QUANTITY');
      return {
        id: requiredText(row.ord_no, 'KIWOOM_OPEN_ORDER_IDENTITY_INVALID'),
        market: 'KR',
        symbol: normalizeDomesticSymbol(row.stk_cd),
        side: side(row.trde_tp),
        price: absoluteNumberOrNull(row.ord_pric),
        quantity,
        remainingQuantity,
        status: requiredText(row.ord_stt, 'KIWOOM_OPEN_ORDER_STATUS_INVALID'),
      };
    });
    if (new Set(openOrders.map((row) => row.id)).size !== openOrders.length) {
      throw new AccountReadonlyError('KIWOOM_OPEN_ORDER_IDENTITY_DUPLICATE');
    }

    const usPositions = usHoldings.rows.map((row) => ({
      market: 'US',
      symbol: normalizeUsSymbol(row.stk_cd),
      quantity: nonNegative(row.poss_qty, 'KIWOOM_US_POSITION_QUANTITY_INVALID'),
      availableQuantity: nonNegativeOrNull(row.sell_alowq, 'KIWOOM_US_POSITION_AVAILABLE_QUANTITY_INVALID'),
      averageEntryPrice: absoluteNumberOrNull(row.frgn_stk_book_uv),
      currentPrice: absoluteNumberOrNull(row.now_pric),
      marketValue: absoluteNumberOrNull(row.evlt_amt),
      unrealizedPnl: nullableNumber(row.pl_amt),
      unrealizedPnlPercent: nullableNumber(row.pl_rt),
      leverage: null,
      liquidationPrice: null,
      marginMode: null,
      side: null,
    }));
    if (new Set(usPositions.map((row) => row.symbol)).size !== usPositions.length) {
      throw new AccountReadonlyError('KIWOOM_US_POSITION_IDENTITY_DUPLICATE');
    }

    const usOpenOrders: CanonicalReadonlyOrder[] = usOpen.rows.map((row) => {
      const quantity = nonNegative(row.ord_qty, 'KIWOOM_US_OPEN_ORDER_QUANTITY_INVALID');
      const remainingQuantity = nonNegative(row.ord_remnq, 'KIWOOM_US_OPEN_ORDER_REMAINING_INVALID');
      if (remainingQuantity > quantity) throw new AccountReadonlyError('KIWOOM_US_OPEN_ORDER_REMAINING_EXCEEDS_QUANTITY');
      return {
        id: requiredText(row.ord_no, 'KIWOOM_US_OPEN_ORDER_IDENTITY_INVALID'),
        market: 'US',
        symbol: normalizeUsSymbol(row.stk_cd),
        side: side(row.slby_tp),
        price: absoluteNumberOrNull(row.ord_uv),
        quantity,
        remainingQuantity,
        status: requiredText(row.ord_stat, 'KIWOOM_US_OPEN_ORDER_STATUS_INVALID'),
      };
    });
    if (new Set(usOpenOrders.map((row) => row.id)).size !== usOpenOrders.length) {
      throw new AccountReadonlyError('KIWOOM_US_OPEN_ORDER_IDENTITY_DUPLICATE');
    }

    const depositCode = normalizeReturnCode(deposit.body.return_code);
    const hasDeposit = depositCode !== KIWOOM_NO_DATA_CODE;
    const cashTotal = hasDeposit ? nullableNumber(deposit.body.entr) : null;
    const withdrawalAvailable = hasDeposit
      ? nonNegativeOrNull(deposit.body.pymn_alow_amt, 'KIWOOM_WITHDRAWAL_AVAILABLE_INVALID')
      : null;
    const buyingPower = hasDeposit
      ? nonNegativeOrNull(deposit.body.ord_alow_amt, 'KIWOOM_BUYING_POWER_INVALID')
      : null;

    const foreignBalances = usDeposit.rows.map((row) => {
      const currency = requiredText(row.crnc_code, 'KIWOOM_US_BALANCE_CURRENCY_INVALID').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new AccountReadonlyError('KIWOOM_US_BALANCE_CURRENCY_INVALID');
      return {
        currency,
        available: nonNegativeOrNull(row.fc_pymn_alowa, 'KIWOOM_US_BALANCE_AVAILABLE_INVALID'),
        locked: null,
        total: nullableNumber(row.fc_entra),
        estimatedKrwValue: null,
      };
    });
    if (new Set(foreignBalances.map((row) => row.currency)).size !== foreignBalances.length) {
      throw new AccountReadonlyError('KIWOOM_US_BALANCE_CURRENCY_DUPLICATE');
    }
    const usd = foreignBalances.find((row) => row.currency === 'USD');
    const usdBuyingPowerRow = usDeposit.rows.find((row) => String(row.crnc_code ?? '').trim().toUpperCase() === 'USD');
    const usdBuyingPower = usdBuyingPowerRow
      ? nonNegativeOrNull(usdBuyingPowerRow.fc_ord_alowa, 'KIWOOM_US_BUYING_POWER_INVALID')
      : null;

    const accounts = [
      { market: 'KR' as const, accountRef: null, currency: 'KRW', buyingPower },
      ...(usd || usPositions.length || usOpenOrders.length
        ? [{ market: 'US' as const, accountRef: null, currency: 'USD', buyingPower: usdBuyingPower }]
        : []),
    ];
    const balances = [
      ...(hasDeposit ? [{
        currency: 'KRW',
        available: withdrawalAvailable,
        locked: null,
        total: cashTotal,
        estimatedKrwValue: cashTotal,
      }] : []),
      ...foreignBalances,
    ];
    const allPositions = [...positions, ...usPositions];
    if (new Set(allPositions.map((row) => `${row.market}:${row.symbol}`)).size !== allPositions.length) {
      throw new AccountReadonlyError('KIWOOM_POSITION_IDENTITY_DUPLICATE');
    }
    const allOpenOrders = [...openOrders, ...usOpenOrders];
    if (new Set(allOpenOrders.map((row) => `${row.market}:${row.id}`)).size !== allOpenOrders.length) {
      throw new AccountReadonlyError('KIWOOM_OPEN_ORDER_IDENTITY_DUPLICATE');
    }

    const checkedAt = now.toISOString();
    return {
      ...emptySnapshot('kiwoom', 'CONNECTED', checkedAt),
      connected: true,
      accounts,
      balances,
      positions: allPositions,
      openOrders: allOpenOrders,
      lastGoodAt: checkedAt,
    };
  }
}
