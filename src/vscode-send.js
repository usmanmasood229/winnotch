'use strict';
// Sending the notch's message to an open Claude chat in VS Code.
//
// There is no supported API for this (see session-prompt.js), so it is done the
// way you would do it, with a check at every step so nothing lands anywhere else:
//   0. The project's VS Code window is found by its title and brought to the
//      front (opened with Code.exe if it isn't open). Windows won't let a
//      background app pull another window forward, so this is done here, with
//      the usual synthetic Alt press, rather than asked of VS Code. The window
//      you were using is noted first and put back in front at the end.
//   1. The chat link focuses that chat's tab; that same window must be in front
//      with a title naming the chat in full (two windows on one folder name,
//      or a chat with no name, are refused rather than guessed).
//   2. Keyboard focus is in that chat's prompt box: Windows UI Automation sees it
//      as an Edit named "Message input" in VS Code's (Chrome) web content.
//   3. The box is empty, so a message you were half-way through typing is never
//      added to or sent.
//   4. The text is set straight into the box (ValuePattern), never by typing or
//      the clipboard, and read back to be exactly the message.
//   5. Box, text and the front window are checked again, Enter is pressed, and
//      only an emptied box counts as sent.
// Any failed check stops before Enter and reports why; main.js then leaves the
// message on the clipboard instead. The one gap left is the instant between the
// last check and the Enter key, which only blocking all input (admin) closes.
//
// Everything travels on stdin as JSON, never in the command line, so nothing in
// the message is ever read as PowerShell.

