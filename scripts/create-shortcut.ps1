# Creates a "SleepPilot" shortcut on the current user's desktop that starts SleepPilot.cmd.
# Usage (from the SleepPilot folder):  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'SleepPilot.cmd'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'SleepPilot.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $target
$s.WorkingDirectory = $root
$s.WindowStyle = 7   # minimized console; the UI opens in its own window
$s.Description = 'SleepPilot - Plan. Build. Verify. Sleep.'
$icon = Join-Path $root 'ui\icon.ico'
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()
Write-Output "Shortcut created: $lnk"
