export interface SearchAliasDefinition {
  assetType: 'stock' | 'coin';
  market?: 'KR' | 'US' | 'spot' | 'futures';
  tickerOrBaseSymbol: string;
  koreanName?: string;
  englishName?: string;
  aliases: string[];
}

export const SEARCH_ALIAS_DEFINITIONS: SearchAliasDefinition[] = [
  { assetType: 'stock', market: 'KR', tickerOrBaseSymbol: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', aliases: ['삼성', '삼전', 'samsung'] },
  { assetType: 'stock', market: 'KR', tickerOrBaseSymbol: '000660', koreanName: 'SK하이닉스', englishName: 'SK Hynix', aliases: ['하이닉스', 'hynix'] },
  { assetType: 'stock', market: 'KR', tickerOrBaseSymbol: '005380', koreanName: '현대차', englishName: 'Hyundai Motor', aliases: ['현대자동차', 'hyundai'] },
  { assetType: 'stock', market: 'KR', tickerOrBaseSymbol: '035420', koreanName: '네이버', englishName: 'NAVER', aliases: ['naver'] },
  { assetType: 'stock', market: 'KR', tickerOrBaseSymbol: '035720', koreanName: '카카오', englishName: 'Kakao', aliases: ['kakao'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'TSLA', koreanName: '테슬라', englishName: 'Tesla', aliases: ['tesla motors'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'NVDA', koreanName: '엔비디아', englishName: 'NVIDIA', aliases: ['nvidia'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'AAPL', koreanName: '애플', englishName: 'Apple', aliases: ['apple computer'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'MSFT', koreanName: '마이크로소프트', englishName: 'Microsoft', aliases: ['ms'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'AMZN', koreanName: '아마존', englishName: 'Amazon', aliases: [] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'GOOGL', koreanName: '구글', englishName: 'Alphabet', aliases: ['google', 'goog'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'META', koreanName: '메타', englishName: 'Meta Platforms', aliases: ['facebook', '페이스북'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'RGTI', koreanName: '리게티 컴퓨팅', englishName: 'Rigetti Computing', aliases: ['리게티', 'rigetti'] },
  { assetType: 'stock', market: 'US', tickerOrBaseSymbol: 'IONQ', koreanName: '아이온큐', englishName: 'IonQ', aliases: ['ion q'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin', aliases: ['비트', 'bitcoin'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'ETH', koreanName: '이더리움', englishName: 'Ethereum', aliases: ['이더', 'ether'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'XRP', koreanName: '리플', englishName: 'XRP', aliases: ['ripple'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'SOL', koreanName: '솔라나', englishName: 'Solana', aliases: [] },
  { assetType: 'coin', tickerOrBaseSymbol: 'DOGE', koreanName: '도지코인', englishName: 'Dogecoin', aliases: ['도지'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'ADA', koreanName: '에이다', englishName: 'Cardano', aliases: ['카르다노'] },
  { assetType: 'coin', tickerOrBaseSymbol: 'AVAX', koreanName: '아발란체', englishName: 'Avalanche', aliases: [] },
  { assetType: 'coin', tickerOrBaseSymbol: 'LINK', koreanName: '체인링크', englishName: 'Chainlink', aliases: [] },
  { assetType: 'coin', tickerOrBaseSymbol: 'DOT', koreanName: '폴카닷', englishName: 'Polkadot', aliases: [] },
  { assetType: 'coin', tickerOrBaseSymbol: 'TRX', koreanName: '트론', englishName: 'TRON', aliases: [] },
];

export function aliasesForAsset(assetType: 'stock' | 'coin', market: string, tickerOrBaseSymbol: string) {
  const key = tickerOrBaseSymbol.trim().toUpperCase();
  return SEARCH_ALIAS_DEFINITIONS.find((item) =>
    item.assetType === assetType &&
    item.tickerOrBaseSymbol.toUpperCase() === key &&
    (!item.market || item.market === market),
  ) ?? null;
}
