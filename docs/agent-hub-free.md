# 무료 GitHub Agent Hub

GitHub Issue #62를 중앙 명령·완료 보고 허브로 사용하는 자동화 설명서다.

## 현재 구성

- **Prompt Compiler:** 보고를 압축하고 profile·위험도·evidence ID·context budget을 Python에서 결정한다.
- **명령 허브:** 검증된 evidence만 Gemini 무료 모델에 전달하고 엄격한 JSON schema로 다음 분석을 받는다.
- **제한형 실행기:** Python 정책을 통과한 `ready` 명령만 읽기 전용으로 수행하거나 격리 브랜치에서 제한된 코드 변경과 Draft PR을 만든다.
- 기본 모델: `gemini-3.1-flash-lite`
- 별도 유료 OpenAI API와 유료 fallback은 사용하지 않는다.

자세한 Prompt Compiler 구조는 `docs/agent-hub-prompt-compiler.md`를 따른다.

## 보고 형식

기존 필드와 호환되며 아래 구조화 필드를 우선 사용한다.

```text
[WORKER_REPORT]
task_id: 고유 작업 ID
worker: 작업방 이름
repository: owner/repository
branch: 작업 브랜치
head_sha: 현재 HEAD
base_sha: 기준 main 또는 base SHA
pr_number: Draft PR 번호
status: completed | blocked | failed
changed_files: 파일 목록
failed_checks: 실패 검사
passed_checks: 성공 검사
skipped_checks: 생략 검사
first_error: 최초 오류
error_file: 오류 파일
error_line: 오류 줄
error_code: 오류 코드
test_summary: 테스트 요약
next_needed: 다음 작업
approval_required: yes | no
```

보고 본문은 system prompt로 사용하지 않는다. Secret 검사 후 untrusted evidence로만 압축·삽입한다.

## Hub 상태

- `needs_context`: 필수 파일·로그·Run·Job이 부족하며 코드 변경 명령을 만들지 않음
- `ready`: low risk 또는 일치한 medium risk 결과가 Python 정책을 모두 통과함
- `waiting_approval`: 고위험·되돌리기 어려운 작업으로 사용자 승인이 필요함
- `blocked`: Secret, schema 오류, 존재하지 않는 evidence ID, Gemini 실패·429 또는 정책 위반
- `no_action`: 완료 상태이며 후속 작업이 없어 Gemini 호출을 생략함

## 자동 전달

- 사용자가 Issue #62에 보고하면 `issue_comment`로 Hub가 실행된다.
- `ready`이고 target worker가 있을 때만 `agent-hub-command-ready` dispatch를 발생시킨다.
- 실행기가 결과 보고를 남기면 `agent-executor-report-ready`로 Hub를 다시 실행한다.
- 매시 복구 확인은 중복 처리 marker와 compact state를 사용한다.

## 안전 제한

다음 작업은 모델 결과와 관계없이 자동 `ready`가 아니다.

- `main` 또는 `master` 직접 수정
- PR 병합·rebase·force push
- 운영·스테이징 배포와 서버 작업
- 삭제
- 권한·Secret·RLS·DB·Supabase 변경
- 유료 API fallback
- 실계좌·실주문·자동매수·자동매도

## 비용과 비밀정보

- Gemini Developer API 무료 등급만 사용
- 429 발생 시 유료 전환·자동 retry 없음
- `GEMINI_API_KEY`는 GitHub Actions Secret에만 저장
- 입력에서 Secret 패턴이 발견되면 모델 전송 전에 `blocked`
- Issue·PR·코드·로그에 API 키를 직접 기록하지 않음

## 상세 문서

- Prompt Compiler: `docs/agent-hub-prompt-compiler.md`
- 제한형 실행기: `docs/agent-hub-executor.md`
