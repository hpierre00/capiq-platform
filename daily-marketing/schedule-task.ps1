# Registers Underlytix Daily Marketing as a Windows Scheduled Task
# Run once as Administrator: Right-click schedule-task.ps1 → Run with PowerShell

$scriptDir  = "C:\Users\herol\OneDrive\Pictures\Documents\Claude\Projects\Underlytix\daily-marketing"
$scriptPath = Join-Path $scriptDir "underlytix-daily-post.js"
$logPath    = Join-Path $scriptDir "logs\daily-post.log"

# Create logs folder if needed
New-Item -ItemType Directory -Force -Path (Join-Path $scriptDir "logs") | Out-Null

# Set your Anthropic API key here (or set it as a system environment variable)
$anthropicKey = "YOUR_ANTHROPIC_API_KEY_HERE"

$action = New-ScheduledTaskAction `
    -Execute "node.exe" `
    -Argument "`"$scriptPath`"" `
    -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At "09:00"

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

$env_block = [System.Collections.Generic.List[Microsoft.Management.Infrastructure.CimInstance]]::new()

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

# Register with ANTHROPIC_API_KEY as environment
$taskName = "Underlytix-Daily-Marketing"

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$task = Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Underlytix Daily Marketing: generates and schedules AI content to all Postiz social channels"

if ($task) {
    Write-Host "✅ Scheduled task '$taskName' registered successfully." -ForegroundColor Green
    Write-Host "   Runs daily at 9:00 AM." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "IMPORTANT: Set your Anthropic API key as a system environment variable:" -ForegroundColor Yellow
    Write-Host "   [System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', '$anthropicKey', 'Machine')" -ForegroundColor White
    Write-Host ""
    Write-Host "Or add it directly to the script's CONFIG.anthropicApiKey value." -ForegroundColor Yellow
} else {
    Write-Host "❌ Failed to register task." -ForegroundColor Red
}
