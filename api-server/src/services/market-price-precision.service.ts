import { isEtp, type AssetType } from '../data/asset-type';

const US_RULE_612_NEW_TICK_COMPLIANCE_AT = Date.UTC(2026, 10, 2);

export function krxPriceTick(price: number, assetType: AssetType): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (isEtp(assetType)) return 5;
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

export function usNmsPriceTick(price: number, asOfMs = Date.now()): number | null {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(asOfMs)) return null;
  // The SEC delayed the amended Rule 612 per-symbol $0.005 assignment until
  // the first business day of Nov. 2026. After that date this app needs the
  // listing exchange's current assignment instead of guessing a universal tick.
  if (asOfMs >= US_RULE_612_NEW_TICK_COMPLIANCE_AT) return null;
  return price >= 1 ? 0.01 : 0.0001;
}

export function bitgetContractPriceTick(pricePlace: unknown, priceEndStep: unknown): number | null {
  const places = Number(pricePlace);
  const endStep = Number(priceEndStep);
  if (!Number.isInteger(places) || places < 0 || places > 12) return null;
  if (!Number.isFinite(endStep) || endStep <= 0) return null;
  const tick = endStep * 10 ** -places;
  return Number.isFinite(tick) && tick > 0 ? tick : null;
}

export function roundPriceToTick(value: number, tick: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(tick) || tick <= 0) return null;
  const rounded = Math.round(value / tick) * tick;
  const decimals = tick >= 1 ? 0 : Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 2));
  const normalized = Number(rounded.toFixed(decimals));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}
