# AI Command Hub 0.2 — Read + Fixed Checks

이 문서는 ChatGPT 맞춤 GPT가 서버 상태와 오류 로그를 직접 조회하고, Codex 없이 서버 자체에서 고정된 검증 작업을 실행하도록 연결하는 구성입니다.

## 현재 허용 범위

- 서버 운영체제, CPU, 메모리, 업타임 조회
- 프로젝트 디스크 사용량 조회
- 현재 Git 브랜치, 커밋, 변경 파일, 최근 커밋 조회
- PM2 프로세스 상태와 지정 앱 최근 로그 조회
- 전체 진단 snapshot 조회
- 고정된 `typecheck`, `build-server`, `build-all` 작업 실행
- 작업 ID, 대기·실행·성공·실패·시간초과 상태와 결과 조회
- 한 번에 작업 하나만 실행
- 모든 요청을 JSONL 감사 로그에 기록

## 계속 차단되는 범위

- 사용자가 보낸 임의 셸 명령 실행
- 파일 생성, 수정, 삭제
- Git commit, pull, reset, checkout
- PM2 restart, stop, delete
- 패키지 설치
- 환경변수 수정
- 데이터베이스 변경
- 배포 및 롤백
- 실제 주문 또는 자동매매 실행

검사 실행기는 기본값이 꺼짐이며, 환경변수로 명시적으로 켜기 전에는 `503 COMMAND_HUB_RUNNER_DISABLED`를 반환합니다.

## 환경변수

```bash
COMMAND_HUB_TOKEN=<길이 32자 이상의 무작위 비밀값>
COMMAND_HUB_PROJECT_ROOT=/opt/stock-app
COMMAND_HUB_API_SERVER_ROOT=/opt/stock-app/api-server
COMMAND_HUB_PM2_APP=stock-app
COMMAND_HUB_AUDIT_LOG=/opt/stock-app/logs/command-hub-audit.jsonl
COMMAND_HUB_RUNNER_ENABLED=false
```

읽기 전용 연결과 서버 검증이 끝난 뒤에만 다음처럼 검사 실행기를 켭니다.

```bash
COMMAND_HUB_RUNNER_ENABLED=true
```

토큰은 GitHub, 소스 코드, 로그 또는 채팅에 저장하지 않습니다. 생성 예시:

```bash
openssl rand -hex 32
```

## 인증

맞춤 GPT Action에는 다음 Bearer 인증을 사용합니다.

```http
Authorization: Bearer <COMMAND_HUB_TOKEN>
```

호환용으로 `X-Command-Hub-Token` 헤더도 지원하지만 URL query string에는 토큰을 넣지 않습니다.

## 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/command-hub/health` | Hub와 고정 검사 실행기 상태 |
| GET | `/api/command-hub/server/status` | 시스템, 디스크, PM2 상태 |
| GET | `/api/command-hub/pm2/status` | PM2 프로세스 목록 |
| GET | `/api/command-hub/pm2/logs?lines=120` | 지정 앱 최근 로그 |
| GET | `/api/command-hub/git/status` | 브랜치, 커밋, 변경 상태 |
| GET | `/api/command-hub/snapshot?lines=120` | 전체 진단 자료 |
| GET | `/api/command-hub/checks` | 최근 검사 작업 목록 |
| POST | `/api/command-hub/checks` | 고정 검사 작업 등록 |
| GET | `/api/command-hub/checks/{jobId}` | 진행 상태와 전체 결과 |

검사 등록 예시:

```json
{ "action": "typecheck" }
```

허용 값은 `typecheck`, `build-server`, `build-all`뿐입니다. 명령어, 경로, 인수를 요청 본문으로 받을 수 없습니다.

## 서버 검증 순서

운영 경로가 아닌 작업 복사본 또는 스테이징에서 먼저 실행합니다.

```bash
pnpm --dir api-server run typecheck
pnpm --dir api-server run build:server
pnpm --dir api-server run build
```

그다음 `COMMAND_HUB_RUNNER_ENABLED=false` 상태로 서버를 시작하고 다음 순서로 확인합니다.

1. `getCommandHubHealth`
2. `getCommandHubSnapshot`
3. 환경변수를 `true`로 전환
4. `runCommandHubCheck`로 `typecheck` 실행
5. 반환된 job ID를 `getCommandHubCheck`로 조회
6. 성공 확인 후 서버 빌드와 전체 빌드 검사

## 권장 GPT 지침

```text
서버 오류 요청을 받으면 먼저 getCommandHubSnapshot을 호출한다.
로그, PM2 상태, Git 변경 상태를 근거로 원인을 분석한다.
데이터에 없는 내용은 추측하지 않는다.
토큰, 비밀번호, 쿠키, JWT 등 민감정보를 출력하지 않는다.
검사가 필요하면 typecheck를 먼저 실행하고 완료 상태를 조회한다.
build-server와 build-all은 앞 단계가 성공했을 때만 순서대로 실행한다.
현재 Command Hub에는 파일 수정, 재시작, 배포 권한이 없으므로 그런 작업이 필요하면 실행했다고 주장하지 않는다.
```

## 보안 원칙

- 반드시 HTTPS 뒤에서만 노출
- 토큰 최소 32자
- 요청 속도 제한 권장
- PM2 환경변수 전체를 반환하지 않음
- 일반적인 API key, token, password, JWT, private key 패턴 마스킹
- 검사 출력 최대 길이 제한
- 검사 시간 제한 10분
- 검사 동시 실행 수 1개
- 최근 작업은 메모리에 최대 50개 유지

API 프로세스가 재시작되면 메모리에 있던 작업 기록은 사라집니다. 영구 작업 기록과 승인형 수정·재시작은 다음 단계에서 별도 저장소와 승인 화면을 추가해 구현합니다.

## 다음 단계

- 파일 읽기 API와 허용 경로 검증
- 변경 제안과 diff 생성
- 승인 화면 및 일회성 승인 ID
- 변경 전 백업
- 승인된 파일 patch
- 타입 검사와 빌드 성공 후 PM2 restart
- health check 실패 시 자동 롤백

운영 서버에 바로 수정 권한을 제공하지 않고 스테이징과 별도 작업 브랜치에서 먼저 검증합니다.
