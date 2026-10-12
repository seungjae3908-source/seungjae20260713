# 원본 1분봉 연구 엔진 → 앱 백테스터 연결 (2026-10-11)

## 범위와 판정

중앙 허브는 Issue #1102, 작업은 기존 Draft PR #1534다. 이 변경의 부모 커밋은 `504dda6961bc46ba27612c3df07d3feb0a12b6c2`다. 기존 원본 분봉 재생·PERIOD·후보 심사·읽기 전용 결과 정제기를 재사용해 **관리자의 수동 기간 연구 요청 → 보관된 원본 검증 → 기간 재생 → 결과 조회/취소**를 연결한다.

기존 가격 백테스터는 그대로 유지하고 Backtests 화면에 별도 원본 분봉 연구 선택을 추가했다. main의 별도 4시장 수동 백테스터(#1733), 자동 연구 큐(#1732), PIT 관리자 포트(#1832)를 중복 구현하거나 이 Draft에 병합하지 않았다. 이 변경은 운영 서버에 설치되거나 설정된 상태가 아니다.

**실제 저장 자료 1,230건을 서비스와 기존 PERIOD 엔진으로 실행해 934건의 모델 계산과 296건의 자료 부족 차단을 확인했다. 이는 4시장 전체 역사적 데이터 확보 또는 수익성 PASS가 아니다.**

항상 다음 상태를 유지한다.

```text
profitabilityProven=false
OOSPassCount=0
trueMarketWideRecall=null
paperAdmissionAllowed=false
executionAuthority=NONE
```

Replit/Replit Agent, Ready/Merge, Staging/Production 배포, DB·계좌·서버 환경·PM2 변경, 실제 주문과 자동모의매매 활성화는 수행하지 않았다.

## 기존 엔진과 새 연결부

| 역할 | 구현 |
|---|---|
| 선택값·기간·비용 계약 | `packages/strategy-hypothesis/src/original-minute-backtest.js` 및 선언 파일 |
| 기존 재생 엔진 | `market-prediction-lab/src/four-market-original-minute-replay-v1.js` |
| 기존 다중 세션 기간 엔진 | `market-prediction-lab/src/four-market-original-minute-period-v1.js` |
| 기존 후보/Paper 연구 심사 | `four-market-original-minute-candidate-review-v1.js` |
| 기존 결과 정제 | `research-original-minute-diagnostic-readonly-v1.js` |
| 새 수동 작업 서비스 | `api-server/src/services/original-minute-backtest.service.ts` |
| 새 관리자 HTTP 경로 | `api-server/src/routes/original-minute-backtests.ts` |
| 앱 요청·응답 검증 및 화면 | `stock-analyzer/src/lib/original-minute-backtest.ts`, `components/original-minute-backtest-panel.tsx` |
| 실제 보관 자료 검증 실행기 | `api-server/scripts/verify-original-minute-backtest-capture-v1.ts` |

PERIOD 결과는 기존 읽기 전용 정제기와 심사를 거친다. 새 수동 실행 경로가 기존 PERIOD/SWEEP 보관 파일을 쓰거나 기존 Paper 심사 상태를 변경하지 않는다. 실자료 검증 실행기는 전체 현재 종목군을 순차 실행하기 위한 QA 코드이며 자동 연구 작업 큐가 아니다.

## 기간과 입력

시작일·종료일은 포함 날짜다. 1일·1주·1개월·3개월·6개월·1년·3년·5년·10년 달력 프리셋과 직접 날짜 입력을 지원한다. 기존 3년 예제나 기존 백테스터의 366일·20,000캔들 제한으로 선택 기간을 잘라 넣지 않는다. 새 계약은 날짜 유효성과 최대 36,600일의 입력 범위를 검사하며, 실제 재생은 실행 시간·자료 유무의 제한을 받는다.

KR/US는 거래소 현지 거래일과 제공된 거래 세션 달력을 사용하고 코인은 UTC 날짜를 사용한다. 현금 시장은 LONG·1배·펀딩 0만 허용한다. 코인 선물은 LONG/SHORT와 1~7배를 허용한다. 원본 1분봉에서 기존 변환기로 시간봉을 만들며, 주식의 1일봉 선택은 지원하지 않는 계약으로 명시적으로 거부한다.

고정 EMA 전략의 길이·손절·목표, 초기 원화 자본, 위험 비중, 레버리지, 진입/청산 수수료·스프레드·슬리피지·세금·지연비용·펀딩 및 환율 가정을 받는다. USD/USDT의 환율은 사용자가 명시해야 하고 KRW는 1이다. 화면의 비용 %를 내부 비율로 한 번 변환한다. 0% 비용은 미반영 가정으로 표시하며 빈 값은 0으로 바꾸지 않는다.

## 자료 범위와 고정 서버 경로

기본 역사적 경로 `HISTORICAL_PIT_ROSTER`는 기존 PIT 명부 검증을 유지한다. 실제 현재 코인 명부와 보관 자료를 사후 재생할 때만 별도의 `CURRENT_PROVIDER_ROSTER_SOURCE_ONLY` 범위를 사용한다. 이 범위는 전체 원본 명부 캡처의 SHA, 공급원·시장·종목, 관측 시각을 검증하며 현재 명부를 과거 상장/상장폐지 명부로 승격하지 않는다.

현재 코인 범위에는 다음 한계가 계속 붙는다.

- `historicalPITRosterChecked=false`: 과거 전체 명부 입증이 아니다.
- 당시 상장 기간·거래 가능 상태·원래 검색 시점의 공개 가능성을 입증하지 않는다.
- Upbit/Bitget의 지정된 원본 분봉 공급원 ID를 요구한다.
- 요청한 각 UTC 날짜에 원본 1,440개 슬롯을 요구한다. 거래 없는 분인지 증명하지 못한 간격을 가상의 봉으로 채우지 않는다.
- Bitget의 실제 한자 계약 코드도 원본 명부에 정확히 있는 경우에만 처리한다.
- 원본/세션/모델 SHA와 범위가 결과에 묶인다. SHA 일치는 파일 내용의 연결 확인이며 공급원 이용권의 독립 인증이 아니다.

HTTP 호출자가 파일 경로, 공급원 주소, 명부, API 키 또는 실행 권한을 지정할 수 없다. 서비스는 아래 **서버에서만 지정할 수 있는** 파일 배치를 읽는다.

```text
RESEARCH_ORIGINAL_MINUTE_SOURCE_ROOT/
  archive/
  CRYPTO_SPOT-roster.json
  CRYPTO_FUTURES-roster.json
  KR_STOCK-pit-manifest.json
  KR_STOCK-stock-calendar.json
  US_STOCK-pit-manifest.json
  US_STOCK-stock-calendar.json
```

이 환경 변수와 운영 파일 배치는 이번 작업에서 설정하지 않았다. 기존 읽기 전용 진단 보관 경로와도 별개다. 경로가 없으면 자료 부족으로 차단한다. 루트 0700, 일반 파일 0600, 심볼릭 링크·다중 하드 링크 거부, 디렉터리 조상 검사, 파일 크기·UTF-8 검증 및 제한된 읽기를 적용한다. 원본 archive 파일은 기존 불변 저장/검증 모듈로 읽는다.

## 수동 HTTP 작업과 화면

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/backtests/original-minute/runs` | 정확히 검증한 선택값으로 수동 작업 생성, 202 |
| GET | `/api/backtests/original-minute/runs/:runId` | 요청한 관리자 자신의 작업 조회 |
| DELETE | `/api/backtests/original-minute/runs/:runId` | 해당 연구 작업 취소 요청 |

기존 인증·기능 권한 검사 뒤 관리자 권한을 요구한다. 다른 관리자의 작업과 없는 작업은 모두 404다. 쿼리나 조회/취소 본문으로 설정을 덮어쓸 수 없고 응답은 `no-store`다. 오류에 내부 파일 경로나 원본 예외를 노출하지 않는다.

프로세스당 활성 작업 1개, 기본 실행 제한 10분, 종료 결과 보관 30분, 기본 최대 종료 결과 20개다. 작업은 메모리에 있어 프로세스 재시작 시 없어지며 여러 API 프로세스 사이에 공유되지 않는다. 장기 자료를 실제 운영 서비스로 처리하려면 별도 지속 저장·작업 라우팅·재개 설계와 승인된 설치가 필요하다.

취소·제한 시간은 기존 엔진에도 전달한다. 엔진이 실제 종료될 때까지 실행 자리를 차지하므로 취소 응답만 받고 다음 엔진을 중첩 실행하지 않는다. 화면은 자신이 시작한 작업만 조회하고, 입력 변경·페이지 이탈·늦게 도착한 POST/GET 응답을 처리해 이전 선택의 수익률이 새 선택에 남지 않게 한다.

완료 상태는 모델 계산 완료만 뜻한다. 결측·차단 결과에는 `report=null`을 유지하고 차단 사유와 누락 날짜·주식 거래 세션 수를 표시한다. 화면에 Paper 편입 또는 실행 활성화 기능을 추가하지 않았다.

## 모델 해석과 함께 수정한 오류

`CLOSE_EACH_SOURCE_SESSION` 정책으로 원본 세션 종료 시 포지션을 닫고, EMA 상태·자본·수익 보관액은 선택 기간 전체에 이어간다. 기존 비용 계산을 재사용한다. 고정 펀딩 입력은 청산 거래에 한 번 적용하는 단순 모델이며 실제 계약별 펀딩 이력이 아니다. 환율도 고정 가정이다.

모델 낙폭은 실현 거래 후 자본 기준으로 장중 미실현 손실을 포함하지 않는다. 고정 1/7/30/90/180/365/1095/1825/3650일 표는 전체 선택 기간 초기 자본을 분모로 한 후행 실현 손익이다. 기간별 별도 초기화 백테스트, 달력 프리셋 수익률 또는 독립 OOS 결과로 해석하면 안 된다. 선택 자료가 부족한 표의 값은 null이다.

검증 중 세 가지 연결 오류를 고쳤다.

1. 큰 비용 가정에서 기존 엔진의 자본 0 제한과 순손익이 모순될 수 있었다. 잔액+수익 보관액과 초기 자본+순손익, 수익률 사이의 정합성을 검사하고 모순이면 `ORIGINAL_MINUTE_MODEL_EQUITY_RECONCILIATION_FAILED`로 차단한다. 실제 BTC 자료의 극단 비용 사례도 차단을 재확인했다.
2. 주식 하루 중 일부 세션이 존재하면 누락 날짜 수는 0일 수 있다. 이때도 `missingExpectedStockSessions`를 서비스와 화면으로 전달해 빠진 거래 세션을 숨기지 않는다.
3. 첫 원격 브라우저 검사에서 중첩된 label/select의 옵션 텍스트 때문에 시장·기간 입력을 정확한 이름으로 찾는 4개 검사가 실패했다. 각 입력에 `useId` 기반 ID와 별도의 `label htmlFor`를 연결했다. 기존 검사 선택자와 제한 시간은 유지했고 수정된 제품 입력을 다시 검증한다. 엔진·서비스·실제 결과 파일은 이 수정에서 바뀌지 않았다.

## 실제 보관 자료 실행 결과

추가 시세 수집 없이 기존 2026-10-10 UTC 자료를 읽었다. 현재 명부는 Upbit KRW 294개와 Bitget 일반 코인 USDT 선물 466개다. 후자는 보관 당시 전체 원본 명부에서 RWA 계약을 제외한 범위다. 상장폐지를 포함한 과거 전체 종목 집합이 아니다.

| 실제 자료/추가 차단 확인 | 실행 수 | COMPLETED | BLOCKED_DATA |
|---|---:|---:|---:|
| Upbit 현물 LONG | 294 | 2 | 292 |
| Bitget 선물 LONG | 466 | 466 | 0 |
| Bitget 선물 SHORT | 466 | 466 | 0 |
| KR·US 원본/명부 부재 확인 | 2 | 0 | 2 |
| BTC 현물 1년·10년 부재 확인 | 2 | 0 | 2 |
| 합계 | 1,230 | 934 | 296 |

현물에서 원본 슬롯이 완전한 종목은 KRW-BTC와 KRW-XRP다. 나머지 292개는 검증되지 않은 분 간격으로 차단됐다. 국내·미국 주식은 역사적 PIT 명부 부재로 차단됐다. BTC의 2025-10-11~2026-10-10 요청에는 364일, 2016-10-11~2026-10-10 요청에는 3,651일의 원본이 없었고 요청 기간을 줄이지 않았다.

고정 모델은 5분봉 EMA 4/12, 손절 1%, 목표 2%, 초기 100만원, 위험 1%, 레버리지 1배다. 진입/청산 수수료 각각 0.05%, 스프레드 0.02%, 슬리피지 0.05%, 세금·추가 지연 0%, 선물 펀딩 0.01%를 가정했다. KRW 환율은 1, USDT는 고정 1,400원 가정이다. 이 값은 당시 실제 비용·환율 이력의 인증이 아니다.

같은 고정 모델에서 KRW-BTC LONG의 모델 순손익은 약 -57.72원, BTCUSDT LONG은 약 +2,246.08원, BTCUSDT SHORT는 약 -6,478.33원이었다. 이는 하루 사후 모델 예시로, 실제 체결 수익이나 전략 추천이 아니다. 서로 자본을 재사용하는 934개 결과를 하나의 포트폴리오 수익으로 합산하지 않는다.

전체 결과 파일은 `p3-actual-original-minute-backtests-20261011.json`이며 8,569,348바이트다. SHA-256은 `f415b6c55c729bedef98fe4d2d94e2d281095465dc1a460fd9fa91f40af014a0`이다. 1,230개 개별 결과, 선택·가정, 원본/모델/코드 해시를 포함한다. 이 파일의 핵심 코드 해시와 현재 파일 내용의 일치도 확인했다. 공급원 GET·금융 변경은 모두 0이었다. private 실제 결과와 원본 캔들은 Git에 넣지 않았다.

## 검증 근거

| 검증 | 결과 |
|---|---|
| 새 서비스·HTTP·화면 및 기존 Backtest/PIT 연결 그룹 | 55/55 PASS |
| 기존 Whole PIT Node 회귀 | 42개 파일, 456/456 PASS |
| 기존 Python selftest | 2개 PASS |
| API 및 프런트 타입 검사 | PASS |
| API 및 프런트 빌드 | PASS |
| 실제 결과의 프런트 요청/응답 전수 검증 | 1,230/1,230 PASS, 차단 report 296개와 미확인 기간 값 7,472개 null 유지 |
| 로컬 브라우저 렌더링 | 미실행: 실행 파일 부재, Chromium 다운로드가 HTML Site Unavailable 응답 |
| 원격 원본 엔진 전용 PIT CI | `c2187e0`, run `38131132688`에서 456/456 및 Python 2개 PASS. 이후 입력 라벨 수정은 엔진 파일을 변경하지 않음 |
| 원격 앱 CI | 첫 `c2187e0`에서 타입·단위·빌드 성공, 브라우저 160 PASS / 입력 라벨 4 FAIL. 수정 후 최종 커밋과 CI 결과는 #1102 및 #1534 댓글에 기록 |

주식 연결 성공은 별도의 **생성된 TEST_FIXTURE**로 검사했다. KR 005930과 US AAPL의 2026-09-18 정규장 분봉을 각각 390개 생성하고 고정 PIT 명부·세션 달력·archive를 통해 같은 PERIOD와 서비스에 연결했다. 두 결과 모두 COMPLETED이지만 `fixtureOnly=true`, `sourceClass=TEST_FIXTURE`, `RESEARCH_HOLD`다. 실제 주식 과거 자료 확보 성공으로 계산하지 않았다.

새 브라우저 검증은 데스크톱 1440px, 모바일 390/360px, 현금 시장 입력 제약, 결측 차단, 취소·늦은 응답, 조작된 수익성 응답 거부의 7개 시나리오이며 기존 Critical browser 목록에 포함했다. 합성 UI fixture이고 원격 공급원이나 주문을 호출하지 않는다. 보관된 실제 결과를 주입하는 별도 로컬 QA 경로 역시 기존 E2E 환경 플래그 아래에만 존재한다.

Application Fast CI는 개발용 검사이며, Ready/Merge 승격에 필요한 정식 Application CI 6개 Required 문맥을 대체하지 않는다. 이 Draft에서 Ready나 승격용 배포를 요청하지 않는다.

## 남은 작업

P0/P1의 핵심 차단은 4시장 과거 전체 PIT·상장폐지/거래종료 이력과 이용권, KR/US 실제 원본 분봉, 원하는 전 기간의 원본 확보 및 장기 보관이다. 현재 하루 가격이 있는 현재 종목군을 역사적 전체 시장의 분모로 사용할 수 없다.

P2의 전체 급등·급락 기회와 원래 T-minus 검색 성공률, P3의 실제 체결 가능성·시계열 환율/펀딩/세금 등 전체 비용 증거, P4의 동결 전략 독립 OOS·워크포워드는 아직 입증되지 않았다. P5 자동모의매매 폐루프 활성화는 이러한 입증과 별도 단계 승격 전에는 진행할 수 없다.

다음 데이터 작업은 이미 보관한 완전한 하루를 재수집하는 것이 아니라, 부족한 역사적 종목·날짜·세션과 공급권을 확보해 같은 archive와 엔진에 연결하는 것이다. 자료가 없는 구간은 계속 차단하며 기회 0건 또는 수익률 0%로 만들지 않는다.

## 2026-10-12: 기존 원본 부분 재수집의 버전 교착 오류 수정 (Draft only)

기존 코드는 원본 1m이 부분적으로 보관된 상태에서 `--retry-partial`로
동일 종목/일자를 재수집하면 as-of 취득시각이 달라 새 불변 버전이
만들어지고, 이후 기본 백테스터 조회는 중복 버전을 검출해 차단한다.
더 많이 확보한 원본도 자동 선택할 수 없어 복구가 사실상 막히는
문제였다.

변경된 원칙:

- 명시적 `--read-public --retry-partial --expected-existing-sha <기존 원본 SHA256>`
  세 조건이 모두 있을 때에만 기존 부분 데이터 재수집을 허용한다.
  단일 PIT gap task executor 및 단건 원본 수집 CLI 양쪽에 적용한다.
- 네트워크 GET **이전**에 기존 유일한 불변 원본의 SHA256과 정확히
  일치하는지 검사한다. 기존 파일 부재·해시 불일치·다중 수정본은
  읽지 않고 차단한다.
- 재수집된 1m이 기존 원본의 모든 분봉을 그대로 포함하는지, 기존
  시가/고가/저가/종가/거래량이 정확히 일치하는지 검사한다.
  하나라도 사라지거나 값이 바뀌면 새 보관 파일을 만들지 않는다.
- 새 분봉이 **실제로 추가되지 않으면** 원본을 다시 쓰지 않는다.
  취득시각만 달라졌다는 이유로 불필요한 버전을 생성하지 않는다.
- 보존된 기존 봉과 일치하면서 추가된 원본 봉이 있을 경우에만
  신규 원본 버전을 생성한다. 이때 응답은
  `RETROSPECTIVE_IMMUTABLE_SUPERSET_AWAITING_REVISION_REVIEW`이고,
  기존/신규 SHA를 함께 반환한다. 조회 기본 경로는 여전히
  `MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION`으로 차단하고
  명시적으로 선택한 SHA로만 개별 분석할 수 있다. 자동으로
  과거 수익성이나 PIT 커버리지를 승격하지 않는다.

Upbit 공식 문서상 거래가 없으면 1분 캔들이 생성되지 않을 수 있다.
이 수정은 누락분을 인위적 OHLC로 채우지 않으며, 데이터 조회가
완료된 것과 과거 시점 게시 가능성·상장폐지 PIT·독립 OOS/워크포워드
증거를 동일시하지 않는다. 운영 서버에 실행하거나 실제 시장
데이터를 새로 수집하지 않았다. 별도의 명시 승인/운영 설정 전까지
`executionAuthority=NONE`, `profitabilityProven=false`.

### 여러 원본 수정본 읽기 전용 확인

새 `auditResearchMinuteSessionRevisionsV1` API와 전용 CLI는 디스크에 이미 보관한
각 수정본의 해시·1분봉 개수·취득 시각을 검증하고, 중복 구간 OHLCV 가격 충돌을
찾아낸다. 어느 수정본이 다른 모든 버전의 봉을 완전하게 포함하는 경우에만
`STRICT_NATIVE_MINUTE_SUPERSET_REQUIRES_REVIEW` 상태로 **검토용 SHA**를 보여준다.

```bash
node market-prediction-lab/scripts/audit-research-minute-revisions-v1.mjs \
  --root /private/minute-archive --market CRYPTO_SPOT \
  --symbol KRW-BTC --day 2026-09-18
```

이 도구는 네트워크 GET·파일 쓰기·금융 주문을 수행하지 않는다. 캔들 값은
출력하지 않으며, 과거 source/PIT/이용권 인증이나 독립 OOS 증명으로
승격하지 않는다. 기존 조회는 다중 수정본을 자동 선택하지 않는다.

## 2026-10-12 — 선택 기간별 증분 원본 복구 계획 보강 (Draft only)

기존 31일 범위 `auditResearchMinuteArchiveWindowV1`는 원본 세션이 아예
없는 날짜만 `missingCollectionPlan`에 내보냈다. 반면 일부 저장된
1분봉은 수량만 세었으므로 단일 원본 버전 기준 해시를 요구하는
`--retry-partial --expected-existing-sha`와 연결되지 않았다.

이번 수정은 **추가 공급원 요청 없이**, 원본 SHA-256을 검증한 청크 결과에서
다음 네 분류를 수집한다.

1. `missingCollectionPlan` — 원본 자체가 없는 일자/거래 세션,
   증분 원본 수집 **검토** 대상.
2. `partialRetryReviewPlan` — 원본 1분봉이 일부 있으며 고유한 단일
   원본 SHA와 남은 불명확한 분 슬롯 수를 함께 돌려준다.
   실제 재수집에는 사용자의 별도 공개 읽기 승인, 정확한 기존 원본
   해시, 거래소 당시 상장 상태, 공급원 이용권이 필요하다.
3. `revisionReviewPlan` — 여러 불변 원본 버전이 존재. SHA 자동 선택을
   하지 않고 별도 revision auditor 검토만 허용한다.
4. `unreadableSourceReviewPlan` — 파일 손상·불변 원본 출처와
   거래 세션 불일치. 단순 미수집으로 간주하지 않고 차단한다.

국내·미국주식의 거래일과 장전/정규/시간외 세션은 현지 거래일 기준이며,
현재 허가된 역사적 원본 1분봉 공급자가 없는 상태이므로
`proposedProvider=null`을 유지한다. 코인현물은 Upbit, 선물은 Bitget
공개 과거 데이터 **후보**로만 표시하고 네 시장 공통으로
`publicHistoryGETAuthorized=false`, `autoExecuteAllowed=false`,
`providerGETCount=0`, `profitabilityProven=false`다.

기존 CLI의 생성 전용 개인 보고서에도 이 네 구분과 원본 SHA를 보존하고
표준 출력에는 복구 검토 건수만 표시한다. 대상 기간을 3년으로
고정하지 않으며 1일~10년 이상의 지정 기간도 기존 최대 31일
청크/이어받기 정책을 그대로 적용한다. 실제 데이터 수집,
원본 파일 수정 또는 운영 배포는 이번 코드 QA에서 수행하지 않는다.

### 2026-10-12 — 전 종목 PIT 일별 보고서로 원본 SHA 복구 티켓 전달

한 종목/선택 기간의 `partialRetryReviewPlan`을 이미 구현된
`auditHistoricalPITMinuteArchiveChunkV1`의 20종목 단위 PIT 원본
보고서로 연결했다. 이어서 전체 일자 `summarizeHistoricalPITMinuteDayPagesV1`
에서 모든 회원명부 종목/원본 세션의 누락 원본 SHA 티켓 개수와
상위 100개 요약을 검증한다.

부분 수집의 원본 SHA, 분봉 수, 남은 미검증 슬롯을 정확한
종목·시장·세션 날짜와 묶는다. 누락 건과 부분 수집 건은 별개이므로
이전에 존재하던 부분 원본을 새 `MISSING_ORIGINAL_ONE_MINUTE_SESSION`
또는 자동 실행 가능한 GET 작업으로 잘못 전환하지 않는다.

`planPITNativeMinuteSourceGapsV1`는 `candidateTasks` (진짜 원본
세션 부재)와 `partialRetryReviewTasks` (이미 가진 분봉의
**수동 해시 대조 검토**)를 따로 표시한다. 후자는 기존의
`runPlannedPITMinuteSourceTaskV1` 자동 대상에 추가하지 않는다.
재수집하려면 사용자의 별도 명시적 공개 데이터 조회 승인,
원본 SHA 리뷰, 공급자별 비용·무료 제한·이용권 확인이 필요하다.

국내/해외주식·코인현물은 매수만, 코인선물은 LONG/SHORT라는
방향 정책은 그대로이고 이 코드에서 매매 신호 또는 주문은
발생하지 않는다. `providerGETCount=0`, `executionAuthority=NONE`,
`profitabilityProven=false`와 Draft 범위가 유지된다.


### 2026-10-12 — SHA 서명된 부분 재수집 검토 목록을 단건 실행기로 연결

이전 \`runPlannedPITMinuteSourceTaskV1\`는
\`--retry-partial --expected-existing-sha\`를 해석하면서도
항상 \`candidateTasks\`(원본 **미보관** 세션)만 골랐다.
따라서 부분 저장된 원본의 SHA를 정확히 지정해도 대상 종목을
올바르게 선택하지 못했다.

수정 후 **처음부터 없던 원본**은 \`candidateTasks\`와
\`candidateTaskDigestSha256\`을 쓰고, **부분 저장된 원본**은
\`partialRetryReviewTasks\`와 \`partialRetryReviewDigestSha256\`을
별도로 사용한다. 두 해시는 교환 불가능하고 각 목록은 기존
전체 PIT 명부/20종목 페이지 영수증으로 다시 확인한다.

부분 재수집의 실제 공개 소스 호출은 승인받은 단건 요청에서
\`--read-public --retry-partial --expected-existing-sha <사전 검토된 원본 SHA>\`
세 조건을 함께 명시해야 한다. --expected-task-digest에는
해당 검토 페이지의 \`partialRetryReviewDigestSha256\`을 넣는다.

각 호출은 단일 코인현물/코인선물 시장·종목·UTC 하루 한 건,
전용 개인 root·용량 제한·배타적 원본 작성 잠금이 적용된다.
기존 원본 SHA가 이미 바뀌었거나, 기존 OHLCV 1분봉이
사라지거나 가격이 모순되면 저장을 차단한다. 새 분봉이
추가된 경우에는 과거 버전을 건드리지 않고 새로운 원본
수정본으로만 저장하며, 이후 기본 백테스터 경로는 여전히
명시적인 수정본 선택 없이 진행할 수 없다.

현금 주식 시장은 원본 분봉 공급권이 확보되지 않았으므로
이 코인 전용 공개 수집 경로를 사용하지 않는다. 원본
1분봉에 없는 체결·호가·OI/펀딩 정보가 복구되는 것으로
해석하지 않으며, 독립 OOS/워크포워드/전체 비용/당시
검색 가능성/과거 PIT 명부 증빙이 없으면 여전히 수익성
PASS는 0건이다.

이번 작업에서는 **코드와 격리된 공급원 mock QA만 실행**하며
실제 거래소 GET, 운영 서버의 과거 데이터 다운로드·보관,
텔레그램·Paper·실주문을 실행하지 않았다.


### 2026-10-12: partial 1m archive no-network preflight (Draft)

The existing native source task previously required the public-read flag even
when an operator only wanted to inspect a previously reviewed partial source.
The single-task executor now verifies the selected PIT day/page digest,
current immutable archive SHA, source revision count and native 1m counts
before permission for ANY Upbit/Bitget GET. The private PIT task CLI and
single-symbol native CLI both support retry-partial + expected-existing-sha
without read-public. Such a run returns a blocked no-consent receipt with
providerGETCount=0, publicGETAttempted=false and the reviewed source SHA.

A real native market GET still requires the explicit read-public flag. The
same immutable-only semantics and no-Paper/no-Live/no-economic-proof gate
remain. Stock markets still require licensed original-minute sources.


### 2026-10-12 — Bitget V2 역사적 1분봉 짧은 페이지 순회 수정

기존 \`collectBitgetCandles\`와 Mark/Index 보조 시세 수집기에는
\`payload.data.length < 200\`이면 수집을 종료하는 조건이 있었다.
Bitget V2 과거 캔들 API는 최대 200건을 반환할 수 있지만 짧은
페이지는 더 오래된 원본 자료가 없다는 증거가 아니다. 특히 1분봉의
유동성 부족·상품 기간·공급원 응답 제한 상황에서 데이터가 더
이전 날짜에 존재하는데도 중간에서 멈출 수 있었다.

이번 수정은 명시적 \`startTime\`까지 **실제로 도달했는지**로
페이지 완료 여부를 판단한다. 짧은 페이지가 오면 이전 페이지에서
받은 가장 오래된 원본 timestamp를 배타적 \`endTime\`으로
다시 조회하여 한 봉도 건너뛰지 않는다. 공급원 빈 페이지 또는
명시된 요청 예산을 소진했는데도 시작 시점에 도달하지 못하면
\`BITGET_HISTORY_RANGE_INCOMPLETE\`/
\`BITGET_HISTORY_PAGE_BUDGET_EXCEEDED\`로 구분하여 차단한다.

모든 콜렉터에는 엄격한 요청 예산 \`maxPages\` 기본 512,
범위 1~2048이 적용되며 \`requestedProviderPages\`를 실제
collector 단위 API \`get\` 호출 수로 기록한다. 이는 HTTP 재시도
횟수까지 포함한 총 요청 수가 아니며, 기존 실제 공급원 데이터를
다운로드했다는 의미도 아니다. 짧은 페이지·빈 페이지·중복·
최대 요청 예산·mark/index를 mock으로 검사하고, 과거 PIT/
실제 체결/OOS 수익성 증명과 구분한다.

실제 과거 데이터의 무료 이용 가능 범위 및 회원 대상 재배포
권한은 별도로 확인해야 한다. 이 Draft에서는 운영 서버의
과거 1분봉을 새로 받거나 API를 호출하지 않았다.


Historical Bitget V2 `BITGET_HISTORY_PAGE_BUDGET_EXCEEDED` is now
classified as an expected blocked original-source coverage failure by the
Research Center's public-source error registry, **not** a software-internal
exception or zero market opportunities. Unknown implementation errors still
surface distinctly for developer repair.
