# AI 차트 · 종목 AI 분석 · 기술 생중계 — 배포 전 일괄 사전검사

2026-10-12 | Central Hub #1102 | Draft #1863 | Replit 및 Replit Agent 사용 금지

## 코드/계약 보완 대상 (한 묶음)
- P0: HTTP 200이지만 요청 시장/종목/시간봉과 다른 4시장 공개 캔들/과거 캔들 응답을 차단한다. 선택 오류를 다른 종목의 실제 수익/AI 근거로 둔갑시키지 않는다.
- P0: KR/US 주식 기본 /candles 공급원 5xx·네트워크 장애 시 GET-only 기존 /chart 보조경로를 사용한다. 429는 우회하지 않으며 장애 종류/출처를 기록한다.
- P1: 사용자 자동 갱신 일시정지 중에도 30초 로컬 시계로 시세 신선도/AI 판단을 다시 평가한다(네트워크 호출 없음).
- P1: 서버 수집 시각 30분 초과 AI 분석을 현행 판단에서 만료한다. 5분 기기 시계 오차 허용, 원시 체결 시각과 수집 시각을 혼동하지 않는다.
- P1: 환율/금액 곱셈의 비정상 수치 Infinity/NaN 노출을 차단한다(주문 가격 불변).

## 한 번의 최종 CI와 배포 선행 게이트
1. **모든 변경을 하나의 Draft 커밋으로 묶은 뒤** Fast CI(타입/단위/smoke/build/critical browser 4개) + exact-HEAD Required Full CI 26잡, 필수 6/6 확인. 성공한 잡 반복 실행 금지. 0 실패, skipped는 별도 표기.
2. 최신 main과 겹치는 파일/behind/mergeable/미해결 리뷰 및 사용자 승인 범위를 재확인. 다른 AUTO/실계좌/Telegram/Research 변경, DB, Secret, 보호 CI/workflow 파일 미수정.
3. 공식 Staging Readiness는 **병합된 최신 main + 승인된 release provenance**를 요구한다. Draft CI만으로 authenticated Staging·4시장 실제 provider/LLM 연결·cold first-usable p95<=5000ms·Production QA를 증명할 수 없다. 이 게이트를 우회하거나 합격 수치를 완화하지 않는다.
4. 운영배포/Activation/계좌조회/실주문/입출금은 사용자 별도 승인 이후의 일이며 이 Draft 범위가 아니다.

## 운영에서 별도로 확보해야 하는 증거
- 국내·미국주식·Upbit·Bitget 실제 공개 API의 심볼/시간봉/수집 시각과 연속 정상 공급, 빈 데이터/429/5xx/장중 종료 시 대처.
- 실제 로그인/회원별 권한·세션 만료·모바일 320~1440px, 차트 최초 사용 가능 p95<=5초.
- 실제 설정한 AI 공급자 사용 가능 여부, 고지된 무료 할당량, 근거/답변 거절/취소/재접속.
- 생중계는 **규칙 기반 기술 이벤트 로그**이며 지속 발화 LLM/실제 수익성 PASS 증거가 아니다.
