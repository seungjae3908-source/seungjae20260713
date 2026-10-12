# 4시장 원본 1분봉 수집 — 격리 Draft v1 (2026-10-12)

## 범위와 현재 한계

- 기존 120초 시장 감시 워커와 별도인 원본 1분봉 수집·저장 시범 경로입니다. **미활성화·미배포**이며 Vultr 시스템에 cron/systemd timer, 폴더, DB, API key, 운영 서버 설정을 설치하지 않습니다.
- KR_STOCK / US_STOCK / CRYPTO_SPOT / CRYPTO_FUTURES 네 시장 식별자를 공통 검증합니다. 실제 HTTP 수집기는 **Upbit KRW 현물, Bitget USDT 선물**에 대해서만 준비됩니다. KR/US 주식은 공급원 계약·접근 권한·PIT/기업행위·거래소 세션 검증 전까지 BLOCKED_STOCK_FEED_NOT_CONFIGURED로 차단합니다.
- **운영 자동 수집은 미완성**입니다. 이 PR은 운영자가 명시적으로 승인한 최대 16개 작업의 1회 수집을 구현합니다. 향후 전체종목 로스터, 영구 작업 큐, 중단 복구, 실제 서비스 타이머 및 스토리지 검증이 필요합니다.
- 라이브/Paper 주문이나 DB·PM2·systemd·Secrets, Telegram 설정은 변경하지 않습니다. 독립 OOS·경제적 수익성은 미입증입니다.

## 1분봉 원본·안전 계약

- UTC 1분 경계의 완료된 봉만 수집. 작업당 최대 120분, 최대 16개 요청; HTTP 응답당 512KiB, 요청당 8초, 요청 간 최소 300ms.
- Upbit 공식 GET /v1/candles/minutes/1 의 candle_date_time_utc는 봉 시작 시각이고 timestamp는 마지막 체결시각입니다. 거래 없는 시간에는 캔들이 없을 수 있어 결측을 임의 0 거래량이나 전봉 복제로 채우지 않습니다.
- Bitget 공식 GET /api/v2/mix/market/history-candles 에 granularity=1m, productType=USDT-FUTURES 및 시간창/최대 200개를 적용합니다. 종료 경계로 추가 반환된 봉은 원본 선택 기간에 섞지 않습니다.
- 고정 공식 공개 GET만 허용하고 redirect:error, OHLCV/중복/미완성 봉 및 429/5xx 실패를 차단합니다. 429를 조기 재요청하지 않으며 계좌·주문·키 호출 0.
- 서버 전용으로 **이미 존재하는 0700 절대경로 원본 저장 루트**가 필요합니다. 하위 폴더는 0700, JSON 파일은 0600이며 symlink·다중 hardlink·경로 이탈을 차단합니다.
- 파일/디렉터리 fsync, 배타적 링크 및 독립 readback으로 기록합니다. 원본 덮어쓰기 금지. 동일 파일은 공급원 재호출 없이 재사용하고, 재수집 내용 불일치는 충돌로 차단합니다. 종료 중 남는 임시파일/2-link 파일은 운영 복구 대상입니다.
- 기록 시각 retrievedAt, 연구 SHA, 원본 digest를 보존합니다. 과거 데이터가 과거 시점에 이미 이용 가능했다고 주장하지 않습니다.
- 결측은 휴장·무거래·공급 장애를 아직 구분하지 않았다는 뜻으로 missingMinutesUnclassified=true. fullMarketCoverageProven=false, OOS=0, Paper=0, profitabilityProven=false 유지.

## 격리 수동 검증

실행 전 내부 테스트:

    cd research-production
    node --test test/four-market-minute-archive-intake-v1.test.mjs
    node bin/four-market-minute-intake.mjs --dry-run

CLI는 기본적으로 DISABLED이고 HTTP/쓰기가 0입니다. 실제 1회 시범 실행에도 별도 사용자 승인, 사용권 확인, 5GiB 이상 남은 전용 디스크, 0700 전용 root, 0600 manifest, 정확한 최신 git SHA 고정이 필요합니다.

