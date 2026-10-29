# Screen helper for Novi's screen plugin (Windows). Commands:
#   shot <png path>   -> saves the primary screen, prints "<width> <height>"
#   click <x> <y>     -> left click at physical pixel x,y
#   type              -> types the text in $env:NOVI_SCREEN_TEXT (never passed on the command line)
#   key <sendkeys>    -> presses one key combination (from the plugin's allow-list)
#   scroll <notches>  -> mouse wheel over the front app (negative = down)
#   window            -> prints the title of the foreground window
#   focus             -> brings the window titled like $env:NOVI_SCREEN_APP to the front (True/False)
param([string]$cmd, [string]$a1, [string]$a2)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class NoviScreen {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", EntryPoint = "IsIconic")] public static extern bool Minimized(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  // The front-most app window that isn't Novi's own page ("NOVI …") or work window ("Novi work …"):
  // what the user means by "on the screen" while talking to Novi on the laptop.
  public static IntPtr FrontApp() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindow(h, 4) != IntPtr.Zero || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512); var t = sb.ToString();
      // (a browser's floating video window sits on top but isn't the page the user means)
      if (t.Length == 0 || t.StartsWith("NOVI") || t.StartsWith("Novi work") || t == "Program Manager" || t.StartsWith("Picture in picture") || t.StartsWith("Picture-in-picture")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
# Physical pixels for both screenshots and clicks (before Windows Forms loads).
[void][NoviScreen]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

switch ($cmd) {
  'shot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($a1, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "$($b.Width) $($b.Height)"
  }
  'click' {
    [void][NoviScreen]::SetCursorPos([int]$a1, [int]$a2)
    [NoviScreen]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [NoviScreen]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  }
  'type' {
    # SendKeys treats + ^ % ~ ( ) { } [ ] as commands: wrap each in braces so it's typed literally.
    $text = ($env:NOVI_SCREEN_TEXT -replace '\r?\n', ' ') -replace '([+^%~(){}\[\]])', '{$1}'
    # SendKeys inverts letter case while Caps Lock is on: switch it off while typing, then back on.
    $caps = [Console]::CapsLock
    if ($caps) { [NoviScreen]::keybd_event(0x14, 0, 0, [UIntPtr]::Zero); [NoviScreen]::keybd_event(0x14, 0, 2, [UIntPtr]::Zero) }
    try { [System.Windows.Forms.SendKeys]::SendWait($text) }
    finally { if ($caps) { [NoviScreen]::keybd_event(0x14, 0, 0, [UIntPtr]::Zero); [NoviScreen]::keybd_event(0x14, 0, 2, [UIntPtr]::Zero) } }
  }
  'key' { [System.Windows.Forms.SendKeys]::SendWait($a1) }
  # Mouse wheel over the middle of the front app window (not Novi's page): $a1 notches, negative = down.
  'scroll' {
    $h = [NoviScreen]::FrontApp()
    if ($h -eq [IntPtr]::Zero) { $h = [NoviScreen]::GetForegroundWindow() }
    $r = New-Object NoviScreen+RECT
    [void][NoviScreen]::GetWindowRect($h, [ref]$r)
    [void][NoviScreen]::SetCursorPos([int](($r.Left + $r.Right) / 2), [int](($r.Top + $r.Bottom) / 2))
    $d = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]([int]$a1 * 120)), 0)
    [NoviScreen]::mouse_event(0x800, 0, 0, $d, [UIntPtr]::Zero)
  }
  # Brings the first window whose title contains $env:NOVI_SCREEN_APP to the front; prints True/False.
  'focus' { (New-Object -ComObject WScript.Shell).AppActivate($env:NOVI_SCREEN_APP) }
  # The front window's links, buttons, tiles… through UI Automation: JSON { title, items: [{ type, name,
  # x, y, w, h }] } in physical pixels (centre). Chromium browsers turn on their page's accessibility only
  # once asked, so a list with just the browser's own buttons is asked again (up to ~3 s).
  'items' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $h = [NoviScreen]::FrontApp()
    if ($h -eq [IntPtr]::Zero) { $h = [NoviScreen]::GetForegroundWindow() }
    $sb = New-Object System.Text.StringBuilder 512
    [void][NoviScreen]::GetWindowText($h, $sb, 512)
    $root = $A::FromHandle($h)
    $CT = [System.Windows.Automation.ControlType]
    $conds = @($CT::Hyperlink, $CT::Button, $CT::ListItem, $CT::TabItem, $CT::Edit, $CT::MenuItem, $CT::CheckBox, $CT::RadioButton, $CT::ComboBox, $CT::TreeItem, $CT::DataItem) | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $_) }
    $or = New-Object System.Windows.Automation.OrCondition($conds)
    # Only Chromium windows switch their page accessibility on late; anything else is read once.
    $cls = New-Object System.Text.StringBuilder 256
    [void][NoviScreen]::GetClassName($h, $cls, 256)
    $tries = if ($cls.ToString() -eq "Chrome_WidgetWin_1") { 6 } else { 1 }
    for ($try = 0; $try -lt $tries; $try++) {
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $or)
      if ($all.Count -gt 40 -or $try -eq $tries - 1) { break }
      Start-Sleep -Milliseconds 500
    }
    $items = New-Object System.Collections.ArrayList
    foreach ($e in $all) {
      $c = $e.Current
      if ($c.IsOffscreen -or $c.BoundingRectangle.IsEmpty -or -not $c.Name -or $c.BoundingRectangle.Width -lt 4) { continue }
      $r = $c.BoundingRectangle
      [void]$items.Add(@{ type = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); name = $c.Name; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); w = [int]$r.Width; h = [int]$r.Height })
      if ($items.Count -ge 400) { break }
    }
    @{ title = $sb.ToString(); hwnd = [int64]$h; items = $items } | ConvertTo-Json -Depth 4 -Compress
  }
  # The foreground window as "<handle>`t<title>" (titles change while typing — Notepad names a new tab
  # after its first line — so Screen Mode follows the handle).
  'front' {
    $h = [NoviScreen]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][NoviScreen]::GetWindowText($h, $sb, 512)
    "$([int64]$h)`t$($sb.ToString())"
  }
  # Brings window <handle> to the front (restored if minimized); prints True only if it really is in front.
  'focushwnd' {
    $h = [IntPtr][int64]$a1
    if ([NoviScreen]::Minimized($h)) { [void][NoviScreen]::ShowWindow($h, 9) }
    # A short Alt press lets a background process take the foreground (Windows' focus-steal rule).
    [NoviScreen]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [NoviScreen]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][NoviScreen]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 120
    ([NoviScreen]::GetForegroundWindow() -eq $h)
  }
  'window' {
    $sb = New-Object System.Text.StringBuilder 512
    [void][NoviScreen]::GetWindowText([NoviScreen]::GetForegroundWindow(), $sb, 512)
    $sb.ToString()
  }
  default { throw "unknown command: $cmd" }
}
