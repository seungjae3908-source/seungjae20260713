[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$')]
    [string]$Server = 'root@lsj119.duckdns.org',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
    [string]$RemoteProjectPath,

    [Parameter(Mandatory = $false)]
    [string]$PatchZip = (Join-Path $PSScriptRoot 'seungjae_AI복구기사_아이콘_빌드전_패치.zip')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $PatchZip -PathType Leaf)) {
    throw "패치 ZIP을 찾지 못했습니다: $PatchZip"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteZip = "/tmp/seungjae-ai-repair-prebuild-$stamp.zip"
$remoteBackup = "$RemoteProjectPath/.manual-backups/ai-repair-prebuild-$stamp"

Write-Host "[1/4] 서버 연결과 프로젝트 경로를 확인합니다."
ssh $Server "set -eu; test -d '$RemoteProjectPath/api-server/src'; test -d '$RemoteProjectPath/stock-analyzer/src'; mkdir -p '$remoteBackup'"
if ($LASTEXITCODE -ne 0) { throw '서버 경로 확인에 실패했습니다.' }

Write-Host "[2/4] 변경 파일 패치를 서버 임시 경로에 업로드합니다."
scp -- $PatchZip "${Server}:$remoteZip"
if ($LASTEXITCODE -ne 0) { throw '패치 업로드에 실패했습니다.' }

Write-Host "[3/4] 기존 파일을 백업하고 소스 파일만 교체합니다."
$remoteCommand = @"
set -eu
cd '$RemoteProjectPath'
files='api-server/src/index.ts api-server/src/routes/index.ts stock-analyzer/src/pages/admin.tsx stock-analyzer/src/pages/account.tsx .gitignore'
for file in `$files; do
  if [ -f "`$file" ]; then
    mkdir -p '$remoteBackup/'"`$(dirname "`$file")"
    cp -p "`$file" '$remoteBackup/'"`$file"
  fi
done
mkdir -p '$remoteBackup/api-server/src/routes'
if [ -f api-server/src/routes/repair.ts ]; then cp -p api-server/src/routes/repair.ts '$remoteBackup/api-server/src/routes/repair.ts'; fi
unzip -oq '$remoteZip' -d '$RemoteProjectPath'
rm -f '$remoteZip'
printf '%s\n' 'SOURCE_APPLIED_BUILD_NOT_RUN' > '$RemoteProjectPath/.ai-repair-prebuild-state'
echo '소스 적용 완료. 빌드와 서버 재시작은 실행하지 않았습니다.'
echo '백업 위치: $remoteBackup'
"@

ssh $Server $remoteCommand
if ($LASTEXITCODE -ne 0) { throw '서버 소스 적용에 실패했습니다. 백업 폴더를 확인해 주세요.' }

Write-Host "[4/4] 적용 파일을 확인합니다."
ssh $Server "set -eu; test -f '$RemoteProjectPath/api-server/src/routes/repair.ts'; grep -q 'AI 복구 기사' '$RemoteProjectPath/stock-analyzer/src/pages/admin.tsx'; test -f '$RemoteProjectPath/.ai-repair-prebuild-state'; echo '검증 완료: 빌드 전 상태로 멈췄습니다.'"
if ($LASTEXITCODE -ne 0) { throw '적용 후 파일 검증에 실패했습니다.' }

Write-Host ''
Write-Host '완료: 서버 소스까지만 적용했고 빌드·배포·재시작은 하지 않았습니다.' -ForegroundColor Green
Write-Host "서버 백업: $remoteBackup"
