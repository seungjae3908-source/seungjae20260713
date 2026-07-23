---
name: Market data provider quirks
description: Non-obvious behaviors of Yahoo/Kiwoom/SEC/DART providers and cache-shape rules
---
- Yahoo v8 chart: `range=max` collapses to ~168 coarse buckets regardless of interval. Use `period1=0&period2=9999999999&interval=1wk|1mo` for full-history weekly/monthly. **Why:** 1W/1M charts looked identical; wrong candle counts.
- Kiwoom chart API ids: 1D=ka10081, 1W=ka10082, 1M=ka10083, 1Y=ka10094, minutes=ka10080. Missing a tf branch silently falls through to daily.
- Candle cache value shape is `{candles, provider}` under key prefix `candles:v2:`; bump the version if the shape changes again (Supabase persistent cache tier survives restarts).
- SEC data.sec.gov intermittently returns 429 from this egress IP — treat as transient, surface 502 with provider name, never fabricate.
- DART corpCode.xml bulk download takes 3–4 min here; bundled fallback at `api-server/data/dart-corpmap.json` (gitignore exception exists). Timeout set ~270s.
- Policy (user-mandated): never show fabricated/sample data when providers fail — return explicit error with provider name. Sample-news fallback was removed for this reason.
- US universe/rankings need FINNHUB_API_KEY (absent); catalog fallback rows have no exchange info, so exchange filters must let empty-exchange rows pass or US movers go empty.

## 시가총액 순위 소스
- 키움 순위 API(volume/tradingValue/gainers/losers)에는 marketCap이 없다. 시총 순위는 전용 소스 필요:
  - KR: `https://m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ}?page=1&pageSize=100` — marketValue 단위 억원, accumulatedTradingValue 단위 백만원.
  - US: 야후 predefined 스크리너가 `sortField=intradaymarketcap&sortType=DESC` 정렬 파라미터를 지원 (quotes에 marketCap 포함).
- naver.getQuote/야후 개별 시세에는 marketCap이 안 실려서 개별 시세 보강으로는 시총 순위를 못 만든다.
