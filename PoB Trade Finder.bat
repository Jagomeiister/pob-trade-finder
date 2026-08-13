@echo off
rem Launches the PoB Trade Finder desktop app (no console window).
cd /d "%~dp0"
start "" pythonw gui.py
