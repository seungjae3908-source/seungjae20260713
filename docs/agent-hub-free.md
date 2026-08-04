# 무료 GitHub Agent Hub

이 문서는 GitHub Issue #62를 중앙 명령·완료 보고 허브로 사용하는 1단계 자동화 설명서다.

## 공급자 변경 기록

GitHub Models는 2026년 7월 30일 완전히 종료되어 사용할 수 없다. 현재 구현은 GitHub Actions의 명령·보고 구조는 유지하고, AI 명령 생성만 Gemini Developer API 무료 등급으로 처리한다.

## 현재 지원 범위

- 작업방이 `[WORKER_REPORT]` 형식으로 완료·차단·실패 결과를 Issue #62에 기록
- GitHub Actions가 신뢰된 작성자(OWNER, MEMBER, COLLABORATOR)의 최신 미처리 보고를 감지
- Gemini Developer API 무료 등급으로 다음 작업 명령을 생성
- 검증된 `[HUB_COMMAND]` 댓글을 Issue #62에 기록
- 같은 보고 댓글은 숨은 처리 마커로 중복 처리 방지
- 모델 실패 또는 무료 한도 초과 시 `[HUB_ERROR]`로 중단

## 비용 구조

- 별도 유료 OpenAI API 키 없음
- GitHub Actions는 공개 저장소의 표준 GitHub-hosted runner를 사용
- Gemini Developer API 무료 등급을 사용
- 기본 모델: `gemini-3.5-flash`
- 결제 계정을 연결하지 않은 무료 프로젝트로 운용
- 무료 한도 초과 시 `429 RESOURCE_EXHAUSTED` 등 오류로 중단하며 유료 모델로 자동 전환하지 않음

무료 등급 요청 내용은 Google 제품 개선에 사용될 수 있으므로, Issue 보고에는 비밀키·개인정보·계좌정보·주문정보를 넣으면 안 된다.

## 필수 저장소 Secret

GitHub 저장소의 Actions Secret에 아래 값이 필요하다.

```text
Name: GEMINI_API_KEY
Value: Google AI Studio에서 발급한 Gemini API 키
```

API 키를 코드, Issue, PR, 로그에 직접 기록하지 않는다.

## 자동 실행 시점

- Issue #62에 신뢰된 사용자가 `[WORKER_REPORT]` 댓글을 등록했을 때 즉시
- 매시 17분에 누락 보고 확인
- 수동 `workflow_dispatch`

## 작업방 보고 예시

```text
[WORKER_REPORT]
task_id: prediction-lab-004
worker: prediction-lab
branch: feature/prediction-lab-standalone
status: completed
head_sha: abcdef1234567890
checks: unit test success, workflow success
summary: adaptive shadow candidate 검증 완료
next_needed: 샘플 누적 기준 재검토
approval_required: no
```

## 자동 허브 응답 예시

```text
[HUB_COMMAND]
source_task_id: prediction-lab-004
target_worker: prediction-lab
status: ready
branch: feature/prediction-lab-standalone
instruction: 샘플 누적 기준과 현재 확정 샘플 차이를 읽기 전용으로 점검한다.
validation: 관련 JSON과 생성 스크립트 기준이 일치하는지 확인한다.
stop_conditions: 코드 변경이나 승격이 필요하면 중단하고 보고한다.
provider: gemini-developer-api-free
model: gemini-3.5-flash
```

## 안전 제한

다음 작업은 AI가 `ready`로 승인할 수 없다.

- `main` 또는 `master` 직접 수정
- 병합
- 운영 배포
- 삭제
- 권한 변경
- 비밀키 처리
- 실계좌·실주문·자동매수·자동매도

위 항목이 필요하면 명령 상태를 `waiting_approval`로 강제 변경한다.

## 아직 지원하지 않는 기능

이 1단계는 다른 ChatGPT 채팅방 입력창에 자동으로 명령을 넣지 않는다. GitHub Issue에서 보고를 읽고 다음 명령을 만들어 주는 중앙 두뇌 역할만 한다. 실제 코드 수정·테스트·커밋을 자동 수행하는 작업자는 별도 2단계에서 제한된 브랜치와 승인 게이트를 붙여 구현한다.
