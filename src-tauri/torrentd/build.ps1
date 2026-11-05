# Builds vega-torrentd.exe (libtorrent engine) and copies it into
# src-tauri/resources/torrentd, where the app bundles it.
#
# Needs Visual Studio 2022 (Build Tools) with C++ and its bundled vcpkg/CMake.
# First run: vcpkg builds libtorrent, Boost and OpenSSL (about an hour).
#
#   powershell -ExecutionPolicy Bypass -File src-tauri/torrentd/build.ps1 [-InstalledDir D:\vcpkg-torrentd]
param(
  [string]$InstalledDir = (Join-Path $PSScriptRoot 'vcpkg_installed')
)
$ErrorActionPreference = 'Stop'
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio 2022 with C++ tools is required.' }
$vcpkgRoot = Join-Path $vs 'VC\vcpkg'
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$build = Join-Path $PSScriptRoot 'build'

# MSVC environment for the Ninja generator.
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}

& $cmake -S $PSScriptRoot -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release `
  "-DCMAKE_TOOLCHAIN_FILE=$vcpkgRoot\scripts\buildsystems\vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static "-DVCPKG_INSTALLED_DIR=$InstalledDir"
if ($LASTEXITCODE) { throw 'CMake configure failed' }
& $cmake --build $build --config Release
if ($LASTEXITCODE) { throw 'Build failed' }

$target = Join-Path $PSScriptRoot '..\resources\torrentd'
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item (Join-Path $build 'vega-torrentd.exe') $target -Force
Write-Output "Built $(Join-Path $target 'vega-torrentd.exe')"
