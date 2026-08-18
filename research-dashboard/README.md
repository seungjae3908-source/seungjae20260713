# Research Lab PWA

기존 투자앱 Production과 같은 서버에서 실행하되, `research-production`의 독립 상태 저장소만 읽는 별도 연구 관제 웹앱입니다.

## 목적

- Paper Forward 표본/Settlement 진행 확인
- Shadow 방향성 표본 및 collapse/F1/Balanced Accuracy 확인
- fast-historical / long-history / forward 연구 사이클 상태 확인
- 연구 실패/BLOCKED_DATA 즉시 확인
- 실사용 투자앱 UI와 연구용 상세 화면 분리

## 런타임

- 장기 실행 HTTP 서버는 Python 3 표준 라이브러리만 사용합니다.
- 별도 pip 패키지나 Node HTTP 런타임이 필요하지 않습니다.
- 프런트엔드 PWA 자산은 기존 JavaScript를 유지하며 Node는 CI의 정적 문법 검사에만 사용합니다.

## 안전 계약

- 기본 바인딩은 `127.0.0.1:18090`입니다. 외부에 포트를 직접 노출하지 않습니다.
- 허용 HTTP method는 `GET`, `HEAD`뿐입니다. POST/PUT/PATCH/DELETE는 405로 거부합니다.
- `/var/lib/investment-research-production`의 정규화된 집계값만 읽습니다.
- 주문, 계좌, private provider, DB write endpoint는 존재하지 않습니다.
- Dashboard 자체는 `PROFITABILITY_PROVEN=true`를 만들 수 없습니다. 승격은 기존 evidence gate만 담당합니다.
- systemd unit은 `investment-research` 사용자, `NoNewPrivileges`, 빈 capability set, `ProtectSystem=strict`로 격리합니다.

## 로컬 검증

```bash
cd research-dashboard
npm test
npm run check
RESEARCH_STATE_ROOT=/var/lib/investment-research-production npm start
```

## 서버 경로

- Dashboard 코드: `/opt/investment-research-dashboard/current/research-dashboard`
- Research Production 코드: `/opt/investment-research/current`
- 상태 읽기: `/var/lib/investment-research-production`
- 내부 주소: `http://127.0.0.1:18090`
- 권장 외부 주소: `https://research.<domain>`

Dashboard 활성화는 Research Production의 current release나 기존 `/opt/stock-app` 배포 SHA를 변경하지 않아야 합니다. 외부 공개 전에는 Caddy/Nginx에서 TLS와 인증을 먼저 적용합니다.
