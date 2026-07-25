#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$HOME/workspace}"

if [[ ! -f "$ROOT/package.json" || ! -f "$ROOT/pnpm-workspace.yaml" ]]; then
  echo "오류: 프로젝트 루트를 찾지 못했습니다: $ROOT"
  echo "사용법: bash chart-repair-20260724/apply.sh /home/runner/workspace"
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/.repair-backups/chart-repair-$STAMP"

FILES=(
  "stock-analyzer/src/pages/chart-relay.tsx"
  "stock-analyzer/src/components/chart-broadcast.tsx"
  "stock-analyzer/src/hooks/use-realtime-chart.ts"
  "stock-analyzer/src/lib/chart-preferences.ts"
  "stock-analyzer/vite.config.ts"
)

mkdir -p "$BACKUP_DIR"

for rel in "${FILES[@]}"; do
  if [[ -f "$ROOT/$rel" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -p "$ROOT/$rel" "$BACKUP_DIR/$rel"
  fi

  if [[ ! -f "$SCRIPT_DIR/files/$rel" ]]; then
    echo "오류: 복구 파일이 없습니다: $SCRIPT_DIR/files/$rel"
    exit 1
  fi

  mkdir -p "$ROOT/$(dirname "$rel")"
  cp -p "$SCRIPT_DIR/files/$rel" "$ROOT/$rel"
done

# Markdown 링크 전체 경로를 파일명으로 붙여 넣으면서 생긴 잘못된 폴더만 정확히 제거합니다.
ACCIDENTAL_DIRS=(
  "[App.tsx](C:"
  "[candle-loader.ts](C:"
  "[push.ts](C:"
  "[watchlist.ts](C:"
)

for name in "${ACCIDENTAL_DIRS[@]}"; do
  if [[ -e "$ROOT/$name" ]]; then
    rm -rf -- "$ROOT/$name"
    echo "잘못 생성된 경로 제거: $name"
  fi
done

echo
echo "복구 파일 적용 완료"
echo "원본 백업: $BACKUP_DIR"
echo "다음 단계: Replit에서 Stop 후 Run을 다시 누르세요."
