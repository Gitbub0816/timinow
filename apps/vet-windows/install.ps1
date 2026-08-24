# Builds Timi Vet and installs it like an application.
#
# `dotnet publish` alone leaves TimiVet.exe five folders deep inside bin\,
# which Windows does not consider an installed app: nothing in the Start
# Menu, nothing findable in search, nothing sane to pin. Every "is this the
# new build" confusion this project has had traces back to people launching
# whatever old copy they could actually find. This script is the missing
# step: publish, copy the result to a stable per-user location, and give it
# a Start Menu entry - so "open Timi Vet" always opens the newest install,
# and the footer's build stamp says when it was made.
#
# Usage, from the repository root or this folder:
#   powershell -ExecutionPolicy Bypass -File apps\vet-windows\install.ps1
#   ... -Desktop        also puts a shortcut on the desktop
#
# No administrator rights needed: everything lands under the current user
# (%LocalAppData%\Programs and the per-user Start Menu), which is also where
# per-user installers like VS Code put themselves.

param(
    [switch]$Desktop
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $PSScriptRoot "src\TimiVet\TimiVet.csproj"
$published = Join-Path $PSScriptRoot "src\TimiVet\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\TimiVet.exe"
$installDir = Join-Path $env:LocalAppData "Programs\Timi Vet"
$installedExe = Join-Path $installDir "TimiVet.exe"
$startMenuDir = Join-Path $env:AppData "Microsoft\Windows\Start Menu\Programs"
$shortcut = Join-Path $startMenuDir "Timi Vet.lnk"

# A running instance holds a lock on its own exe, and a single-file publish
# has to rewrite it - without this, GenerateBundle fails with an
# access-denied that never says "the app is running", and the old binary is
# silently left in place to be tested as if it were the new one.
Stop-Process -Name TimiVet -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

Write-Host "Building Timi Vet..." -ForegroundColor Cyan
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed - nothing was installed. The previous install, if any, is untouched." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $published)) {
    Write-Host "Build reported success but $published does not exist - nothing was installed." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item $published $installedExe -Force

# A .lnk via the shell COM object: the one shortcut format the Start Menu,
# search, and taskbar pinning all understand. The icon comes from the exe
# itself, which carries the Timi artwork.
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $installedExe
$link.WorkingDirectory = $installDir
$link.Description = "Timi Vet - live veterinary intake console"
$link.Save()

if ($Desktop) {
    $desktopLink = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Timi Vet.lnk"))
    $desktopLink.TargetPath = $installedExe
    $desktopLink.WorkingDirectory = $installDir
    $desktopLink.Save()
}

$stamp = (Get-Item $installedExe).LastWriteTime.ToString("d MMM HH:mm")
Write-Host ""
Write-Host "Installed: $installedExe (built $stamp)" -ForegroundColor Green
Write-Host "Start Menu: search for 'Timi Vet', pin it from there." -ForegroundColor Green
Write-Host "The app's own footer shows the same build stamp, so a stale copy identifies itself."
Start-Process $installedExe
