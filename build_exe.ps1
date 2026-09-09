# ============================================================
#  OsuSkinMaker (Tauri) 一键打包脚本
#  用法：在项目根目录打开 PowerShell，运行
#     powershell -ExecutionPolicy Bypass -File .\build_exe.ps1
#  功能：编译 release exe 并复制到 temp\ 目录
# ============================================================

param(
    [switch]$NoBundle   # 加 -NoBundle 则只出 exe，不生成安装包
)

# 错误即停止
$ErrorActionPreference = "Stop"

# 项目根目录（脚本所在目录）
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "==> 项目目录: $Root" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. 补齐工具链 PATH（Rust 与 Node/npm）
#    优先跟随官方环境变量（CARGO_HOME/RUSTUP_HOME），不存在时回退到用户目录默认位置，
#    再探测 PATH 中是否已有 cargo/npm（有则不需要补位）。
# ---------------------------------------------------------------------------
$cargoHome = $env:CARGO_HOME; if (-not $cargoHome) { $cargoHome = Join-Path $env:USERPROFILE ".cargo" }
$rustupHome = $env:RUSTUP_HOME; if (-not $rustupHome) { $rustupHome = Join-Path $env:USERPROFILE ".rustup" }

$rustDirs = @(
    "$cargoHome\bin",
    "$rustupHome\toolchains\stable-x86_64-pc-windows-msvc\bin"
)
$nodeDirs = @()
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    $nodeDirs = @(
        (Join-Path $env:APPDATA "nvm"),
        "$env:ProgramFiles\nodejs"
    )
}

foreach ($d in $rustDirs + $nodeDirs) {
    if ($d -and (Test-Path $d)) { $env:PATH = "$d;$env:PATH" }
}

# 校验 cargo
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    throw "找不到 cargo，请确认 Rust (MSVC) 已安装并配置好 PATH。"
}
Write-Host "==> 使用 cargo: $($cargo.Source)" -ForegroundColor Gray

# ---------------------------------------------------------------------------
# 2. 确认依赖已安装（node_modules 存在即可；没有则自动 npm install）
# ---------------------------------------------------------------------------
if (-not (Test-Path "$Root\node_modules")) {
    Write-Host "==> 未找到 node_modules，执行 npm install ..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败。" }
}

# ---------------------------------------------------------------------------
# 3. 执行 Tauri 打包
#    始终 --no-bundle：只出 exe，跳过 WiX/MSI 安装包（避免联网下载 WiX，
#    也无需额外工具）。若你就是想要安装包，手动运行 `npm run tauri build`。
# ---------------------------------------------------------------------------
Write-Host "==> 开始编译 release exe（LTO 开启，首次需几分钟，请耐心等待）..." -ForegroundColor Cyan
& npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) { throw "cargo tauri build 失败。" }

# ---------------------------------------------------------------------------
# 4. 复制产物到 temp 目录
# ---------------------------------------------------------------------------
$exe = Join-Path $Root "src-tauri\target\release\OsuSkinMaker.exe"
if (-not (Test-Path $exe)) { throw "未找到编译产物: $exe" }

$tempDir = Join-Path $Root "temp"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$dest = Join-Path $tempDir "OsuSkinMaker.exe"
Copy-Item $exe $dest -Force

$sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "`n==> 完成！exe 已输出到: $dest  ($sizeMB MB)" -ForegroundColor Green