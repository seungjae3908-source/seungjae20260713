# 관리자 UI 편집기 3차 범위

## 목표

1. 기존 화면 영역을 선택하면 내부 글씨·버튼·카테고리를 단계별로 열어 수정한다.
2. 기존 항목 삭제가 실제 게시 화면에서 숨김 처리되도록 한다.
3. 숨긴 기존 항목은 다시 추가/복원할 수 있게 한다.
4. 버튼 내부 카테고리를 추가·삭제하고 기존 허용 라우트에 연결한다.
5. 신호검색의 보조 문구를 수정·숨김·추가할 수 있게 한다.
6. 하단 메뉴의 종목 팝업에서 닫기·뒤로·제목·주식/코인·국내/해외·현물/선물 항목을 수정한다.

## 안전 원칙

- 임의 JavaScript/HTML/서버 명령 입력 금지
- 등록된 기존 라우트와 조회 API만 연결
- 실주문·자동매매 로직 변경 금지
- 기존 게시/버전/롤백 구조 유지
- 기존 스키마 버전 2 및 parentId 필드 재사용(추가 DB migration 없음)

## 주요 변경 파일

- `stock-analyzer/src/lib/ui-layout.ts`
- `stock-analyzer/src/components/ui-internal-editor.tsx`
- `stock-analyzer/src/components/ui-layout-runtime.tsx`
- `stock-analyzer/src/components/bottom-nav.tsx`
- `stock-analyzer/src/pages/signal-scan.tsx`
- `stock-analyzer/src/pages/admin-ui-builder.tsx`
- `api-server/src/routes/admin-ui-layouts.ts`
- `api-server/src/routes/ui-layouts.ts`

## 삭제 동작

- 기존 화면 요소: 레이아웃에서 제거하지 않고 `visible=false`로 저장하여 실제 화면에서 숨김
- 사용자 추가 요소: 해당 요소와 하위 요소를 레이아웃에서 완전히 제거
- 숨긴 기존 요소: 추가 화면에서 복원 가능

## 내부 편집 대상

### 신호검색

- 상단 제목/보조 문구
- 뒤로/새로고침 버튼
- 단타·스윙·중장기·직접설정 탭
- `실제 15분봉만 사용 · 거래량/거래대금·단기 추세·지지/저항을 함께 확인` 안내 문구
- 검색 조건 영역 내부 사용자 글씨/버튼 추가

### 하단 메뉴 > 종목

- 종목 메뉴 버튼
- 팝업 닫기/뒤로 버튼
- 팝업 제목
- 주식/코인 카테고리
- 국내주식/해외주식
- 코인 현물/코인 선물
- 사용자 카테고리 버튼 추가 및 허용 라우트 연결
