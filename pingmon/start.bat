@echo off
setlocal
cd /d "%~dp0"
title PingMon

rem Python : 1) dossier local "python" (version portable), 2) lanceur "py", 3) "python" du PATH
set "PY="
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PY ( py -3 --version >nul 2>nul && set "PY=py -3" )
if not defined PY ( python --version >nul 2>nul && set "PY=python" )

if not defined PY (
  echo Python introuvable.
  echo Telecharge le zip "Windows embeddable package" sur python.org, dezippe-le
  echo dans le sous-dossier "python" ici meme, puis relance ce fichier.
  pause
  exit /b 1
)

%PY% run.py %*
if errorlevel 1 pause