운영자 전용 manifest 예시(날짜와 숫자는 시연용, 자동 설치되지 않음):

    {
      "schemaVersion": "minute-archive-operator-task-manifest/v1",
      "tasks": [
        {
          "market": "CRYPTO_SPOT", "symbol": "BTC",
          "windowStartMs": 1791626400000,
          "windowEndMs": 1791630000000
        }
      ]
    }

운영자 승인 후에만 설정할 변수:
RESEARCH_CODE_SHA (현재 정확한 40자 git SHA),
RESEARCH_MINUTE_ARCHIVE_ROOT (기존 전용 root),
RESEARCH_MINUTE_ARCHIVE_MANIFEST (0600 manifest),
RESEARCH_MINUTE_ARCHIVE_ENABLED=true.
명시적인 CLI --execute 없이는 다운로드되지 않습니다.
이번 Draft에서는 활성화하지 않습니다.

## 전시장 자동화에서 추가로 필요한 것

1. 현재/역사 전체 종목 **PIT universe, 상장폐지 이력** 검증.
2. 국내/미국주식의 승인된 1분봉 공급원, 세션·기업행위·수정 가격/FX 검증.
3. Vultr 실제 CPU/RAM/스토리지 가용량, 독립 볼륨, 장기 백업 및 공급원 재배포·저장 라이선스 감사.
4. 실시간 수집과 과거 백필을 분리하는 **영구 작업 큐·페이지네이션·속도 제한·누락복구·장애 경보**, 기존 Watch와 로스터·HTTP 자원 중복 최소화.
5. 원본 1분봉으로 3/5/15/60분봉 생성, Research Center 기간별 조회 및 비용/OOS/워크포워드 검증, PASS 확인 뒤 Paper 연결.

공식 문서:
- https://docs.upbit.com/kr/reference/list-candles-minutes
- https://www.bitget.com/api-doc/classic/contract/market/Get-History-Candle-Data


## 후속 Draft v2: 영속 작업 큐 + 5분 간격 스케줄러 틀 (서버 미설치)

새 구현:
- src/four-market-minute-backfill-queue-v1.mjs: 2,048개까지 운영자 명시 범위를 받아 모든 기간을 **120분 이하 창**으로 지연 분할하고, 종목별 cursor·완료 페이지 수·마지막 오류를 전용 0600 파일에 내구적으로 기록합니다. 최대 16회 요청/주기, 종목별 round-robin 공정 순회, 매회 저장·독립 readback 검증.
- BACKFILL(고정 과거 기간) 및 CONTINUOUS(시간이 흐르면 안전하게 완료된 UTC 분까지만 새 창 생성) 모드를 지원합니다. 같은 시장·종목을 두 모드에서 구분하여 선언할 수 있습니다. 과거 복구 중 새 시세 수집이 영원히 뒤처지는 것을 줄일 수 있지만 **수집 용량·전 종목 24h 보장은 아직 입증하지 않았습니다.**
- HTTP 429는 최소 15분, 네트워크/시간초과·5xx는 최소 5분 재시도 대기. 같은 구간 최대 5회 실패 시 NEEDS_REVIEW로 남겨 무한 재요청/누락 은폐를 금지합니다. 비정상 OHLC, 미완성 봉, 무거래로 빈 페이지, 주식 공급원 미구성은 실증 전 자동 PASS가 아니라 NEEDS_REVIEW.
- 네트워크 성공 후 cursor 저장 직전에 전원이 꺼져도, 다음 실행이 이미 봉인된 원본을 읽어 중복 공급원 요청 없이 건너뜁니다. 연구 코드 SHA가 바뀌어도 **원래 생산 SHA는 유지**하고 검증된 동일 캔들만 재사용합니다.
- bin/four-market-minute-backfill.mjs는 --dry-run 기본 비활성화, 단독 --execute도 운영 환경파일의 **명시적 true**, exact git SHA, 0600 작업 manifest, 두 사유(private root와 archive root), 5GiB 여유 용량이 없으면 차단합니다. Linux flock 비차단 잠금으로 동시에 두 작업이 cursor를 덮어쓰지 않도록 합니다.
- deploy/research-production-minute-backfill.service/.timer: 연구 전용 서비스/5분 timer **정의만 추가**, 실제 systemctl enable/start/운영 설치는 **0회**. 기존 market-watch(120초)·Paper/Auto/Telegram 서비스는 변경하지 않습니다.
- 상태 JSON의 완료란 선언한 **페이지가 보관됐다는 의미만**입니다. 빈 시간의 실제 거래 부재/다운타임·상장폐지 PIT·원본 사용권·4시장 전체 커버리지·수익성·OOS·Paper admission은 모두 미검증입니다.

