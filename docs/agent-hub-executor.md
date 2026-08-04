# Agent Hub 제한형 실행기

이 문서는 GitHub Issue #62의 `[HUB_COMMAND]`를 받아 읽기 전용 점검이나 제한된 코드 변경을 수행하는 2단계 자동 작업자를 설명한다.

일반 ChatGPT 채팅방을 원격 조작하는 기능이 아니라, GitHub Actions 안에서 독립적으로 실행되는 저장소 작업자다.

## 자동 순환 구조

```text
신뢰된 작업방 또는 사용자
  → Issue #62에 [WORKER_REPORT]
  → Free Agent Hub가 Gemini로 [HUB_COMMAND] 생성
  → repository_dispatch: agent-hub-command-ready
  → Agent Hub Executor가 명령 검증·실행
  → 읽기 전용 결과 또는 격리 브랜치의 Draft PR 생성
  → Issue #62에 [WORKER_REPORT]
  → repository_dispatch: agent-executor-report-ready
  → Free Agent Hub가 종료·승인대기·다음 명령 결정
```

GitHub의 기본 `GITHUB_TOKEN`으로 작성한 일반 Issue 댓글은 다른 워크플로를 즉시 재실행하지 않으므로, 두 워크플로 사이의 즉시 전달은 허용된 `repository_dispatch` 이벤트를 사용한다. 매시간 예약 실행은 누락 복구용이다.

## 실행 모드

### `read_only`

- 저장소 파일 조회·검색·디렉터리 목록만 허용
- 파일 생성·수정·삭제가 하나라도 발생하면 실패
- 결과를 Issue #62에 보고하고 추가 작업 없이 종료

### `code_change`

- 최소한의 소스·테스트·일반 문서 편집만 허용
- Gemini에게 쉘과 네트워크 도구를 제공하지 않음
- 변경량·경로·비밀정보 검사를 통과해야 함
- 타입검사와 API smoke test 성공 후에만 격리 브랜치에 커밋
- `agent/hub-*` 브랜치와 Draft PR만 생성
- 병합은 사용자 명시 승인 전 수행하지 않음

## 신뢰 조건

실행기는 아래 조건을 모두 만족하는 댓글만 명령으로 인정한다.

- Issue #62의 댓글
- 작성자 `github-actions[bot]`
- `[HUB_COMMAND]` 포함
- Agent Hub가 넣은 정확한 숨은 처리 마커 포함
- `provider: gemini-developer-api-free`
- `target_worker: github-executor`
- `status: ready`
- `execution_mode: read_only` 또는 `code_change`
- 자동 연속 작업 횟수 1~3 이내

같은 명령 댓글은 성공 또는 오류 마커가 생긴 뒤 다시 처리하지 않는다.

## Gemini 도구 제한

사용 Action과 CLI는 다음 버전으로 고정한다.

- `google-github-actions/run-gemini-cli@v0.1.22`
- Gemini CLI `0.52.0`
- 모델 `gemini-3.1-flash-lite`

읽기 전용 모드의 도구:

```text
read_file
glob
grep_search
list_directory
```

코드 변경 모드는 아래 두 도구만 추가한다.

```text
write_file
replace
```

`run_shell_command`, 웹 검색, MCP, 확장 기능, Agent Skill은 Gemini에서 사용할 수 없다. 검증·Git·PR 작업은 모델이 아니라 고정된 GitHub Actions 단계가 수행한다.

## 변경 안전 게이트

다음 조건을 하나라도 위반하면 커밋과 PR 생성을 중단한다.

- 변경 파일 최대 12개
- 총 추가·삭제 최대 1,200줄
- 파일 삭제·이름 변경·복사 금지
- 바이너리·심볼릭 링크·UTF-8이 아닌 새 파일 금지
- API 키·토큰·개인키 패턴 발견 시 금지
- 새로 생성된 추적되지 않은 파일도 검사 대상

변경 금지 경로와 종류:

- `.github`, `.git`, `.gemini`
- `ops`, `infra`, `deploy`, `supabase`, migration
- `.env`, Secret·Credential·Private Key 관련 경로
- Agent Hub 실행 코드와 문서
- `package.json`과 모든 lockfile
- `dist`, coverage, Playwright report, test result, `node_modules`

## 고정 검증

코드 변경이 있을 때 아래 명령을 Gemini와 분리된 단계에서 실행한다.

```bash
pnpm install --frozen-lockfile
pnpm --dir stock-analyzer run typecheck
pnpm --dir api-server run typecheck
pnpm --dir api-server run test:smoke
```

검증 실패 시 커밋·push·Draft PR 생성은 수행하지 않고 실패 보고만 남긴다.

## 승인 경계

항상 자동 실행 금지:

- `main` 직접 변경
- PR 병합
- 운영·스테이징 배포
- 파일 또는 인프라 삭제
- 권한 변경
- Secret 생성·변경·조회
- 데이터베이스 migration
- 실계좌·실주문·자동매수·자동매도

코드 변경 Draft PR이 만들어지면 허브는 `waiting_approval`로 정지한다.

## CI 주의사항

작업자가 기본 `GITHUB_TOKEN`으로 Draft PR을 만들면 GitHub는 해당 PR의 `pull_request` 워크플로를 승인 대기 상태로 생성할 수 있다. 이 경우 저장소 쓰기 권한이 있는 사용자가 PR 화면에서 **Approve workflows to run**을 눌러 전체 Application CI를 시작한다.

실행기 내부 타입검사와 smoke test는 PR 생성 전에 이미 수행되지만, 병합 전에는 기존 필수 CI도 모두 성공해야 한다.

## 비용

- 기존 `GEMINI_API_KEY` 무료 등급 사용
- 별도 OpenAI API 비용 없음
- 유료 모델 자동 전환 없음
- 무료 한도 초과 시 실패 보고 후 정지
- 공개 저장소의 표준 GitHub-hosted runner 사용

## 운영 원칙

Issue #62에는 비밀키, 개인정보, 계좌정보, 주문정보를 기록하지 않는다. 모든 자동 생성 PR은 Draft 상태로 유지하며 사용자의 명시 병합 승인 없이는 `main`에 반영하지 않는다.