const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class NotchWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  public static bool ToolWindow(IntPtr h) { return (GetWindowLong(h, -20) & 0x80) != 0; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> Visible() { var l = new List<IntPtr>(); EnumWindows((h, x) => { if (IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero); return l; }
  // The plain call first. Only if Windows refuses it (a background process may
  // not take the foreground) the usual Alt tap unlocks it: a lone Alt landing in
  // VS Code can put its focus on the menu bar, so it is not used when not needed.
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
}
'@
# The window you were using: the top real window that isn't the notch. Once the
# message is in (or not), it goes back in front, so VS Code is only up for the
# moment the send needs it. Windows only lets the front window take keystrokes,
# and VS Code doesn't register text set from the background, so it can't be
# skipped altogether.
$script:back = [IntPtr]::Zero; $script:raised = [IntPtr]::Zero
# Set once the message is in VS Code's box, so an unexpected error says so.
$script:typed = $false
# Anything unexpected still ends through Done: your window comes back, and the
# notch is told whether the text is sitting in VS Code's box.
trap { Done @{ ok = $false; reason = 'script-failed'; left = $script:typed } }
function Done($r) {
  if ($script:raised -ne [IntPtr]::Zero -and $script:back -ne [IntPtr]::Zero -and $script:back -ne $script:raised) {
    [NotchWin]::Raise($script:back) | Out-Null
  }
  $r | ConvertTo-Json -Compress; exit 0
}
function ProcName($h) { (Get-Process -Id ([NotchWin]::Pid($h)) -ErrorAction SilentlyContinue).ProcessName }
function Front { $h = [NotchWin]::GetForegroundWindow(); @{ h = $h; proc = (ProcName $h); title = [NotchWin]::Title($h) } }
# Every VS Code window on this folder name. More than one (two clones with the
# same folder name) is refused rather than guessed between.
function FindWins {
  $suffix = ' - ' + $in.folderName + ' - Visual Studio Code'
  $hits = @()
  foreach ($h in [NotchWin]::Visible()) {
    $t = [NotchWin]::Title($h)
    if (($t.EndsWith($suffix, 'OrdinalIgnoreCase') -or $t.Equals($in.folderName + ' - Visual Studio Code', 'OrdinalIgnoreCase')) -and (ProcName $h) -eq 'Code') { $hits += $h }
  }
  return ,$hits
}
function Box {
  $f = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $f) { return $null }
  $c = $f.Current
  if ($c.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or $c.Name -ne 'Message input' -or $c.FrameworkId -ne 'Chrome') { return $null }
  return $f
}
function Val($e) { try { return $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null } }
function Norm($s) { return ($s -replace '\s+', ' ').Trim().ToLowerInvariant() }
# An empty box is not reported as empty: its grey hint (CSS-generated) comes
# back as the value. Read on this machine: 'ctrl esc to focus or unfocus Claude'
# when idle, 'Queue another message…' while Claude works.
# ponytail: a list of VS Code's wording. A hint not on it reads as a draft, so
# the send falls back to the clipboard (safe); add the new wording here.
$HINTS = @('ctrl esc to focus or unfocus claude', 'queue another message…', 'queue another message...', 'queue another message')
function IsEmptyBox($v) { if ($null -eq $v) { return $false }; $n = Norm $v; return ($n -eq '') -or ($HINTS -contains $n) }

function UserWindow {
  foreach ($h in [NotchWin]::Visible()) {          # top of the z-order first
    $t = [NotchWin]::Title($h)
    if (-not $t -or $t -eq 'Program Manager' -or [NotchWin]::Cloaked($h) -or [NotchWin]::ToolWindow($h)) { continue }
    if (@('WinNotch', 'electron') -contains (ProcName $h)) { continue }
    return $h
  }
  return [IntPtr]::Zero
}

# 0. The project's window to the front, opening it if it isn't open.
if (-not $in.title) { Done @{ ok = $false; reason = 'no-title' } }
$script:back = UserWindow
$hits = FindWins
if ($hits.Count -eq 0 -and $in.exe) {
  # The folder is a checked plain drive path with no quotes (session-prompt.js).
  Start-Process -FilePath $in.exe -ArgumentList ('"' + $in.folder + '"')
  for ($i = 0; $i -lt 40 -and $hits.Count -eq 0; $i++) { Start-Sleep -Milliseconds 200; $hits = FindWins }
}
if ($hits.Count -gt 1) { Done @{ ok = $false; reason = 'ambiguous-window' } }
if ($hits.Count -eq 0) { Done @{ ok = $false; reason = 'no-window' } }
$w = $hits[0]
$script:raised = $w
[NotchWin]::Raise($w) | Out-Null
Start-Sleep -Milliseconds 250
if ((Front).h -ne $w) { [NotchWin]::Raise($w) | Out-Null; Start-Sleep -Milliseconds 250 }
if ((Front).h -ne $w) { Done @{ ok = $false; reason = 'not-vscode-front' } }

# 1-2. The link focuses the chat's tab. Wait until the window title names that
# chat in full (the switch takes a moment, and until then focus is still in
# whichever chat was in front), let it settle, and only then take its box. The
# whole title must match, so a chat whose name merely starts the same way never
# passes. A name VS Code shortens with "…" doesn't match either, and the send
# falls back to the clipboard: telling it apart from a chat that shares the
# start of its name isn't possible from the title.
$want = Norm $in.title
$winSuffix = ' - ' + (Norm $in.folderName) + ' - visual studio code'
function TitleIsChat($t) {
  $head = Norm $t
  if ($head.EndsWith($winSuffix)) { $head = $head.Substring(0, $head.Length - $winSuffix.Length) }
  return $head -eq $want
}
Start-Process $in.uri
$box = $null; $titleOk = $false; $fg = $null
# Another app can take the front back while the link is handled (seen here a
# second in). It is brought back at most twice; past that it's someone using
# their machine, and the send gives up rather than fight them.
$retakes = 0
for ($i = 0; $i -lt 28 -and -not $box; $i++) {
  Start-Sleep -Milliseconds 150
  $fg = Front
  if ($fg.h -ne $w) {
    if ($retakes -lt 2) { $retakes++; [NotchWin]::Raise($w) | Out-Null }
    continue
  }
  $titleOk = TitleIsChat $fg.title
  if ($titleOk) { Start-Sleep -Milliseconds 150; if (TitleIsChat (Front).title) { $box = Box } }
}
if (-not $fg -or $fg.h -ne $w) { Done @{ ok = $false; reason = 'not-vscode-front' } }
if (-not $titleOk) { Done @{ ok = $false; reason = 'wrong-chat' } }
if (-not $box) { Done @{ ok = $false; reason = 'no-box' } }

# 3. Never add to, or send, something already in the box.
$v = Val $box
if ($null -eq $v) { Done @{ ok = $false; reason = 'no-box' } }
if (-not (IsEmptyBox $v)) { Done @{ ok = $false; reason = 'draft' } }

# 4. Put the message in (straight into the box, never by keystrokes or the
# clipboard) and read it back. Compared with spacing normalised: the editor may
# turn spaces into non-breaking ones once the text is in.
$set = $false
$wantText = Norm $in.text
try { $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($in.text); Start-Sleep -Milliseconds 80; $set = ((Norm (Val $box)) -eq $wantText) } catch {}
$script:typed = $set
if (-not $set) {
  # The box was empty a moment ago; leave it empty rather than half-filled.
  try { $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('') } catch {}
  Done @{ ok = $false; reason = 'type-failed' }
}

# 5. Still the same box, still exactly the message: send, and see it go.
$b2 = Box
if (-not $b2) { Done @{ ok = $false; reason = 'focus-moved'; left = $true; why = 'box' } }
if ((Norm (Val $b2)) -ne $wantText) { Done @{ ok = $false; reason = 'focus-moved'; left = $true; why = 'text' } }
if ($in.dry) { $b2.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue(''); Done @{ ok = $true; dry = $true } }
# The cheapest check last, right before the key: still this exact window.
if ([NotchWin]::GetForegroundWindow() -ne $w) { Done @{ ok = $false; reason = 'focus-moved'; left = $true; why = 'front' } }
# Said before the key goes, so a timeout from here on is "may have sent", never
# a reason to hand the text over for a second send (main.js).
[Console]::Out.WriteLine('ENTER'); [Console]::Out.Flush()
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 150
  if (IsEmptyBox (Val $b2)) { Done @{ ok = $true } }
}
Done @{ ok = $false; reason = 'not-sent'; left = $true }
`;

// Resolves { ok, reason?, left?, entered?, dry? }. Never rejects: a failure to
// run at all is reported as a reason like any other.
//   folder: the session's folder; exe: Code.exe or null; uri: the chat link
//   (session-prompt.js); text: the message; title: the chat's name or null.
// One send at a time: two scripts at once would fight over the front window and
// each other's "window you were using". A second call while one runs is refused.
let inFlight = false;
function sendToChat(args, opts) {
  if (inFlight) return Promise.resolve({ ok: false, reason: 'busy' });
  inFlight = true;
  return runScript(args, opts).finally(() => { inFlight = false; });
}

function runScript({ folder, exe, uri, text, title, dry = false }, { timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    let out = '', done = false, timer = null;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let p;
    try {
      // Code.exe is Electron too: inheriting ELECTRON_RUN_AS_NODE would make it
      // run as plain Node and do nothing.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      // Encoded, so no quoting in the script can be mangled on the way in.
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return finish({ ok: false, reason: 'no-powershell' });
    }
    // Out of time after Enter was pressed is "may have sent": never handed back
    // for a second send. Before it, nothing was sent.
    timer = setTimeout(() => {
      try { p.kill(); } catch {}
      finish(/(^|\n)ENTER\r?\n/.test(out) ? { ok: false, reason: 'unconfirmed', entered: true } : { ok: false, reason: 'timeout' });
    }, timeoutMs);
    p.on('error', () => finish({ ok: false, reason: 'no-powershell' }));
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => {
      const line = out.trim().split(/\r?\n/).pop() || '';
      try { finish(JSON.parse(line)); }
      catch {
        // No verdict. If Enter had gone, it may have sent: same as a timeout.
        finish(/(^|\n)ENTER\r?\n/.test(out) ? { ok: false, reason: 'unconfirmed', entered: true }
                                            : { ok: false, reason: 'script-failed' });
      }
    });
    const folderName = String(folder).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    p.stdin.end(JSON.stringify({ folder, folderName, exe: exe || '', uri, text, title: title || '', dry: !!dry }));
  });
}

module.exports = { sendToChat, SCRIPT };