### 범위 manifest (운영자 준비, 루트 내부 권한 0600)

아래 두 시작 시각은 예시이며, 유효한 UTC 1분 경계의 Unix 밀리초를 사용합니다.

    {
      "schemaVersion": "research-minute-backfill-scope/v1",
      "ranges": [
        {
          "market": "CRYPTO_SPOT",
          "symbol": "BTC",
          "mode": "CONTINUOUS",
          "startMs": 1791626400000
        },
        {
          "market": "CRYPTO_SPOT",
          "symbol": "BTC",
          "mode": "BACKFILL",
          "startMs": 1791540000000,
          "endMs": 1791626400000
        },
        {
          "market": "CRYPTO_FUTURES",
          "symbol": "BTCUSDT",
          "mode": "CONTINUOUS",
          "startMs": 1791626400000
        }
      ]
    }

실제 period/end는 현재 운영자가 승인한 범위를 사용하며, 이 예시는 서버 실행에 사용하지 않습니다. 구성 변경 시 기존 cursor와 scopeDigest가 일치하지 않아 자동 초기화하지 않고 차단합니다. 우회·기존 상태 삭제 대신 **사람 검토를 거친 범위 확장/상태 이전 절차**가 필요합니다.

추가 실행 환경:
- RESEARCH_MINUTE_QUEUE_ROOT: 기존에 준비된 연구용 0700 진행상태 디렉터리
- RESEARCH_MINUTE_QUEUE_MANIFEST: 미리 구성된 0600 범위 JSON
- RESEARCH_MINUTE_ARCHIVE_ROOT: 기존에 준비된 연구용 0700 원본 디렉터리
- RESEARCH_MINUTE_ARCHIVE_ENABLED=true, RESEARCH_CODE_SHA=정확한 현재 checkout SHA
- node research-production/bin/four-market-minute-backfill.mjs --dry-run : 항상 네트워크·파일 변형 0. --execute와 timer는 GitHub Production 보호 승인 및 Vultr 조건 확인 후에만 운영자가 별도 승인해야 합니다.

검증(네트워크/실주문 없음):

    node --test research-production/test/four-market-minute-archive-intake-v1.test.mjs
    node --test research-production/test/four-market-minute-backfill-queue-v1.test.mjs
    node --test research-production/test/four-market-minute-backfill-runtime-contract.test.mjs

**아직 남은 운영 P0:** 실제 Vultr의 디스크/CPU/RAM, 데이터 보관·상업 재제공 약관, KR/US 인증된 분봉 제공사 및 거래일/기업행위, 전시장 PIT roster, 유효한 종료·무거래 증거, 수집 source-gap 복구, 24시간 연속 표본, 원본에서 연구센터/백테스터로의 합법적 연결, OOS·경제적 PASS. 이 PR의 green CI는 이 운영 증거를 대신하지 않습니다.


## 후속 Draft v3: 전체 종목 처리량 차단·신규 현행 로스터 정합성

### 실제 확인된 수집 용량 부족

