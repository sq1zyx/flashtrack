@echo off
chcp 65001 >nul
cd /d "%~dp0"
title dogovor-audit.ru - сервер

where node >nul 2>nul
if errorlevel 1 goto no_node
node -e "process.exit(+process.versions.node.split('.')[0] < 22 ? 1 : 0)"
if errorlevel 1 goto old_node

if not exist .env goto make_env

echo [1/4] Проверяю зависимости...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto fail

echo [2/4] Собираю сервис...
call npm run build --silent
if errorlevel 1 goto fail

echo [3/4] Проверяю нейросеть...
node dist/check-llm.js
if errorlevel 1 goto fail

echo [4/4] Запускаю...
where cloudflared >nul 2>nul
if errorlevel 1 goto no_tunnel
if not exist "%USERPROFILE%\.cloudflared\cert.pem" goto no_tunnel
start "Туннель dogovor-audit.ru - не закрывайте" cloudflared tunnel run --url http://localhost:3000 dogovor-audit
echo Сайт будет доступен по адресу https://dogovor-audit.ru
goto run

:no_tunnel
echo Туннель не настроен - сайт доступен только на этом компьютере. Чтобы открыть его в интернете, запустите setup-tunnel.bat

:run
echo Не закрывайте это окно: пока оно открыто, сервис работает.
start "" http://localhost:3000
node --disable-warning=ExperimentalWarning dist/server.js
echo Сервер остановлен.
pause
exit /b 0

:make_env
copy /y .env.example .env >nul
echo.
echo Первый запуск: сейчас откроется файл настроек .env в Блокноте.
echo Вставьте ключ GigaChat после GIGACHAT_AUTH_KEY= и сохраните файл - Ctrl+S.
echo Потом закройте Блокнот и снова запустите start.bat
echo.
notepad .env
exit /b 0

:no_node
echo Не найден Node.js. Скачайте версию LTS с https://nodejs.org, установите и запустите start.bat снова.
start "" https://nodejs.org
pause
exit /b 1

:old_node
echo Нужен Node.js версии 22 или новее. Скачайте LTS с https://nodejs.org и установите поверх старой.
pause
exit /b 1

:fail
echo.
echo Что-то пошло не так - сообщение об ошибке выше. Сфотографируйте или скопируйте его и пришлите в чат.
pause
exit /b 1
