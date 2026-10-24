@echo off
python -m pip install --quiet vpk
python "%~dp0build_pack.py" %*
pause
