@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Настройка домена dogovor-audit.ru
set DOMAIN=dogovor-audit.ru
set TUNNEL=dogovor-audit

where cloudflared >nul 2>nul
if not errorlevel 1 goto have_cloudflared
echo Устанавливаю cloudflared - программу туннеля от Cloudflare...
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
echo.
echo Готово. Закройте это окно и запустите setup-tunnel.bat ещё раз.
pause
exit /b 0

:have_cloudflared
if exist "%USERPROFILE%\.cloudflared\cert.pem" goto logged_in
echo Шаг 1 из 3: откроется браузер. Войдите в Cloudflare и нажмите на домен %DOMAIN%, затем Authorize.
cloudflared tunnel login
if errorlevel 1 goto fail

:logged_in
echo Шаг 2 из 3: создаю туннель %TUNNEL%...
cloudflared tunnel create %TUNNEL%
echo Если выше написано, что туннель уже существует - это нормально.

echo Шаг 3 из 3: привязываю домен...
cloudflared tunnel route dns %TUNNEL% %DOMAIN%
cloudflared tunnel route dns %TUNNEL% www.%DOMAIN%

echo.
echo Готово! Теперь start.bat сам запускает туннель, и сайт открывается по адресу https://%DOMAIN%
pause
exit /b 0

:fail
echo Не получилось войти в Cloudflare. Проверьте, что домен %DOMAIN% добавлен в ваш аккаунт Cloudflare, и попробуйте снова.
pause
exit /b 1
