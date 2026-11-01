# Captures real screenshots of session-transfer's UI states from a live
# Claude Code session in Windows Terminal. Writes docs/screenshots/*.png.
#
#   pwsh -File scripts/capture-screenshots.ps1 [-Model haiku] [-Limit 30000]
#
# It opens a terminal window, types into it, and screenshots it: don't use the
# keyboard while it runs. SESSION_TRANSFER_LIMIT makes the limit low enough
# that the first reply reaches it. Costs a few cents on Haiku.
param(
  [string]$Model = 'haiku',
  [int]$Limit = 30000,
  [int]$Cols = 150,
  [int]$Rows = 42
)
$ErrorActionPreference = 'Stop'
$mod = Split-Path -Parent $PSScriptRoot
$out = Join-Path $mod 'docs\screenshots'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Win]::SetProcessDPIAware() | Out-Null

$title = 'st-demo-' + (Get-Random)

# A clean demo: the window must not inherit this shell's Claude Code session
# markers (they turn transcript saving off), and the person's other installed
# plugins are disabled for this one session through a --settings file. Their
# own settings.json is never touched.
foreach ($n in (Get-ChildItem env: | Where-Object { $_.Name -like 'CLAUDE*' -and $_.Name -ne 'CLAUDE_CONFIG_DIR' }).Name) { Remove-Item "env:$n" }
$userSettings = Join-Path ($env:CLAUDE_CONFIG_DIR ?? (Join-Path $HOME '.claude')) 'settings.json'
$disabled = @{}
if (Test-Path $userSettings) {
  $us = Get-Content $userSettings -Raw | ConvertFrom-Json
  if ($us.enabledPlugins) { foreach ($k in ($us.enabledPlugins | Get-Member -MemberType NoteProperty).Name) { $disabled[$k] = $false } }
}
$demoSettings = Join-Path $env:TEMP 'session-transfer-demo-settings.json'
[IO.File]::WriteAllText($demoSettings, (@{ enabledPlugins = $disabled } | ConvertTo-Json -Depth 4))
$cmd = "set SESSION_TRANSFER_LIMIT=$Limit&& claude --plugin-dir `"$mod`" --settings `"$demoSettings`" --model $Model"
Start-Process wt.exe -ArgumentList "--size $Cols,$Rows --pos 40,40 -w new new-tab --title $title --suppressApplicationTitle -d `"$mod`" cmd /k `"$cmd`""

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 240 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $h = [Win]::FindWindow([NullString]::Value, $title) }
if ($h -eq [IntPtr]::Zero) { throw "terminal window '$title' not found" }

# Keys go to whatever window is in front, so this never types unless the demo
# window is verifiably the foreground one; otherwise it stops the run.
function Focus {
  for ($i = 0; $i -lt 10; $i++) {
    if ([Win]::GetForegroundWindow() -eq $h) { Start-Sleep -Milliseconds 150; return }
    [Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt down/up: lets this process move the foreground
    [Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [Win]::ShowWindow($h, 9) | Out-Null               # SW_RESTORE
    [Win]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
  }
  if ([Win]::GetForegroundWindow() -ne $h) {
    [Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    throw 'the demo window could not be brought to the front; stopped without typing'
  }
}
function Keys([string]$k) { Focus; [System.Windows.Forms.SendKeys]::SendWait($k) }
function SendLine([string]$text) {
  Focus
  [System.Windows.Forms.SendKeys]::SendWait('^u')   # clear whatever is left in the prompt box
  Start-Sleep -Milliseconds 200
  # one key at a time: a burst loses characters in the prompt box.
  # SendKeys treats + ^ % ~ ( ) { } [ ] as specials.
  foreach ($c in $text.ToCharArray()) {
    if ([Win]::GetForegroundWindow() -ne $h) { Focus } # re-checked before every key
    $k = if ('+^%~(){}[]'.Contains($c)) { '{' + $c + '}' } else { [string]$c }
    [System.Windows.Forms.SendKeys]::SendWait($k)
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 500
  Focus
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

# Real signals instead of guesses: the mod writes a chunk at the end of every
# turn, and a handoff adds a session to thread.json.
$cfgDir = $env:CLAUDE_CONFIG_DIR ?? (Join-Path $HOME '.claude')
$archive = Join-Path $cfgDir (Join-Path 'session-transfer' ($mod -replace '[^A-Za-z0-9]', '-'))
function Chunks { if (Test-Path $archive) { @(Get-ChildItem -Recurse -Filter 'c*.md' $archive -ErrorAction SilentlyContinue).Count } else { 0 } }
function Sessions { @(Get-ChildItem -Recurse -Filter 'thread.json' $archive -ErrorAction SilentlyContinue | ForEach-Object { (Get-Content $_.FullName -Raw | ConvertFrom-Json).sessions.Count } | Measure-Object -Sum).Sum }
function WaitFor([scriptblock]$cond, [int]$seconds = 120) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  Write-Warning 'timed out waiting'; return $false
}
$threadsBefore = if (Test-Path (Join-Path $archive 'threads')) { @(Get-ChildItem (Join-Path $archive 'threads') -Directory).Name } else { @() }
function Shot([string]$name) {
  Focus
  Start-Sleep -Milliseconds 600
  $r = New-Object Win+RECT
  # the frame without the drop shadow (DWMWA_EXTENDED_FRAME_BOUNDS = 9)
  if ([Win]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [Win]::GetWindowRect($h, [ref]$r) | Out-Null }
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $path = Join-Path $out ($name + '.png')
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved $path"
}

Start-Sleep -Seconds 14                    # Claude Code starts, the mod loads
$n = Chunks
SendLine 'Read hooks/lib.js, then say in one sentence what it does.'
WaitFor { (Chunks) -gt $n } | Out-Null     # the reply is archived: the turn ended
Start-Sleep -Seconds 4                      # the yes/no suggestion opens
Shot '01-suggestion'
Keys '{DOWN}'; Start-Sleep -Milliseconds 400; Keys '{ENTER}'   # "No, stay here"
Start-Sleep -Seconds 3
Shot '02-stayed'
SendLine '/transfer'
Start-Sleep -Seconds 3
Shot '03-panel-overview'
Keys '2'; Start-Sleep -Seconds 2; Shot '04-panel-history'
Keys '3'; Start-Sleep -Seconds 2; Shot '05-panel-savings'
Keys '4'; Start-Sleep -Seconds 2; Shot '06-panel-settings'
Keys '{ESC}'; Start-Sleep -Seconds 1
SendLine '/transfer unattended on'
Start-Sleep -Seconds 3
Shot '07-unattended'
SendLine '/transfer unattended off'
Start-Sleep -Seconds 2
$s0 = Sessions
SendLine '/handoff'
WaitFor { (Sessions) -gt $s0 } 60 | Out-Null
Start-Sleep -Seconds 3
Shot '08-fresh-session'
$n = Chunks
SendLine 'What did you say hooks/lib.js does? Answer from the archived history, not by reading the file again.'
WaitFor { (Chunks) -gt $n } 150 | Out-Null
Start-Sleep -Seconds 2
Shot '09-lookup'
SendLine '/exit'
Start-Sleep -Seconds 3
[Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null # close this window only (WM_CLOSE)
# The demo's threads would otherwise be offered as "continue previous thread" in this project.
if (Test-Path (Join-Path $archive 'threads')) {
  foreach ($d in Get-ChildItem (Join-Path $archive 'threads') -Directory) { if ($threadsBefore -notcontains $d.Name) { Remove-Item -Recurse -Force $d.FullName } }
}
Remove-Item -Force $demoSettings -ErrorAction SilentlyContinue
Write-Output 'done'
