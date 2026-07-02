@echo off
cd /d "%~dp0"
title LingoPlay Production
if not exist ".venv\Scripts\python.exe" (
  echo Dang tao moi truong Python lan dau...
  py -m venv .venv 2>nul || python -m venv .venv
)
call ".venv\Scripts\activate.bat"
python -m pip install -q -r requirements.txt
start "" http://localhost:3000
python app.py
pause
