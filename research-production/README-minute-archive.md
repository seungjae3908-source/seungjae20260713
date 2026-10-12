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
