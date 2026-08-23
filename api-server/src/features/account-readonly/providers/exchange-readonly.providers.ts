import { prepareBitgetAccount, prepareBitgetPositions, prepareUpbitAccounts, type BitgetCredentials, type PreparedExchangeRequest, type UpbitCredentials } from '../../../services/trade-exchange-adapters.service';
import { emptySnapshot, nullableNumber, type CanonicalAccountSnapshot } from '../account-readonly.contract';

export type SignedReadonlyTransport = (request: PreparedExchangeRequest, signal?: AbortSignal) => Promise<unknown>;

export async function readUpbitSnapshot(credentials: UpbitCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const raw = await transport(prepareUpbitAccounts(credentials), signal);
  if (!Array.isArray(raw)) throw new Error('UPBIT_ACCOUNT_RESPONSE_INVALID');
  const balances = raw.map((r: any) => ({ currency: String(r.currency ?? ''), available: nullableNumber(r.balance), locked: nullableNumber(r.locked), total: nullableNumber(r.balance) === null || nullableNumber(r.locked) === null ? null : Number(r.balance) + Number(r.locked), estimatedKrwValue: null }));
  const positions = raw.filter((r: any) => nullableNumber(r.balance) !== null || nullableNumber(r.locked) !== null).map((r: any) => ({ market: 'UPBIT', symbol: String(r.currency ?? ''), quantity: nullableNumber(r.balance) === null || nullableNumber(r.locked) === null ? null : Number(r.balance) + Number(r.locked), availableQuantity: nullableNumber(r.balance), averageEntryPrice: nullableNumber(r.avg_buy_price), currentPrice: null, marketValue: null, unrealizedPnl: null, unrealizedPnlPercent: null, leverage: null, liquidationPrice: null, marginMode: null, side: null }));
  const checkedAt = now.toISOString(); return { ...emptySnapshot('upbit', 'CONNECTED', checkedAt), connected: true, balances, positions, lastGoodAt: checkedAt };
}

export async function readBitgetSnapshot(credentials: BitgetCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const [accountRaw, positionRaw] = await Promise.all([transport(prepareBitgetAccount(credentials), signal), transport(prepareBitgetPositions(credentials), signal)]);
  const data = (v: any) => Array.isArray(v?.data) ? v.data : [];
  const balances = data(accountRaw).map((r: any) => ({ currency: String(r.marginCoin ?? 'USDT'), available: nullableNumber(r.available), locked: nullableNumber(r.locked ?? r.occupied), total: nullableNumber(r.accountEquity), estimatedKrwValue: null }));
  const positions = data(positionRaw).map((r: any) => ({ market: 'BITGET', symbol: String(r.symbol ?? ''), quantity: nullableNumber(r.total), availableQuantity: nullableNumber(r.available), averageEntryPrice: nullableNumber(r.openPriceAvg), currentPrice: nullableNumber(r.markPrice), marketValue: null, unrealizedPnl: nullableNumber(r.unrealizedPL), unrealizedPnlPercent: null, leverage: nullableNumber(r.leverage), liquidationPrice: nullableNumber(r.liquidationPrice), marginMode: r.marginMode ? String(r.marginMode) : null, side: r.holdSide ? String(r.holdSide) : null }));
  const checkedAt = now.toISOString(); return { ...emptySnapshot('bitget', 'CONNECTED', checkedAt), connected: true, balances, positions, lastGoodAt: checkedAt };
}
