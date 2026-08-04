# Information Analysis Hub Browser Failure

## Playwright output
```text

Running 3 tests using 1 worker

[1/3] e2e/info-analysis-hub.spec.ts:174:1 › RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers
[2/3] (retries) e2e/info-analysis-hub.spec.ts:174:1 › RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers (retry #1)
  1) e2e/info-analysis-hub.spec.ts:174:1 › RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers 

    Error: locator.click: Error: strict mode violation: getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true }) resolved to 2 elements:
        1) <p class="text-[10px] font-black text-muted-foreground">분석 신뢰도</p> aka getByRole('paragraph').filter({ hasText: '분석 신뢰도' })
        2) <span class="block text-sm font-black">분석 신뢰도</span> aka locator('span').filter({ hasText: /^분석 신뢰도$/ })

    Call log:
      - waiting for getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true })


      204 |   await expect(hub.getByText('기계적 관찰 가격', { exact: true })).toBeVisible();
      205 |
    > 206 |   await hub.getByText('분석 신뢰도', { exact: true }).click();
          |                                                  ^
      207 |   await expect(hub.getByText('경쟁사 최신 정량 비교자료', { exact: true })).toBeVisible();
      208 |   clean();
      209 | });
        at /home/runner/work/seungjae20260713/seungjae20260713/stock-analyzer/e2e/info-analysis-hub.spec.ts:206:50

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: video (video/webm) ──────────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/trace.zip
    Usage:

        pnpm exec playwright show-trace test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: locator.click: Error: strict mode violation: getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true }) resolved to 2 elements:
        1) <p class="text-[10px] font-black text-muted-foreground">분석 신뢰도</p> aka getByRole('paragraph').filter({ hasText: '분석 신뢰도' })
        2) <span class="block text-sm font-black">분석 신뢰도</span> aka locator('span').filter({ hasText: /^분석 신뢰도$/ })

    Call log:
      - waiting for getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true })


      204 |   await expect(hub.getByText('기계적 관찰 가격', { exact: true })).toBeVisible();
      205 |
    > 206 |   await hub.getByText('분석 신뢰도', { exact: true }).click();
          |                                                  ^
      207 |   await expect(hub.getByText('경쟁사 최신 정량 비교자료', { exact: true })).toBeVisible();
      208 |   clean();
      209 | });
        at /home/runner/work/seungjae20260713/seungjae20260713/stock-analyzer/e2e/info-analysis-hub.spec.ts:206:50

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: video (video/webm) ──────────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/trace.zip
    Usage:

        pnpm exec playwright show-trace test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────


[3/3] e2e/info-analysis-hub.spec.ts:211:1 › a newly confirmed development failure records the reason and lowers the outlook without manual prose
[4/3] (retries) e2e/info-analysis-hub.spec.ts:211:1 › a newly confirmed development failure records the reason and lowers the outlook without manual prose (retry #1)
  2) e2e/info-analysis-hub.spec.ts:211:1 › a newly confirmed development failure records the reason and lowers the outlook without manual prose 

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })
    Expected: visible
    Timeout: 15000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" with timeout 15000ms
      - waiting for getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })


      223 |   const updatedHub = page.getByTestId('stock-analysis-hub');
      224 |   await expect(updatedHub.getByText(/핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
    > 225 |   await expect(updatedHub.getByText('기존 전망 변경', { exact: true })).toBeVisible();
          |                                                                   ^
      226 |   await expect(updatedHub.getByText(/새 이벤트: 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
      227 |   await expect(updatedHub.getByText(/최근 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
      228 |   clean();
        at /home/runner/work/seungjae20260713/seungjae20260713/stock-analyzer/e2e/info-analysis-hub.spec.ts:225:67

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: video (video/webm) ──────────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/trace.zip
    Usage:

        pnpm exec playwright show-trace test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })
    Expected: visible
    Timeout: 15000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" with timeout 15000ms
      - waiting for getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })


      223 |   const updatedHub = page.getByTestId('stock-analysis-hub');
      224 |   await expect(updatedHub.getByText(/핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
    > 225 |   await expect(updatedHub.getByText('기존 전망 변경', { exact: true })).toBeVisible();
          |                                                                   ^
      226 |   await expect(updatedHub.getByText(/새 이벤트: 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
      227 |   await expect(updatedHub.getByText(/최근 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
      228 |   clean();
        at /home/runner/work/seungjae20260713/seungjae20260713/stock-analyzer/e2e/info-analysis-hub.spec.ts:225:67

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: video (video/webm) ──────────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/trace.zip
    Usage:

        pnpm exec playwright show-trace test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────


[5/3] e2e/info-analysis-hub.spec.ts:231:1 › missing sector and financial data lowers confidence but never creates a blank or NaN screen
  2 failed
    e2e/info-analysis-hub.spec.ts:174:1 › RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers 
    e2e/info-analysis-hub.spec.ts:211:1 › a newly confirmed development failure records the reason and lowers the outlook without manual prose 
  1 passed (47.3s)
```

## Error contexts

### stock-analyzer/test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose-retry1/error-context.md
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: info-analysis-hub.spec.ts >> a newly confirmed development failure records the reason and lowers the outlook without manual prose
- Location: e2e/info-analysis-hub.spec.ts:211:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })

```

```yaml
- banner:
  - heading "정보" [level=1]
  - button "정보"
  - button "공부"
  - button "주식"
  - button "코인"
  - button "국내"
  - button "해외"
