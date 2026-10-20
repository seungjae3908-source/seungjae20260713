# crypto-stat-arb: 원본 재현·레버리지 1~7배 검증 (조회 전용, PAPER)

공개 저장소 [abailey81/Crypto-Statistical-Arbitrage](https://github.com/abailey81/Crypto-Statistical-Arbitrage)(고정 SHA `44b718e`)의 Phase 3 BTC 선물 전략을 조사하고 재현한다. 원본 조사 결과는 [docs/ORIGINAL_AUDIT.md](docs/ORIGINAL_AUDIT.md)에 있다.

이 패키지에는 **주문·계정·출금 코드가 없다.** HTTP 클라이언트는 허용된 공개 조회 경로만 열고, 인증 헤더와 주문 경로는 요청 전에 거부한다(`csa_lab/http.py`). 운영 앱·서버와는 연결되지 않는다.

## 구성

| 모듈 | 역할 |
|---|---|
| `leverage.py` | 레버리지 입력 검증. 정수 1~7만 허용하고 기본값은 1이다. 거래소별로 확인된 한도도 여기서 다룬다 |
| `margin.py` | 명목가치, 증거금, 격리 청산가, 미실현 손익 계산 |
| `money.py` | 원화→USDT 환산(환율이 없으면 중단)과 전략별 자금 할당 장부 |
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
- **PAPER 한도와 실계좌 한도 분리**: PAPER 계산은 1~7배를 모두 허용한다. 대신 거래소 한도가 확인되지 않았으면 결과에 `UNVERIFIED_VENUE_LIMIT`로 표시한다.

## 실행

```bash
pip install -r requirements.txt
python -m pytest -q tests

python -m csa_lab collect  --data-dir D --start 2020-01 --end 2026-09
python -m csa_lab backtest --data-dir D --results-dir R --leverage all          # 기본 1배, all=1~7
python -m csa_lab backtest --data-dir D --results-dir R --leverage 3 --capital-krw 500000
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
