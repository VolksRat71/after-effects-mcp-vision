<#
.SYNOPSIS
  Dev install for Windows: links cep/ into the per-user CEP extensions folder.

.DESCRIPTION
  Mirrors scripts/cep-install.sh. No admin rights and no signing certificate:
  the extensions folder is per-user, and unsigned extensions load because
  PlayerDebugMode is set. Signing is a release concern only.

  A directory junction is used rather than a symbolic link because junctions do
  not require elevation or Developer Mode.

.PARAMETER Uninstall
  Remove the link instead of creating it.
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$BundleId = 'com.aemcpvision.bridge'
$Src      = (Resolve-Path (Join-Path $PSScriptRoot '..\cep')).Path
$DestDir  = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$Dest     = Join-Path $DestDir $BundleId

if ($Uninstall) {
  if (Test-Path $Dest) {
    (Get-Item $Dest).Delete()
    Write-Host "removed $Dest"
  } else {
    Write-Host "nothing installed at $Dest"
  }
  exit 0
}

if (-not (Test-Path $Src)) { throw "No cep directory at $Src" }
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

if (Test-Path $Dest) {
  $item = Get-Item $Dest -Force
  # Only ever replace our own link. A real directory here is a packaged install.
  if ($item.LinkType) {
    $item.Delete()
  } else {
    throw "$Dest exists and is not a link. That looks like a packaged install - remove it by hand if intended."
  }
}

New-Item -ItemType Junction -Path $Dest -Target $Src | Out-Null
Write-Host "linked $Dest -> $Src"

# Unsigned extensions require PlayerDebugMode, set per CSXS major version.
foreach ($v in 10, 11, 12, 13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  New-Item -Path $key -Force | Out-Null
  $current = (Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
  if ($current -ne '1') {
    Set-ItemProperty -Path $key -Name PlayerDebugMode -Value '1'
    Write-Host "enabled PlayerDebugMode for CSXS.$v"
  }
}

Write-Host ''
Write-Host 'Restart After Effects. The server starts with it; the status panel'
Write-Host 'is optional, under Window > Extensions > AE MCP Vision.'