- main:
  - heading "특이정보" [level=2]
  - paragraph: 해외 앱 종목 1개를 순환 확인합니다. 1주일 이내는 최신으로, 1주일이 지나면 보관함의 지난 정보로 표시됩니다.
  - button "최신정보"
  - button "보관함":
    - img
    - text: 보관함
  - img
  - textbox:
    - /placeholder: 종목·코인·제목·내용 검색
  - button "전체"
  - button "뉴스"
  - button "호재"
  - button "악재"
  - button "중요공시"
  - button "차트신호"
  - button "최신공시 리게티 컴퓨팅 RGTI 핵심 양자 프로세서 개발 실패 및 일정 재검토 공식 시험에서 목표 성능을 달성하지 못했습니다. SEC · 방금 전 1주일 이내":
    - text: 최신공시 리게티 컴퓨팅 RGTI
    - paragraph: 핵심 양자 프로세서 개발 실패 및 일정 재검토
    - paragraph: 공식 시험에서 목표 성능을 달성하지 못했습니다.
    - text: SEC · 방금 전 1주일 이내
  - img
  - textbox:
    - /placeholder: 해외 종목명·티커·한글명 검색
  - paragraph: 리게티 컴퓨팅
  - paragraph: RGTI · 해외 · 출처 US_PROVIDER · 기준 2026. 8. 4. 오전 10:42:39 · 최신
  - button "관심종목":
    - img
  - paragraph: 현재가
  - paragraph: $12.5
  - paragraph: 등락률
  - paragraph: "-16.70%"
  - button "상세 분석":
    - text: 상세 분석
    - img
  - img
  - heading "AI 종합평가" [level=2]
  - text: 자체엔진 투자 권유 아님
  - paragraph: 양자컴퓨팅 업종별 기준 · 2026. 8. 4. 오전 10:42:41
  - paragraph: 종합점수
  - text: 33점
  - paragraph: 부정
  - paragraph: 단기 전망
  - img
  - text: 하락 우위
  - paragraph: 위험도
  - text: 높음
  - paragraph: 70점
  - paragraph: 분석 신뢰도
  - text: 82%
  - paragraph: 4/5
  - paragraph: 핵심 한줄
  - paragraph: “양자 기술 기대보다 핵심 성능·확장성·상용화 검증이 우선인 단계입니다. 최근 핵심 양자 프로세서 개발 실패 및 일정 재검토 영향은 보수적으로 반영했습니다.”
  - group:
    - text: AI 종합 분석 기술력·사업성·성장성·재무·주가·이벤트
    - img
    - text: 기술력 51점
    - paragraph: 큐비트 규모·게이트 정확도·확장성 자료 반영 · 기술 이벤트 영향 -15점
    - text: 사업성 46점
    - paragraph: 실제 매출 확인 · 계약·사업 이벤트 영향 -11점
    - text: 성장성 41점
    - paragraph: 매출 증감 20.0% · 성장 이벤트 영향 -16점
    - text: 재무건전성 28점
    - paragraph: 영업적자 · 현금 소진 확인 필요
    - text: 주가 흐름 24점
    - paragraph: 당일 등락 -16.70% · 52주 가격범위 43% 위치
    - text: 촉매·이벤트 32점
    - paragraph: 최근 분류 이벤트 1건 · 이벤트 순영향 -18점
    - img
    - text: 강점
    - list:
      - listitem: 1 매출 20.0% 성장
    - img
    - text: 약점
    - list:
      - listitem: 1 주가 흐름 취약
      - listitem: 2 재무건전성 취약
      - listitem: 3 핵심 양자 프로세서 개발 실패 및 일정 재검토
      - listitem: 4 영업적자 지속
    - paragraph: 사업 단계
    - paragraph: 초기 상용화·성장 투자 단계
    - paragraph: 매출 상태
    - paragraph: 성장 중
    - paragraph: 성장 가능성
    - paragraph: 낮음·검증 필요
    - paragraph: 검증 필요
    - paragraph: 큐비트·게이트 정확도
  - group:
    - text: 경쟁력 비교 IBM · Google · IonQ 비교 준비
    - img
  - group:
    - text: 이벤트 분석 분류 이벤트 1건 · 분석 변경 자동 추적
    - img
    - paragraph: 저장된 이전 분석과 비교할 유의미한 변경이 없습니다. 데이터가 바뀌면 점수·전망·위험도 변경 이유가 여기에 표시됩니다.
    - article:
      - paragraph: 핵심 양자 프로세서 개발 실패 및 일정 재검토
      - paragraph: 2026. 8. 4. 오전 10:42:39 · 공식 확인 · 근거 1건
      - img
      - text: 기술력 -15 사업성 -11 성장성 -16 재무 -5 주가 -11 촉매 -18 위험도 +18
      - paragraph: 개발 실패는 기존 기술 로드맵과 성장 가정을 다시 검증하게 만듭니다.
  - group:
    - text: 재무 해석 매출 흐름은 개선 중이며 영업적자가 이어져 수익화와 현금 소진 속도를 함께 확인해야 합니다.
    - img
  - group:
    - text: 주가와 연결 현재 가격 위치·최근 상승/하락 이유·기대 선반영 확인
    - img
  - group:
    - text: 투자자가 궁금한 조건 상승 가능 요인·하락 위험·기계적 관찰 가격
    - img
  - group:
    - text: 분석 신뢰도 82% · 근거와 부족 데이터를 함께 공개
    - img
  - button "기본정보 눌러서 펼치기":
    - text: 기본정보 눌러서 펼치기
    - img
  - button "지정가 알림 저장된 알림 없음":
    - img
    - text: 지정가 알림 저장된 알림 없음
    - img
  - button "기업·업종 눌러서 펼치기":
    - text: 기업·업종 눌러서 펼치기
    - img
  - button "재무요약 눌러서 펼치기":
    - text: 재무요약 눌러서 펼치기
    - img
  - button "수급·공매도 눌러서 펼치기":
    - text: 수급·공매도 눌러서 펼치기
    - img
  - button "최신 뉴스 최신 고유 0건 / 전체 0건":
    - text: 최신 뉴스 최신 고유 0건 / 전체 0건
    - img
  - button "최신 공시 최신 고유 1건 / 전체 1건":
    - text: 최신 공시 최신 고유 1건 / 전체 1건
    - img
- navigation:
  - button "홈":
    - img
    - text: 홈
  - button "종목":
    - img
    - text: 종목
  - button "테마":
    - img
    - text: 테마
  - button "관심":
    - img
    - text: 관심
  - button "정보":
    - img
    - text: 정보
  - button "설정":
    - img
    - text: 설정
- region "Notifications (F8)":
  - list
