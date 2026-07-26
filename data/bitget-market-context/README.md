# Bitget 공개 시장상태 수집 데이터

- 기본 주기: 5분
- 기본 종목: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
- 형식: `YYYY-MM-DD/SYMBOL.jsonl`
- 항목: 가격·마크·지수·스프레드·펀딩·OI·계정/포지션/시장 롱숏비율
- 기본 보존: 180일
- 실제 주문·개인계좌·API 키 사용 없음
- 서버 재시작 시 최근 3일 파일을 읽어 OI 변화율 계산을 이어감
- 런타임 JSONL 파일은 Git에 커밋하지 않음

초기에는 1시간 OI 이력이 부족하므로 `OI_HISTORY_INSUFFICIENT` 경고와 함께 신규 롱 진입이 차단됩니다.
