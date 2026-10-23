# Собирает install-TweakMacro.bat: файлы программы вшиваются в него в base64.
# Запуск после любых правок программы: python3 macros/build-installer.py
import base64, os

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['TweakMacro.ahk', 'ui.html', 'launcher.html', 'icon.ico']

TPL = r"""@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ((Get-Content -LiteralPath $f -Raw) -split '#PS#')[2]"
echo.
pause
exit /b
#PS#

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $ahkExe = @("$env:ProgramFiles\AutoHotkey\v2\AutoHotkey64.exe", "$env:LOCALAPPDATA\Programs\AutoHotkey\v2\AutoHotkey64.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $ahkExe) {
    Write-Host '[1/3] Installing AutoHotkey v2...'
    $ok = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --id AutoHotkey.AutoHotkey -e --silent --accept-package-agreements --accept-source-agreements
      $ok = ($LASTEXITCODE -eq 0)
    }
    if (-not $ok) {
      $inst = Join-Path $env:TEMP 'ahk-v2-setup.exe'
      Invoke-WebRequest 'https://www.autohotkey.com/download/ahk-v2.exe' -OutFile $inst -UseBasicParsing
      Start-Process $inst -ArgumentList '/silent' -Wait
    }
    $ahkExe = @("$env:ProgramFiles\AutoHotkey\v2\AutoHotkey64.exe", "$env:LOCALAPPDATA\Programs\AutoHotkey\v2\AutoHotkey64.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $ahkExe) { throw 'AutoHotkey v2 was not found after install. Install it manually: https://www.autohotkey.com/' }
  } else { Write-Host '[1/3] AutoHotkey v2 already installed' }

  Write-Host '[2/3] Copying TweakMacro to Desktop...'
  $desk = [Environment]::GetFolderPath('Desktop')
  $dir = Join-Path $desk 'TweakMacro'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Migrate from the old FlashMacro name: keep settings, drop the old shortcut
  $old = Join-Path $desk 'FlashMacro'
  if ((Test-Path (Join-Path $old 'config.ini')) -and -not (Test-Path (Join-Path $dir 'config.ini'))) { Copy-Item (Join-Path $old 'config.ini') $dir }
  Remove-Item (Join-Path $desk 'FlashMacro.lnk') -ErrorAction SilentlyContinue
@@FILES@@
  $ws = New-Object -ComObject WScript.Shell
  $script = Join-Path $dir 'TweakMacro.ahk'
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'TweakMacro.lnk'
  foreach ($path in @((Join-Path $desk 'TweakMacro.lnk'), $menu)) {
    $lnk = $ws.CreateShortcut($path)
    $lnk.TargetPath = $ahkExe
    $lnk.Arguments = '"' + $script + '"'
    $lnk.WorkingDirectory = $dir
    $lnk.IconLocation = (Join-Path $dir 'icon.ico') + ',0'
    $lnk.Description = 'TweakMacro'
    $lnk.Save()
  }

  Write-Host '[3/3] Starting TweakMacro...'
  Start-Process $ahkExe -ArgumentList ('"' + $script + '"') -WorkingDirectory $dir
  Write-Host ''
  Write-Host 'DONE. Desktop: folder TweakMacro + shortcut TweakMacro (also in Start menu).' -ForegroundColor Green
  Write-Host 'The TweakMacro launcher is open. Your config.ini (if any) was kept.'
} catch {
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
}
"""

lines = []
for name in FILES:
    b64 = base64.b64encode(open(os.path.join(HERE, name), 'rb').read()).decode()
    lines.append(f"  [IO.File]::WriteAllBytes((Join-Path $dir '{name}'), [Convert]::FromBase64String('{b64}'))")
out = TPL.replace('@@FILES@@', '\n'.join(lines) + '\n').replace('\n', '\r\n')
open(os.path.join(HERE, 'install-TweakMacro.bat'), 'w', encoding='utf-8', newline='').write(out)
print('install-TweakMacro.bat:', len(out), 'bytes')
