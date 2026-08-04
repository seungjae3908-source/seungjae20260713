# Agent Hub Prompt Compiler v1

무료 Gemini Agent Hub가 긴 `WORKER_REPORT` 원문을 그대로 전송하지 않도록 하는 결정론적 전처리·정책·검증 계층이다.

## 처리 순서

1. 입력에서 Secret 패턴을 검사하고 발견 즉시 모델 호출 전 `blocked` 처리한다.
2. 허용된 보고 필드와 실패 증거만 추출한다.
3. 중복·정상 설치 로그·progress bar·의존성 다운로드 출력을 제거한다.
4. 최초 오류 20줄, 마지막 오류 20줄, 파일·줄번호, HTTP 상태와 오류 개수를 유지한다.
5. 이전 compact state와 현재 보고의 delta만 만든다.
6. 작업 profile과 위험도를 Python에서 결정한다.
7. `[ROLE]`, `[GOAL]`, `[EVIDENCE]`, `[CONSTRAINTS]`, `[OUTPUT_SCHEMA]` 다섯 블록을 조립한다.
8. Gemini JSON 응답을 정확한 schema, evidence ID, HEAD, branch, path, 위험 정책으로 재검증한다.
9. 검증 실패, 429, API 실패, schema 누락은 모두 fail-closed 처리한다.

`WORKER_REPORT` 본문은 system prompt에 들어가지 않으며 `[EVIDENCE]`의 JSON 문자열로만 전달된다.

## Context budget

profile별 `maximum_context_size` 안에서 다음 비중을 사용한다.

- ROLE: 최대 10%
- GOAL·완료 기준: 약 20%
- EVIDENCE: 약 45%
- CONSTRAINTS: 약 15%
- OUTPUT_SCHEMA: 약 10%

초과 시 중복, 정상 로그, 오래된 상태, 관련 없는 파일, 오류 주변 밖의 로그 순서로 제거한다. HEAD, base SHA, CI Run, 변경 파일, 실패 step, 최초·마지막 오류와 완료 기준은 mandatory evidence로 유지한다.

## Prompt profiles

| Profile | 허용 action | 필수 evidence | 최대 context | 금지 결정 |
|---|---|---|---:|---|
| `ci_analyzer` | `analyze_ci`, `request_context`, `no_action` | CI와 실패 증거 | 14,000자 | 코드 수정·병합·배포 |
| `code_fix_planner` | `plan_code_fix`, `request_context`, `no_action` | 이전 CI 분석, 파일, HEAD | 16,000자 | 분석 없는 수정·병합·배포 |
| `test_planner` | `plan_tests`, `request_context`, `no_action` | 변경 파일, HEAD | 13,000자 | 코드 수정·병합·배포 |
| `conflict_analyzer` | `analyze_conflict`, `request_context`, `no_action` | HEAD, base, 변경 파일 | 15,000자 | 병합·rebase·force push |
| `security_reviewer` | `review_security`, `request_context`, `no_action` | 변경 파일, HEAD | 15,000자 | Secret 접근·권한 변경·자동 수정 |
| `release_validator` | `validate_release`, `request_context`, `no_action` | CI, HEAD, base | 15,000자 | 병합·배포 승인 |
| `ui_reviewer` | `review_ui`, `request_context`, `no_action` | UI 증거, 변경 파일, HEAD | 14,000자 | 보지 못한 화면 추측·자동 수정 |

`code_fix_planner`는 `analysis_evidence_ids`로 이전 `ci_analyzer` 결과가 확인될 때만 사용한다.

## 상태와 delta

각 명령 댓글에는 Secret이 없는 compact state가 숨은 marker로 저장된다.

- repository
- current_main_sha
- worker
- branch
- head_sha
- draft_pr
- last_ci_run
- last_result
- changed_files
- known_blockers
- forbidden_operations
- updated_at

새 보고는 같은 repository·worker·branch의 최신 state와 비교한다. 전체 과거 댓글 대신 변경된 delta만 evidence에 넣는다. HEAD 변경 시 `STATE-PREVIOUS-COMMAND-STALE` evidence가 추가되고 `expected_head_sha`는 현재 보고의 HEAD로 강제된다.

## 위험도별 모델 호출

- **low:** Gemini 1회 후 Python 정책 검증
- **medium:** 분석 1회 + 독립 검증 1회. status, action, worker, branch, SHA, path, 승인 여부가 모두 같아야 진행
- **high:** 모델은 분석 1회 이하이며 Python이 항상 `waiting_approval` 또는 `blocked`로 강제
- **no_action:** 완료·후속 없음이 결정론적이면 모델 호출 0회
- **needs_context:** 필수 evidence가 없으면 모델 호출 0회

운영·스테이징 배포, 병합·rebase·force push, Secret·권한·RLS·DB·Supabase, 삭제, 유료 fallback, 실주문은 자동 `ready`가 될 수 없다.

## Output schema

Gemini는 자유형 설명 없이 정확히 하나의 JSON object만 반환한다. 모든 응답에는 다음 필드가 존재한다.

`status`, `action_type`, `target_worker`, `risk_level`, `summary`, `evidence_ids`, `assumptions`, `missing_context`, `reason`, `exact_files_or_logs_needed`, `safe_read_only_command`, `repository`, `branch`, `base_sha`, `expected_head_sha`, `allowed_paths`, `forbidden_paths`, `instruction`, `validation`, `stop_conditions`, `requires_user_approval`, `confidence`, `provider`, `model`, `policy_version`.

`needs_context`는 `missing_context`, `reason`, `exact_files_or_logs_needed`, `safe_read_only_command`, `stop_conditions`가 비어 있으면 차단된다. 존재하지 않는 evidence ID나 현재 HEAD와 다른 `expected_head_sha`도 차단된다.

## 비용 보호

- 동일 보고 원문·이전 전체 대화·중복 evidence를 보내지 않는다.
- profile별 few-shot은 사용하지 않으며 추가 시 최대 1개로 제한한다.
- 모델 출력은 1,400 token 및 12,000자로 제한한다.
- 429에서 유료 모델로 전환하지 않는다.
- 자동 retry를 하지 않는다.
- `ready` 명령이 아닐 때 executor dispatch를 생략한다.
