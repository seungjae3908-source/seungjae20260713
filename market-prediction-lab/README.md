# Market Prediction Lab (standalone)

운영 API 안정화 작업과 충돌하지 않도록 만든 **완전 독립형 예측·데이터 연구실**입니다.

## 격리 원칙

- `api-server`, `stock-analyzer`, 루트 `package.json`, `pnpm-workspace.yaml`을 수정하지 않습니다.
- 기존 앱 API를 호출·수정하거나 라우트를 추가하지 않습니다.
- 환경변수, 인증, Supabase, PM2, Caddy, 운영 DB에 접근하지 않습니다.
- 외부 패키지가 없으며 Node.js 20 이상 기본 기능만 사용합니다.
- 운영 서버에서 모델 학습이나 LLM을 실행하지 않습니다.
- 입력은 사용자가 내보낸 JSON 스냅샷 또는 승인된 공개 읽기 전용 시장데이터 수집기만 받습니다.

## 구현 범위

- 국내주식·미국주식·코인 현물·코인 선물 공통 정규화
- Canonical object 및 Bitget-style array 포맷 지원
- 원본 스냅샷 불변 보존과 SHA-256 무결성 기록
- 동일 원본 재수집 시 manifest 중복 생성을 막는 멱등 처리
- 중복 제거, 정렬, OHLC 검증, 누락 구간·0거래량 품질 보고서
- EMA, RSI, MACD, ATR, 볼린저밴드, 거래량, 지지·저항
- 시장별 규칙 엔진 및 초소형 선형 기준 모델
- 상승·중립·하락 확률과 미래 시나리오 캔들
- 미래 데이터 누수를 차단한 학습 레코드 생성
- 예측 결과와 실제 결과 자동 매칭
- 예측 구간이 겹치지 않는 purged walk-forward train/validation/test 분할
- JSONL 데이터셋 및 해시 manifest 원자적 저장
- Bitget 공개 GET 시장데이터 그림자 수집과 OI·펀딩비 이력 누적

## 전체 검증

```bash
cd market-prediction-lab
npm run validate
```

`validate`는 전체 JavaScript 문법검사, 단위·호환성 테스트, 파이프라인 스모크 테스트, 4시장 스트레스 테스트, 손상 입력 퍼즈 테스트를 실행합니다.

## 오프라인 데이터 수집

```bash
node scripts/ingest-snapshot.js \
  --input ./export/btc.json \
  --output ./data \
  --market CRYPTO_FUTURES \
  --symbol BTCUSDT \
  --timeframe 15m \
  --format bitget-array \
  --source manual-export
```

기존 앱 API에는 연결하지 않으며, 파일로 내보낸 데이터만 격리 저장합니다.

## Bitget 공개 데이터 그림자 수집

```bash
npm run collect:bitget -- \
  --market CRYPTO_FUTURES \
  --symbol BTCUSDT \
  --timeframe 15m \
  --days 52
```

이 명령은 Bitget 공개 시장데이터 GET 엔드포인트만 사용합니다. API 키·서명·패스프레이즈가 없고 계좌·포지션·주문 API를 호출하지 않습니다. PM2·cron·systemd에는 등록하지 않은 수동 오프라인 명령입니다.

- 캔들은 역방향 페이지네이션으로 수집하고 타임스탬프 중복을 제거합니다.
- Bitget의 배타적 `endTime` 경계를 그대로 다음 페이지 커서로 사용해 페이지 사이 봉 누락을 방지합니다.
- 429·일시적 서버 오류는 제한된 횟수만 재시도합니다.
- 페이지가 과거로 이동하지 않으면 무한 반복 방지를 위해 실패 처리합니다.
- 캔들 스냅샷은 원자적으로 교체하고 내용 해시가 같으면 다시 쓰지 않습니다.
- 선물 OI·펀딩비·시장가·마크가격·지수가격은 값이 변경될 때만 이력에 추가합니다.
- 금융 소수 원문은 문자열로 보존하고 계산용 숫자를 별도 저장합니다.

자세한 내용은 `docs/bitget-shadow-collection.md`를 확인합니다.

## 실제 공개 API 검증

2026-07-30 KST에 기능 브랜치 전용 격리 실행으로 BTCUSDT USDT 선물 15분봉을 실제 수집했습니다.

### 1일 스모크 검증

- 최근 1일 범위 95개 봉 수집
- 15분 간격 누락 0건
- 중복·역순 타임스탬프 0건
- 0거래량 봉 0건
- OHLCV 무결성 오류 0건
- OI, 현재 펀딩비, 펀딩비 이력 100건, 시장가·마크가격·지수가격 수집 성공

검증 요약은 `docs/live-smoke-result.json`에 있습니다.

### 52일 전체 범위 검증

첫 실행에서 200개 페이지 경계마다 한 봉씩 건너뛰는 문제를 품질검사가 발견했습니다. Bitget의 `endTime`이 배타 경계라는 규칙에 맞춰 커서를 수정하고 3페이지 연속성 회귀 테스트를 추가한 뒤 다시 검증했습니다.

- 52일 범위 4,991개 완성 봉 수집
- 15분 간격 누락 0건
- 중복·역순·거부 행·0거래량 0건
- 정규화 품질 상태 `clean`
- lookback 200, horizon 8, stride 4 기준 학습 레코드 1,196개 생성
- 미래 구간 겹침 제거 후 train 837 / validation 177 / test 178
- 분할 경계에서 각각 2개 레코드를 purge해 미래 데이터 누수 차단
- 각 데이터셋 SHA-256 기록

검증 요약은 `docs/btcusdt-15m-52d-result.json`에 있습니다. 실검증용 임시 GitHub Actions 파일과 원본 시세 데이터는 실행 후 저장소에서 제거했으며, 최종 브랜치에는 요약과 해시만 남습니다.

## 학습 데이터셋 생성

```bash
node scripts/build-dataset.js \
  --input ./data/normalized/CRYPTO_FUTURES/BTCUSDT/15m/<snapshot>.normalized.json \
  --output ./data/training/BTCUSDT-15m \
  --lookback 200 \
  --horizon 5 \
  --stride 1
```

## 중요

현재 `tiny-linear-baseline-v0`은 데이터 수집과 비교 기준을 위한 **미학습 기준 모델**입니다. 실제 적중률·신뢰도 공개 전에는 시장별 학습, 시간순 백테스트, 확률 보정, 그림자 검증이 필요합니다.
