@echo off
cd /d "%~dp0"
pip install -r requirements.txt pyinstaller
pyinstaller --onefile --windowed --name VoiceChanger voice_changer.py
echo.
echo Готово: dist\VoiceChanger.exe
pause
