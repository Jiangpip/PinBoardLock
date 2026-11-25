@echo off
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync-PinterestBoards.ps1" %*
echo.
pause
