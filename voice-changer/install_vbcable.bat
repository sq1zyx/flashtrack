@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Установка VB-Cable для Discord и игр

rem ====================================================================
rem  Ставит бесплатный виртуальный кабель VB-Audio Virtual Cable:
rem  программа выводит новый голос в "CABLE Input",
rem  а Discord и игры слушают его как микрофон "CABLE Output".
rem  Драйвер скачивается с официального сайта vb-audio.com.
rem ====================================================================

net session >nul 2>&1
if errorlevel 1 (
    echo Для установки драйвера нужны права администратора.
    echo Сейчас Windows спросит разрешение - нажмите "Да".
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "URL=https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
set "WORK=%TEMP%\vbcable_setup"

echo.
echo  =============================================
echo     VB-Cable - виртуальный микрофон
echo  =============================================
echo.

powershell -NoProfile -Command "if (Get-PnpDevice -FriendlyName '*VB-Audio Virtual Cable*' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo  VB-Cable уже установлен, ничего делать не нужно.
    goto howto
)

echo [1/3] Скачиваю драйвер с vb-audio.com...
if exist "%WORK%" rd /s /q "%WORK%"
mkdir "%WORK%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%WORK%\vbcable.zip'"
if not exist "%WORK%\vbcable.zip" goto err_download

echo [2/3] Распаковываю...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force -Path '%WORK%\vbcable.zip' -DestinationPath '%WORK%'"
set "SETUP=VBCABLE_Setup_x64.exe"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "SETUP=VBCABLE_Setup.exe"
if not exist "%WORK%\%SETUP%" goto err_download

echo [3/3] Устанавливаю драйвер...
echo       Если Windows спросит "Установить программное обеспечение
echo       для данного устройства?" - нажмите "Установить".
start "" /wait "%WORK%\%SETUP%" -i -h

powershell -NoProfile -Command "if (Get-PnpDevice -FriendlyName '*VB-Audio Virtual Cable*' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Тихая установка не прошла. Сейчас откроется обычный установщик:
    echo  нажмите в нём "Install Driver".
    start "" /wait "%WORK%\%SETUP%"
)
rd /s /q "%WORK%" >nul 2>&1

echo.
echo  Готово! Чтобы кабель заработал, нужно перезагрузить компьютер.

:howto
echo.
echo  Как пользоваться:
echo   1. В Voice Changer нажмите кнопку "Discord и игры"
echo      - вывод станет "CABLE Input".
echo   2. В Discord: Настройки - Голос и видео - Устройство ввода:
echo      "CABLE Output (VB-Audio Virtual Cable)".
echo   3. В играх и OBS выберите микрофон "CABLE Output" так же.
echo.
choice /c YN /n /m "Перезагрузить компьютер сейчас? [Y - да, N - позже]: "
if errorlevel 2 goto end
shutdown /r /t 10 /c "Перезагрузка для VB-Cable"
goto end

:err_download
echo.
echo  ОШИБКА: не удалось скачать драйвер. Проверьте интернет
echo  или скачайте вручную: https://vb-audio.com/Cable/
start "" "https://vb-audio.com/Cable/"

:end
echo.
pause
endlocal
