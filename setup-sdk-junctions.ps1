# Run this in an ELEVATED PowerShell (Right-click PowerShell -> Run as Administrator)
# Redirects Windows SDK install path and VS Installer download cache to F: drive,
# via NTFS junctions, so they don't consume space on the nearly-full C: drive.

$ErrorActionPreference = "Stop"

# --- 1. Windows Kits (Windows SDK) -> F: ---
$kitsTarget = "F:\Working folder\Visual Studio Code\WindowsKits10"
$kitsLink   = "C:\Program Files (x86)\Windows Kits"

New-Item -ItemType Directory -Path $kitsTarget -Force | Out-Null

if (Test-Path $kitsLink) {
    Write-Warning "$kitsLink already exists - not overwriting. Remove/move it first if you want to redirect it."
} else {
    New-Item -ItemType Junction -Path $kitsLink -Target $kitsTarget | Out-Null
    Write-Output "Junction created: $kitsLink -> $kitsTarget"
}

# --- 2. VS Installer download cache -> F: ---
$cacheTarget = "F:\Working folder\Visual Studio Code\VSInstallerPackages"
$cacheLink   = "C:\ProgramData\Microsoft\VisualStudio\Packages"

New-Item -ItemType Directory -Path $cacheTarget -Force | Out-Null

if (Test-Path $cacheLink) {
    # Move existing (currently tiny, ~20MB) contents over, then replace with a junction.
    robocopy $cacheLink $cacheTarget /E /MOVE | Out-Null
    Remove-Item $cacheLink -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Junction -Path $cacheLink -Target $cacheTarget | Out-Null
Write-Output "Junction created: $cacheLink -> $cacheTarget"

Write-Output ""
Write-Output "Done. Verify with:"
Write-Output "  Get-Item '$kitsLink' | Select-Object LinkType,Target"
Write-Output "  Get-Item '$cacheLink' | Select-Object LinkType,Target"
Write-Output ""
Write-Output "Now open the Visual Studio Installer, modify your VS 18 Community instance,"
Write-Output "and add the 'Desktop development with C++' workload. Both the SDK and the"
Write-Output "download cache will land on F: instead of C:."
