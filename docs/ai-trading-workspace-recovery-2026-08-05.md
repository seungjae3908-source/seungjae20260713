# AI 매매 워크스페이스 안전 복구 기록

작성 기준: 2026-08-05 KST

## 저장소 독립 확인 결과

- 기준 저장소: `seungjae3908-source/seungjae20260713`
- 기준 브랜치: `main`
- 작업 시작 기준 HEAD: `c4f1b557be2d6ebd661464c75ea9be4d86947031`
- `main`에는 `/trading-workspace` route와 주식용 AI 매매 워크스페이스 파일이 없었습니다.
- `mock_trade_orders`, `/api/trading/mock/execute`, prepare/execute/orders/cancel 구현은 파일·커밋·PR 검색에서 확인되지 않았습니다.
- 현재 `/paper-trading`은 Bitget 선물 모의거래 화면이므로 주식 AI 차트에 재사용하지 않았습니다.
- 과거 인수인계의 1~5차 완료 내용은 저장소에 반영된 구현으로 독립 재현되지 않았습니다.

## 이번 복구 범위

전용 브랜치 `agent/ai-trading-workspace-entry`에서 다음 UI 안전 경계만 복구합니다.

1. `/trading-workspace` 독립 route
2. AI 차트의 `AI 매매창 열기` 버튼
3. 데스크톱 팝업 창과 팝업 차단 시 동일 탭 fallback
4. 모바일 동일 탭 이동
5. 선택 종목·시장·시간봉 query 전달
6. 워크스페이스의 AI 차트 복귀 버튼
7. 첫 Enter 검토, 두 번째 Enter 로컬 모의기록
8. pending 로컬 기록 취소와 세션 기록 비우기

## 안전 경계

- 주문·계좌·DB API 호출 없음
- 실주문 코드 추가 없음
- 자동매수·자동매도 없음
- 운영·Replit 배포 없음
- Supabase·migration·RLS 변경 없음
- Secret·환경변수 변경 없음
- 브라우저 `sessionStorage`에 최대 50건만 저장
- AI 분석 결과가 주문을 자동 실행하지 않음
- route는 `canAccessPaperTrading` capability로 보호

## 의도적으로 제외한 범위

다음 항목은 별도 설계·검토와 사용자 승인이 필요하므로 포함하지 않습니다.

- `/api/trading/mock/prepare`
- `/api/trading/mock/execute`
- `/api/trading/mock/orders`
- `/api/trading/mock/cancel`
- 승인 토큰과 idempotency 서버 계약
- `mock_trade_orders` migration과 RLS
- Supabase 실제 적용
- 키움·비트겟 private account 연결
- 실계좌 조회와 모든 실제 주문

## 검증 계획

Draft PR에서 다음을 확인합니다.

- 프런트엔드 TypeScript
- 백엔드 TypeScript 회귀
- 프런트엔드 production build
- 백엔드 production build
- 기존 unit/regression/E2E
- 주문성 네트워크 요청이 추가되지 않았는지 diff 검토
- `main` 직접 수정, 병합, 배포가 없었는지 확인
