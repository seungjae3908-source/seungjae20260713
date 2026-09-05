import { prepareBitgetAccount, prepareBitgetPositions, prepareUpbitAccounts, type BitgetCredentials, type PreparedExchangeRequest, type UpbitCredentials } from '../../../services/trade-exchange-adapters.service';
import { emptySnapshot, nullableNumber, type CanonicalAccountSnapshot } from '../account-readonly.contract';

export type SignedReadonlyTransport = (request: PreparedExchangeRequest, signal?: AbortSignal) => Promise<unknown>;
type Row = Record<string, unknown>;

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown, code: string): Row[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error(code);
  return value;
}

function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim().toUpperCase();
}

function total(balance: number | null, locked: number | null) {
  if (balance === null || locked === null || balance < 0 || locked < 0) return null;
  const result = balance + locked;
  return Number.isFinite(result) ? result : null;
}

export async function readUpbitSnapshot(credentials: UpbitCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const raw = rows(await transport(prepareUpbitAccounts(credentials), signal), 'UPBIT_ACCOUNT_RESPONSE_INVALID');
  const balances = raw.map((row) => {
    const available = nullableNumber(row.balance);
    const locked = nullableNumber(row.locked);
    return { currency: identity(row.currency, 'UPBIT_ACCOUNT_IDENTITY_INVALID'), available, locked, total: total(available, locked), estimatedKrwValue: null };
  });
  if (new Set(balances.map((row) => row.currency)).size !== balances.length) throw new Error('UPBIT_ACCOUNT_IDENTITY_DUPLICATE');
  const positions = raw.map((row, index) => ({
    market: 'UPBIT', symbol: balances[index].currency, quantity: balances[index].total,
    availableQuantity: balances[index].available, averageEntryPrice: nullableNumber(row.avg_buy_price),
    currentPrice: null, marketValue: null, unrealizedPnl: null, unrealizedPnlPercent: null,
    leverage: null, liquidationPrice: null, marginMode: null, side: null,
  }));
  const checkedAt = now.toISOString();
  return { ...emptySnapshot('upbit', 'CONNECTED', checkedAt), connected: true, balances, positions, lastGoodAt: checkedAt };
}

export async function readBitgetSnapshot(credentials: BitgetCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const [accountRaw, positionRaw] = await Promise.all([transport(prepareBitgetAccount(credentials), signal), transport(prepareBitgetPositions(credentials), signal)]);
  const data = (value: unknown) => {
    if (!record(value) || value.code !== '00000') throw new Error('BITGET_ACCOUNT_RESPONSE_INVALID');
    return rows(value.data, 'BITGET_ACCOUNT_RESPONSE_INVALID');
  };
  const balances = data(accountRaw).map((row) => ({
    currency: identity(row.marginCoin, 'BITGET_ACCOUNT_IDENTITY_INVALID'),
    available: nullableNumber(row.available), locked: nullableNumber(row.locked ?? row.occupied),
    total: nullableNumber(row.accountEquity), estimatedKrwValue: null,
  }));
  if (new Set(balances.map((row) => row.currency)).size !== balances.length) throw new Error('BITGET_ACCOUNT_IDENTITY_DUPLICATE');
  const positions = data(positionRaw).map((row) => ({
    market: 'BITGET', symbol: identity(row.symbol, 'BITGET_POSITION_IDENTITY_INVALID'),
    quantity: nullableNumber(row.total), availableQuantity: nullableNumber(row.available),
    averageEntryPrice: nullableNumber(row.openPriceAvg), currentPrice: nullableNumber(row.markPrice),
    marketValue: null, unrealizedPnl: nullableNumber(row.unrealizedPL), unrealizedPnlPercent: null,
    leverage: nullableNumber(row.leverage), liquidationPrice: nullableNumber(row.liquidationPrice),
    marginMode: typeof row.marginMode === 'string' ? row.marginMode : null,
    side: typeof row.holdSide === 'string' ? row.holdSide : null,
  }));
  const checkedAt = now.toISOString();
  return { ...emptySnapshot('bitget', 'CONNECTED', checkedAt), connected: true, balances, positions, lastGoodAt: checkedAt };
}