```

# Test source

```ts
  125 |               scalability: 'modular',
  126 |             });
  127 |       }
  128 |       if (action.startsWith('financials')) {
  129 |         return json(route, mode === 'missing'
  130 |           ? { source: 'SEC_XBRL', financials: { quarterly: [] } }
  131 |           : {
  132 |               source: 'SEC_XBRL',
  133 |               updatedAt: NOW,
  134 |               financials: {
  135 |                 quarterly: [
  136 |                   { period: '2026-Q2', revenue: 120_000_000, operatingIncome: -80_000_000, netIncome: -75_000_000, cash: 300_000_000, operatingCashFlow: -60_000_000 },
  137 |                   { period: '2026-Q1', revenue: 100_000_000, operatingIncome: -70_000_000, netIncome: -68_000_000, cash: 350_000_000, operatingCashFlow: -55_000_000 },
  138 |                 ],
  139 |                 ratios: { debtRatio: 40 },
  140 |               },
  141 |             });
  142 |       }
  143 |       if (action.startsWith('market-flow')) return json(route, { available: false, note: '미국 수급 제공기관 미지원' });
  144 |       if (action.startsWith('short-selling')) return json(route, { available: true, latest: { shortVolume: 1_000_000, ratio: 4.2, balance: 8_000_000 } });
  145 |       if (action.startsWith('news')) {
  146 |         return json(route, { news: mode === 'balanced' ? [{ title: '핵심 개발 일정 지연과 비용 증가 가능성', summary: '상용화 일정 확인 필요', source: 'Reuters', date: NOW }] : [] });
  147 |       }
  148 |       if (action.startsWith('disclosures') || action.startsWith('filings')) {
  149 |         const disclosures = mode === 'failure'
  150 |           ? [{ report: '핵심 양자 프로세서 개발 실패 및 일정 재검토', source: 'SEC', date: NOW }]
  151 |           : mode === 'missing'
  152 |             ? []
  153 |             : [{ report: '정부 연구기관과 양자 시스템 공급 계약 체결', source: 'SEC', date: NOW }];
  154 |         return json(route, { disclosures });
  155 |       }
  156 |     }
  157 | 
  158 |     if (path === '/api/notifications/price-alerts') return json(route, { alerts: [] });
  159 |     return json(route, { ok: true });
  160 |   });
  161 | }
  162 | 
  163 | function diagnostics(page: Page) {
  164 |   const errors: string[] = [];
  165 |   page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  166 |   page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  167 |   page.on('requestfailed', (request) => {
  168 |     const reason = request.failure()?.errorText ?? '';
  169 |     if (!reason.includes('ERR_ABORTED')) errors.push(`request:${reason}`);
  170 |   });
  171 |   return () => expect(errors, errors.join('\n')).toEqual([]);
  172 | }
  173 | 
  174 | test('RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers', async ({ page }) => {
  175 |   let mode: Mode = 'balanced';
  176 |   const clean = diagnostics(page);
  177 |   await installAnalysisMocks(page, () => mode);
  178 |   await page.addInitScript(() => localStorage.clear());
  179 |   await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');
  180 | 
  181 |   const hub = page.getByTestId('stock-analysis-hub');
  182 |   await expect(hub.getByText('AI 종합평가', { exact: true })).toBeVisible();
  183 |   await expect(hub.getByText('자체엔진', { exact: true })).toBeVisible();
  184 |   await expect(hub.getByText(/양자 기술 개발 역량|양자 기술 기대/)).toBeVisible();
  185 |   await expect(hub.getByText('기술력', { exact: true }).first()).toBeVisible();
  186 |   await expect(hub.getByText(/정부 연구기관과 양자 시스템 공급 계약 체결/).first()).toBeVisible();
  187 |   await expect(hub.getByText(/핵심 개발 일정 지연/).first()).toBeVisible();
  188 | 
  189 |   await hub.getByText('경쟁력 비교', { exact: true }).click();
  190 |   await expect(hub.getByText('IBM', { exact: true })).toBeVisible();
  191 |   await expect(hub.getByText('Google', { exact: true })).toBeVisible();
  192 |   await expect(hub.getByText('IonQ', { exact: true })).toBeVisible();
  193 |   await expect(hub.getByText('자료 필요', { exact: true }).first()).toBeVisible();
  194 | 
  195 |   await hub.getByText('재무 해석', { exact: true }).click();
  196 |   await expect(hub.getByText(/영업적자/).first()).toBeVisible();
  197 | 
  198 |   await hub.getByText('주가와 연결', { exact: true }).click();
  199 |   await expect(hub.getByText('52주 고점 대비', { exact: true })).toBeVisible();
  200 | 
  201 |   await hub.getByText('투자자가 궁금한 조건', { exact: true }).click();
  202 |   await expect(hub.getByText('왜 오를 수 있나?', { exact: true })).toBeVisible();
  203 |   await expect(hub.getByText('왜 떨어질 수 있나?', { exact: true })).toBeVisible();
  204 |   await expect(hub.getByText('기계적 관찰 가격', { exact: true })).toBeVisible();
  205 | 
  206 |   await hub.getByText('분석 신뢰도', { exact: true }).click();
  207 |   await expect(hub.getByText('경쟁사 최신 정량 비교자료', { exact: true })).toBeVisible();
  208 |   clean();
  209 | });
  210 | 
  211 | test('a newly confirmed development failure records the reason and lowers the outlook without manual prose', async ({ page }) => {
  212 |   let mode: Mode = 'positive';
  213 |   const clean = diagnostics(page);
  214 |   await installAnalysisMocks(page, () => mode);
  215 |   await page.addInitScript(() => localStorage.clear());
  216 |   await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');
  217 |   const hub = page.getByTestId('stock-analysis-hub');
  218 |   await expect(hub.getByText(/공급 계약 체결/).first()).toBeVisible();
  219 |   await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('sa-stock-analysis-history-v1:US:RGTI')));
  220 | 
  221 |   mode = 'failure';
  222 |   await page.reload();
  223 |   const updatedHub = page.getByTestId('stock-analysis-hub');
  224 |   await expect(updatedHub.getByText(/핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
> 225 |   await expect(updatedHub.getByText('기존 전망 변경', { exact: true })).toBeVisible();
      |                                                                   ^ Error: expect(locator).toBeVisible() failed
  226 |   await expect(updatedHub.getByText(/새 이벤트: 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
  227 |   await expect(updatedHub.getByText(/최근 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();

### stock-analyzer/test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers-retry1/error-context.md
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: info-analysis-hub.spec.ts >> RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers
- Location: e2e/info-analysis-hub.spec.ts:174:1

# Error details

```
Error: locator.click: Error: strict mode violation: getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true }) resolved to 2 elements:
    1) <p class="text-[10px] font-black text-muted-foreground">분석 신뢰도</p> aka getByRole('paragraph').filter({ hasText: '분석 신뢰도' })
    2) <span class="block text-sm font-black">분석 신뢰도</span> aka locator('span').filter({ hasText: /^분석 신뢰도$/ })

Call log:
  - waiting for getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e8]:
    - banner [ref=e9]:
      - heading "정보" [level=1] [ref=e10]
      - generic [ref=e11]:
        - button "정보" [ref=e12]
        - button "공부" [ref=e13]
      - generic [ref=e14]:
        - button "주식" [ref=e15]
        - button "코인" [ref=e16]
      - generic [ref=e17]:
        - button "국내" [ref=e18]
        - button "해외" [ref=e19]
    - main [ref=e20]:
      - generic [ref=e21]:
        - generic [ref=e22]:
          - heading "특이정보" [level=2] [ref=e23]
          - paragraph [ref=e24]: 해외 앱 종목 2개를 순환 확인합니다. 1주일 이내는 최신으로, 1주일이 지나면 보관함의 지난 정보로 표시됩니다.
        - generic [ref=e25]:
          - button "최신정보" [ref=e26]
          - button "보관함" [ref=e27]:
            - img [ref=e28]
            - text: 보관함
        - generic [ref=e31]:
          - img [ref=e32]
          - textbox [ref=e35]:
            - /placeholder: 종목·코인·제목·내용 검색
        - generic [ref=e36]:
          - button "전체" [ref=e37]
          - button "뉴스" [ref=e38]
          - button "호재" [ref=e39]
          - button "악재" [ref=e40]
          - button "중요공시" [ref=e41]
          - button "차트신호" [ref=e42]
        - generic [ref=e43]:
          - button "최신공시 리게티 컴퓨팅 RGTI 정부 연구기관과 양자 시스템 공급 계약 체결 다년 계약으로 실제 매출 전환 여부를 확인해야 합니다. SEC · 방금 전 1주일 이내" [ref=e44]:
            - generic [ref=e45]:
              - generic [ref=e47]:
                - generic [ref=e48]:
                  - generic [ref=e49]: 최신공시
                  - generic [ref=e50]: 리게티 컴퓨팅
                  - generic [ref=e51]: RGTI
                - paragraph [ref=e52]: 정부 연구기관과 양자 시스템 공급 계약 체결
                - paragraph [ref=e53]: 다년 계약으로 실제 매출 전환 여부를 확인해야 합니다.
              - generic [ref=e54]:
                - generic [ref=e55]: SEC · 방금 전
                - generic [ref=e56]: 1주일 이내
          - button "최신악재 리게티 컴퓨팅 RGTI 핵심 개발 일정 지연과 비용 증가 가능성 실패는 아니지만 상용화 일정 확인이 필요합니다. Reuters · 방금 전 1주일 이내" [ref=e57]:
            - generic [ref=e58]:
              - generic [ref=e60]:
                - generic [ref=e61]:
                  - generic [ref=e62]: 최신악재
                  - generic [ref=e63]: 리게티 컴퓨팅
                  - generic [ref=e64]: RGTI
                - paragraph [ref=e65]: 핵심 개발 일정 지연과 비용 증가 가능성
                - paragraph [ref=e66]: 실패는 아니지만 상용화 일정 확인이 필요합니다.
              - generic [ref=e67]:
                - generic [ref=e68]: Reuters · 방금 전
                - generic [ref=e69]: 1주일 이내
      - generic [ref=e71]:
        - img [ref=e72]
        - textbox [ref=e75]:
          - /placeholder: 해외 종목명·티커·한글명 검색
      - generic [ref=e76]:
        - generic [ref=e77]:
          - generic [ref=e78]:
            - paragraph [ref=e79]: 리게티 컴퓨팅
            - paragraph [ref=e80]: RGTI · 해외 · 출처 US_PROVIDER · 기준 2026. 8. 4. 오전 10:42:18 · 최신
          - button "관심종목" [ref=e81]:
            - img [ref=e82]
        - generic [ref=e84]:
          - generic [ref=e85]:
            - paragraph [ref=e86]: 현재가
            - paragraph [ref=e87]: $15
          - generic [ref=e88]:
            - paragraph [ref=e89]: 등락률
            - paragraph [ref=e90]: +3.40%
        - button "상세 분석" [ref=e91]:
          - text: 상세 분석
          - img [ref=e92]
      - generic [ref=e94]:
        - generic [ref=e95]:
          - generic [ref=e96]:
            - generic [ref=e97]:
              - img [ref=e98]
              - heading "AI 종합평가" [level=2] [ref=e100]
              - generic [ref=e101]: 자체엔진
              - generic [ref=e102]: 투자 권유 아님
            - paragraph [ref=e103]: 양자컴퓨팅 업종별 기준 · 2026. 8. 4. 오전 10:42:19
          - generic [ref=e104]:
            - generic [ref=e105]:
              - paragraph [ref=e106]: 종합점수
              - generic [ref=e107]: 56점
              - paragraph [ref=e108]: 중립
            - generic [ref=e109]:
              - paragraph [ref=e110]: 단기 전망
              - generic [ref=e111]:
                - img [ref=e112]
                - text: 중립~상승
            - generic [ref=e115]:
              - paragraph [ref=e116]: 위험도
              - generic [ref=e117]: 보통
              - paragraph [ref=e118]: 51점
            - generic [ref=e119]:
              - paragraph [ref=e120]: 분석 신뢰도
              - generic [ref=e121]: 82%
              - paragraph [ref=e122]: 4/5
          - generic [ref=e123]:
            - paragraph [ref=e124]: 핵심 한줄
            - paragraph [ref=e125]: “양자 기술 개발 역량은 확인되지만 상용화·수익성과 로드맵 이행 검증이 필요한 단계입니다.”
        - group [ref=e126]:
          - generic "AI 종합 분석 기술력·사업성·성장성·재무·주가·이벤트" [ref=e127] [cursor=pointer]:
            - generic [ref=e128]:
              - generic [ref=e129]: AI 종합 분석
              - generic [ref=e130]: 기술력·사업성·성장성·재무·주가·이벤트
            - img [ref=e131]
          - generic [ref=e134]:
            - generic [ref=e135]:
              - generic [ref=e136]:
                - generic [ref=e137]:
                  - generic [ref=e138]: 기술력
                  - generic [ref=e139]: 64점
                - paragraph [ref=e142]: 큐비트 규모·게이트 정확도·확장성 자료 반영 · 기술 이벤트 영향 -2점
              - generic [ref=e143]:
                - generic [ref=e144]:
                  - generic [ref=e145]: 사업성
                  - generic [ref=e146]: 63점
                - paragraph [ref=e149]: 실제 매출 확인 · 계약·사업 이벤트 영향 +6점
              - generic [ref=e150]:
                - generic [ref=e151]:
                  - generic [ref=e152]: 성장성
                  - generic [ref=e153]: 61점
                - paragraph [ref=e156]: 매출 증감 20.0% · 성장 이벤트 영향 +4점
              - generic [ref=e157]:
                - generic [ref=e158]:
                  - generic [ref=e159]: 재무건전성
                  - generic [ref=e160]: 35점
                - paragraph [ref=e163]: 영업적자 · 현금 소진 확인 필요
              - generic [ref=e164]:
                - generic [ref=e165]:
                  - generic [ref=e166]: 주가 흐름
                  - generic [ref=e167]: 57점
                - paragraph [ref=e170]: 당일 등락 3.40% · 52주 가격범위 60% 위치
              - generic [ref=e171]:
                - generic [ref=e172]:
                  - generic [ref=e173]: 촉매·이벤트
                  - generic [ref=e174]: 54점
                - paragraph [ref=e177]: 최근 분류 이벤트 2건 · 이벤트 순영향 +4점
            - generic [ref=e178]:
              - generic [ref=e179]:
                - generic [ref=e180]:
                  - img [ref=e181]
                  - text: 강점
                - list [ref=e184]:
                  - listitem [ref=e185]:
                    - generic [ref=e186]: "1"
                    - generic [ref=e187]: 기술력 양호
                  - listitem [ref=e188]:
                    - generic [ref=e189]: "2"
                    - generic [ref=e190]: 사업성 양호
                  - listitem [ref=e191]:
                    - generic [ref=e192]: "3"
                    - generic [ref=e193]: 정부 연구기관과 양자 시스템 공급 계약 체결
                  - listitem [ref=e194]:
                    - generic [ref=e195]: "4"
                    - generic [ref=e196]: 매출 20.0% 성장
              - generic [ref=e197]:
                - generic [ref=e198]:
                  - img [ref=e199]
                  - text: 약점
                - list [ref=e201]:
                  - listitem [ref=e202]:
                    - generic [ref=e203]: "1"
                    - generic [ref=e204]: 재무건전성 주의
                  - listitem [ref=e205]:
                    - generic [ref=e206]: "2"
                    - generic [ref=e207]: 핵심 개발 일정 지연과 비용 증가 가능성
                  - listitem [ref=e208]:
                    - generic [ref=e209]: "3"
                    - generic [ref=e210]: 영업적자 지속
            - generic [ref=e211]:
              - generic [ref=e212]:
                - paragraph [ref=e213]: 사업 단계
                - paragraph [ref=e214]: 초기 상용화·성장 투자 단계
              - generic [ref=e215]:
                - paragraph [ref=e216]: 매출 상태
                - paragraph [ref=e217]: 성장 중
              - generic [ref=e218]:
                - paragraph [ref=e219]: 성장 가능성
                - paragraph [ref=e220]: 보통
              - generic [ref=e221]:
                - paragraph [ref=e222]: 검증 필요
                - paragraph [ref=e223]: 큐비트·게이트 정확도
        - group [ref=e224]:
          - generic "경쟁력 비교 IBM · Google · IonQ 비교 준비" [ref=e225] [cursor=pointer]:
            - generic [ref=e226]:
              - generic [ref=e227]: 경쟁력 비교
              - generic [ref=e228]: IBM · Google · IonQ 비교 준비
            - img [ref=e229]
          - generic [ref=e232]:
            - paragraph [ref=e233]: 선택 종목은 현재 수집된 자료로 평가하고, 경쟁사는 정량자료가 없을 때 임의 점수를 만들지 않고 ‘자료 필요’로 표시합니다.
            - table [ref=e235]:
              - rowgroup [ref=e236]:
                - row "비교 기준 리게티 컴퓨팅 IBM Google IonQ" [ref=e237]:
                  - columnheader "비교 기준" [ref=e238]
                  - columnheader "리게티 컴퓨팅" [ref=e239]
                  - columnheader "IBM" [ref=e240]
                  - columnheader "Google" [ref=e241]
                  - columnheader "IonQ" [ref=e242]
              - rowgroup [ref=e243]:
                - row "기술 성숙도 ○ 자료 필요 자료 필요 자료 필요" [ref=e244]:
                  - cell "기술 성숙도" [ref=e245]
                  - cell "○" [ref=e246]:
                    - generic [ref=e247]: ○
                  - cell "자료 필요" [ref=e248]:
                    - generic [ref=e249]: 자료 필요
                  - cell "자료 필요" [ref=e250]:
                    - generic [ref=e251]: 자료 필요
                  - cell "자료 필요" [ref=e252]:
                    - generic [ref=e253]: 자료 필요
                - row "상용화 ○ 자료 필요 자료 필요 자료 필요" [ref=e254]:
                  - cell "상용화" [ref=e255]
                  - cell "○" [ref=e256]:
                    - generic [ref=e257]: ○
                  - cell "자료 필요" [ref=e258]:
                    - generic [ref=e259]: 자료 필요
                  - cell "자료 필요" [ref=e260]:
                    - generic [ref=e261]: 자료 필요
                  - cell "자료 필요" [ref=e262]:
                    - generic [ref=e263]: 자료 필요
                - row "확장성 ○ 자료 필요 자료 필요 자료 필요" [ref=e264]:
                  - cell "확장성" [ref=e265]
                  - cell "○" [ref=e266]:
                    - generic [ref=e267]: ○
                  - cell "자료 필요" [ref=e268]:
                    - generic [ref=e269]: 자료 필요
                  - cell "자료 필요" [ref=e270]:
                    - generic [ref=e271]: 자료 필요
                  - cell "자료 필요" [ref=e272]:
                    - generic [ref=e273]: 자료 필요
        - group [ref=e274]:
          - generic "이벤트 분석 분류 이벤트 2건 · 분석 변경 자동 추적" [ref=e275] [cursor=pointer]:
            - generic [ref=e276]:
              - generic [ref=e277]: 이벤트 분석
              - generic [ref=e278]: 분류 이벤트 2건 · 분석 변경 자동 추적
            - img [ref=e279]
          - generic [ref=e282]:
            - paragraph [ref=e283]: 저장된 이전 분석과 비교할 유의미한 변경이 없습니다. 데이터가 바뀌면 점수·전망·위험도 변경 이유가 여기에 표시됩니다.
            - generic [ref=e284]:
              - article [ref=e285]:
                - generic [ref=e286]:
                  - generic [ref=e287]:
                    - paragraph [ref=e288]: 핵심 개발 일정 지연과 비용 증가 가능성
                    - paragraph [ref=e289]: 2026. 8. 4. 오전 10:42:18 · 가능성 높음 · 근거 1건
                  - img [ref=e290]
                - generic [ref=e293]:
                  - generic [ref=e294]: 기술력 -2
                  - generic [ref=e295]: 사업성 -2
                  - generic [ref=e296]: 성장성 -2
                  - generic [ref=e297]: 재무 -1
                  - generic [ref=e298]: 주가 -2
                  - generic [ref=e299]: 촉매 -3
                  - generic [ref=e300]: 위험도 +2
                - paragraph [ref=e301]: 일정 지연은 실패와 다르지만 매출 전환 시점과 신뢰도를 낮출 수 있습니다.
              - article [ref=e302]:
                - generic [ref=e303]:
                  - generic [ref=e304]:
                    - paragraph [ref=e305]: 정부 연구기관과 양자 시스템 공급 계약 체결
                    - paragraph [ref=e306]: 2026. 8. 4. 오전 10:42:18 · 공식 확인 · 근거 1건
                  - img [ref=e307]
                - generic [ref=e310]:
                  - generic [ref=e311]: 사업성 +8
                  - generic [ref=e312]: 성장성 +6
                  - generic [ref=e313]: 재무 +3

### stock-analyzer/test-results/info-analysis-hub-a-newly--60a08-utlook-without-manual-prose/error-context.md
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: info-analysis-hub.spec.ts >> a newly confirmed development failure records the reason and lowers the outlook without manual prose
- Location: e2e/info-analysis-hub.spec.ts:211:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByTestId('stock-analysis-hub').getByText('기존 전망 변경', { exact: true })

```

```yaml
- banner:
  - heading "정보" [level=1]
  - button "정보"
  - button "공부"
  - button "주식"
  - button "코인"
  - button "국내"
  - button "해외"
- main:
  - heading "특이정보" [level=2]
  - paragraph: 해외 앱 종목 1개를 순환 확인합니다. 1주일 이내는 최신으로, 1주일이 지나면 보관함의 지난 정보로 표시됩니다.
  - button "최신정보"
  - button "보관함":
    - img
    - text: 보관함
  - img
  - textbox:
    - /placeholder: 종목·코인·제목·내용 검색
  - button "전체"
  - button "뉴스"
  - button "호재"
  - button "악재"
  - button "중요공시"
  - button "차트신호"
  - button "최신공시 리게티 컴퓨팅 RGTI 핵심 양자 프로세서 개발 실패 및 일정 재검토 공식 시험에서 목표 성능을 달성하지 못했습니다. SEC · 방금 전 1주일 이내":
    - text: 최신공시 리게티 컴퓨팅 RGTI
    - paragraph: 핵심 양자 프로세서 개발 실패 및 일정 재검토
    - paragraph: 공식 시험에서 목표 성능을 달성하지 못했습니다.
    - text: SEC · 방금 전 1주일 이내
  - img
  - textbox:
    - /placeholder: 해외 종목명·티커·한글명 검색
  - paragraph: 리게티 컴퓨팅
  - paragraph: RGTI · 해외 · 출처 US_PROVIDER · 기준 2026. 8. 4. 오전 10:42:21 · 최신
  - button "관심종목":
    - img
  - paragraph: 현재가
  - paragraph: $12.5
  - paragraph: 등락률
  - paragraph: "-16.70%"
  - button "상세 분석":
    - text: 상세 분석
    - img
  - img
  - heading "AI 종합평가" [level=2]
  - text: 자체엔진 투자 권유 아님
  - paragraph: 양자컴퓨팅 업종별 기준 · 2026. 8. 4. 오전 10:42:23
  - paragraph: 종합점수
  - text: 33점
  - paragraph: 부정
  - paragraph: 단기 전망
  - img
  - text: 하락 우위
  - paragraph: 위험도
  - text: 높음
  - paragraph: 70점
  - paragraph: 분석 신뢰도
  - text: 82%
  - paragraph: 4/5
  - paragraph: 핵심 한줄
  - paragraph: “양자 기술 기대보다 핵심 성능·확장성·상용화 검증이 우선인 단계입니다. 최근 핵심 양자 프로세서 개발 실패 및 일정 재검토 영향은 보수적으로 반영했습니다.”
  - group:
    - text: AI 종합 분석 기술력·사업성·성장성·재무·주가·이벤트
    - img
    - text: 기술력 51점
    - paragraph: 큐비트 규모·게이트 정확도·확장성 자료 반영 · 기술 이벤트 영향 -15점
    - text: 사업성 46점
    - paragraph: 실제 매출 확인 · 계약·사업 이벤트 영향 -11점
    - text: 성장성 41점
    - paragraph: 매출 증감 20.0% · 성장 이벤트 영향 -16점
    - text: 재무건전성 28점
    - paragraph: 영업적자 · 현금 소진 확인 필요
    - text: 주가 흐름 24점
    - paragraph: 당일 등락 -16.70% · 52주 가격범위 43% 위치
    - text: 촉매·이벤트 32점
    - paragraph: 최근 분류 이벤트 1건 · 이벤트 순영향 -18점
    - img
    - text: 강점
    - list:
      - listitem: 1 매출 20.0% 성장
    - img
    - text: 약점
    - list:
      - listitem: 1 주가 흐름 취약
      - listitem: 2 재무건전성 취약
      - listitem: 3 핵심 양자 프로세서 개발 실패 및 일정 재검토
      - listitem: 4 영업적자 지속
    - paragraph: 사업 단계
    - paragraph: 초기 상용화·성장 투자 단계
    - paragraph: 매출 상태
    - paragraph: 성장 중
    - paragraph: 성장 가능성
    - paragraph: 낮음·검증 필요
    - paragraph: 검증 필요
    - paragraph: 큐비트·게이트 정확도
  - group:
    - text: 경쟁력 비교 IBM · Google · IonQ 비교 준비
    - img
  - group:
    - text: 이벤트 분석 분류 이벤트 1건 · 분석 변경 자동 추적
    - img
    - paragraph: 저장된 이전 분석과 비교할 유의미한 변경이 없습니다. 데이터가 바뀌면 점수·전망·위험도 변경 이유가 여기에 표시됩니다.
    - article:
      - paragraph: 핵심 양자 프로세서 개발 실패 및 일정 재검토
      - paragraph: 2026. 8. 4. 오전 10:42:21 · 공식 확인 · 근거 1건
      - img
      - text: 기술력 -15 사업성 -11 성장성 -16 재무 -5 주가 -11 촉매 -18 위험도 +18
      - paragraph: 개발 실패는 기존 기술 로드맵과 성장 가정을 다시 검증하게 만듭니다.
  - group:
    - text: 재무 해석 매출 흐름은 개선 중이며 영업적자가 이어져 수익화와 현금 소진 속도를 함께 확인해야 합니다.
    - img
  - group:
    - text: 주가와 연결 현재 가격 위치·최근 상승/하락 이유·기대 선반영 확인
    - img
  - group:
    - text: 투자자가 궁금한 조건 상승 가능 요인·하락 위험·기계적 관찰 가격
    - img
  - group:
    - text: 분석 신뢰도 82% · 근거와 부족 데이터를 함께 공개
    - img
  - button "기본정보 눌러서 펼치기":
    - text: 기본정보 눌러서 펼치기
    - img
  - button "지정가 알림 저장된 알림 없음":
    - img
    - text: 지정가 알림 저장된 알림 없음
    - img
  - button "기업·업종 눌러서 펼치기":
    - text: 기업·업종 눌러서 펼치기
    - img
  - button "재무요약 눌러서 펼치기":
    - text: 재무요약 눌러서 펼치기
    - img
  - button "수급·공매도 눌러서 펼치기":
    - text: 수급·공매도 눌러서 펼치기
    - img
  - button "최신 뉴스 최신 고유 0건 / 전체 0건":
    - text: 최신 뉴스 최신 고유 0건 / 전체 0건
    - img
  - button "최신 공시 최신 고유 1건 / 전체 1건":
    - text: 최신 공시 최신 고유 1건 / 전체 1건
    - img
- navigation:
  - button "홈":
    - img
    - text: 홈
  - button "종목":
    - img
    - text: 종목
  - button "테마":
    - img
    - text: 테마
  - button "관심":
    - img
    - text: 관심
  - button "정보":
    - img
    - text: 정보
  - button "설정":
    - img
    - text: 설정
- region "Notifications (F8)":
  - list
```

# Test source

```ts
  125 |               scalability: 'modular',
  126 |             });
  127 |       }
  128 |       if (action.startsWith('financials')) {
  129 |         return json(route, mode === 'missing'
  130 |           ? { source: 'SEC_XBRL', financials: { quarterly: [] } }
  131 |           : {
  132 |               source: 'SEC_XBRL',
  133 |               updatedAt: NOW,
  134 |               financials: {
  135 |                 quarterly: [
  136 |                   { period: '2026-Q2', revenue: 120_000_000, operatingIncome: -80_000_000, netIncome: -75_000_000, cash: 300_000_000, operatingCashFlow: -60_000_000 },
  137 |                   { period: '2026-Q1', revenue: 100_000_000, operatingIncome: -70_000_000, netIncome: -68_000_000, cash: 350_000_000, operatingCashFlow: -55_000_000 },
  138 |                 ],
  139 |                 ratios: { debtRatio: 40 },
  140 |               },
  141 |             });
  142 |       }
  143 |       if (action.startsWith('market-flow')) return json(route, { available: false, note: '미국 수급 제공기관 미지원' });
  144 |       if (action.startsWith('short-selling')) return json(route, { available: true, latest: { shortVolume: 1_000_000, ratio: 4.2, balance: 8_000_000 } });
  145 |       if (action.startsWith('news')) {
  146 |         return json(route, { news: mode === 'balanced' ? [{ title: '핵심 개발 일정 지연과 비용 증가 가능성', summary: '상용화 일정 확인 필요', source: 'Reuters', date: NOW }] : [] });
  147 |       }
  148 |       if (action.startsWith('disclosures') || action.startsWith('filings')) {
  149 |         const disclosures = mode === 'failure'
  150 |           ? [{ report: '핵심 양자 프로세서 개발 실패 및 일정 재검토', source: 'SEC', date: NOW }]
  151 |           : mode === 'missing'
  152 |             ? []
  153 |             : [{ report: '정부 연구기관과 양자 시스템 공급 계약 체결', source: 'SEC', date: NOW }];
  154 |         return json(route, { disclosures });
  155 |       }
  156 |     }
  157 | 
  158 |     if (path === '/api/notifications/price-alerts') return json(route, { alerts: [] });
  159 |     return json(route, { ok: true });
  160 |   });
  161 | }
  162 | 
  163 | function diagnostics(page: Page) {
  164 |   const errors: string[] = [];
  165 |   page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  166 |   page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  167 |   page.on('requestfailed', (request) => {
  168 |     const reason = request.failure()?.errorText ?? '';
  169 |     if (!reason.includes('ERR_ABORTED')) errors.push(`request:${reason}`);
  170 |   });
  171 |   return () => expect(errors, errors.join('\n')).toEqual([]);
  172 | }
  173 | 
  174 | test('RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers', async ({ page }) => {
  175 |   let mode: Mode = 'balanced';
  176 |   const clean = diagnostics(page);
  177 |   await installAnalysisMocks(page, () => mode);
  178 |   await page.addInitScript(() => localStorage.clear());
  179 |   await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');
  180 | 
  181 |   const hub = page.getByTestId('stock-analysis-hub');
  182 |   await expect(hub.getByText('AI 종합평가', { exact: true })).toBeVisible();
  183 |   await expect(hub.getByText('자체엔진', { exact: true })).toBeVisible();
  184 |   await expect(hub.getByText(/양자 기술 개발 역량|양자 기술 기대/)).toBeVisible();
  185 |   await expect(hub.getByText('기술력', { exact: true }).first()).toBeVisible();
  186 |   await expect(hub.getByText(/정부 연구기관과 양자 시스템 공급 계약 체결/).first()).toBeVisible();
  187 |   await expect(hub.getByText(/핵심 개발 일정 지연/).first()).toBeVisible();
  188 | 
  189 |   await hub.getByText('경쟁력 비교', { exact: true }).click();
  190 |   await expect(hub.getByText('IBM', { exact: true })).toBeVisible();
  191 |   await expect(hub.getByText('Google', { exact: true })).toBeVisible();
  192 |   await expect(hub.getByText('IonQ', { exact: true })).toBeVisible();
  193 |   await expect(hub.getByText('자료 필요', { exact: true }).first()).toBeVisible();
  194 | 
  195 |   await hub.getByText('재무 해석', { exact: true }).click();
  196 |   await expect(hub.getByText(/영업적자/).first()).toBeVisible();
  197 | 
  198 |   await hub.getByText('주가와 연결', { exact: true }).click();
  199 |   await expect(hub.getByText('52주 고점 대비', { exact: true })).toBeVisible();
  200 | 
  201 |   await hub.getByText('투자자가 궁금한 조건', { exact: true }).click();
  202 |   await expect(hub.getByText('왜 오를 수 있나?', { exact: true })).toBeVisible();
  203 |   await expect(hub.getByText('왜 떨어질 수 있나?', { exact: true })).toBeVisible();
  204 |   await expect(hub.getByText('기계적 관찰 가격', { exact: true })).toBeVisible();
  205 | 
  206 |   await hub.getByText('분석 신뢰도', { exact: true }).click();
  207 |   await expect(hub.getByText('경쟁사 최신 정량 비교자료', { exact: true })).toBeVisible();
  208 |   clean();
  209 | });
  210 | 
  211 | test('a newly confirmed development failure records the reason and lowers the outlook without manual prose', async ({ page }) => {
  212 |   let mode: Mode = 'positive';
  213 |   const clean = diagnostics(page);
  214 |   await installAnalysisMocks(page, () => mode);
  215 |   await page.addInitScript(() => localStorage.clear());
  216 |   await page.goto('/stock-info?asset=stock&market=US&ticker=RGTI');
  217 |   const hub = page.getByTestId('stock-analysis-hub');
  218 |   await expect(hub.getByText(/공급 계약 체결/).first()).toBeVisible();
  219 |   await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('sa-stock-analysis-history-v1:US:RGTI')));
  220 | 
  221 |   mode = 'failure';
  222 |   await page.reload();
  223 |   const updatedHub = page.getByTestId('stock-analysis-hub');
  224 |   await expect(updatedHub.getByText(/핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
> 225 |   await expect(updatedHub.getByText('기존 전망 변경', { exact: true })).toBeVisible();
      |                                                                   ^ Error: expect(locator).toBeVisible() failed
  226 |   await expect(updatedHub.getByText(/새 이벤트: 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();
  227 |   await expect(updatedHub.getByText(/최근 핵심 양자 프로세서 개발 실패/).first()).toBeVisible();

### stock-analyzer/test-results/info-analysis-hub-RGTI-ana-5c097-confidence-and-sector-peers/error-context.md
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: info-analysis-hub.spec.ts >> RGTI analysis hub explains score, events, financials, price, factors, confidence, and sector peers
- Location: e2e/info-analysis-hub.spec.ts:174:1

# Error details

```
Error: locator.click: Error: strict mode violation: getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true }) resolved to 2 elements:
    1) <p class="text-[10px] font-black text-muted-foreground">분석 신뢰도</p> aka getByRole('paragraph').filter({ hasText: '분석 신뢰도' })
    2) <span class="block text-sm font-black">분석 신뢰도</span> aka locator('span').filter({ hasText: /^분석 신뢰도$/ })

Call log:
  - waiting for getByTestId('stock-analysis-hub').getByText('분석 신뢰도', { exact: true })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e8]:
    - banner [ref=e9]:
      - heading "정보" [level=1] [ref=e10]
      - generic [ref=e11]:
        - button "정보" [ref=e12]
        - button "공부" [ref=e13]
      - generic [ref=e14]:
        - button "주식" [ref=e15]
        - button "코인" [ref=e16]
      - generic [ref=e17]:
        - button "국내" [ref=e18]
        - button "해외" [ref=e19]
    - main [ref=e20]:
      - generic [ref=e21]:
        - generic [ref=e22]:
          - heading "특이정보" [level=2] [ref=e23]
          - paragraph [ref=e24]: 해외 앱 종목 2개를 순환 확인합니다. 1주일 이내는 최신으로, 1주일이 지나면 보관함의 지난 정보로 표시됩니다.
        - generic [ref=e25]:
          - button "최신정보" [ref=e26]
          - button "보관함" [ref=e27]:
            - img [ref=e28]
            - text: 보관함
        - generic [ref=e31]:
          - img [ref=e32]
          - textbox [ref=e35]:
            - /placeholder: 종목·코인·제목·내용 검색
        - generic [ref=e36]:
          - button "전체" [ref=e37]
          - button "뉴스" [ref=e38]
          - button "호재" [ref=e39]
          - button "악재" [ref=e40]
          - button "중요공시" [ref=e41]
          - button "차트신호" [ref=e42]
        - generic [ref=e43]:
          - button "최신공시 리게티 컴퓨팅 RGTI 정부 연구기관과 양자 시스템 공급 계약 체결 다년 계약으로 실제 매출 전환 여부를 확인해야 합니다. SEC · 방금 전 1주일 이내" [ref=e44]:
            - generic [ref=e45]:
              - generic [ref=e47]:
                - generic [ref=e48]:
                  - generic [ref=e49]: 최신공시
                  - generic [ref=e50]: 리게티 컴퓨팅
                  - generic [ref=e51]: RGTI
                - paragraph [ref=e52]: 정부 연구기관과 양자 시스템 공급 계약 체결
                - paragraph [ref=e53]: 다년 계약으로 실제 매출 전환 여부를 확인해야 합니다.
              - generic [ref=e54]:
                - generic [ref=e55]: SEC · 방금 전
                - generic [ref=e56]: 1주일 이내
          - button "최신악재 리게티 컴퓨팅 RGTI 핵심 개발 일정 지연과 비용 증가 가능성 실패는 아니지만 상용화 일정 확인이 필요합니다. Reuters · 방금 전 1주일 이내" [ref=e57]:
            - generic [ref=e58]:
              - generic [ref=e60]:
                - generic [ref=e61]:
                  - generic [ref=e62]: 최신악재
                  - generic [ref=e63]: 리게티 컴퓨팅
                  - generic [ref=e64]: RGTI
                - paragraph [ref=e65]: 핵심 개발 일정 지연과 비용 증가 가능성
                - paragraph [ref=e66]: 실패는 아니지만 상용화 일정 확인이 필요합니다.
              - generic [ref=e67]:
                - generic [ref=e68]: Reuters · 방금 전
                - generic [ref=e69]: 1주일 이내
      - generic [ref=e71]:
        - img [ref=e72]
        - textbox [ref=e75]:
          - /placeholder: 해외 종목명·티커·한글명 검색
      - generic [ref=e76]:
        - generic [ref=e77]:
          - generic [ref=e78]:
            - paragraph [ref=e79]: 리게티 컴퓨팅
            - paragraph [ref=e80]: RGTI · 해외 · 출처 US_PROVIDER · 기준 2026. 8. 4. 오전 10:42:14 · 최신
          - button "관심종목" [ref=e81]:
            - img [ref=e82]
        - generic [ref=e84]:
          - generic [ref=e85]:
            - paragraph [ref=e86]: 현재가
            - paragraph [ref=e87]: $15
          - generic [ref=e88]:
            - paragraph [ref=e89]: 등락률
            - paragraph [ref=e90]: +3.40%
        - button "상세 분석" [ref=e91]:
          - text: 상세 분석
          - img [ref=e92]
      - generic [ref=e94]:
        - generic [ref=e95]:
          - generic [ref=e96]:
            - generic [ref=e97]:
              - img [ref=e98]
              - heading "AI 종합평가" [level=2] [ref=e100]
              - generic [ref=e101]: 자체엔진
              - generic [ref=e102]: 투자 권유 아님
            - paragraph [ref=e103]: 양자컴퓨팅 업종별 기준 · 2026. 8. 4. 오전 10:42:17
          - generic [ref=e104]:
            - generic [ref=e105]:
              - paragraph [ref=e106]: 종합점수
              - generic [ref=e107]: 56점
              - paragraph [ref=e108]: 중립
            - generic [ref=e109]:
              - paragraph [ref=e110]: 단기 전망
              - generic [ref=e111]:
                - img [ref=e112]
                - text: 중립~상승
            - generic [ref=e115]:
              - paragraph [ref=e116]: 위험도
              - generic [ref=e117]: 보통
              - paragraph [ref=e118]: 51점
            - generic [ref=e119]:
              - paragraph [ref=e120]: 분석 신뢰도
              - generic [ref=e121]: 82%
              - paragraph [ref=e122]: 4/5
          - generic [ref=e123]:
            - paragraph [ref=e124]: 핵심 한줄
            - paragraph [ref=e125]: “양자 기술 개발 역량은 확인되지만 상용화·수익성과 로드맵 이행 검증이 필요한 단계입니다.”
        - group [ref=e126]:
          - generic "AI 종합 분석 기술력·사업성·성장성·재무·주가·이벤트" [ref=e127] [cursor=pointer]:
            - generic [ref=e128]:
              - generic [ref=e129]: AI 종합 분석
              - generic [ref=e130]: 기술력·사업성·성장성·재무·주가·이벤트
            - img [ref=e131]
          - generic [ref=e134]:
            - generic [ref=e135]:
              - generic [ref=e136]:
                - generic [ref=e137]:
                  - generic [ref=e138]: 기술력
                  - generic [ref=e139]: 64점
                - paragraph [ref=e142]: 큐비트 규모·게이트 정확도·확장성 자료 반영 · 기술 이벤트 영향 -2점
              - generic [ref=e143]:
                - generic [ref=e144]:
                  - generic [ref=e145]: 사업성
                  - generic [ref=e146]: 63점
                - paragraph [ref=e149]: 실제 매출 확인 · 계약·사업 이벤트 영향 +6점
              - generic [ref=e150]:
                - generic [ref=e151]:
                  - generic [ref=e152]: 성장성
                  - generic [ref=e153]: 61점
                - paragraph [ref=e156]: 매출 증감 20.0% · 성장 이벤트 영향 +4점
              - generic [ref=e157]:
                - generic [ref=e158]:
                  - generic [ref=e159]: 재무건전성
                  - generic [ref=e160]: 35점
                - paragraph [ref=e163]: 영업적자 · 현금 소진 확인 필요
              - generic [ref=e164]:
                - generic [ref=e165]:
                  - generic [ref=e166]: 주가 흐름
                  - generic [ref=e167]: 57점
                - paragraph [ref=e170]: 당일 등락 3.40% · 52주 가격범위 60% 위치
              - generic [ref=e171]:
                - generic [ref=e172]:
                  - generic [ref=e173]: 촉매·이벤트
                  - generic [ref=e174]: 54점
                - paragraph [ref=e177]: 최근 분류 이벤트 2건 · 이벤트 순영향 +4점
            - generic [ref=e178]:
              - generic [ref=e179]:
                - generic [ref=e180]:
                  - img [ref=e181]
                  - text: 강점
                - list [ref=e184]:
                  - listitem [ref=e185]:
                    - generic [ref=e186]: "1"
                    - generic [ref=e187]: 기술력 양호
                  - listitem [ref=e188]:
                    - generic [ref=e189]: "2"
                    - generic [ref=e190]: 사업성 양호
                  - listitem [ref=e191]:
                    - generic [ref=e192]: "3"
                    - generic [ref=e193]: 정부 연구기관과 양자 시스템 공급 계약 체결
                  - listitem [ref=e194]:
                    - generic [ref=e195]: "4"
                    - generic [ref=e196]: 매출 20.0% 성장
              - generic [ref=e197]:
                - generic [ref=e198]:
                  - img [ref=e199]
                  - text: 약점
                - list [ref=e201]:
                  - listitem [ref=e202]:
                    - generic [ref=e203]: "1"
                    - generic [ref=e204]: 재무건전성 주의
                  - listitem [ref=e205]:
                    - generic [ref=e206]: "2"
                    - generic [ref=e207]: 핵심 개발 일정 지연과 비용 증가 가능성
                  - listitem [ref=e208]:
                    - generic [ref=e209]: "3"
                    - generic [ref=e210]: 영업적자 지속
            - generic [ref=e211]:
              - generic [ref=e212]:
                - paragraph [ref=e213]: 사업 단계
                - paragraph [ref=e214]: 초기 상용화·성장 투자 단계
              - generic [ref=e215]:
                - paragraph [ref=e216]: 매출 상태
                - paragraph [ref=e217]: 성장 중
              - generic [ref=e218]:
                - paragraph [ref=e219]: 성장 가능성
                - paragraph [ref=e220]: 보통
              - generic [ref=e221]:
                - paragraph [ref=e222]: 검증 필요
                - paragraph [ref=e223]: 큐비트·게이트 정확도
        - group [ref=e224]:
          - generic "경쟁력 비교 IBM · Google · IonQ 비교 준비" [ref=e225] [cursor=pointer]:
            - generic [ref=e226]:
              - generic [ref=e227]: 경쟁력 비교
              - generic [ref=e228]: IBM · Google · IonQ 비교 준비
            - img [ref=e229]
          - generic [ref=e232]:
            - paragraph [ref=e233]: 선택 종목은 현재 수집된 자료로 평가하고, 경쟁사는 정량자료가 없을 때 임의 점수를 만들지 않고 ‘자료 필요’로 표시합니다.
            - table [ref=e235]:
              - rowgroup [ref=e236]:
                - row "비교 기준 리게티 컴퓨팅 IBM Google IonQ" [ref=e237]:
                  - columnheader "비교 기준" [ref=e238]
                  - columnheader "리게티 컴퓨팅" [ref=e239]
                  - columnheader "IBM" [ref=e240]
                  - columnheader "Google" [ref=e241]
                  - columnheader "IonQ" [ref=e242]
              - rowgroup [ref=e243]:
                - row "기술 성숙도 ○ 자료 필요 자료 필요 자료 필요" [ref=e244]:
                  - cell "기술 성숙도" [ref=e245]
                  - cell "○" [ref=e246]:
                    - generic [ref=e247]: ○
                  - cell "자료 필요" [ref=e248]:
                    - generic [ref=e249]: 자료 필요
                  - cell "자료 필요" [ref=e250]:
                    - generic [ref=e251]: 자료 필요
                  - cell "자료 필요" [ref=e252]:
                    - generic [ref=e253]: 자료 필요
                - row "상용화 ○ 자료 필요 자료 필요 자료 필요" [ref=e254]:
                  - cell "상용화" [ref=e255]
                  - cell "○" [ref=e256]:
                    - generic [ref=e257]: ○
                  - cell "자료 필요" [ref=e258]:
                    - generic [ref=e259]: 자료 필요
                  - cell "자료 필요" [ref=e260]:
                    - generic [ref=e261]: 자료 필요
                  - cell "자료 필요" [ref=e262]:
                    - generic [ref=e263]: 자료 필요
                - row "확장성 ○ 자료 필요 자료 필요 자료 필요" [ref=e264]:
                  - cell "확장성" [ref=e265]
                  - cell "○" [ref=e266]:
                    - generic [ref=e267]: ○
                  - cell "자료 필요" [ref=e268]:
                    - generic [ref=e269]: 자료 필요
                  - cell "자료 필요" [ref=e270]:
                    - generic [ref=e271]: 자료 필요
                  - cell "자료 필요" [ref=e272]:
                    - generic [ref=e273]: 자료 필요
        - group [ref=e274]:
          - generic "이벤트 분석 분류 이벤트 2건 · 분석 변경 자동 추적" [ref=e275] [cursor=pointer]:
            - generic [ref=e276]:
              - generic [ref=e277]: 이벤트 분석
              - generic [ref=e278]: 분류 이벤트 2건 · 분석 변경 자동 추적
            - img [ref=e279]
          - generic [ref=e282]:
            - paragraph [ref=e283]: 저장된 이전 분석과 비교할 유의미한 변경이 없습니다. 데이터가 바뀌면 점수·전망·위험도 변경 이유가 여기에 표시됩니다.
            - generic [ref=e284]:
              - article [ref=e285]:
                - generic [ref=e286]:
                  - generic [ref=e287]:
                    - paragraph [ref=e288]: 핵심 개발 일정 지연과 비용 증가 가능성
                    - paragraph [ref=e289]: 2026. 8. 4. 오전 10:42:14 · 가능성 높음 · 근거 1건
                  - img [ref=e290]
                - generic [ref=e293]:
                  - generic [ref=e294]: 기술력 -2
                  - generic [ref=e295]: 사업성 -2
                  - generic [ref=e296]: 성장성 -2
                  - generic [ref=e297]: 재무 -1
                  - generic [ref=e298]: 주가 -2
                  - generic [ref=e299]: 촉매 -3
                  - generic [ref=e300]: 위험도 +2
                - paragraph [ref=e301]: 일정 지연은 실패와 다르지만 매출 전환 시점과 신뢰도를 낮출 수 있습니다.
              - article [ref=e302]:
                - generic [ref=e303]:
                  - generic [ref=e304]:
                    - paragraph [ref=e305]: 정부 연구기관과 양자 시스템 공급 계약 체결
                    - paragraph [ref=e306]: 2026. 8. 4. 오전 10:42:14 · 공식 확인 · 근거 1건
                  - img [ref=e307]
                - generic [ref=e310]:
                  - generic [ref=e311]: 사업성 +8
                  - generic [ref=e312]: 성장성 +6
                  - generic [ref=e313]: 재무 +3
