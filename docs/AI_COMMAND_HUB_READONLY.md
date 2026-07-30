# AI Command Hub 0.1 — Read-only

이 문서는 ChatGPT 맞춤 GPT가 서버 상태와 오류 로그를 직접 조회할 수 있도록 연결하는 1단계 구성입니다.

## 현재 허용 범위

- 서버 운영체제, CPU, 메모리, 업타임 조회
- 프로젝트가 위치한 디스크 사용량 조회
- 현재 Git 브랜치, 커밋, 변경 파일, 최근 커밋 조회
- PM2 프로세스 상태 조회
- 지정된 PM2 앱의 최근 로그 조회
- 위 정보를 한 번에 반환하는 snapshot 조회
- 모든 요청을 JSONL 감사 로그에 기록

## 현재 차단 범위

- 임의 셸 명령 실행
- 파일 생성, 수정, 삭제
- Git commit, pull, reset, checkout
- PM2 restart, stop, delete
- 패키지 설치
- 환경변수 수정
- 데이터베이스 변경
- 배포 및 롤백
- 실제 주문 또는 자동매매 실행

현재 단계의 모든 엔드포인트는 읽기 전용입니다.

## 필수 환경변수

```bash
COMMAND_HUB_TOKEN=<길이 32자 이상의 무작위 비밀값>
COMMAND_HUB_PROJECT_ROOT=/opt/stock-app
COMMAND_HUB_PM2_APP=stock-app
COMMAND_HUB_AUDIT_LOG=/opt/stock-app/logs/command-hub-audit.jsonl
```

토큰은 GitHub, 소스 코드, 로그 또는 채팅에 저장하지 않습니다.

무작위 토큰 생성 예시:

```bash
openssl rand -hex 32
```

## 인증

다음 중 하나를 사용할 수 있습니다.

```http
Authorization: Bearer <COMMAND_HUB_TOKEN>
```

또는

```http
X-Command-Hub-Token: <COMMAND_HUB_TOKEN>
```

맞춤 GPT Action에는 Bearer 인증 사용을 권장합니다.

## 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/command-hub/health` | Hub 연결과 읽기 전용 모드 확인 |
| GET | `/api/command-hub/server/status` | 시스템, 디스크, PM2 상태 |
| GET | `/api/command-hub/pm2/status` | PM2 프로세스 목록 |
| GET | `/api/command-hub/pm2/logs?lines=120` | 지정 앱의 최근 로그 |
| GET | `/api/command-hub/git/status` | 브랜치, 커밋, 변경 상태 |
| GET | `/api/command-hub/snapshot?lines=120` | 전체 진단 자료 일괄 조회 |

`lines`는 최소 20줄, 최대 500줄로 제한됩니다.

## 맞춤 GPT Action 연결

1. `docs/ai-command-hub-openapi.yaml`을 엽니다.
2. `servers.url`을 실제 HTTPS 서버 주소로 변경합니다.
3. 맞춤 GPT 편집 화면에서 Actions에 스키마를 붙여 넣습니다.
4. Authentication을 API Key/Bearer 방식으로 설정합니다.
5. `COMMAND_HUB_TOKEN`과 동일한 값을 등록합니다.
6. `getCommandHubHealth`를 먼저 테스트합니다.
7. 정상 연결 후 `getCommandHubSnapshot`으로 전체 상태를 확인합니다.

## 권장 GPT 지침

```text
서버 오류 요청을 받으면 먼저 getCommandHubSnapshot을 호출한다.
로그, PM2 상태, Git 변경 상태를 근거로 원인을 분석한다.
데이터에 없는 내용을 추측하지 않는다.
토큰, 비밀번호, 쿠키, JWT 등 민감정보를 출력하지 않는다.
현재 Command Hub는 읽기 전용이므로 수정이나 재시작이 필요하면 실행하지 말고,
정확한 원인과 다음 안전 작업을 사용자에게 보고한다.
```

## 보안 원칙

- 반드시 HTTPS 뒤에서만 노출합니다.
- `COMMAND_HUB_TOKEN`은 최소 32자 이상으로 설정합니다.
- 토큰은 URL query string에 넣지 않습니다.
- 방화벽 또는 프록시에서 요청 속도 제한을 추가하는 것을 권장합니다.
- PM2 프로세스 환경변수 전체를 API로 반환하지 않습니다.
- 로그 출력에서 일반적인 API key, token, password, JWT, private key 패턴을 제거합니다.
- 감사 로그 파일 권한은 소유자만 읽도록 유지합니다.

## 다음 단계

0.1 안정화 후 0.2에서는 다음 기능을 별도 승인 토큰과 작업 ID 기반으로 추가합니다.

- typecheck, test, build 실행
- 변경 전 백업
- 지정 파일 patch
- 변경 diff 확인
- 사용자 승인 후 PM2 restart
- health check 실패 시 자동 롤백

운영 서버에 바로 쓰기 권한을 제공하지 않고, 스테이징과 별도 작업 브랜치에서 먼저 검증합니다.
