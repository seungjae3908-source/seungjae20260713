import { apiGet } from '@/lib/api';

export type DataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'disconnected'
  | 'error'
  | 'insufficient';

export type NormalizedCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  timeframe: string;
  symbol: string;
  market: 'crypto-futures';
  source: string;
  isClosed: boolean;
  isDelayed: boolean;
  updatedAt: string;
};

export type FuturesMarketSnapshot = {
  symbol: string;
  price: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  change24hPercent: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  spreadPercent: number | null;
  openInterest: number | null;
  previousOpenInterest: number | null;
  openInterestChangePercent: number | null;
  fundingRate: number | null;
  nextFundingAt: string | null;
  basis: number | null;
  basisPercent: number | null;
  source: string;
  status: DataStatus;
  isDelayed: boolean;
  updatedAt: string;
  warnings: string[];
};

export type FuturesMarketStatus = {
  ok: true;
  provider: 'bitget';
  market: 'crypto-futures';
  status: DataStatus;
  connection: DataStatus;
  publicDataOnly: true;
  orderCapability: false;
  symbolCount: number;
  updatedAt: string;
  warnings: string[];
};

type SnapshotResponse = {
  ok: true;
  data: FuturesMarketSnapshot;
};

export function getFuturesMarketStatus() {
  return apiGet<FuturesMarketStatus>('/crypto/futures/status');
}

export async function getFuturesMarketSnapshot(symbol: string) {
  const response = await apiGet<SnapshotResponse>(
    `/crypto/futures/${encodeURIComponent(symbol)}/snapshot`,
  );
  return response.data;
}
