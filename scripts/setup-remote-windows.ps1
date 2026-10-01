<#
  Phone access to hive on Windows over Tailscale + SSH.
  Run in an elevated PowerShell (Run as administrator):

    powershell -ExecutionPolicy Bypass -File scripts\setup-remote-windows.ps1
    ... -TailscaleOnly    # SSH accepted only from Tailscale addresses (100.64.0.0/10)
    ... -DryRun           # print what it would do

  Installs Tailscale and the built-in OpenSSH server, makes PowerShell the SSH shell.
  Windows has no tmux: if the SSH connection drops, `hive tui` closes (agents' sessions
  resume next time). For always-on use, run hive on the Linux server (scripts/setup-remote.sh).
#>
param([switch]$TailscaleOnly, [switch]$DryRun)
$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Run([string]$what, [scriptblock]$do) {
  Write-Host "+ $what"
  if (-not $DryRun) { & $do }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $DryRun) { throw "Run this from an elevated PowerShell (right-click → Run as administrator)." }

Step "1/4 Tailscale"
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  Write-Host "tailscale already installed"
} else {
  Run "winget install --id Tailscale.Tailscale -e" { winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements }
}
Write-Host "Sign in from the Tailscale tray icon with the same account as your phone."

Step "2/4 OpenSSH server"
$cap = if ($DryRun) { $null } else { Get-WindowsCapability -Online -Name "OpenSSH.Server*" }
if ($cap -and $cap.State -eq "Installed") { Write-Host "OpenSSH server already installed" }
else { Run "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0" { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null } }
Run "Set-Service sshd -StartupType Automatic; Start-Service sshd" { Set-Service -Name sshd -StartupType Automatic; Start-Service sshd }

# PowerShell 7 if present, else Windows PowerShell, as the shell you land in
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" }
Run "DefaultShell = $shell" { New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value $shell -PropertyType String -Force | Out-Null }

Step "3/4 firewall"
if ($TailscaleOnly) {
  Run "SSH (port 22) only from 100.64.0.0/10" {
    Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress "100.64.0.0/10"
    if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (Tailscale only)" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress "100.64.0.0/10" -Action Allow | Out-Null
    }
  }
} else {
  Write-Host "unchanged (Windows' OpenSSH rule allows your local network; add -TailscaleOnly to allow only Tailscale)"
}

Step "4/4 keys"
$isAdminUser = (Get-LocalGroupMember -Group Administrators -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$env:USERNAME" })
$keys = if ($isAdminUser) { "$env:ProgramData\ssh\administrators_authorized_keys" } else { "$env:USERPROFILE\.ssh\authorized_keys" }
Write-Host "Put your phone's public key (Termius → Keychain → Generate key) in:`n  $keys"
if ($isAdminUser) { Write-Host "(admin accounts use that file; it must be readable only by Administrators and SYSTEM:`n  icacls `"$keys`" /inheritance:r /grant Administrators:F /grant SYSTEM:F)" }

$ip = try { (tailscale ip -4 2>$null | Select-Object -First 1) } catch { $null }
Write-Host "`nDone. On the phone: Tailscale app → Termius → host $env:COMPUTERNAME ($(if ($ip) { $ip } else { '100.x.y.z' })), user $env:USERNAME."
Write-Host "Then: cd <your project>; hive tui"
