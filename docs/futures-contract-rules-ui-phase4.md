# Phase 4 · 선물 계약 규칙 연결과 리스크 UI 검증

## 1. 범위

Phase 4는 Bitget 공개 계약 설정을 읽어 Phase 3의 preview-only 리스크 엔진에 전달하고, 리스크 입력 UI와 데스크톱·모바일 렌더링을 검증하는 작업이다.

포함 범위:

- Bitget 공개 contracts 응답 정규화
- 수량 단위, 최소 수량, 최소 명목금액, 가격 단위, 레버리지 한도 연결
- 계약 규칙과 시장 데이터 상태에 따른 분석 시나리오 차단
- 리스크 입력 상태와 비동기 요청 안정화
- Playwright fixture 기반 브라우저 검증
- 기초 접근성 점검

제외 범위:

- 실제 주문 및 자동매매
- 실제 계좌·포지션 연동
- 백테스트, 모의체결, 거래일지, AI 복기
- WebSocket
- DB·migration
- 환경변수 및 운영 배포
- 권한 체계 전면 개편
- 하단 내비게이션 변경

## 2. 공개 데이터 API

사용하는 거래소 API:

```text
GET /api/v2/mix/market/contracts
productType=USDT-FUTURES
symbol=<SYMBOL>
```

서버 공개 API:

```text
GET /api/crypto/futures/:symbol/contract-rules
```

정상 응답은 다음 안전 속성을 포함한다.

```json
{
  "ok": true,
  "publicDataOnly": true,
  "orderCapability": false,
  "data": {}
}
```

이 서비스는 API Key, Secret, Passphrase, 계좌, 포지션, 주문 권한 또는 자동매매 설정을 사용하지 않는다.

## 3. Bitget 실제 필드 매핑

`GET /api/v2/mix/market/contracts`의 문서화된 필드만 사용한다.

| 앱 필드 | Bitget 필드 | 변환 |
|---|---|---|
| `symbol` | `symbol` | 대문자 문자열 |
| `quantityStep` | `sizeMultiplier` | 0보다 큰 유한 숫자 |
| `minimumQuantity` | `minTradeNum` | 0보다 큰 유한 숫자 |
| `minimumNotional` | `minTradeUSDT` | 0보다 큰 유한 숫자 |
| `quantityPrecision` | `volumePlace` | 0 이상의 정수 |
| `pricePrecision` | `pricePlace` | 0 이상의 정수 |
| `priceStep` | `priceEndStep`, `pricePlace` | `priceEndStep × 10^-pricePlace` |
| `minimumLeverage` | `minLever` | 0보다 큰 유한 숫자 |
| `maximumLeverage` | `maxLever` | 0보다 큰 유한 숫자 |
| 거래 가능 상태 | `symbolStatus` | `normal`만 live 후보 |
| `updatedAt` | 최상위 `requestTime` | ISO 시각 |

Bitget 문서에서 `sizeMultiplier`는 주문 수량이 따라야 하는 배수이고, `volumePlace`는 수량 소수점 자릿수다. `priceEndStep`은 가격 단계 길이이며 `pricePlace`와 함께 실제 가격 단위를 계산한다.

### 매핑하지 않는 필드

contracts 응답에서 확인되지 않은 값은 추측하지 않는다.

- `maintenanceMarginRate`: `null`
- `contractSize`: `null`

유지증거금률은 별도의 포지션 등급 API와 명목 구간에 따라 달라질 수 있다. Phase 4는 contracts 응답만 계약 규칙의 자동 입력 근거로 사용하므로 유지증거금률을 거래소 값처럼 만들지 않는다.

## 4. null 및 비정상 값 처리

다음 값은 `null`로 정규화한다.

- 필드 누락
- 빈 문자열 또는 공백 문자열
- 숫자로 변환할 수 없는 문자열
- `NaN`
- `Infinity`, `-Infinity`
- 음수 수량·가격·최소값·레버리지
- 정수가 아닌 precision

0의 처리:

- precision은 0이 유효하다.
- 수량 단위, 최소 수량, 최소 명목금액, 레버리지는 0을 유효한 거래 규칙으로 사용하지 않는다.
- 확인할 수 없는 필드는 임의 기본값으로 대체하지 않는다.

필수 수량 규칙이 없으면 다음 경고를 반환한다.

```text
거래소 최소 주문 규칙을 확인할 수 없습니다.
```

## 5. 계약 상태와 캐시

계약 규칙 상태:

- `live`: Bitget 응답 시각이 유효하고 `symbolStatus=normal`
- `delayed`: 응답 시각이 설정된 신뢰 구간보다 오래됨
- `cached`: 공급자 장애 시 마지막 정상 캐시 반환
- `insufficient`: 응답 시각 누락, 비정상 상태, 필수 정보 부족
- `error` 또는 `disconnected`: 호출 계층에서 오류 상태로 전달 가능

