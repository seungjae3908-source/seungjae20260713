# 무료 GitHub Agent Hub

GitHub Issue #62를 중앙 명령·완료 보고 허브로 사용하는 자동화 설명서다.

## 현재 구성

- **Phase 1 — 명령 허브:** 신뢰된 `[WORKER_REPORT]`를 읽고 Gemini가 검증 가능한 `[HUB_COMMAND]`를 생성한다.
- **Phase 2 — 제한형 실행기:** 안전한 명령만 읽기 전용으로 수행하거나 격리 브랜치에 제한된 코드 변경과 Draft PR을 만든다.
- 기본 모델: `gemini-3.1-flash-lite`
- 별도 유료 OpenAI API는 사용하지 않는다.

GitHub Models는 종료되었으므로 사용하지 않으며, AI 호출은 `GEMINI_API_KEY`로 Gemini Developer API 무료 등급을 사용한다.

## 보고 형식

```text
[WORKER_REPORT]
task_id: 고유 작업 ID
worker: 작업방 이름
branch: 작업 브랜치
status: completed | blocked | failed
head_sha: 커밋 SHA 또는 none
checks: 실행한 검증과 결과
summary: 완료 내용
next_needed: 다음에 필요한 작업 또는 none
approval_required: yes | no
```

신뢰 대상은 저장소 OWNER·MEMBER·COLLABORATOR의 보고와, 제한형 실행기가 숨은 인증 마커를 붙여 작성한 bot 보고뿐이다.

## 명령 형식

```text
[HUB_COMMAND]
source_task_id: 보고 task_id
target_worker: github-executor | none
status: ready | waiting_approval | no_action
branch: 격리 작업 브랜치 또는 none
execution_mode: read_only | code_change | approval_only
instruction: 수행할 정확한 작업
validation: 완료 전에 확인할 검사
stop_conditions: 중단 조건
auto_step: 현재 자동 단계
auto_limit: 최대 자동 단계
provider: gemini-developer-api-free
model: gemini-3.1-flash-lite
```

모델 출력은 그대로 실행되지 않는다. Python 검증기가 필수 필드, 위험 용어, 대상 작업자, 브랜치, 자동 단계 한도를 다시 검사하고 안전한 값으로 덮어쓴다.

## 자동 전달

- 사용자가 Issue #62에 보고하면 `issue_comment`로 Hub가 즉시 실행된다.
- Hub가 실행기용 명령을 만들면 `repository_dispatch: agent-hub-command-ready`를 발생시킨다.
- 실행기가 결과 보고를 남기면 `repository_dispatch: agent-executor-report-ready`로 Hub를 다시 실행한다.
- Hub는 완료 시 `no_action`, 코드 변경 PR 생성 시 `waiting_approval`로 정지한다.
- Hub는 매시 17분, 실행기는 매시 37분에 누락 작업을 복구 확인한다.

## 안전 제한

다음 작업은 `ready`로 자동 승인하지 않는다.

- `main` 또는 `master` 직접 수정
- PR 병합
- 운영·스테이징 배포
- 삭제
- 권한 변경
- Secret 처리
- 데이터베이스 migration
- 실계좌·실주문·자동매수·자동매도

위 작업은 `waiting_approval`로 강제 변경한다.

## 비용과 비밀정보

- Gemini Developer API 무료 등급 사용
- 유료 모델 자동 전환 없음
- 무료 한도 초과 시 오류 보고 후 중단
- `GEMINI_API_KEY`는 GitHub Actions Secret에만 저장
- Issue·PR·코드·로그에 API 키를 직접 기록하지 않음

무료 등급 요청 데이터 정책을 고려해 Issue #62에는 비밀키, 개인정보, 계좌정보, 주문정보를 넣지 않는다.

## 상세 실행기 문서

경로·변경량 제한, Gemini 도구 허용 목록, 테스트와 Draft PR 규칙은 `docs/agent-hub-executor.md`를 따른다.
