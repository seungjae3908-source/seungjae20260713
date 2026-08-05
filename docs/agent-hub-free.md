# 무료 AI Agent Hub 중앙 조정자 v4

Issue #62는 여러 작업방과 GitHub 워커가 공유하는 중앙 명령·보고 허브다.
허브는 코드를 직접 수정하거나 배포하지 않는다. 보고를 검증하고 Gemini 무료 모델에 제한된 제안을 요청한 뒤, **결정론적 Python 정책 엔진**이 최종 상태와 권한을 결정한다.

## 고정 공급자

- Provider: `gemini-developer-api-free`
- Model: `gemini-3.1-flash-lite`
- 정책·Python 기본값·워크플로·문서·HUB_COMMAND 모두 동일 모델 사용
- 결제 계정이 연결되지 않은 무료 프로젝트만 사용
- `429` 또는 무료 한도 초과 시 `[HUB_ERROR] free_quota_exhausted`
- 유료 모델 또는 유료 공급자 fallback: `0`

## 처리 순서

1. Issue #62의 최신 미처리 `[WORKER_REPORT]` 선택
2. 작성자 신뢰 검증
   - 사용자 보고: `OWNER`, `MEMBER`, `COLLABORATOR`
   - 실행기 보고: `github-actions[bot]` + `<!-- agent-executor-report -->`
3. 완료 보고의 40자리 `head_sha`와 숫자 `ci_run_id` 검증
4. Secret 탐지
   - 의심되는 Secret이 있으면 Gemini를 호출하지 않고 `secret_detected`로 차단
5. 이메일·전화번호·계좌번호·주문 ID·주민번호 마스킹
6. 마스킹된 보고만 Gemini에 전달
7. Gemini는 `target_worker`, `action_type`, 경로와 작업 설명만 JSON으로 제안
8. Python 정책 엔진이 action table, worker registry, SHA, 경로, 동시 실행, 재시도 정책을 적용
9. 필수 필드가 완성된 `[HUB_COMMAND]` 게시
10. `status=ready`인 경우에만 등록된 실행기를 깨움

Gemini 원문은 직접 실행되지 않는다.

## 명령 필수 필드

모든 `[HUB_COMMAND]`에는 아래 필드가 필요하다.

- `command_id`
- `source_task_id`
- `source_report_comment_id`
- `target_worker`
- `status`
- `action_type`
- `risk_level`
- `repository`
- `branch`
- `base_sha`
- `expected_head_sha`
- `allowed_paths`
- `forbidden_paths`
- `instruction`
- `validation`
- `stop_conditions`
- `requires_user_approval`
- `required_approval_phrase`
- `max_attempts`
- `expires_at`
- `policy_version`
- `provider`
- `model`

누락·형식 오류·알 수 없는 action은 fail-closed 처리한다.

## 상태

- `ready`: low-risk 정책과 worker registry를 모두 통과
- `waiting_approval`: 사용자 승인이 필요한 작업
- `blocked`: 절대 금지, 미등록 worker, 범위 이탈, 정책 위반
- `stale`: 현재 브랜치 HEAD가 `expected_head_sha`와 다름
- `expired`: `expires_at` 경과
- `superseded`: 새 명령으로 대체
- `waiting`: 동일 worker가 다른 명령을 실행 중
- `no_action`: 추가 실행 없음

## Action policy

### 자동 허용

`inspect_repository`, `inspect_branch`, `inspect_pull_request`, `analyze_ci_failure`,
`analyze_logs`, `analyze_playwright_trace`, `modify_feature_branch`,
`add_or_update_tests`, `run_typecheck`, `run_unit_tests`, `run_build`,
`run_playwright`, `create_draft_pr`, `update_draft_pr_description`,
`report_results`, `analyze_conflicts`, `create_integration_plan`,
`inspect_security_contract`, `inspect_private_api_calls`,
`inspect_paper_vs_live_order_separation`

자동 허용 목록에 있어도 worker registry, 브랜치, SHA, 경로, 실행 횟수 검증에 실패하면 `blocked`, `stale` 또는 `waiting`이 된다.

### 사용자 승인 필수

`mark_pr_ready`, `merge_pr`, `squash_merge`, `rebase`, `merge_main`,
`cherry_pick`, `modify_workflow`, `modify_ops_script`, `modify_auth`,
`modify_permissions`, `modify_rls`, `create_db_migration`,
`apply_db_migration`, `modify_supabase`, `staging_deploy`,
`staging_readiness`, `restart_process`, `restart_server`, `resize_server`,
`cleanup_files`, `cleanup_logs`, `delete_old_release`, `delete_backup`,
`enable_paid_api`, `change_billing`, `modify_external_data_transfer`,
`connect_live_account`, `prepare_production_deploy`

승인 명령에는 exact action, 대상, SHA, 사유, 파일, 효과, 위험,
rollback, downtime, cost, validation, 정확한 승인 문구가 포함된다.

### 절대 금지

직접 main/master 커밋, force push, 보호 규칙 해제, CI 우회, 실패 은폐,
Secret·환경변수 출력, 권한 확대, 관리자 자동 생성, 운영 보호 해제,
운영 DB 삭제·초기화, rollback·최신 백업 삭제, 실주문·출금·자산이체,
거래소 키 변경, 안전 정책 수정, 유료 자동 fallback은 항상 차단한다.

한국어·영어·일본어·중국어 우회 표현과
`운영에 반영`, `기본 브랜치에 적용`, `apply to production`,
`apply to default branch`도 차단 표현으로 관리한다.

## Worker registry

정적 등록 파일: `.github/agent-hub/workers.json`

등록 항목:

- `worker_id`
- `allowed_branches`
- `allowed_path_patterns`
- `forbidden_path_patterns`
- `allowed_action_types`
- `max_files_per_command`
- `max_commits_per_command`
- `can_create_draft_pr`
- `can_run_ci`
- `can_modify_code`

등록 worker:

- `github-executor`
- `prediction-lab`
- `stock-analyzer`
- `api-server`
- `test-runner`
- `integration-planner`
- `security-inspector`
- `operations-worker`
- `agent-hub-validation`

`operations-worker`는 운영 관련 action을 자동 실행하지 않으며 승인 요청만 생성한다.

## 경쟁·중복·재시도

- 보고 댓글별 정확히 한 번 처리
- `command_id`는 보고 댓글과 정책 버전으로 결정론적 생성
- 중복 command ID 게시 금지
- 실행 직전 target branch HEAD 재검증
- 명령 TTL 30분
- 동일 worker running이면 새 명령 `waiting`
- `max_attempts=2`: 최초 실행 + 자동 재시도 1회
- 동일 failure signature 반복 시 `waiting_approval`
- 대체 명령은 `[HUB_STATE] superseded` 기록
- 완료 보고는 실제 `head_sha`, `ci_run_id`, `command_id` 필수

## 기본 금지 경로

`.github/workflows/**`, `.github/agent-hub/**`, `ops/**`,
`**/migrations/**`, `**/auth/**`, `**/permissions/**`, `**/secrets/**`,
`production/**`, `infrastructure/**`, `supabase/**`, 환경파일,
package manifest와 lockfile, Agent Hub 정책·스크립트·문서,
생성 산출물 디렉터리.

정책 자체는 사람이 검토한 전용 PR에서만 변경한다.

## 운영배포 격리

Coordinator와 일반 worker는 SSH, Vultr, PM2, Caddy, Snapshot,
staging readiness/deploy, production deploy, cleanup, DB·Supabase,
실계좌·실주문을 수행하지 않는다. 운영 action은 승인 요청에서 멈춘다.
