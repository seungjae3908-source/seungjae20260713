차트 복구 패치 2026-07-24

적용 대상
- 현재 Replit의 '업뎃후 망침' 상태
- 새로 추가한 관심종목·알림·Broadcast 기능은 유지
- 기존 프로젝트 전체를 덮어쓰지 않고 차트 관련 5개 파일만 교체

확인된 핵심 원인
1. 공유 WebSocket 훅이 처음부터 connecting 상태로 시작했습니다.
2. Relay/Broadcast 화면은 connecting 상태에서 REST 캔들 조회를 껐습니다.
3. Replit Vite 프록시에 ws:true가 없어 /api/realtime/chart 업그레이드가 전달되지 않았습니다.
4. 결과적으로 WebSocket 스냅샷도 없고 REST 조회도 꺼져 차트가 무한 로딩될 수 있었습니다.
5. 코인 현물 4시간봉의 Upbit 240분 변환도 빠져 있었습니다.

적용 명령
cd ~/workspace
unzip -o chart-repair-20260724.zip
bash chart-repair-20260724/apply.sh

적용 후
- Replit에서 Stop
- Run 다시 실행
- 브라우저에서 새로고침

복구되는 파일
- stock-analyzer/src/pages/chart-relay.tsx
- stock-analyzer/src/components/chart-broadcast.tsx
- stock-analyzer/src/hooks/use-realtime-chart.ts
- stock-analyzer/src/lib/chart-preferences.ts
- stock-analyzer/vite.config.ts

안전 조치
- 기존 5개 파일은 .repair-backups/chart-repair-날짜시간/ 아래에 자동 백업됩니다.
- 잘못 생성된 [App.tsx](C: 등 네 폴더만 정확히 제거합니다.
- .env, Secrets, Supabase 데이터, 회원 계정은 변경하지 않습니다.
- 실제 주문·자동매매 설정은 변경하지 않습니다.

검사
- 수정된 TS/TSX 파일의 TypeScript 구문 검사를 통과했습니다.
- Replit 실제 실행 및 외부 API 연결은 이 환경에서 실행하지 않았습니다.
