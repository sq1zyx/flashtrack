@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Выдать код доступа
if not exist dist\cli.js call npm run build --silent

set CREDITS=
set /p CREDITS=Сколько проверок в коде? Введите число и нажмите Enter: 
set NOTE=
set /p NOTE=Для кого код? Имя или комментарий, можно латиницей: 
node --disable-warning=ExperimentalWarning dist/cli.js new %CREDITS% "%NOTE%"
echo.
echo Отправьте клиенту код из строки выше и ссылку https://dogovor-audit.ru
echo.
echo Все коды и остатки:
node --disable-warning=ExperimentalWarning dist/cli.js list
pause
