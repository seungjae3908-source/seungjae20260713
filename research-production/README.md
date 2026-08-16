# Research Production

기존 투자앱 Production과 분리하여 `market-prediction-lab`의 검증된 공개데이터 연구 스크립트를 서버에서 병렬 실행하고, 결과를 독립 상태 디렉터리에 누적하는 Research Production 런타임입니다.

## 원칙

- 기존 `stock-analyzer`, `api-server`, 운영 DB/상태 디렉터리를 수정하지 않습니다.
- 실제 주문, private account/exchange API, 자금 이동 권한을 갖지 않습니다.
- 정확한 40자 Git SHA를 고정하지 않으면 실행을 거부합니다.
- Paper와 Shadow는 `/var/lib/investment-research-production/forward` 아래의 **독립 상태**만 사용하여 기존 Paper/Shadow evidence chain과 충돌하지 않습니다.
- 연구 실패는 fail-closed로 기록하되 다른 독립 lane을 중단시키지 않습니다.
- 병렬 task마다 `stateRoot/runs/<cycle>/<task>/workspace`에 `market-prediction-lab`을 복제하여 생성 산출물이 서로 덮어쓰지 않도록 합니다.
- 서버의 일반 환경변수는 자식 연구 프로세스로 그대로 전달하지 않으며 PATH/LANG/TZ 등 최소 실행 환경만 전달하여 Token/API key/DB credential 전파를 차단합니다.
- `RESEARCH_CODE_SHA`와 실제 checkout `git rev-parse HEAD`가 다르면 실행을 거부합니다.
- Paper Forward activation timestamp는 첫 실행 때 상태 저장소에 고정되고 이후 변경을 거부합니다.
- 프로세스 강제 종료 후 남은 stale lock은 다음 실행에서 PID/시간을 검증해 안전하게 회수합니다.
- 상태 디스크의 가용 공간이 기본 5 GiB 미만이면 새 연구 cycle을 시작하지 않습니다(`RESEARCH_MIN_FREE_BYTES`로 조정 가능).
- `BLOCKED_DATA`는 수익 성공으로 간주하지 않고 별도 상태로 보존합니다.

## 프로필

- `fast-historical`: **3개 독립 파이프라인을 병렬 실행**합니다. 같은 파이프라인 내부는 기존 GitHub Multi-Market Suite의 검증된 의존 순서를 그대로 유지합니다.
  - Crypto Futures/Derivatives: 시장 데이터·후보 → 일반화 → 비용/PnL → regime → funding history → market structure
  - Crypto Spot: Upbit public → 비용/PnL → 대안전략
  - Stocks: KR/US public → 비용/PnL → unseen-symbol/rolling generalization → US pullback → regime
  - 총 14개 역사연구 단계를 3개 격리 workspace에서 병렬 처리합니다.
- `long-history`: V1/V3/V4/V5/V6 long-history 연구를 병렬 실행합니다.
- `forward`: 별도 state root로 Paper Forward + Shadow를 실행합니다. 미래 시간은 압축하지 않습니다.
- `all`: 배포/감사용 **계획 출력만** 허용하며 실제 실행은 세 프로필을 따로 실행하게 강제해 장시간 단일 프로세스와 state 충돌을 피합니다.

기존 Quant Lab의 `bounded_coarse_narrow_fine` candidate narrowing, OOS/walk-forward/holdout 안전계약과 Automated V1 adapter는 서버 preflight에서 **현재 exact SHA 모듈을 직접 import**하여 검증합니다. 시장 연구 알고리즘은 재작성하지 않고 기존 검증 suite를 재사용합니다. 따라서 속도 향상은 독립 시장 파이프라인의 병렬화에서 얻고, 동일 시장의 선행 산출물 의존성은 보존합니다.

## 로컬/CI 검증

```bash
cd research-production
npm test
node bin/research-cycle.mjs preflight \
  --repo-root .. \
  --state-root /tmp/investment-research-production \
  --research-sha "$(git rev-parse HEAD)"
node bin/research-cycle.mjs plan \
  --profile all \
  --repo-root .. \
  --state-root /tmp/investment-research-production \
  --research-sha "$(git rev-parse HEAD)"
```

## 서버 배포 전 계약

권장 경로:

- 코드: `/opt/investment-research/current`
- 상태: `/var/lib/investment-research-production`
- 환경: `/etc/investment-research/research-production.env`
- 전용 사용자: `investment-research`

`deploy/research-production@.service`와 세 timer를 설치하면 daily historical / weekly long-history / hourly forward가 서로 독립적으로 실행됩니다. 전용 서비스는 앱 상태 디렉터리가 아니라 `/var/lib/investment-research-production`만 쓰기 가능하도록 systemd sandbox를 적용합니다.

**이 브랜치에서는 실제 서버 설치·timer enable/start를 수행하지 않습니다.** 운영 배포 직전에는 exact branch SHA, CI 성공, 전용 사용자/디렉터리 권한, env의 모든 live/private flag=false, 기존 Production SHA 불변을 재확인한 뒤에만 별도 승인으로 설치합니다.
