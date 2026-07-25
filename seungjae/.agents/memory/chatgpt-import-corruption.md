---
name: 외부(ChatGPT) 파일 반입 시 손상 패턴
description: 외부에서 만들어 온 파일 묶음(tar/txt)을 반입할 때 반복된 손상 유형과 검증 절차
---
외부에서 준비한 파일 묶음(예: final-8-files.tar.gz)은 파일 내용이 뒤바뀐 채 반입된 사례가 반복됨(프런트 scanner.tsx 자리에 api-server 라우트 코드가 들어감). 서비스와 라우트 버전이 어긋난 채 스냅샷되기도 함(라우트는 getCandlesMeta/getFeed(asset,market,limit)를 호출하는데 서비스에는 해당 시그니처가 없음).

**Why:** git status clean + 빌드 성공이어도 스냅샷 자체가 일관성이 없을 수 있음. 2회 연속 손상 사고 발생.

**How to apply:** 외부 파일 반입·브랜치 전환 직후 반드시 프런트/서버 모두 `tsc --noEmit` 실행. 오류가 "다른 계층의 코드가 들어있다"는 형태면 파일 스왑 손상을 의심하고, 마지막 정상 커밋에서 해당 파일만 복원 후 새 컴포넌트 계약(프롭)만 맞춘다.
