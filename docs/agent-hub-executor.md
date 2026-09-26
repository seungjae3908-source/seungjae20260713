# Agent Hub 등록 워커 실행기 v4

실행기는 Issue #62의 `status=ready` 명령만 처리한다. 중앙 조정자가 아닌
별도 worker이며, Gemini 원문이 아닌 정책 엔진이 완성한 명령만 받는다.

## 실행 전 검증

- 댓글 작성자 `github-actions[bot]`
- 보고·command authenticity marker 일치
- 모든 v4 필수 필드 존재
- Provider `gemini-developer-api-free`
- Model `gemini-3.1-flash-lite`
- `paid_fallback=false`
- 등록 worker와 action scope 일치
- main/master가 아닌 허용 브랜치
- allowed path가 worker registry 내부
- forbidden path와 교차하지 않음
- 명령 미만료
- target branch 현재 HEAD와 `expected_head_sha` 일치
- attempt가 `max_attempts` 이내

HEAD가 바뀌면 Gemini를 호출하지 않고 `stale` 보고를 남긴다.
만료 명령은 `expired` 보고를 남긴다.

## 분리 브랜치

코드 변경 명령도 target 기능 브랜치에 직접 커밋하지 않는다.

1. target branch의 정확한 `expected_head_sha`를 fetch
2. 해당 SHA에서 `agent/hub-<command_id>-a<attempt>` 브랜치 생성
3. 허용 경로 안에서만 변경
4. 결정론적 검증
5. 정확히 한 커밋 생성
6. target 기능 브랜치를 base로 Draft PR 생성

main 병합과 Draft 해제는 하지 않는다.

## Gemini 도구 제한

읽기 전용:

- `read_file`
- `glob`
- `grep_search`
- `list_directory`

코드 변경:

- 위 읽기 도구
- `write_file`
- `replace`

제공하지 않는 것:

- shell
- network
- MCP
- extension
- skill
- Git extension
- 환경변수 접근

Telemetry는 비활성화한다.

## Diff 안전 게이트

- 허용 경로 패턴에 반드시 일치
- 금지 경로 패턴에 하나라도 일치하면 차단
- 삭제·rename·copy·symlink·binary·non-UTF8 차단
- worker별 최대 파일 수 적용
- 전체 변경량 1,200줄 hard limit
- 의심 Secret이 추가된 diff 차단
- worker별 최대 커밋 수 적용
- 현재 자동 코드 worker는 최대 1커밋
- 안전한 diff가 없는 code-change 명령은 `blocked`

## 결정론적 validation

- `run_typecheck`: frontend/backend typecheck
- `run_unit_tests`: API unit tests
- `run_build`: frontend/backend build
- `run_playwright`: Chromium 설치 후 Playwright
- `modify_feature_branch`, `add_or_update_tests`: frontend/backend typecheck + API smoke

테스트 실패·exit code는 무시하지 않는다.

## 완료 보고

모든 실행 결과는 다음 값을 포함한 `[WORKER_REPORT]`로 Issue #62에 게시한다.

- `command_id`
- `root_task_id`
- `worker`
- `target_branch`
- `branch`
- `status`
- 실제 `head_sha`
- 실제 `ci_run_id`
- `ci_run_attempt`
- `action_type`
- `attempt`
- `max_attempts`
- `checks`
- `failure_signature`
- Draft PR URL
- 승인 필요 여부

보고 후 repository dispatch로 중앙 조정자를 다시 깨운다.

## 절대 수행하지 않는 작업

서버 SSH, Vultr, PM2, Caddy, Snapshot, staging readiness/deploy,
production deploy, cleanup, DB·Supabase 변경, main 병합,
실계좌 연결과 실주문.
