# 棱镜更新执行器（Windows 版，与 deploy.sh 对等）：GitHub main 为唯一发布源。
# 用法：powershell -File scripts\deploy.ps1 -DataDir <正式数据目录> [-SkipHealth] [-Port 4391]
# 依赖：Node 24、pnpm（corepack enable 一次）、git（deploy key 或已配置凭据）。
# 服务进程只做检测提示（/api/v1/update-check），实际更新由本脚本执行——进程不自我更新。
param(
    [Parameter(Mandatory = $true)][string]$DataDir,
    [switch]$SkipHealth,
    [switch]$Force,
    [int]$Port = 4391
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Fail([string]$msg) { Write-Error $msg; exit 1 }

# 工作树必须干净（发布只能来自 GitHub main）
$dirty = git status --porcelain
if ($dirty) { Fail "工作树不干净，拒绝更新：`n$($dirty | Select-Object -First 10)" }

git fetch origin main
if ($LASTEXITCODE -ne 0) { Fail "git fetch 失败" }
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse FETCH_HEAD).Trim()
if ($local -eq $remote -and -not $Force) { Write-Host "已是最新（$local），无需更新。"; exit 0 }
if ($local -eq $remote) { Write-Host "已最新（$local），-Force 重建重启。" }
else { Write-Host "更新：$($local.Substring(0,12)) → $($remote.Substring(0,12))" }
git merge --ff-only FETCH_HEAD
if ($LASTEXITCODE -ne 0) { Fail "fast-forward 合并失败" }

# 锁文件变化才重装依赖
$lockChanged = git diff --name-only $local HEAD -- pnpm-lock.yaml
if ($lockChanged) {
    Write-Host "锁文件变化，重新安装依赖…"
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败" }
}

# 停旧实例：只按端口精确定位
$oldPid = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1).OwningProcess
if ($oldPid) {
    Write-Host "停止旧实例 PID $oldPid…"
    Stop-Process -Id $oldPid -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
}

# 清洁构建；tsc 不拷贝 .sql，迁移集合显式同步
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
if (Test-Path web-dist) { Remove-Item web-dist -Recurse -Force }
pnpm run build
if ($LASTEXITCODE -ne 0) { Fail "构建失败" }
New-Item -ItemType Directory -Force "dist\src\storage\migrations" | Out-Null
Copy-Item "src\storage\migrations\*" "dist\src\storage\migrations\" -Force

Write-Host "应用迁移…"
$env:DEBATE_DATA_DIR = $DataDir
node --input-type=module -e "const{Db,defaultDbPath}=await import(String.raw``./dist/src/storage/db.js``);const{archiveLegacyMock}=await import(String.raw``./dist/src/storage/legacy.js``);const{migrate,defaultMigrationsDir}=await import(String.raw``./dist/src/storage/migrate.js``);const db=new Db(defaultDbPath(process.env.DEBATE_DATA_DIR||String.raw``./.data``));archiveLegacyMock(db);console.log(migrate(db,defaultMigrationsDir()));db.close()"
if ($LASTEXITCODE -ne 0) { Fail "迁移失败" }

Write-Host "启动新实例…"
$log = Join-Path $DataDir 'server.log'
$proc = Start-Process -FilePath node -ArgumentList 'dist/src/server.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
Write-Host "新实例 PID $($proc.Id)"

if ($SkipHealth) { Write-Host "跳过健康检查。"; exit 0 }
foreach ($i in 1..30) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 3
        if ($health.data.version) {
            Write-Host "健康检查通过 ✓  http://127.0.0.1:$Port"
            Write-Host ($health.data | ConvertTo-Json -Compress)
            exit 0
        }
    } catch { Start-Sleep -Seconds 1 }
}
Fail "健康检查未通过，请查看 $log"
