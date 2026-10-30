@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Установка Voice Changer

rem ====================================================================
rem  Установщик Voice Changer для Windows 10/11
rem  1) ставит Python, если его нет  2) скачивает программу
rem  3) ставит библиотеки  4) создаёт ярлыки на рабочем столе и в Пуске
rem ====================================================================

set "APPDIR=%LOCALAPPDATA%\VoiceChanger"
set "REPO=https://raw.githubusercontent.com/sq1zyx/flashtrack/ccr-c9177474-i5ork0/voice-changer"
set "PYVER=3.12.7"
set "PYURL=https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe"

echo.
echo  =============================================
echo     Voice Changer - установка
echo  =============================================
echo.
echo  Папка программы: %APPDIR%
echo.

rem ---------------------------------------------------------- 1. Python
echo [1/5] Ищу Python...
set "PY="
call :find_python
if defined PY goto python_ok

echo       Python не найден. Скачиваю Python %PYVER% - около 25 МБ...
set "PYSETUP=%TEMP%\python-%PYVER%-setup.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%PYURL%' -OutFile '%PYSETUP%'"
if not exist "%PYSETUP%" goto err_download_python

echo       Устанавливаю Python, подождите 1-2 минуты...
start "" /wait "%PYSETUP%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_tcltk=1 Include_pip=1 Include_test=0
del "%PYSETUP%" >nul 2>&1

if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY call :find_python
if not defined PY goto err_python

:python_ok
echo       OK: %PY%

"%PY%" -c "import tkinter" >nul 2>&1
if errorlevel 1 goto err_tkinter

rem ---------------------------------------------------------- 2. файлы
echo [2/5] Копирую программу...
if not exist "%APPDIR%" mkdir "%APPDIR%"

if exist "%~dp0voice_changer.py" (
    copy /y "%~dp0voice_changer.py" "%APPDIR%\voice_changer.py" >nul
    copy /y "%~dp0requirements.txt" "%APPDIR%\requirements.txt" >nul
) else (
    echo       Скачиваю с GitHub...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%REPO%/voice_changer.py' -OutFile '%APPDIR%\voice_changer.py'; Invoke-WebRequest -UseBasicParsing -Uri '%REPO%/requirements.txt' -OutFile '%APPDIR%\requirements.txt'"
)
if not exist "%APPDIR%\voice_changer.py" goto err_download_app

rem ---------------------------------------------------------- 3. библиотеки
echo [3/5] Ставлю библиотеки: numpy, sounddevice...
if not exist "%APPDIR%\venv\Scripts\python.exe" "%PY%" -m venv "%APPDIR%\venv"
if not exist "%APPDIR%\venv\Scripts\python.exe" goto err_venv
"%APPDIR%\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet --disable-pip-version-check
"%APPDIR%\venv\Scripts\python.exe" -m pip install -r "%APPDIR%\requirements.txt" --quiet --disable-pip-version-check
if errorlevel 1 goto err_pip

rem ---------------------------------------------------------- 4. ярлыки и служебные файлы
echo [4/5] Создаю ярлыки...
(
    echo @echo off
    echo cd /d "%APPDIR%"
    echo "%APPDIR%\venv\Scripts\python.exe" voice_changer.py
    echo pause
) > "%APPDIR%\debug.bat"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'));" ^
  "foreach ($dir in $targets) {" ^
  "  $s = $ws.CreateShortcut((Join-Path $dir 'Voice Changer.lnk'));" ^
  "  $s.TargetPath = '%APPDIR%\venv\Scripts\pythonw.exe';" ^
  "  $s.Arguments = '\"%APPDIR%\voice_changer.py\"';" ^
  "  $s.WorkingDirectory = '%APPDIR%';" ^
  "  $s.IconLocation = '%SystemRoot%\System32\SndVol.exe,0';" ^
  "  $s.Description = 'Voice Changer';" ^
  "  $s.Save() }"

for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Programs')"`) do set "STARTMENU=%%D"
(
    echo @echo off
    echo chcp 65001 ^>nul
    echo echo Удаляю Voice Changer...
    echo del "%DESKTOP%\Voice Changer.lnk" ^>nul 2^>^&1
    echo del "%STARTMENU%\Voice Changer.lnk" ^>nul 2^>^&1
    echo cd /d "%TEMP%"
    echo echo Готово. Python остаётся на компьютере, его можно удалить через Параметры - Приложения.
    echo pause
    echo rd /s /q "%APPDIR%"
) > "%APPDIR%\uninstall.bat"

rem ---------------------------------------------------------- 5. VB-Cable
echo [5/5] Проверяю виртуальный кабель для Discord и игр...
powershell -NoProfile -Command "if (Get-PnpDevice -FriendlyName '*VB-Audio Virtual Cable*' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo       VB-Cable уже установлен.
    goto done
)
echo.
echo       Чтобы ваш новый голос слышали в Discord, играх и OBS,
echo       нужен бесплатный драйвер VB-Audio Virtual Cable.
choice /c YN /n /m "      Открыть страницу загрузки VB-Cable? [Y - да, N - нет]: "
if errorlevel 2 goto done
start "" "https://vb-audio.com/Cable/"
echo       Скачайте архив, распакуйте и запустите VBCABLE_Setup_x64.exe
echo       от имени администратора, затем перезагрузите компьютер.

:done
echo.
echo  =============================================
echo     Готово! Ярлык "Voice Changer" на рабочем столе.
echo  =============================================
echo.
echo  Discord: в программе вывод "CABLE Input",
echo           в Discord микрофон "CABLE Output".
echo  Если программа не открывается: %APPDIR%\debug.bat
echo  Удаление: %APPDIR%\uninstall.bat
echo.
choice /c YN /n /m "Запустить Voice Changer сейчас? [Y/N]: "
if errorlevel 2 goto end
start "" "%APPDIR%\venv\Scripts\pythonw.exe" "%APPDIR%\voice_changer.py"
:end
endlocal
exit /b 0

rem ====================================================================
:find_python
rem Пропускаем заглушку из Microsoft Store: она есть в PATH, но не работает
for /f "usebackq delims=" %%P in (`py -3 -c "import sys; print(sys.executable)" 2^>nul`) do set "PY=%%P"
if defined PY goto :check_version
for /f "usebackq delims=" %%P in (`python -c "import sys; print(sys.executable)" 2^>nul`) do set "PY=%%P"
if not defined PY exit /b 0
:check_version
"%PY%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
if errorlevel 1 set "PY="
exit /b 0

:err_download_python
echo.
echo  ОШИБКА: не удалось скачать Python. Проверьте интернет
echo  или установите его вручную: https://www.python.org/downloads/
echo  При установке отметьте "Add Python to PATH". Потом запустите этот файл снова.
goto fail
:err_python
echo.
echo  ОШИБКА: Python установился, но не найден. Перезагрузите компьютер
echo  и запустите этот файл снова.
goto fail
:err_tkinter
echo.
echo  ОШИБКА: в вашем Python нет модуля tkinter - он нужен для окна программы.
echo  Переустановите Python с python.org с галочкой "tcl/tk and IDLE".
goto fail
:err_download_app
echo.
echo  ОШИБКА: не удалось скачать программу с GitHub. Проверьте интернет.
goto fail
:err_venv
echo.
echo  ОШИБКА: не удалось создать окружение Python в %APPDIR%\venv
goto fail
:err_pip
echo.
echo  ОШИБКА: не удалось установить библиотеки. Проверьте интернет и запустите снова.
goto fail
:fail
echo.
pause
endlocal
exit /b 1