`listed`, `maintain`, `limit_open`, `restrictedAPI`, `off` 등 `normal`이 아닌 상태는 분석 진입 가능 판정에 사용하지 않는다.

캐시 정책:

- 정상 계약 규칙 TTL: 10분
- 동일 심볼 중복 요청은 in-flight Promise 공유
- 갱신 실패 시 기존 정상 캐시가 있으면 `cached`와 경고 반환
- 캐시가 없고 공급자 호출이 실패하면 안전한 503 응답

## 6. 수량 단위 처리

리스크 엔진은 다음 두 규칙 중 더 엄격한 단위를 사용한다.

```text
precisionStep = 10^-quantityPrecision
effectiveQuantityStep = max(quantityStep, precisionStep)
```

최종 수량:

```text
recommendedQuantity = floor(rawQuantity / effectiveQuantityStep)
                    × effectiveQuantityStep
```

부동소수점 오차를 줄이기 위해 정수 스케일 단위로 변환해 내림한다.

검증 예:

```text
rawQuantity = 0.019999999
quantityStep = 0.001
quantityPrecision = 3
recommendedQuantity = 0.019
```

수량을 내린 뒤 다음 항목을 다시 계산한다.

- 진입 명목금액
- 진입 수수료
- 손절 청산 수수료
- 양방향 슬리피지
- 예상 펀딩 비용
- 최대 예상손실
- 필요 증거금
- 목표가별 순예상수익과 손익비

최종 조건:

```text
estimatedMaximumLoss <= maximumRiskAmount
```

수량 단계가 있을 때 조건을 초과하면 제한된 반복 안에서 한 단계씩 더 줄인다.

## 7. 최소 수량과 최소 명목금액

`minimumQuantity`와 `minimumNotional`은 내림 완료 후 최종 수량으로 검사한다.

- 최종 수량이 `minimumQuantity` 미만이면 `MINIMUM_QUANTITY`
- 최종 진입 명목금액이 `minimumNotional` 미만이면 `MINIMUM_NOTIONAL`

거래소 규칙이 null이면 가짜 최소값을 만들지 않는다. 계산 결과는 제공할 수 있지만 규칙 미확인 경고가 포함되고 계약 규칙 상태가 live가 아니면 분석 진입 판정은 차단한다.

## 8. 레버리지 제한

### 앱 안전 제한

```text
crypto-futures 앱 안전 레버리지 상한 = 10배
```

입력 레버리지가 앱 안전 제한을 초과하면:

```text
LEVERAGE_EXCEEDS_APP_LIMIT
```

### 거래소 제공 제한

`maxLever`가 실제 응답에서 유효하게 제공될 때만 거래소 최대 레버리지로 사용한다.

입력 레버리지가 거래소 제한을 초과하면:

```text
LEVERAGE_EXCEEDS_EXCHANGE_LIMIT
```

앱 제한과 거래소 제한은 서로 다른 정책이다. 거래소가 더 높은 레버리지를 허용해도 앱 안전 제한을 초과하면 분석 진입 판정은 차단한다. `maxLever`가 null이면 임의 거래소 최대치를 표시하지 않는다.

## 9. 리스크 엔진 연결

계약 규칙이 `live`일 때 UI가 다음 값을 preview API에 자동 전달한다.

- `quantityStep`
- `quantityPrecision`
- `minimumQuantity`
- `minimumNotional`
- `maintenanceMarginRate` (`null` 유지)
- `maximumLeverage`
- `contractRulesStatus`
- `appMaximumLeverage=10`

계약 규칙 상태가 다음이면 `CONTRACT_RULES_NOT_LIVE`로 차단한다.

- `cached`
- `delayed`
- `disconnected`
- `error`
- `insufficient`

cached 데이터는 화면에서 확인할 수 있지만 진입 가능 분석에는 사용하지 않는다.

## 10. UI 안정화

`TradingRiskPreviewPanel`은 계약 규칙을 읽기 전용으로 표시한다.

표시 항목:

- 계약 규칙 상태
- 수량 단위
- 최소 수량
- 최소 주문금액
- 가격 단위
- 거래소 최대 레버리지
- 앱 안전 레버리지
- 유지증거금률 출처
- 마지막 업데이트 시각
- warnings

입력 안정화:

- 빈 문자열과 소수점 입력 중간 상태 보존
- 일반 양수 입력에서 마이너스 차단
- 펀딩비와 실현손익에서만 마이너스 허용
- 지수 표기 문자 제거
- `inputMode=decimal`로 모바일 숫자 키보드 유도
- markPrice 및 fundingRate 자동 입력 후 사용자 수정 보호
- 손절·목표 수동 수정 후 방향 또는 시세 갱신으로 무단 덮어쓰기 금지
- 종목 변경 시 이전 결과와 입력 자동 상태 초기화
- 요청 중복 클릭 차단
- AbortController로 이전 요청 취소
- 요청 순번으로 최신 응답만 반영
- API 오류 시 이전 성공 결과 제거

