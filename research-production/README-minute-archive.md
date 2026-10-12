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

## Draft v5 — Data-gap audit, Backtester prewire, storage footprint (2026-10-12)

This section is an **unactivated Draft** with no production-server write/daemon,
no Replit and no order/Paper authorization.

### 1. Distinguish an archived page from complete one-minute observation
- New auditOriginalMinuteWindowSlotsV1 checks a bounded 120-minute source
  window for observed timestamps, missing slots and contiguous missing runs.
- Upbit may omit no-trade minutes. Missing is **unverified**, not automatically
  attributed to provider outages and never filled with fictitious candles.
- Persisted backfill cursor now records sourceGapPages,
  unverifiedMissingMinuteSlots and historicalMissingBeforeAudit. A finished
  request window containing gaps reports PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED.
- Old v1 cursors without these diagnostics are marked legacy-unknown, never
  silently promoted into a zero-gap coverage certificate. Existing immutable
  raw source files and original ingestion/retrieval times remain unchanged.
- Full coverage/PIT/OOS/returns/Paper admission is not established.

### 2. Private read-only compatibility with the existing strategy model
- four-market-minute-backtester-prewire-v1.mjs takes exactly one complete
  crypto UTC day of original 1m source. It verifies 1440 slots, SHA digests,
  venue, cutoff and actual source retrieval availability, then creates a
  PRIVATE IN-MEMORY model input with exact native-minute fields expected by
  the original research strategy model in Draft #1534.
- It rechecks 1m and 5m source consistency. A day with one missing minute or
  any minute obtained after the requested historical cutoff is BLOCKED_DATA
  with modelInput=null.
- This is retrospective **offline research input only**, NOT proof those bars
  were available at the actual signal time, NOT verified historical PIT, fill,
  OOS or profitability evidence. No HTTP Backtester strategy is invoked here.
- inspectSealedMinuteBacktesterPeriodV1 supports user-chosen historical dates
  up to about 10 years using <=7-day pages, a nextCursorDate and safe status,
  counts and checksums rather than raw OHLCV in responses.
- KR/US stock sources stay BLOCKED until independently licensed source,
  exchange sessions/DST/holiday and corporate actions are verified. Existing
  #1534/#1832 functionality is not merged or reimplemented in production.

### 3. Archive storage/inode forecast, not verified server capacity
- forecastPublicMinuteArchiveFootprintV1 calculates a transparent planning
  estimate. At the old **example** roster count 294 spot + 466 futures,
  1440 minutes/day, 120m per JSON page, 180 bytes/row, 700 bytes/page:
  ~1,094,400 rows and 9,120 immutable page files DAILY;
  ~399,456,000 rows, 3,328,800 files and ~69 GiB per 365 days.
- The earlier 16 requests every 5 minutes = 4,608 requests/day, well below
  9,120 requests/day in a dense-minute 760-symbol scenario.
- These figures exclude true provider throughput, compression, backup, file
  metadata and actual Vultr disk/inodes. No storage purchase or deletion,
  quota change or increased provider request rate is implemented.
- Production retention requires hashed source receipts, lossless compressed
  daily/monthly segments, verification, immutable backups and an approved
  bounded resource cap before enabling any all-symbol 24h service.

### 4. Safe command (default disabled)

    node research-production/bin/four-market-minute-backtester-source-status.mjs --dry-run

An owner-approved read-only inspection would separately require an exact
RESEARCH_CODE_SHA checkout, a private RESEARCH_MINUTE_ARCHIVE_ROOT and
RESEARCH_MINUTE_SOURCE_READONLY_ENABLED=true. It examines 7 dates at a time:

    node research-production/bin/four-market-minute-backtester-source-status.mjs --inspect --market=CRYPTO_SPOT --symbol=BTC --startDate=2026-10-09 --endDate=2026-10-12

The command is NOT activated and does not send provider GETs, expose raw prices,
mutate files, change DB/systemd/PM2, publish member/Telegram data, or place
orders. The main app's Backtester HTTP route remains untouched.

