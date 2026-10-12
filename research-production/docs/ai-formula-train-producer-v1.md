# AI 연구 평가 → 수식 TRAIN 큐 연결 (Draft 전용)

## 목적 및 실제 기능

기존 Vultr Research Production의 Gemini/Groq AI Review가 생성한 **정성 연구가설**과, 독립 검토된 기존 `StrategyHypothesisV1 → FormulaCandidateV1` 수식을 매칭하여, **실제 원본 데이터 승인 검증을 거친 TRAIN 전용 입력만** 기존 `formula-backtest/producer-outbox/<digest>.json` 구조로 전달할 수 있는 작은 안전 연결부입니다.

새 수식 실행 엔진·거래 엔진을 중복 생성하지 않습니다. 기존 `buildFormulaProducedTrainInputV1`, `ingestFormulaProducedTrainInputsV1`, `processFormulaAutoBacktestQueueV1`, `runOnePassCandidateBacktestV1`을 그대로 재사용합니다.

### 이 Draft에서 검증하는 연결

1. 운영 AI 출력 계약 `research-production-ai-review-v1`, 정확한 Research SHA, 안전 정책, 증거 digest, 역할/프로필 확인.
2. 역할 `PROPOSER`이며 `RESEARCH_PROPOSAL_ONLY`인 항목만 다음 단계. 실제 초기 AI 활성화에서 확인된 `forward/CRITIC`은 제안 검토만 하고 자동 수식 큐를 생성하지 않습니다.
3. 별도로 원본 연구가설 승인 이력과 해시가 존재하는 *기존* FormulaCandidate만 허용. 모델이 임의로 반환한 JavaScript, 매매코드, AST, 가격, 포지션/주문 필드는 받아들이지 않습니다.
4. 4시장 정책: KR/US/Spot LONG만, Futures LONG/SHORT. 원본 TRAIN dataset 날짜/분봉/방향/신원·비용 입력을 기존 정식 큐 Validator로 검증합니다.
   - AI 원본 검토의 `observedAt`을 불변 `queuedAt` 기준으로 바인딩하여 동일한 AI 가설·수식·데이터를 훗날 재실행해도 새 digest를 발급하지 않습니다.
   - 외부 source verifier는 원본 자료가 AI 평가 시점 **이전에 실제 확보**됐고, 해당 AI 평가·정식 수식 ID/hash·원본 데이터의 검토 매핑 digest를 독립 검토한 사실을 명시해야 합니다. 사후 확보 데이터나 잘못된 관계는 HOLD 처리합니다.
5. 검증된 원본 아카이브의 **외부 소유권이 있는 verifier**가 정확한 dataset hash·연구 SHA·권리·시각·출처를 확인해야 TRAIN outbox 등록 후보가 됩니다. 기본 verifier 없음 → HOLD. 외부 verifier의 서명/신뢰성 자체는 이 코드만으로 증명되지 않으므로 실제 데이터 인증 완료로 보고하지 않습니다.
6. 기본값은 **순수 미리보기**. 쓰기를 요청해도 `RESEARCH_AI_FORMULA_TRAIN_STAGE_ENABLED=true`가 별도로 설정되지 않으면 거부합니다. 연결부를 호출하는 새 timer/systemd/cron은 추가하지 않았으며 이 환경변수를 운영에 설정하지 않았습니다.
7. opt-in Staging은 서비스 외부 계좌/DB가 아닌 격리 연구 state에만 0600 불변 digest 파일을 독점 생성합니다. 일치 재시도는 중복으로 보존, 다른 내용을 동일 digest 이름에 덮어쓰지 않습니다. 부모 폴더 0700, 연구 root 0700/0750, no-symlink/no-hardlink 경계 및 fsync 검증.
8. 기존 정식 TRAIN 백테스터는 `PASS` 대신 근거 부족시 `HOLD`로 유지. 독립 OOS, 워크포워드, 전비용, 실현 체결·텔레그램 근거가 없으면 승격 불가.
9. TRAIN 피드백 어댑터는 HOLD/RESERVE/EXCLUDE의 실패 분류 코드만 반환합니다. PASS 또는 Paper 등록이 포함된 미인증 큐 요약은 거부합니다. 이 피드백을 AI 프롬프트에 다시 연결하는 작업은 별도 검토 대상이며 현재 운영 Gemini의 프롬프트는 변경하지 않습니다.

