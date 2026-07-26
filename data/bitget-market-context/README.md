# Bitget market context runtime data

이 폴더는 비트겟 공개 선물시장 데이터의 미래 검증용 스냅샷을 저장합니다.

- 기본 주기: 5분
- 기본 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 형식: `YYYY-MM-DD/SYMBOL.jsonl`
- 수집 항목: 가격·마크·지수·스프레드·펀딩·OI·계정/포지션/전체 롱숏비율
- 실제 주문·개인계좌·API 키 사용 없음
- JSONL 결과는 Git에 커밋하지 않음

초기 1시간은 OI 변화 이력이 충분하지 않아 `OI_HISTORY_INSUFFICIENT` 경고와 함께 롱 눌림 진입을 차단합니다. 서버 재시작 시 최근 3일 파일을 다시 읽어 변화율 계산을 이어갑니다.