2026-10-11에 관측했던 코인현물 294개 + 코인선물 466개를 **현재 숫자라고 확정하지 않는 과거 작업 표본**으로 가정하면:
- 상한 120분/페이지 -> 24시간 x 60분 / 120분 = 종목당 매일 최소 12페이지.
- 필요한 원본 조회 = (294+466) x 12 = 매일 최소 9,120회(모든 종목에서 봉이 지속 생성되는 상한 시나리오).
- 현재 timer 5분마다 16회 = 매일 최대 4,608회.
- **단순 요청 용량 약 50.5%**, 부족분 4,512회/일. 우발적 재시도·기존 Watch HTTP 공유·휴장/무거래/종목 수 변화·호스트 부하를 아직 포함하지 않았음.
- 여유 20% 모델에서는 5분당 최소 38회 처리해야 하지만, 실제 Vultr 2 vCPU/4GiB와 거래소 IP별 API 호출 한도·HTTP 응답 시간·디스크 용량을 확인하기 전에는 요청 상한을 16에서 강제로 올리지 않음.
- 신규 assessMinuteManifestCapacity는 crypto의 CONTINUOUS 범위만 24시간 모형으로 계산. KR/US 주식에는 거래소·거래시간·공급 데이터 권한이 빠져 있어 "STOCK_SESSION_NOT_MODELLED"이며 PASS 불가.
- 상한보다 큰 scope의 작업자는 **HOLD_CAPACITY**로 요청·저장소 변경 전 차단. 상한 아래인 작은 연구 시범도 "CAPACITY_MODEL_POSSIBLE"이라는 **산술 모형**만 표시하며 데이터 완전성/서버 SLA/수익성 PASS가 아님.

CLI(공급원 HTTP, 저장, timer 조작 없이 0600 스코프 파일 분석):
    
    RESEARCH_MINUTE_QUEUE_MANIFEST=/path/to/private-manifest.json \
    node research-production/bin/four-market-minute-backfill.mjs --capacity

### 전체 코인 공개 종목 현재 목록 검증

신규 four-market-minute-roster-capacity-v1.mjs:
- Upbit 공식 /v1/market/all?is_details=true 의 2024년 이후 **market_event.warning + market_event.caution** 필드를 검증. 제거된 market_warning을 정상 근거로 사용하지 않음. 유의/주의 종목은 **연구 데이터용 로스터에 기록하되 restricted로 표시**, 종목 누락/삭제/비정상 응답·경고값을 무음 처리하지 않음. 기존 120초 Watch의 실제 후보 검색은 경고 종목을 검색에서 제외하도록 안전하게 보완.
- Bitget 공식 /api/v2/mix/market/contracts?productType=USDT-FUTURES의 유효 선물/USDT/현재 symbol 상태/RWA 분류를 검증. 상장 종료·RWA 계약은 현재 대상에서 제외하고, 제한/분류 불명은 연구용 목록에는 남기되 restricted로 표시. 현재 로스터는 **상장폐지 포함 과거 PIT 로스터 증명이 아님**.
- 수집 목록은 원본 시각/데이터 digest/경고 표시로 봉인하고, 자료 생성 후 15분 넘으면 신규 일괄 실행용 목록으로 자동 사용하지 않음.
- Upbit/Bitget 공개 REST 조회는 **명시적으로 opt-in 한 1회 진단**만 지원. 2개 공급원 모두 정상이어야 일괄 로스터를 출력하며, 한쪽 429/오류는 전체 차단. 최대 2MB 응답, 8초 timeout, URL 고정, redirect 거부, 비공개 주문/계좌 API 없음. 서비스 timer에 이 진단은 추가하지 않음.
- 전체 종목용 연속 수집 manifest는 아직 **승인용 제안** 단계이며, 자동 서버 queue admission·스케줄 활성화는 없음. 기존 Research Stage-1 Watch와 중복된 새 상시 로스터 감시기를 추가하지 않음.

아래 명령은 기본 OFF이며, 명시적인 자격 확인/프로덕션 승인 없이 실행하지 않습니다.
    
    node research-production/bin/four-market-minute-roster-capacity.mjs --dry-run
    # 별도 승인 후에만 RESEARCH_MINUTE_PUBLIC_ROSTER_PROBE_ENABLED=true
    # node research-production/bin/four-market-minute-roster-capacity.mjs --public-probe

공식 참고:
- https://docs.upbit.com/kr/reference/list-trading-pairs
- https://docs.upbit.com/kr/reference/rate-limits
- https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market

**남은 운영 P0:** 실제 4시장 저비용 사용권/1분봉 보관/재제공 조건, KR·US 주식 히스토리 및 세션 통합, 역사적 delisting 포함 PIT 로스터, 실 서버 자원 계측, 지속 가능한 요청/WSS 처리량, 누락 자동복구 증거, 이전 원본 용량/포맷 관리, 연구센터 PIT·백테스트 연결, 24시간 실제 가동 및 독립 OOS/비용/수익성 PASS. Draft green CI는 실제 원본 확보나 server activation의 증거가 아닙니다.