### Next blockers
4-market historical active and delisted PIT rosters; real KR/US authorized
minute feeds and trading-calendar provenance; 24-hour Vultr disk/CPU/RAM/IP
verification; selective source-gap reconciliation distinguishing no-trade from
outages; 4-market source rights and retention costs; integration of verified
native original-minute evidence with Research/Backtester UI, followed by
independent OOS/full-cost/WF and only later controlled Paper testing.


## Draft v6 — 누락된 원본 1분봉 재조회와 불변 보충 기록

코드 및 모의 fixture 검증만 수행한다. **실제 Vultr provider GET 및 서비스 활성화 없음.**

### 선택적 missing-minute recheck
- 새 src/four-market-minute-gap-recheck-v1.mjs는 이미 존재하는 원본 페이지 한 개의 1분봉 결측 시각을 공식 Upbit KRW/Bitget USDT 공개 REST에서 다시 확인하는 1회성 연구 기능이다.
- Upbit는 실제 거래 없는 1분에 캔들을 생성하지 않는다. 공급원 응답에서 비어 있다고 무거래가 검증된 것은 아니며, 반대로 모든 빈 분이 장애라는 뜻도 아니다. NO_NEW_CANDLES_OBSERVED는 실제 재확인 결과 새 분봉 없음, 정상 무거래 확정은 아니다.
- 이미 있던 분봉의 OHLCV/거래대금 값이 달라지면 MINUTE_RECHECK_CONFLICTING_SOURCE_REVISION으로 차단. **기존 immutable 원본은 절대 고치거나 덮어쓰지 않는다.**
- 실제 재조회에서 빠졌던 캔들이 추가로 관측될 때만, 분봉을 받은 새 시각 및 생산 코드 SHA를 묶어 별도 minute-rechecks-v1 하위 사유 폴더에 digest 봉인된 immutable supplemental receipt를 기록할 수 있다.
- 한 원본 페이지에 최대 8개 보충 영수증, 페이지당 개별 256KiB 이하, 폴더 최대 256개 파일. 안전한 디렉터리·파일 권한, O_NOFOLLOW, 충돌/경계/이전 원본 해시 연결, fsync와 읽기 검증을 수행한다. 0개 새 캔들일 때는 새 파일을 만들지 않는다.
- src/four-market-minute-daily-rollup-v1.mjs가 기존 원본과 보충 영수증을 결합해 **읽기 전용** 시간봉 입력을 만든다. 동일 시각의 값이 충돌하면 block. 뒤늦게 받은 분봉은 실제 최초 수신 시각 전의 과거 신호로 사용하지 않는다.
- 기존 Backfill queue의 과거 누락 수를 조용히 0으로 수정하지 않으며, 원본 및 supplemental digest는 독립적으로 검증한다. 서비스 설치/DB/Telegram/Paper/실주문 없음.

### 기본 DISABLED 원샷 CLI (이 PR에서는 실행·활성화하지 않음)

    node research-production/bin/four-market-minute-recheck.mjs --dry-run

향후 소유자 승인 시 한 번만 출처 재조회하는 선택적 명령:
- RESEARCH_MINUTE_ARCHIVE_ROOT: 연구 전용 0700 원본 폴더
- RESEARCH_MINUTE_QUEUE_ROOT: 기존 Backfill과 같은 flock 잠금 영역, 0700
- RESEARCH_MINUTE_RECHECK_MANIFEST: 정확한 1개 마켓/심볼/UTC 분 구간을 지정한 0600 파일
- RESEARCH_CODE_SHA: 실제 checked-out 커밋과 일치하는 40자 SHA
- RESEARCH_MINUTE_RECHECK_ENABLED=true: 공개 source 1회 GET 진단 승인
- RESEARCH_MINUTE_RECHECK_WRITE_ALLOWED=true: 재조회 **새 immutable 보충 파일 쓰기**를 별도로 승인
- --inspect: 공개 API 1회 읽기·원본 보관 변경 없음
- --execute: 승인 2종, root·manifest 안전 검증, CPU 디스크 여유/파일 잠금 후에만 immutable 보충 영수증 쓰기
- CLI 출력은 시세 원본·내부 파일 경로·자격 정보를 담지 않고 상태/건수만 표시한다.

