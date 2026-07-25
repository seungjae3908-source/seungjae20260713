# 2026-07-24 통합 수정 보고서

## 반영 기능
- 차트 생중계 및 신호검색기: 기존 WebSocket/분석 서비스와 화면을 유지하고 권한 체계를 5단계로 확장
- 중앙 팝업 UI: 기존 BottomNav 중앙 오버레이 팝업 구조 유지
- 설정창: 기존 설정/알림/백업 기능 유지, 달러 계산기 추가
- 모의 자동매매: master/admin 전용, 로컬 모의 주문·포지션·목표/손절 계산 구현
- 회원등급: pending / associate / full / master / admin
- 실제 주문: 모든 UI와 로직에서 비활성. 신규 자동매매 화면은 실계좌 API를 호출하지 않음

## 권한 요약
- pending: 승인 대기 화면
- associate: 기본 차트·뉴스/정보
- full: 고급 분석·차트 생중계·신호검색·선물·관심·포트폴리오
- master: full + 모의 자동매매
- admin: master + 회원관리/최고관리자 기능

## DB 적용
`supabase/migrations/20260724_expand_member_roles.sql`을 Supabase SQL Editor에서 적용해야 5단계 role 값이 저장됩니다.

## 검증 참고
현재 작업 환경은 외부 npm 레지스트리 접근이 차단되어 pnpm 실행형 타입검사는 수행하지 못했습니다. 대신 변경 파일 문법/경로/라우팅과 git diff 공백 오류를 점검했습니다.
