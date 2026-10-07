# Screen helper for Novi's screen plugin (Windows). Commands:
#   shot <png path>   -> saves the primary screen, prints "<width> <height>"
#   click <x> <y>     -> left click at physical pixel x,y
#   type              -> types the text in $env:NOVI_SCREEN_TEXT (never passed on the command line)
#   key <sendkeys>    -> presses one key combination (from the plugin's allow-list)
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
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
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
  # Brings the first window whose title contains $env:NOVI_SCREEN_APP to the front; prints True/False.
  'focus' { (New-Object -ComObject WScript.Shell).AppActivate($env:NOVI_SCREEN_APP) }
  'window' {
    $sb = New-Object System.Text.StringBuilder 512
    [void][NoviScreen]::GetWindowText([NoviScreen]::GetForegroundWindow(), $sb, 512)
    $sb.ToString()
  }
  default { throw "unknown command: $cmd" }
}
