import { runFile } from '../util/proc.mjs';

/** Native Windows folder picker (WinForms FolderBrowserDialog via PowerShell, STA thread). */
export async function pickFolder(initial) {
  if (process.platform !== 'win32') return { ok: false, error: 'The folder picker is only available on Windows; enter the path by hand.' };
  const init = initial ? String(initial).replace(/'/g, "''") : '';
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'SleepPilot - choose the project folder'
$d.ShowNewFolderButton = $true
${init ? `$d.SelectedPath = '${init}'` : ''}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`;
  const r = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 10 * 60_000 });
  const p = r.stdout.trim();
  if (r.exitCode !== 0) return { ok: false, error: r.stderr.trim().slice(0, 300) || 'Could not open the folder picker.' };
  return p ? { ok: true, path: p } : { ok: false, cancelled: true };
}
