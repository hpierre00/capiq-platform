@echo off
echo Installing Underlytix Daily Marketing dependencies...
cd /d "%~dp0"
npm init -y
npm install @anthropic-ai/sdk node-fetch
echo.
echo Done! Now:
echo   1. Add your Anthropic API key to underlytix-daily-post.js (CONFIG.anthropicApiKey)
echo   2. Connect Facebook, Instagram, X at platform.postiz.com
echo   3. Run: node underlytix-daily-post.js
echo   4. To schedule: Right-click schedule-task.ps1 and Run with PowerShell
pause