## Draft v4 — 읽기 전용 원본 1분봉 → 3·5·15·60분봉

추가 모듈:
- src/research-minute-to-multiframe-reuse-v1.mjs: 분리된 연구 Draft #1534의 검증 모델(원본 소스 blob 453f0966215d82eb13acf266c0b6ea2a30452338)을 현 연구 격리 구조에 연결한 읽기 전용 포트. 신규 거래 엔진이 아니며 #1534 병합 전 canonical 중복 소유권을 정리해야 합니다.
- src/four-market-minute-daily-rollup-v1.mjs: 서버가 보유한 0700 private 원본 루트에서 정확한 마켓·종목·UTC 날짜 한 개만 검사. 그 날짜 및 직전 날짜(120분 자정 교차)의 불변 분봉 페이지만 읽음. 파일명·폴더·SHA·OHLC 위변조/충돌·Symlink·중간 임시파일은 차단.
- 각 분봉의 availableAtMs는 실제 서버 수집시각 retrievedAt 이상입니다. 뒤늦게 받은 과거 자료를 당시 검색기가 알고 있던 신호로 소급하지 않습니다. 생산 코드 SHA는 원본 그대로 유지하고 동일한 관측값은 중복 제거하지만 충돌하는 OHLC는 블록합니다.
- 하루 1440개 1분 슬롯이 로컬 원본 완전성의 분모입니다. Upbit 무거래 분봉 누락과 공급원 장애 누락은 아직 구별할 증거가 없으므로 0거래량/전봉복제 봉을 생성하지 않습니다. 한 분이라도 빠진 3/5/15/60분봉 버킷은 미완료로 표시하고, 실제 존재하는 완성 버킷만 조회합니다.
- 1/3/5/15/30/60/240/1440분 중 요청한 범위만 계산. 아직 닫히지 않은 봉과 asOf 시점 이후 서버에 수집된 retrospective 자료는 조회 결과에서 제외됩니다.
- SOURCE_ONLY_COMPLETE_DAY_MINUTES라는 값도 해당 마켓·종목·날짜의 로컬 원본 슬롯 확인일 뿐, 역사적 상장폐지 포함 전시장 PIT 인증, 수익성, OOS/Paper/실거래 준비를 의미하지 않습니다.
- 한국/미국 주식은 거래소 현지 정규·프리·애프터 시간과 휴장/DST, 기업행위, 승인 데이터 공급원이 필요하므로 이번 암호화폐 UTC 24h 일간 브리지에서는 STOCK_EXCHANGE_SESSION_SOURCE_NOT_CONNECTED로 차단합니다.

수동 read-only 진단:
    node research-production/bin/four-market-minute-rollup-status.mjs --dry-run

조회 전에 사람 승인·정확한 Research SHA·보호된 원본 루트 경로가 필수이며, 그 조건에서도 --inspect --market=CRYPTO_SPOT --symbol=BTC --day=YYYY-MM-DD는 오직 출력용입니다. 원본 OHLC 파일의 데이터 자체를 일반 회원·Telegram·외부 AI에 전송하지 않으며 GET/원본 파일 쓰기/작업 스케줄 실행은 0입니다. 실제 운영 서버에서는 아직 실행하지 않았습니다.

테스트는 원본 120분 페이지 12개와 1440개 1분봉을 사용한 일일 변환, UTC 자정 교차, 1분 누락, 중복·서로 다른 OHLC 충돌, 실제 소스 수신시각, 미래 asOf, 파일 조작/시너지 링크 및 비정상 stock 세션 입력을 검사합니다.

현재 앱 관리자 HTTP/backtester에 이 파일을 직접 연결하지 않습니다. 실제 Vultr 24시간 수집, 주식 원본/API 사용권, 4시장 역사 PIT, 전시장 비용/OOS·Paper 폐쇄루프는 별도 작업/운영 승인 후 검증해야 합니다.