manifest 계약 예시:

    {
      "schemaVersion": "research-minute-recheck-operator-task/v1",
      "task": {
        "market": "CRYPTO_SPOT", "symbol": "BTC",
        "windowStartMs": 1791626400000,
        "windowEndMs": 1791630000000
      }
    }

### 운영 블로커
1. Vultr CPU·RAM·Disk/Inode/Backups·실제 24h data GET 계측 및 앱과 공유하는 IP API budget.
2. 국내·미국주식 검증된 1분봉 공급원과 라이선스, 현지 거래 세션·기업행위·상장폐지 PIT.
3. 모든 종목 source 누락 자동 재조회 작업 큐·429 rate gate·소스 진단 수용량(기존 16/5m로 760 dense symbols 지속 수집 불가).
4. 앱 Research/Backtester 정식 운영 API 연결, 실제 OOS·워크포워드·수수료/슬리피지 포함 거래 검증, Paper admission.
5. source-gap 복원이나 모델 회귀 테스트 성공은 실제 수익성 PASS 또는 24h 운영 증거가 아니다. executionAuthority=NONE, profitabilityProven=false.

NO Replit, NO Ready/Merge/Deploy/Production, NO Vultr/PM2/systemd changes, NO live/private broker API or Paper orders.


### 2026-10-13 — 수집 처리량·시간제한 통합 사전점검(읽기 전용)