## 자동 연구 완성을 위한 미해결 연결

- AI가 정성 연구가설 외에 **새 canonical hypothesis + 검증된 독립 출처 + 승인된 DSL 수식**을 스스로 생산하는 기능은 아직 없습니다. 현재는 승인된 기존 seed만 큐에 전달할 수 있습니다.
- 현재 `fast-historical`과 `long-history`는 최신 릴리스 SHA 기준 AI PROPOSER 증거가 없었습니다. 정해진 연구 주기 이후 정확한 SHA 결과가 발생했는지 확인해야 합니다.
- 전시장/과거상장폐지 포함 4시장 원본분봉과 권리 검증, 서버 보관된 TRAIN corpus에 대한 canonical source verifier가 필요합니다. 불명 데이터는 HOLD입니다.
- 별도의 24시간 연구 전용 scheduler + 상태/비용 상한 + 재실행/중복/장애 복구, 독립 OOS/WF/전비용 proof producer, 안전 Paper handoff, 회원 UI 피드백 연결은 운영 승인 전 구현·QA가 더 필요합니다.

## QA 및 승인 경계

`node --test research-production/test/ai-formula-train-producer-v1.test.mjs`

신규 테스트는 AI 임의 매매 명령 차단, 부정확한 자료의 HOLD, 실제 canonical TRAIN 백테스터 HOLD, futures SHORT 정책, 중복 재실행, 심볼릭 링크, 원본 데이터 차단, forged PASS 피드백을 검사합니다. 모의 결과는 테스트용 예시 데이터이며 수익성이나 공급원 실제 조회 증거가 아닙니다.

**Draft/Drift ONLY.** Replit 사용 금지. Ready/Merge/Deploy/Production DB/Secrets/systemd/PM2/텔레그램 발송/Paper·LIVE 자동매매/주문·정정·취소·이체·출금 모두 금지. 기본 실행 권한 NONE, 사용자의 후속 명시 승인 필요.

## 후속 신뢰성 보강 — 원자적 게시와 후보 귀속 (2026-10-12)

- 기존 직접 최종파일 쓰기는 중단·강제종료 시 반쯤 써진 JSON이 정식 백테스트 입력 경로에 남을 위험이 있었습니다. 이제 격리 연구 폴더에 숨긴 임시파일을 0600으로 먼저 생성·완료·fsync하고, 최종 digest 경로에 **독점 hardlink 게시**, 임시 링크 제거 및 디렉터리 fsync 후 readback 검증을 수행합니다. 이미 발행된 불변 파일은 절대 덮어쓰지 않습니다. 비정상 종료로 남은 숨김 .partial 파일은 최종 JSON 큐 대상이 아니며 자동 삭제·우회하지 않습니다.
- 동시 실행되는 동일 AI 연구 입력은 정확히 1건만 최초 등록하고 다른 실행은 내용·digest가 같을 때만 멱등 처리합니다. 다른 데이터·손상·영구 hardlink를 정상 등록으로 간주하지 않습니다.
- AI 리뷰 출력의 **전체 안전정책**, 리뷰 객체의 허용 필드·크기 및 연구가설 필드를 재검증해 모델 응답에 몰래 추가된 실행·유료·승격 권한을 차단합니다.
- 기존 전체 연구 큐의 피드백에는 다른 연구 후보가 포함될 수 있습니다. 이제 피드백 함수에 정확한 `reviewedItemDigests`(1~4개)를 명시해야 하며, 해당 후보의 HOLD/RESERVE/EXCLUDE만 보고합니다. 아직 큐에서 처리되지 않은 후보는 `WAITING_BOUND_TRAIN_RESULTS`로 보존하고 타 후보의 실패 사유를 할당하지 않습니다. 피드백 digest에는 Research SHA와 후보 집합을 포함합니다.
- 테스트는 병렬 8건 등록, 최종 파일 변조 후 재실행 차단, 추가 AI 권한, 대용량 AI 응답, 다른 후보 및 다른 Research 릴리스의 피드백 혼입을 검증합니다.

이 보강은 기존 Draft에만 적용됩니다. 운영 서버가 AI 제안에서 수식을 자동 생성·개선하거나 24시간 실행하는 것은 아직 아니며 실제 원본·사용권·독립 OOS·전비용 증명 없이는 계속 HOLD입니다. Ready/Merge/Deploy 및 실주문은 하지 않습니다.
