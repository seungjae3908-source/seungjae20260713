# Market Prediction Lab (standalone)

운영 API 안정화 작업과 충돌하지 않도록 만든 **완전 독립형 예측·데이터 연구실**입니다.

## 격리 원칙

- `api-server`, `stock-analyzer`, 루트 `package.json`, `pnpm-workspace.yaml`을 수정하지 않습니다.
- 기존 API를 호출하거나 라우트를 추가하지 않습니다.
- 환경변수, 인증, Supabase, PM2, Caddy, 운영 DB에 접근하지 않습니다.
- 외부 패키지가 없으며 Node.js 20 이상 기본 기능만 사용합니다.
- 운영 서버에서 모델 학습이나 LLM을 실행하지 않습니다.
- 입력은 사용자가 내보낸 JSON 스냅샷만 받습니다.

## 구현 범위

- 국내주식·미국주식·코인 현물·코인 선물 공통 정규화
- Canonical object 및 Bitget-style array 포맷 지원
- 원본 스냅샷 불변 보존과 SHA-256 무결성 기록
- 중복 제거, 정렬, OHLC 검증, 누락 구간·0거래량 품질 보고서
- EMA, RSI, MACD, ATR, 볼린저밴드, 거래량, 지지·저항
- 시장별 규칙 엔진 및 초소형 선형 기준 모델
- 상승·중립·하락 확률과 미래 시나리오 캔들
- 미래 데이터 누수를 차단한 학습 레코드 생성
- 예측 결과와 실제 결과 자동 매칭
- 예측 구간이 겹치지 않는 purged walk-forward train/validation/test 분할
- JSONL 데이터셋 및 해시 manifest 원자적 저장

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

기존 API에는 연결하지 않으며, 파일로 내보낸 데이터만 격리 저장합니다.

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
