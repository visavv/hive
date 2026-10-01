<#
  hive: install or update on Windows, in one step.

  First time (PowerShell, from the folder you want hive in, e.g. $HOME\code):
    git clone https://github.com/visavv/hargent hive
    cd hive
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Project C:\code\myproject

  Update later (from the hive folder):
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

  What it does:
    1. checks Node 22+ and Git (offers to install them with winget)
    2. git core.longpaths (agent worktrees can have long paths)
    3. switches to the hive branch and pulls the latest version
    4. npm install, build, and `npm link` so `hive` works in any terminal
    5. hive doctor (are Claude Code / Codex / API keys ready?)
    6. with -Project: a Start-menu entry for that project, and opens hive on it

  Switches: -Branch <name>  -Project <folder>  -Test (run the test suite too)
            -NoLaunch  -SkipPrereqs  -NoPull
#>
param(
  [string]$Branch = "claude/execute-planned-features-loop-9amlre",
  [string]$Project = "",
  [switch]$Test,
  [switch]$NoLaunch,
  [switch]$SkipPrereqs,
  [switch]$NoPull
)
$ErrorActionPreference = "Stop"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "'$exe $($argv -join ' ')' failed (exit $LASTEXITCODE)." }
}

# Repo root = the folder above scripts\
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root "package.json"))) { Fail "Run this from the hive folder (scripts\install-windows.ps1 inside the cloned repo)." }
Set-Location $root

if (-not $SkipPrereqs) {
  Step "Checking Node.js and Git"
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodeOk = $false
  if ($node) {
    $v = (& node -v).TrimStart("v")
    $nodeOk = [int]($v.Split(".")[0]) -ge 22
    if ($nodeOk) { Ok "Node $v" } else { Warn "Node $v is too old (need 22+)" }
  }
  if (-not $nodeOk) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "Install Node.js 22 LTS from https://nodejs.org and run this again." }
    $a = Read-Host "Install Node.js LTS with winget now? [Y/n]"
    if ($a -match "^[nN]") { Fail "Node.js 22+ is required." }
    Run "winget" @("install", "--id", "OpenJS.NodeJS.LTS", "-e", "--accept-source-agreements", "--accept-package-agreements")
    Refresh-Path
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "Install Git from https://git-scm.com and run this again." }
    $a = Read-Host "Install Git with winget now? [Y/n]"
    if ($a -match "^[nN]") { Fail "Git is required." }
    Run "winget" @("install", "--id", "Git.Git", "-e", "--accept-source-agreements", "--accept-package-agreements")
    Refresh-Path
  }
  Ok ("Git " + ((& git --version) -replace "git version ", ""))
}

Step "Git settings"
& git config --global core.longpaths true
Ok "core.longpaths = true"

if (-not $NoPull) {
  Step "Getting the latest hive ($Branch)"
  $dirty = (& git status --porcelain --untracked-files=no)
  if ($dirty) { Warn "You have local changes in the hive folder; skipping the update (commit or stash them to update)." }
  else {
    Run "git" @("fetch", "origin", $Branch)
    Run "git" @("checkout", $Branch)
    Run "git" @("pull", "--ff-only", "origin", $Branch)
    Ok (& git log -1 --format="%h %s")
  }
}

Step "Installing dependencies (npm install)"
Run "npm" @("install", "--no-fund", "--no-audit")

Step "Building"
Run "npm" @("run", "build")
Run "node" @("scripts/build-ui.mjs")

if ($Test) {
  Step "Running the test suite (a few minutes; uses a built-in mock agent, no logins needed)"
  Run "npm" @("test")
}

Step "Putting 'hive' on your PATH (npm link)"
Run "npm" @("link")
Refresh-Path
$hiveCmd = Get-Command hive.cmd -ErrorAction SilentlyContinue
if ($hiveCmd) { Ok "hive -> $($hiveCmd.Source)" } else { Warn "Open a new terminal for 'hive' to be found (or run: node $root\dist\cli\index.js)" }
$cli = Join-Path $root "dist\cli\index.js"

Step "Checking agents (hive doctor)"
& node $cli doctor --quick
Write-Host "    Full check with logins: hive accounts   (in the app: Hive -> Accounts)" -ForegroundColor DarkGray

if ($Project) {
  if (-not (Test-Path $Project)) { Fail "Project folder not found: $Project" }
  $proj = (Resolve-Path $Project).Path
  Step "Start-menu entry for $proj"
  Run "node" @($cli, "desktop", "--cwd", $proj)
  if (-not $NoLaunch) {
    Step "Opening hive on $proj"
    Start-Process -FilePath "node" -ArgumentList @("`"$cli`"", "ui", "--cwd", "`"$proj`"") -WorkingDirectory $proj -WindowStyle Hidden
    Ok "The hive window should open in a few seconds."
  }
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "  Open hive on a project:   cd C:\code\myproject; hive ui"
Write-Host "  Sign in once if needed:   claude  (then /login)   ·   codex login"
Write-Host "  Update later:             powershell -ExecutionPolicy Bypass -File $root\scripts\install-windows.ps1"
