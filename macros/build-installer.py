# Собирает TweakMacro.exe и установщик install-TweakMacro.bat (файлы программы вшиваются в него в base64).
#
#   python3 macros/build-installer.py                         — обычная версия
#   python3 macros/build-installer.py --admin КОД --out ПУТЬ  — админская версия: рядом с программой кладётся admin.key
#
# TweakMacro.exe собирается из TweakMacro.ahk скриптом build/compile.ahk (на Windows — напрямую, на Linux — через Wine).
# Путь к AutoHotkey64.exe берётся из переменной AHK_EXE. Если её нет, используется уже собранный TweakMacro.exe.
import argparse, base64, hashlib, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['TweakMacro.exe', 'ui.html', 'launcher.html', 'icon.ico']

TPL = r"""@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ((Get-Content -LiteralPath $f -Raw) -split '#PS#')[2]"
echo.
pause
exit /b
#PS#

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  Write-Host '[1/2] Copying @@NAME@@ v@@VER@@ to Desktop...'
  $desk = [Environment]::GetFolderPath('Desktop')
  $dir = Join-Path $desk '@@NAME@@'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Migrate from the old FlashMacro name: keep settings, drop the old shortcut
  $old = Join-Path $desk 'FlashMacro'
  if ((Test-Path (Join-Path $old 'config.ini')) -and -not (Test-Path (Join-Path $dir 'config.ini'))) { Copy-Item (Join-Path $old 'config.ini') $dir }
  Remove-Item (Join-Path $desk 'FlashMacro.lnk') -ErrorAction SilentlyContinue
  # Close a running copy so the .exe can be replaced; the script version is not needed any more
  # A copy started as administrator hides its path and can't be closed from here: then re-run the installer elevated
  Get-Process TweakMacro -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ((Get-Process TweakMacro -ErrorAction SilentlyContinue) -and -not $isAdmin) {
    Write-Host 'TweakMacro is running as administrator. Asking for admin rights to close it...' -ForegroundColor Yellow
    Start-Process cmd.exe -Verb RunAs -ArgumentList ('/c "' + $f + '"')
    return
  }
  # Old script versions run inside AutoHotkey and would fight the new exe for the same keys
  Get-CimInstance Win32_Process -Filter "Name like 'AutoHotkey%'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'TweakMacro|FlashMacro' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item (Join-Path $dir 'TweakMacro.ahk') -ErrorAction SilentlyContinue
  # If the .exe is still locked, move it aside: Windows allows renaming a running program
  Get-ChildItem $dir -Filter 'TweakMacro.old*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $cur = Join-Path $dir 'TweakMacro.exe'
  if (Test-Path $cur) {
    try { Remove-Item $cur -Force } catch { Rename-Item $cur ('TweakMacro.old' + [DateTime]::Now.Ticks + '.exe') }
  }
@@FILES@@
  $ws = New-Object -ComObject WScript.Shell
  $exe = Join-Path $dir 'TweakMacro.exe'
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) '@@NAME@@.lnk'
  foreach ($path in @((Join-Path $desk '@@NAME@@.lnk'), $menu)) {
    $lnk = $ws.CreateShortcut($path)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $dir
    $lnk.IconLocation = $exe + ',0'
    $lnk.Description = '@@NAME@@'
    $lnk.Save()
  }

  Write-Host '[2/2] Starting @@NAME@@...'
  Start-Process $exe -WorkingDirectory $dir
  Write-Host ''
  Write-Host 'DONE. @@NAME@@ v@@VER@@ installed. Desktop: folder @@NAME@@ + shortcut @@NAME@@ (also in Start menu).' -ForegroundColor Green
  Write-Host 'The launcher is open. Your config.ini (if any) was kept.'
} catch {
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
}
"""


