# Windows equivalent of init-secrets.sh. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\init-secrets.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path secrets | Out-Null

function New-Secret([string]$Name, [int]$Length) {
  $path = "secrets/$Name.txt"
  if ((Test-Path $path) -and ((Get-Item $path).Length -gt 0)) { Write-Host "  keep   $path"; return }
  $chars = [char[]]"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $bytes = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $value = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) $path), $value)
  Write-Host "  create $path"
}

Write-Host "Secrets in .\secrets:"
New-Secret db_root_password 32
New-Secret db_auth_password 32
New-Secret db_upload_password 32
New-Secret db_stream_password 32
New-Secret jwt_secret 64
New-Secret internal_token 48
New-Secret admin_password 20
Write-Host "`nAdmin login:  admin / $(Get-Content secrets/admin_password.txt)"
