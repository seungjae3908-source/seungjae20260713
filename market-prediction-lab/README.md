# Market Prediction Lab (standalone)

운영 API 안정화 작업과 충돌하지 않도록 만든 **완전 독립형 예측 연구실**입니다.

## 격리 원칙

- `api-server`, `stock-analyzer`, 루트 `package.json`, `pnpm-workspace.yaml`을 수정하지 않습니다.
- 기존 API를 호출하거나 라우트를 추가하지 않습니다.
- 환경변수, 인증, Supabase, PM2, Caddy, 운영 DB에 접근하지 않습니다.
- 외부 패키지가 없으며 Node.js 20 이상 기본 기능만 사용합니다.
- 운영 서버에서 모델 학습이나 LLM을 실행하지 않습니다.
- 입력은 저장된 JSON/JSONL 또는 향후 승인된 읽기 전용 어댑터로만 받습니다.

## 현재 범위

- 공통 입력 검증: 국내주식, 미국주식, 코인 현물, 코인 선물
- 기술지표: EMA, RSI, MACD, ATR, 볼린저밴드, 거래량, 지지·저항
- 시장별 규칙 엔진
- 초소형 선형 기준 모델(v0, 미학습 상태 명시)
- 상승·중립·하락 확률
- 3개 시나리오와 미래 예상 캔들
- 50%/80% 불확실성 구간
- JSONL 데이터 수집
- 실제 결과 사후검증

## 실행

```bash
cd market-prediction-lab
npm run validate
npm run stress
```

`validate`는 문법 검사, 전체 단위테스트, 스모크 테스트를 순서대로 실행합니다.

## 중요

현재 `tiny-linear-baseline-v0`은 데이터 수집과 비교 기준을 위한 **미학습 기준 모델**입니다. 실제 적중률·신뢰도 공개 전에는 별도 학습·시간순 백테스트·그림자 검증이 필요합니다.
