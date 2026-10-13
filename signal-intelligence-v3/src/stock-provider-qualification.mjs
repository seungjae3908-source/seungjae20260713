const REQUIRED_PRICE_CAPABILITIES = Object.freeze(['QUOTE', 'CANDLES', 'VOLUME']);

export const STOCK_PROVIDER_POLICIES = Object.freeze({
  YAHOO_CHART: Object.freeze({
    markets: Object.freeze(['KR_STOCK', 'US_STOCK']),
    timeframes: Object.freeze(['5m', '60m', '1D']),
    capabilities: Object.freeze(['QUOTE', 'CANDLES', 'VOLUME']),
    access: 'PUBLIC_UNAUTHENTICATED',
    usageCondition: 'PUBLIC_ENDPOINT_NO_CONTRACTED_SLA',
    requiresCredentials: false,
    connectorEligible: true,
  }),
  NASDAQ_TRADER: Object.freeze({
    markets: Object.freeze(['US_STOCK']),
    timeframes: Object.freeze([]),
    capabilities: Object.freeze(['UNIVERSE']),
    access: 'PUBLIC_DIRECTORY',
    usageCondition: 'SYMBOL_DIRECTORY_ONLY_NOT_A_PRICE_FEED',
    requiresCredentials: false,
    connectorEligible: true,
  }),
  TOSS_INVEST: Object.freeze({
    markets: Object.freeze(['KR_STOCK', 'US_STOCK']),
    // The checked-in connector currently maps only 1m and 1D. Do not imply
    // native Scanner 5m/60m support until an authenticated payload proves it.
    timeframes: Object.freeze(['1m', '1D']),
    capabilities: Object.freeze(['QUOTE', 'CANDLES', 'VOLUME']),
    access: 'AUTHENTICATED_OFFICIAL_API',
    usageCondition: 'BROKER_ACCOUNT_AND_API_AGREEMENT_REQUIRED',
    requiresCredentials: true,
    connectorEligible: true,
  }),
  KIWOOM: Object.freeze({
    // kiwoom-chart.ts uses the domestic ka10080/ka10081 endpoints. The
    // existence of separate US order routes is not US candle-feed evidence.
    markets: Object.freeze(['KR_STOCK']),
    timeframes: Object.freeze(['5m', '60m', '1D']),
    capabilities: Object.freeze(['QUOTE', 'CANDLES', 'VOLUME']),
    access: 'AUTHENTICATED_OFFICIAL_OPENAPI',
    usageCondition: 'BROKER_ACCOUNT_AND_OPENAPI_AGREEMENT_REQUIRED',
    requiresCredentials: true,
    connectorEligible: true,
  }),
  FINNHUB: Object.freeze({
    markets: Object.freeze(['US_STOCK']),
    timeframes: Object.freeze([]),
    capabilities: Object.freeze(['QUOTE', 'VOLUME']),
    access: 'API_KEY',
    usageCondition: 'API_PLAN_AND_REDISTRIBUTION_TERMS_REQUIRED',
    requiresCredentials: true,
    connectorEligible: true,
  }),
  NAVER_PAGE: Object.freeze({
    markets: Object.freeze(['KR_STOCK']),
    timeframes: Object.freeze(['1D']),
    capabilities: Object.freeze(['QUOTE', 'CANDLES', 'VOLUME']),
    access: 'WEB_PAGE_INTERNAL_ENDPOINT',
    usageCondition: 'NO_CONFIRMED_MARKET_DATA_API_CONTRACT',
    requiresCredentials: false,
    connectorEligible: false,
  }),
});

function validObservation(value) {
  return Boolean(value && typeof value === 'object'
    && Number.isInteger(value.httpStatus)
    && typeof value.observedAt === 'string'
    && Number.isFinite(Date.parse(value.observedAt)));
}

export function qualifyStockProviders(observations = {}) {
  return Object.entries(STOCK_PROVIDER_POLICIES).map(([provider, policy]) => {
    const observation = observations[provider] ?? null;
    const actualQueryVerified = validObservation(observation)
      && observation.httpStatus === 200
      && observation.payloadValidated === true;
    const credentialsReady = !policy.requiresCredentials || observation?.credentialsReady === true;
    const usageTermsConfirmed = observation?.usageTermsConfirmed === true;
    const connectable = policy.connectorEligible
      && actualQueryVerified
      && credentialsReady
      && usageTermsConfirmed;
    const blockers = [];
    if (!policy.connectorEligible) blockers.push('CONNECTOR_NOT_ELIGIBLE');
    if (!validObservation(observation)) blockers.push('ACTUAL_QUERY_NOT_OBSERVED');
    else if (observation.httpStatus !== 200) blockers.push(`HTTP_${observation.httpStatus}`);
    else if (observation.payloadValidated !== true) blockers.push('PAYLOAD_NOT_VALIDATED');
    if (!credentialsReady) blockers.push('CREDENTIALS_NOT_READY');
    if (!usageTermsConfirmed) blockers.push('USAGE_TERMS_NOT_CONFIRMED');
    return Object.freeze({
      provider,
      ...policy,
      actualQueryVerified,
      credentialsReady,
      usageTermsConfirmed,
      connectable,
      observedHttpStatus: validObservation(observation) ? observation.httpStatus : null,
      observedAt: validObservation(observation) ? observation.observedAt : null,
      blockers: Object.freeze([...new Set(blockers)]),
    });
  });
}

export function selectQualifiedStockPriceProvider({ market, timeframe = null, observations = {} } = {}) {
  const qualified = qualifyStockProviders(observations)
    .filter((row) => row.connectable
      && row.markets.includes(market)
      && (!timeframe || row.timeframes.includes(timeframe))
      && REQUIRED_PRICE_CAPABILITIES.every((capability) => row.capabilities.includes(capability)));
  const preference = ['TOSS_INVEST', 'KIWOOM', 'YAHOO_CHART'];
  qualified.sort((left, right) => preference.indexOf(left.provider) - preference.indexOf(right.provider));
  return qualified[0] ?? null;
}

