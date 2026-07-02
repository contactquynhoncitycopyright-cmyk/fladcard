@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo Dang kiem tra...
python --version
echo.
echo Cau truc thu muc:
dir
echo.
echo Neu thay server.py va thu muc public la dung.
pause
