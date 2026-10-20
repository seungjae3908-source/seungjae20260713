# crypto-stat-arb: 원본 재현·레버리지 1~10배 검증 (조회 전용, PAPER)

공개 저장소 [abailey81/Crypto-Statistical-Arbitrage](https://github.com/abailey81/Crypto-Statistical-Arbitrage)(고정 SHA `44b718e`)의 Phase 3 BTC 선물 전략을 조사하고 재현한다. 원본 조사 결과는 [docs/ORIGINAL_AUDIT.md](docs/ORIGINAL_AUDIT.md)에 있다.

이 패키지에는 **주문·계정·출금 코드가 없다.** HTTP 클라이언트는 허용된 공개 조회 경로만 열고, 인증 헤더와 주문 경로는 요청 전에 거부한다(`csa_lab/http.py`). 운영 앱·서버와는 연결되지 않는다.

## 구성

| 모듈 | 역할 |
|---|---|
| `leverage.py` | 레버리지 입력 검증. 정수 1~10만 허용하고 기본값은 1이다. 거래소별로 확인된 한도도 여기서 다룬다 |
| `margin.py` | 명목가치, 증거금, 격리 청산가, 미실현 손익 계산 |
| `money.py` | 원화→USDT 환산(환율이 없으면 중단)과 전략별 자금 할당 장부 |
| `fund.py` | 자동매매 자금 원장(PAPER): 기본 자금·최대 진입 증거금·50% 재투자·예비금·중복 결산 금지·복구 |
| `costs.py` | 비용 항목. 미확인 비용은 `UNKNOWN`, 가정한 비용은 `ASSUMED`로 표시 |
| `quality.py` | 중복·누락·비정상 가격·OHLC 모순·최신성 검사 |
| `storage.py` | 원자적 저장, 실행 잠금, 체크포인트, 결과 불변 보관(MANIFEST sha256) |
| `http.py` | 읽기 전용 공개 API 클라이언트. 지수형 재시도에 상한이 있다 |
| `data/` | Binance 월별 파일(체크섬 검증)·REST, Hyperliquid info, 업비트·ECB 환율 수집 |
| `backtest.py` | 실제 손익 백테스트 엔진과 전략 2종 |
| `pipeline.py` | 수집 → 품질 검사 → 레버리지별 실행 → 결과 저장 |
| `original_runner.py` | 원본 코드를 무수정으로 격리 실행 |
| `soak.py` | 장시간 무주문 운영 실행기 |

## 레버리지 적용 방식

선택한 레버리지 L 하나가 CLI → `parse_leverage` → `run_backtest` → 포지션 크기 → 비용·펀딩 → 청산가 → 결과 파일까지 그대로 전달된다.

- **거래소 간 펀딩 차이 전략(`xvenue_funding`)**
  - 자본 C를 두 거래소의 증거금으로 반씩 나눈다.
  - 다리당 명목가치는 `C/2 × L`이다.
- **펀딩 캐리 전략(`carry_binance`)**
  - 현물 매수 명목은 `C·L/(L+1)`이고, 무기한 선물 숏 증거금은 `C/(L+1)`이다. 무기한 숏의 명목가치는 현물과 같다.
  - 현물 다리에는 레버리지를 걸지 않는다.
- **비례 관계**: 수수료·슬리피지·스프레드·펀딩은 모두 명목가치에 비례하므로 L에 비례해서 커진다.
- **청산가**: 롱은 `E(1-1/L)/(1-mmr)`, 숏은 `E(1+1/L)/(1+mmr)`이다. 봉의 고가·저가(바이낸스는 마크가격)가 청산가에 닿으면 그 다리의 증거금 전액을 잃는 것으로 처리한다.
- **PAPER 한도와 실계좌 한도 분리**: PAPER 계산은 1~10배를 모두 허용한다. 대신 거래소 한도가 확인되지 않았으면 결과에 `UNVERIFIED_VENUE_LIMIT`로 표시한다.

## 자동매매 자금 관리 (fund.py)

- 초기 기본 자금 1,000,000 KRW(참고 기준, 손실 뒤 자동 보충 없음), 최대 진입 증거금 한도 기본 1,000,000 KRW(`--max-entry-krw`로 변경).
- 진입 증거금(레버리지 적용 전) = min(최대 진입 한도, 기본 자금 잔액, 전략 계획 잔여분, 거래소 잔액·증거금 상한·리스크 상한 중 확인된 값). 거래소 최소 주문 금액보다 작으면 진입을 막는다.
- 실현 순이익(수수료·펀딩·슬리피지·스프레드 차감 후)의 50%는 기본 자금에 재투자, 50%는 예비금. 손실은 기본 자금에서 뺀다. 예비금 → 기본 자금 이체 기능은 없다.
- 전략별 계획 자금(기본 500,000 KRW)은 같은 기본 자금에서 떼어 두는 계획이다. 계획 합계가 기본 자금을 넘으면 `BLOCKED_PLAN_EXCEEDS_FUND`로 기록하고 실행하지 않는다(같은 돈의 중복 사용 금지).
- 결산은 거래 ID로 한 번만 처리한다. 상태는 원자적으로 저장하고, 다시 읽을 때 일지로 재계산해 불일치(변조·반쪽 저장)를 잡는다.
- 백테스트에서는 구간 시작 환율 하나로 원화↔USDT를 고정 환산한다(환율 변동 손익 미반영). 장시간 무주문 실행기(soak)는 신호와 PAPER 포지션 상태만 기록하고 이 원장에 결산하지 않는다(두 다리 가격이 없어 순손익을 산출하지 않음).

## 시장별 레버리지 정책 (최종, `market_policy.py`)

| 시장 | 범위 | 기본 | 입력 허용 | 비고 |
|---|---|---|---|---|
| 비트겟 선물 | 정수 1~10 | 1 | 예 | PAPER·백테스트 범위. 계약 공개 한도(`minLever`~`maxLever`)는 `scripts/bitget_leverage_evidence.py`로 조회해 결과에 기록 |
| 업비트 현물 | 1 고정 | 1 | 아니오 | API·설정·요청 본문 어느 경로로 1 이외 값이 오면 거부(`tests/test_market_policy.py`) |
| 국내 주식 | 1 고정(현금) | 1 | 아니오 | 신용·미수 미사용 |
| 미국 주식 | 1 고정(현금) | 1 | 아니오 | 마진 미사용 |

## 운영 앱 반영 (이 PR에 포함하지 않음, 패치로 전달)

- 운영 앱(`api-server`, `stock-analyzer`)의 비트겟 선물 레버리지 하한을 2→1로 내리고 업비트 현물·주식 계획의 `leverage`/`marginMode` 필드를 `LEVERAGE_NOT_APPLICABLE_SPOT_OR_STOCK`으로 차단하는 변경은 만들어 검증했지만(서버 테스트 2,884건·타입검사·자동매매 게이트 검증기 통과) 이 PR에는 넣지 않았다. 이유: 운영 앱 자동매매 파일을 바꾸면 소유자 승인 경로 목록 검사(`verify-research-workspace-sync-v3.mjs`)가 PR의 모든 파일을 승인 목록과 대조하는데, 이 디렉터리(`crypto-stat-arb/**`)는 그 목록에 없어 함께 넣으면 통과할 수 없다.
- 그 변경은 `/mnt/project-files/review/bitget-leverage-floor-1x-20261020.patch`(승인 목록 안의 파일만)와 `...-unreviewed-paths-20261020.patch`(`four-market-auto-readiness.service.ts`, `futures-live-limited-capability.service.ts` 두 파일, 승인 목록 밖)로 보관한다. 별도 브랜치·PR로 올리려면 사용자 허락이 필요하다.
- **바꾸지 않은 것(승인 항목)**: 기본값 2배, 회원 최대 3배·관리자 최대 7배 상한, 설정 화면(`trade-automation-settings.tsx`, 소유자 해시 고정)의 1배 선택지. 기본값을 1로 바꾸면 2배로 고정된 자동 PAPER 사이징(`pump-reversal-paper-risk-sizing.service.ts`)과 작업자의 증빙 일치 검사가 어긋나 자동 진입이 전부 차단된다. 8~10배는 게이트 상한(7) 완화가 필요하다.
- 운영 앱의 PAPER와 실거래는 같은 정책 행(`trade_automation_profiles`)을 읽는다. 별도의 PAPER 전용 레버리지 설정은 없다.
- 운영 앱의 100만원은 `totalCapitalKrw`(총 자본), 50만원은 회원 1회 주문 상한(`maxOrderKrw`, 관리자 100만원)이다. 이 패키지의 50만원은 전략별 계획 자금, 100만원은 자동매매 기본 자금이며 운영 앱 자금과 연결되지 않는다.

## 실행

```bash
pip install -r requirements.txt
python -m pytest -q tests

python -m csa_lab collect  --data-dir D --start 2020-01 --end 2026-09
python -m csa_lab backtest --data-dir D --results-dir R --leverage all          # 기본 1배, all=1~10
python scripts/bitget_leverage_evidence.py OUT.json                                # 비트겟 계약 공개 한도(조회 전용)
python -m csa_lab backtest --data-dir D --results-dir R --leverage 3 --capital-krw 500000 \
    --fund-initial-krw 1000000 --max-entry-krw 1000000      # 자금 원장 적용(기본). --no-fund 로 끔
python -m csa_lab original --original-repo ORIG --data-dir D --out O --start-date 2023-07-01 --end-date 2024-12-31
python -m csa_lab soak     --root S --hours 24 --interval-s 300
python -m csa_lab verify   R/<run_id>
```

- 결과는 `R/<시각>-<라벨>-<설정해시>-<데이터지문>/`에 새로 만든다. 이전 결과는 덮어쓰지 않는다.
- GitHub Actions 워크플로 `.github/workflows/crypto-stat-arb-validation.yml`이 이 디렉터리를 바꾸는 PR에서 위 과정 전체를 실행한다. 단계별 기록은 `scripts/ci_pipeline.sh`, `scripts/ci_soak.sh`에 있다.

## 알려진 한계

- **하이퍼리퀴드 가격 대용**: 하이퍼리퀴드 1시간봉은 공개 API가 최근 5,000개만 준다. 그래서 하이퍼리퀴드 다리의 가격은 바이낸스 BTCUSDT 무기한 가격으로 대신하고, 결과에 그렇게 표시한다. 펀딩은 실제 하이퍼리퀴드 이력을 쓴다.
- **비용 가정**: 현재 수수료표, 바이낸스 유지증거금률 0.4%, 스프레드 1bp는 이 작업 환경에서 출처를 다시 확인하지 못한 가정값(`ASSUMED`)이다. 그래서 순수익성은 "미검증"으로 표시한다.
- **원본과 다르게 정한 규칙**: 원본에는 청산 규칙이 없다(예상 수익을 즉시 기록하므로). 그래서 여기서 정했다. 캐리 전략은 연환산 5% 미만이면 청산하고, 거래소 간 전략은 차이가 0 이하가 되거나 30일이 지나면 청산한다. 데이터가 오래되면 신규 진입을 막고 보유 포지션도 정리한다.
