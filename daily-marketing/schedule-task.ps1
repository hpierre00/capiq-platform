# Registers Underlytix Daily Marketing as a Windows Scheduled Task
# Run once as Administrator: Right-click schedule-task.ps1 → Run with PowerShell

$scriptDir  = "C:\Users\herol\OneDrive\capiq-platform\daily-marketing"
$scriptPath = Join-Path $scriptDir "underlytix-daily-post.js"
$logPath    = Join-Path $scriptDir "logs\daily-post.log"

# Create logs folder if needed
New-Item -ItemType Directory -Force -Path (Join-Path $scriptDir "logs") | Out-Null

# Set ANTHROPIC_API_KEY as a persistent user environment variable
$apiKey = $env:ANTHROPIC_API_KEY
if (-not $apiKey) {
    Write-Host "⚠️  ANTHROPIC_API_KEY not found in environment." -ForegroundColor Yellow
    Write-Host "   Set it now: [System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY','YOUR_KEY','User')" -ForegroundColor Cyan
}

# Build action — node.exe runs the script with the env key passed explicitly
$argument = "`"$scriptPath`""
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"set ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% && node.exe $scriptPath >> $logPath 2>&1`"" `
    -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At "09:00"

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

$taskName = "Underlytix-Daily-Marketing"

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$task = Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Daily Marketing: generates and schedules AI content to Postiz social channels for Underlytix + Tradolux"

if ($task) {
    Write-Host "✅ Task '$taskName' registered. Runs daily at 9:00 AM." -ForegroundColor Green
    Write-Host "   Log: $logPath" -ForegroundColor Cyan
} else {
    Write-Host "❌ Failed to register task." -ForegroundColor Red
}
