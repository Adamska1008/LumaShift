param([ValidateSet('dev','build','test','check','diagnose')][string]$Action = 'dev')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# Include prerelease Visual Studio installations, which Rust's discovery can miss.
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$visualStudioPath = $null
if (Test-Path -LiteralPath $vswherePath) {
  $visualStudioPath = & $vswherePath -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $visualStudioPath) {
  $candidates = Get-ChildItem -Path "$env:ProgramFiles\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*" -Directory -ErrorAction SilentlyContinue
  $toolset = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
  if ($toolset) {
    $env:PATH = (Join-Path $toolset.FullName 'bin\Hostx64\x64') + ';' + $env:PATH
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
    $sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Lib') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    $env:LIB = "$(Join-Path $toolset.FullName 'lib\x64');$sdkRoot\Lib\$($sdkVersion.Name)\ucrt\x64;$sdkRoot\Lib\$($sdkVersion.Name)\um\x64"
    $env:INCLUDE = "$(Join-Path $toolset.FullName 'include');$sdkRoot\Include\$($sdkVersion.Name)\ucrt;$sdkRoot\Include\$($sdkVersion.Name)\shared;$sdkRoot\Include\$($sdkVersion.Name)\um"
    $env:PATH = "$sdkRoot\bin\$($sdkVersion.Name)\x64;" + $env:PATH
  }
} else {
  # This command only imports compiler environment variables; it performs no file operations.
  $developerCommand = Join-Path $visualStudioPath 'Common7\Tools\VsDevCmd.bat'
  & cmd.exe /d /c "call `"$developerCommand`" -arch=x64 -host_arch=x64 >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
  }
}
switch ($Action) {
  'dev' { & npm.cmd run tauri -- dev }
  'build' {
    # Keep compiler output separate from executables users launch.
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'src-tauri\target\desktop-build'
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outputDirectory = Join-Path $projectRoot '.local\builds'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $outputPath = Join-Path $outputDirectory "LumaShift-$version-$timestamp.exe"
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\lumashift.exe') -Destination $outputPath -ErrorAction Stop
    Write-Host "Built executable: $outputPath"
  }
  'test' { & cargo test --manifest-path src-tauri/Cargo.toml }
  'check' { & cargo check --manifest-path src-tauri/Cargo.toml }
  'diagnose' { & cargo run --manifest-path src-tauri/Cargo.toml -- --diagnose }
}
exit $LASTEXITCODE