def compile_exe():
    ahk = os.environ.get('AHK_EXE')
    exe = os.path.join(HERE, 'TweakMacro.exe')
    if not ahk:
        if not os.path.exists(exe):
            sys.exit('Нет TweakMacro.exe: укажи AHK_EXE=путь к AutoHotkey64.exe, чтобы собрать его')
        print('AHK_EXE не задан — беру уже собранный TweakMacro.exe')
        return
    args = [os.path.join(HERE, 'build', 'compile.ahk'), os.path.join(HERE, 'TweakMacro.ahk'), ahk, os.path.join(HERE, 'icon.ico'), exe]
    if os.name == 'nt':
        cmd = [ahk, '/ErrorStdOut'] + args
    else:
        win = lambda p: 'Z:' + os.path.abspath(p).replace('/', '\\')
        cmd = ['wine', ahk, '/ErrorStdOut'] + [win(a) for a in args]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if 'ok ' not in out.stdout:
        sys.exit('Сборка .exe не удалась:\n' + out.stdout + out.stderr)
    print('TweakMacro.exe:', os.path.getsize(exe), 'bytes')


def build(name, extra, out_path):
    lines = []
    for fname in FILES:
        b64 = base64.b64encode(open(os.path.join(HERE, fname), 'rb').read()).decode()
        lines.append(f"  [IO.File]::WriteAllBytes((Join-Path $dir '{fname}'), [Convert]::FromBase64String('{b64}'))")
    for fname, data in extra.items():
        b64 = base64.b64encode(data).decode()
        lines.append(f"  [IO.File]::WriteAllBytes((Join-Path $dir '{fname}'), [Convert]::FromBase64String('{b64}'))")
    ver = re.search(r'^APP_VERSION := "([^"]+)"', open(os.path.join(HERE, 'TweakMacro.ahk'), encoding='utf-8').read(), re.M).group(1)
    out = TPL.replace('@@NAME@@', name).replace('@@VER@@', ver).replace('@@FILES@@', '\n'.join(lines) + '\n').replace('\n', '\r\n')
    open(out_path, 'w', encoding='utf-8', newline='').write(out)
    print(os.path.basename(out_path) + ':', len(out), 'bytes')


def set_admin(code):
    # Меняет хэш админ-кода в TweakMacro.ahk (сам код в программу не попадает)
    p = os.path.join(HERE, 'TweakMacro.ahk')
    s = open(p, encoding='utf-8').read()
    h = hashlib.sha256(code.encode()).hexdigest()
    s, n = re.subn(r'^ADMIN_HASH := "[0-9a-f]{64}"', f'ADMIN_HASH := "{h}"', s, flags=re.M)
    if n != 1:
        sys.exit('ADMIN_HASH не найден в TweakMacro.ahk')
    open(p, 'w', encoding='utf-8').write(s)
    print('ADMIN_HASH обновлён. Не забудь тот же код в ADMIN_TOKEN на сервере.')


ap = argparse.ArgumentParser()
ap.add_argument('--admin', help='собрать админскую версию с этим админ-кодом')
ap.add_argument('--out', help='куда положить установщик')
ap.add_argument('--set-admin', help='сменить админ-код (хэш в TweakMacro.ahk)')
a = ap.parse_args()
if a.set_admin:
    set_admin(a.set_admin)
    sys.exit(0)
compile_exe()
if a.admin:
    want = re.search(r'^ADMIN_HASH := "([0-9a-f]{64})"', open(os.path.join(HERE, 'TweakMacro.ahk'), encoding='utf-8').read(), re.M).group(1)
    if hashlib.sha256(a.admin.encode()).hexdigest() != want:
        sys.exit('Код не совпадает с ADMIN_HASH в TweakMacro.ahk — проверь код или смени его через --set-admin')
    build('TweakMacro Admin', {'admin.key': a.admin.encode()}, a.out or os.path.join(HERE, 'install-TweakMacro-Admin.bat'))
else:
    build('TweakMacro', {}, a.out or os.path.join(HERE, 'install-TweakMacro.bat'))