- 상태 명령 `node research-production/bin/four-market-minute-backfill.mjs --capacity`는 **기존 0600 로컬 범위 파일을 읽는 것 외에 파일 저장/네트워크 요청/운영 활성화가 없습니다**. `pacingPreflight` 필드는 독립 산술 사전검사로, 실행 설정을 바꾸지 않습니다.
- 신규 `research-minute-collector-pace-preflight/v1` 계산은 기존 `16회/5분` 현재값, 120분 원본 수집 페이지, `20%` 여유 요구, 개별 HTTP 최악 `8초`, 요청 사이 `300ms`, `flock` 하위 작업 `210초`, systemd `240초`, 마지막 중단·상태 기록용 `15초` 예비 시간을 **동시에** 적용합니다.
- **가상 예시** (현재 실제 전체 종목 수/활성 세션/거래소 IP 여유의 보증 아님): 코인현물 294개 + 선물 466개 = 760개가 매일 24시간 완전 1분봉을 발행하면 최소 `9,120`개 120분 창이 필요합니다. 20% 재시도 여유 포함 `10,944`창/일, 이론상 **5분당 38회 이상** 필요. 현재 최대 `4,608`회/일로 부족합니다.
- **중요한 두 번째 병목**: 38회 순차 수집 요청이 각각 8초 최악 지연이면 전송 간격 포함 약 `315,100ms`가 필요해 하위 worker 210초보다 깁니다. 현 설정으로는 15초 비상 예비 시간을 제외해 **순차 최대 약 23회/회차**만 최악 조건을 견딥니다. 요청 예외/락 충돌/재기동을 PASS로 숨겨서는 안 됩니다.
- 별도의 2분 타이머도 16회 × 8초 최대 지연(약 `132,500ms`)이 2분 주기를 초과할 수 있어, 주기 단축만으로 해결되지 않습니다.
- Upbit 공식 공개시세 분봉 `candle` 그룹 [요청 제한](https://docs.upbit.com/kr/reference/rate-limits)은 공개문서상 최대 초당 10회/IP, Bitget [역사 캔들](https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market) 문서상 초당 20회/IP입니다. 이 숫자는 거래소 문서의 상한이지 **Vultr 공용 IP 남은 할당량·상업적 재배포 권한·실제 24시간 처리량** 확인이 아닙니다. 문서 정책은 변경될 수 있으므로 활성화 전 최신 원문과 응답 헤더·약관을 다시 확인해야 합니다.
- 이 테스트는 `MINUTE_QUEUE_LIMITS.maxActionsPerCycle=16`과 실제 5분 timer, systemd 자원 한도, enabled=false 기본값을 변경하지 않습니다. 38회 동시/병렬 처리 작업도 허용하거나 실행하지 않습니다. 앞으로 필요할 수 있는 병렬성 수치는 **산술적인 하한**이며 락/큐 원장 일관성·저장소 IOPS·provider 429·공용 IP 권한·실제 Vultr 사용량 측정 전에는 설계 승인으로 간주하지 않습니다.
- 주식 KR/US는 24시간 코인 전제를 사용하지 않으며, 별도 공식 장 일정·법적 원본 공급원·과거 PIT 상장폐지·기업행위/환율 사용 조건이 확보되지 않으면 `STOCK_SESSION_NOT_MODELLED`로 계속 차단합니다.
- 모든 경로 `profitabilityProven=false`, `continuous24hProven=false`, `executionAuthority=NONE`, 리프릿 사용 0, Ready/Merge/Staging/Production/systemd/PM2/cron/개인 거래소 API/실주문 0.


### 2026-10-13 — Read-only 200-minute alternative and historical backfill origin budget

This is `--capacity` arithmetic only. The ACTIVE collector still accepts
**120-minute immutable pages, 16 actions / 5 minutes**, with a 210-second
flock child timeout and 15-second shutdown reserve. Nothing is installed or
enabled. No public-provider GET is sent by this preflight.

- Official public references: Upbit minute-candle API
  https://docs.upbit.com/kr/reference/list-candles-minutes and Bitget **v2**
  history-candles
  https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market
  each document at most **200 returned 1m candles per request**. A documented
  response cap is NOT validation of 200-minute source-window continuity,
  historical availability, gap absence or trading/backtester authorization.
- New `pacingPreflight.alternatePage200Scenario` reports a deliberately
  **HYPOTHETICAL_NOT_EXECUTABLE** model. At the *example only* 294 Upbit KRW +
  466 Bitget USDT-futures symbols, it shows 6,080 pages/day at 200 minutes
  per page; with 20% headroom, 7,296 actions/day or at least 26/5min;
  the 16/5min hard cap still fails. If each request takes 8 seconds plus
  300 ms spacing, 26 sequential calls cost 215,500 ms, exceeding the
  current conservative 195,000 ms worker allowance. These are planning
  bounds, not host/IP throughput measurements.
- Another *hypothetical* 2-minute cadence would need 11 actions / 2min
  under this simple 200m model, but no 2-minute timer has been installed.
  Current 120-minute collector, immutable archive layout, durable cursor,
  day rollup and #1848 native replay/prewire (minimum 12 source page digests)
  are **not contract-compatible with a silent 200-minute switch**. A separate
  versioned migration, sealed source receipts, overlapping-page/cross-day
  verification and exact-head offline/browser regression are prerequisites.
- The preflight also reports `declaredBackfillRanges` and
  `declaredBackfillPagesFromOrigin` (120m) plus the hypothetical 200m
  origin estimate. These counts describe manifest-origin historical requests,
  NOT current outstanding work: the protected on-server cursor is *not*
  read, and its true remaining pages and shared-provider retry/429 load are
  unverified. Continuous 24h capacity MUST NOT silently include claimed
  catch-up/backfill throughput.
- Malformed/duplicate manifest scopes are rejected before computing a
  seemingly authoritative budget. Stock exchange session-specific throughput,
  current and delisted PIT membership, vendor licenses, corporate actions,
  historical FX, actual provider restrictions, Vultr disk/inodes/backup,
  24-hour continuity, OOS/full-cost/Paper profit remain UNKNOWN/BLOCKED.
- No real vendor GET, no server credentials/DB mutation, no systemd/PM2,
  Staging/Production, Merge/Ready, orders or Telegram sends. Replit/Replit
  Agent is prohibited. This is not an authorization or release receipt.


## 2026-10-13 — Opt-in immutable 180-minute source pages (DRAFT, inactive)

Official Upbit minute candles and Bitget V2 history-candles support up to
200 **returned** rows per request. Because the futures endpoint may return an
extra boundary interval, and Upbit may omit no-trade minutes, the experimental
source window chooses **180 UTC minutes**, keeping up to 20 rows of slack and
exactly 8 nominal source pages per 24-hour crypto day. This is NOT evidence of
a complete original day; missing minutes remain blocked and are never filled.

- The existing protected manifest (v1) with no `pageWindowMinutes` remains
  **exactly 120m** with the unchanged prior scopeDigest. This is the default.
- An owner-reviewed research-only *new* manifest may specify the top-level
  `"pageWindowMinutes":180` and **only** 120 or 180 is allowed. The 180
  selection is bound into a different scopeDigest and sealed queue state.
  Existing 120m cursors do not automatically migrate; an attempt to point the
  new manifest at a legacy queue is BLOCKED with a scope mismatch. Never
  delete, rewrite or reset prior queue receipts to evade this protection.
- New pages still use the same SHA-bound immutable original records, per-bar
  source retrieval times, O_NOFOLLOW/private 0700 roots, atomic fsync and
  bounded response/body size. The 180m scoped source page can be rechecked
  with immutable supplements, and 8 complete original source pages can feed
  the UTC daily rollup (1440 real slots) and the private source-only prewire.
  Native archive bridge #1848 needs corresponding >=8 real page receipt
  contract alignment before use. There is no automatic bridge import.
- 760 continuously trading crypto pairs *still* need about 6,080 REST pages
  per day at 180m plus a 20% retry budget, or about 26 actions per 5 minutes.
  Current 16/5m, sequential host/timeout limit and 24h source rights leave
  all-crypto continuous production collection **HOLD_CAPACITY**. Runtime
  timer/service, CLI approval flag, operations, provider quotas and account
  authority have NOT been changed.
- This is a testable dormant path, not permission to run production or create
  new queues on Vultr. Staging, Production, live/Paper orders, secrets,
  private APIs, actual 24h provider reads, historic PIT/delistings,
  stock-source licensing, OOS and profitability remain unverified. Replit
  and Replit Agent prohibited.


### 2026-10-13 — Dormant two-provider lane experiment (not activated)

A single global queue using 16 calls every 5 minutes cannot keep up with
the *modelled* 760 dense crypto symbols, even at 180-minute source pages.
A guarded **test-only / programmatic** dual-venue experiment processes
up to 16 Upbit calls and up to 16 Bitget calls per 5-minute cycle:
sequential within each venue, overlapping only the independent venues.
No more than one provider GET is in flight for the same venue, so the
durable venue-wide 429 quarantine still blocks follow-on sibling requests.

- New read-only `dualVenuePacingProposal` in the existing `--capacity` output
  estimates two market-specific independent budgets and worst-case runtime.
  For illustrative 294 spot/466 futures symbols, 180m page, 20% headroom,
  the minimum per-venue actions are **10 spot + 16 futures per 5 minutes**.
  This fits the theoretical 16 calls/venue cap; each lane of 16 worst-case
  8-second HTTP calls + 300ms spacing is about 132.5s versus the existing
  195s usable worker allowance. A theoretical bound is NOT proof of server
  processing latency, reserved shared-IP quota, correct no-trade data or
  market-wide availability.
- The ordinary `--execute` CLI **does not expose or enable** the dual-venue
  mode. Existing defaults, worker/timer, single-lane max 16, 120m scope
  and all production settings remain unchanged. The experimental
  `runDurableMinuteBackfillCycle` arguments require all three booleans
  `dualVenueMode=true`, `dualVenueOwnerApproved=true`, and
  `dualVenueHostAttested=true`; these are only used with injected fixture
  HTTP, not with actual provider GETs.
- In this experiment, both results from one cross-venue round are awaited
  before the globally flock-protected immutable cursor is committed
  serially. A crash between source write and cursor persistence remains
  idempotent through the existing sealed page readback. Provider 429 is
  venue-wide and pauses subsequent calls in that venue while the other
  venue may advance independently. The hard 210s worker and shutdown
  reserve remain enforced, with a deadline hold before a new fetch.
- 120m dense 760-symbol dual-lane collection **still fails** the separate
  futures capacity test. 180m merely creates an arithmetic possibility,
  not Staging approval or a turnkey production all-symbol collector.
  Real source-holder approval, shared-IP rate tests, CPU/IO/inodes/backup,
  24h restart/HTTP-429/gap chaos validation, stock source permissions and
  PIT, OOS, fees, and actual Paper settlement are all still required.

**Prohibitions unchanged:** Replit/Replit Agent, Ready/Merge, server
service changes, Staging/Production, DB/Secrets/permissions, account
calls, real/Paper orders and Telegram sends are not part of this Draft.
