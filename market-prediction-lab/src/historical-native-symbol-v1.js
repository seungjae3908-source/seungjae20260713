// Identity grammar only, never evidence of historical membership or access.
// Preserve existing ASCII lifecycle identifiers in every market. Only Bitget
// futures may additionally carry native Han identifiers already supported by
// the public collector and hashed archive. Never transliterate an identifier.
const ASCII=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const FUTURES=/^[A-Z0-9\p{Script=Han}][A-Z0-9\p{Script=Han}._:-]{0,39}$/u;
const MARKETS=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const NATIVE_USDT=/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u;

export function isHistoricalNativeSymbolV1(market,symbol) {
  return MARKETS.has(market)&&typeof symbol==="string"
    &&(market==="CRYPTO_FUTURES"?FUTURES:ASCII).test(symbol);
}

// Actual source requests use the narrower native pair grammar: at most 30
// characters including the USDT suffix, in agreement with the candle client.
export function isNativeBitgetUsdtSymbolV1(symbol) {
  return typeof symbol==="string"&&NATIVE_USDT.test(symbol);
}