계산 불가능 값은 0으로 표시하지 않고 `계산 불가`로 표시한다.

## 11. 브라우저 검증

Playwright Chromium과 API fixture를 사용한다. 실제 Bitget 네트워크 상태에 따라 브라우저 테스트가 흔들리지 않도록 다음 요청을 mock한다.

- `GET /api/crypto/futures/BTCUSDT/snapshot`
- `GET /api/crypto/futures/BTCUSDT/contract-rules`
- `POST /api/trading/risk/preview`
- 워크스페이스가 사용하는 ticker, candle, status 보조 요청

검증 viewport:

- 데스크톱: 1440×900
- 모바일: 390×844
- 소형 모바일: 360×740

자동 검증 항목:

- 실제 코인 선물 워크스페이스 렌더링
- 시장 상태 패널과 리스크 패널 순서
- 계약 규칙 표시
- markPrice 및 fundingRate 자동 입력
- 롱·숏 계산 흐름
- 차단 사유와 계산 불가 표시
- 실제 주문 미전송 안내
- 입력 label 연결
- Tab 포커스 이동
- 버튼 터치
- 경고 영역 스크롤
- 가로 스크롤 없음
- console error와 uncaught exception 없음
- 정상 fixture 흐름에서 API 4xx/5xx 없음
- 계약 규칙 503 및 null 표시 시 이전 결과가 최신처럼 남지 않음

CI 실행 전 결과는 미검증이며, 최종 PR 본문과 완료 보고에는 실제 GitHub Actions 결과만 기록한다.

## 12. 모바일 검증

반응형 입력 그리드:

- 360px: 1열
- 380px 이상: 2열

카드와 결과 영역에 `min-width: 0`, 줄바꿈, 제한 높이 스크롤을 적용해 화면 밖 잘림과 가로 overflow를 방지한다.

모바일 소프트 키보드가 실제 기기에서 열린 상태의 viewport 축소·복원 동작은 CI Chromium에서 완전하게 재현하기 어려우므로 별도 실제 기기 검증 전까지 미검증으로 남긴다.

## 13. 접근성 기초 점검

- 모든 숫자 입력에 고유 id와 연결된 label
- 버튼에 텍스트 또는 `aria-label`
- 롱·숏 선택에 `aria-pressed`
- 계산 중 버튼에 `disabled`, `aria-busy`
- 상태 배지에 텍스트 포함
- 차단 영역에 `role=alert`
- 경고·안내 영역에 `role=status`
- 색상뿐 아니라 제목과 문장으로 상태 전달
- `focus-visible` 윤곽선 유지
- 숫자 단위와 퍼센트·소수 계약을 화면에 명시

전문 접근성 감사와 실제 스크린리더 조작은 이번 단계에서 미검증이다.

## 14. 테스트

자동 테스트 그룹:

- Phase 2 공개 선물 데이터 회귀 테스트
- Phase 3 리스크 엔진 회귀 테스트
- Phase 4 계약 규칙 정규화 테스트
- Phase 4 수량·레버리지·상태 연동 테스트
- 공개 계약 규칙 API 스모크 테스트
- 기존 리스크 preview API 스모크 테스트
- Playwright 데스크톱·모바일 브라우저 테스트

API 스모크에서 확인하는 안전 조건:

- 정상 200
- 잘못된 심볼 400
- 공급자 장애 및 캐시 없음 503
- 공개 데이터 전용 표시
- `orderCapability=false`
- 주문 관련 필드 없음
- stack trace, API Key, Secret, Authorization 문자열 미노출

## 15. 실제 주문과 분리

신규 계약 규칙 서비스와 라우터는 다음 파일을 import하거나 호출하지 않는다.

```text
api-server/src/routes/crypto-auto.ts
```

신규 API는 GET 공개 데이터만 사용하며 주문 endpoint, 개인 인증 헤더, 계좌 조회, 포지션 조회를 호출하지 않는다. 리스크 API는 계속 다음 값을 반환한다.

```json
{
  "mode": "preview-only",
  "orderSubmitted": false
}
```

## 16. 미검증 항목

CI 및 실제 검증 전에는 다음을 미검증으로 기록한다.

- GitHub Actions 최종 타입검사·테스트·빌드 결론
- 3개 viewport의 실제 Playwright 실행 결과
- 실제 GitHub Actions screenshot·trace artifact 생성 여부
- 장시간 Bitget 장애 후 캐시 만료 동작
- 실제 모바일 소프트 키보드 동작
- 스크린리더와 전문 접근성 감사
- 실제 거래소 유지증거금 구간

운영 서버 배포는 Phase 4 범위에 포함되지 않는다.
