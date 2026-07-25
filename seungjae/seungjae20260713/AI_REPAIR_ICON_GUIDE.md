# AI 복구 기사 — 앱 아이콘 작업 1단계

이 버전은 관리자 화면에서 앱 아이콘 이미지를 서버에 업로드하고, 승인 후 PWA 아이콘 소스 파일에 적용한 다음 **빌드 직전에서 멈추는 기능**입니다.

## 동작 순서

1. 관리자 계정으로 로그인합니다.
2. `계정 → 관리자 관리센터 → AI 복구 기사`로 이동합니다.
3. PNG, JPG 또는 WEBP 이미지를 선택합니다.
4. 배경색과 요청내용을 입력하고 `서버에 올리고 작업 생성`을 누릅니다.
5. 브라우저가 64, 180, 192, 512, 마스커블 512 크기의 PNG를 생성합니다.
6. 서버가 PNG 구조, 파일 크기, 정확한 가로·세로 크기를 다시 검사하고 `.ai-repair/staging`에 저장합니다.
7. `아이콘 소스 적용` 문구를 직접 입력한 뒤 승인하면 기존 파일을 백업하고 소스 파일을 교체합니다.
8. `.ai-repair/pending-build.json`을 생성하고 빌드·배포는 실행하지 않습니다.
9. 문제가 있으면 `아이콘 원복` 문구를 입력해 변경 전 파일로 복구할 수 있습니다.

## 변경 대상

- `stock-analyzer/public/favicon.png`
- `stock-analyzer/public/icons/apple-touch-icon.png`
- `stock-analyzer/public/icons/icon-192.png`
- `stock-analyzer/public/icons/icon-512.png`
- `stock-analyzer/public/icons/maskable-512.png`
- `stock-analyzer/index.html`의 favicon 링크
- `stock-analyzer/public/icon-version.json`

## 안전장치

- 승인된 관리자만 접근 가능
- 업로드 파일은 브라우저에서 PNG로 변환
- 서버에서 PNG 시그니처, IHDR/IEND 구조, 크기 재검사
- 파일별 SHA-256 기록 및 적용 직전 재검사
- 기존 파일 전체 백업
- 임시 파일에 쓴 뒤 원자적 교체
- 중간 실패 시 자동 원복
- 빌드와 배포 자동 실행 금지
- Supabase 감사 로그 best-effort 기록
- `.env`, 비밀키, 주문 기능 및 데이터베이스는 변경하지 않음

## 서버 설정

서버가 프로젝트 루트를 자동으로 찾지 못하면 환경변수를 지정합니다.

```bash
AI_REPAIR_WORKSPACE_ROOT=/실제/프로젝트/루트
```

프로젝트 루트에는 `api-server/src`와 `stock-analyzer/public`이 모두 있어야 합니다.

## 빌드 승인 이후 수동 명령

이 버전에서는 아래 명령을 자동 실행하지 않습니다.

```bash
pnpm --filter @workspace/stock-analyzer run build
```

빌드 후 서버 재시작·배포·헬스체크·실패 시 롤백은 다음 단계에서 별도 승인 기능으로 연결합니다.

## Replit 배포 주의

Replit 작업공간에서는 소스 변경이 저장될 수 있지만, Cloud Run 형태의 배포 컨테이너 파일시스템은 재시작 시 변경이 사라질 수 있습니다. 영구 반영은 Git 저장소 또는 Vultr의 지속 디스크에 연결해야 합니다.
