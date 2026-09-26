---
name: No-fake-data UI rules
description: Binding honesty rules for 승재주식 UI — what counts as fabricated data and required fallbacks
---
Rule: any value without a real provider source must render 정보 없음 / 데이터 부족 / 제공 불가 / 산출 불가 — never a heuristic computed from current price, score, or opinion.
**Why:** User explicitly banned fake data; a code review failed the build because 적정가/목표가/손절가 fell back to `currentPrice * heuristic rate`. Those fallbacks were removed (null → "산출 불가").
**How to apply:** When adding metrics/targets/grades, omit the fallback branch entirely; risk grades default to "데이터 부족", not 낮음. 0건 결과와 API 오류는 반드시 구분해 표기.
Also: price-alerts API (`/api/notifications/price-alerts`) expects camelCase body keys (assetType, targetPrice, appEnabled…) but returns snake_case rows — easy mismatch.
