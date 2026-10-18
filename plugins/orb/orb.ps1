# Novi's desktop orb (2026-10-18). A small round window, always on top, that never takes the focus
# from the app being typed in. Shows Novi's state (sent by Novi as JSON lines on stdin), and sends
# events as JSON lines on stdout: 'tap' (talk to Novi), 'hold_start' / 'hold_end' (Ctrl+Shift+Space
# held for dictation), 'moved' (new place), 'open' (open Novi's page). It never presses keys in apps.
param([int]$X = -1, [int]$Y = -1)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NoviOrbNative {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

function Send-Event($name, $extra = @{}) {
  $o = @{ event = $name } + $extra
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# Novi's messages arrive on stdin; a second runspace reads them so the window never blocks.
$queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$reader = [runspacefactory]::CreateRunspace()
$reader.Open()
$reader.SessionStateProxy.SetVariable('queue', $queue)
$readPs = [powershell]::Create()
$readPs.Runspace = $reader
[void]$readPs.AddScript({
  $in = [Console]::In
  while ($true) {
    $line = $in.ReadLine()
    if ($null -eq $line) { $queue.Enqueue('__eof__'); break }
    $queue.Enqueue($line)
  }
})
[void]$readPs.BeginInvoke()

$size = 56
$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ShowActivated = $false
$win.ResizeMode = 'NoResize'
$win.Width = $size
$win.Height = $size
$area = [System.Windows.SystemParameters]::WorkArea
if ($X -lt 0 -or $Y -lt 0 -or $X -gt $area.Right - 20 -or $Y -gt $area.Bottom - 20) {
  $win.Left = $area.Right - $size - 24
  $win.Top = $area.Bottom - $size - 24
} else {
  $win.Left = $X
  $win.Top = $Y
}

$grid = New-Object System.Windows.Controls.Grid
$glow = New-Object System.Windows.Shapes.Ellipse
$core = New-Object System.Windows.Shapes.Ellipse
$ring = New-Object System.Windows.Shapes.Ellipse
$core.Margin = '10'
$ring.Margin = '4'
$ring.StrokeThickness = 2
$ring.StrokeDashArray = New-Object System.Windows.Media.DoubleCollection
$ring.StrokeDashArray.Add(3); $ring.StrokeDashArray.Add(3)
$scale = New-Object System.Windows.Media.ScaleTransform 1, 1
$spin = New-Object System.Windows.Media.RotateTransform 0
$core.RenderTransformOrigin = '0.5,0.5'
$core.RenderTransform = $scale
$ring.RenderTransformOrigin = '0.5,0.5'
$ring.RenderTransform = $spin
[void]$grid.Children.Add($glow)
[void]$grid.Children.Add($core)
[void]$grid.Children.Add($ring)
$win.Content = $grid
$win.ToolTip = 'Novi: tap to talk, hold Ctrl+Shift+Space to type by voice'

$colors = @{
  idle = '#00f2fe'; listening = '#00f2fe'; thinking = '#b18cff'; speaking = '#7cf29a'; quiet = '#8a94a8'
}
$script:state = 'idle'
function Set-Look {
  $c = [System.Windows.Media.ColorConverter]::ConvertFromString($colors[$script:state])
  $brush = New-Object System.Windows.Media.RadialGradientBrush
  $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromArgb(255, 255, 255, 255)), 0))
  $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop $c, 0.55))
  $brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop ([System.Windows.Media.Color]::FromArgb(255, 5, 7, 13)), 1))
  $core.Fill = $brush
  $glow.Fill = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(60, $c.R, $c.G, $c.B))
  $ring.Stroke = New-Object System.Windows.Media.SolidColorBrush $c
  $ring.Visibility = if ($script:state -eq 'thinking') { 'Visible' } else { 'Hidden' }
  $win.Opacity = if ($script:state -eq 'idle' -or $script:state -eq 'quiet') { 0.55 } else { 1.0 }
}
Set-Look

# Never take the focus (dictation pastes into the app in front) and stay out of Alt+Tab.
$win.Add_SourceInitialized({
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper $win).Handle
  $ex = [NoviOrbNative]::GetWindowLong($hwnd, -20)
  [void][NoviOrbNative]::SetWindowLong($hwnd, -20, ($ex -bor 0x08000000 -bor 0x00000080))
})

# Left button: a tap talks to Novi; a drag moves the orb (and the place is remembered).
$win.Add_MouseLeftButtonDown({
  $left = $win.Left; $top = $win.Top
  try { $win.DragMove() } catch { }
  if ([Math]::Abs($win.Left - $left) -lt 4 -and [Math]::Abs($win.Top - $top) -lt 4) { Send-Event 'tap' }
  else { Send-Event 'moved' @{ x = [int]$win.Left; y = [int]$win.Top } }
})

# Right button: open Novi, hide for an hour, hide until Novi restarts.
$menu = New-Object System.Windows.Controls.ContextMenu
$open = New-Object System.Windows.Controls.MenuItem; $open.Header = 'Open Novi'
$hour = New-Object System.Windows.Controls.MenuItem; $hour.Header = 'Hide for 1 hour'
$gone = New-Object System.Windows.Controls.MenuItem; $gone.Header = 'Hide until Novi restarts'
$open.Add_Click({ Send-Event 'open' })
$back = New-Object System.Windows.Threading.DispatcherTimer
$back.Interval = [TimeSpan]::FromHours(1)
$back.Add_Tick({ $back.Stop(); $win.Show() })
$hour.Add_Click({ $win.Hide(); $back.Start() })
$gone.Add_Click({ $back.Stop(); $win.Hide() })
[void]$menu.Items.Add($open); [void]$menu.Items.Add($hour); [void]$menu.Items.Add($gone)
$win.ContextMenu = $menu

# Every 50 ms: Novi's messages, the dictation keys, and the animation.
$script:held = $false
$script:t = 0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    if ($line -eq '__eof__') { $timer.Stop(); $win.Close(); return }
    try {
      $msg = $line | ConvertFrom-Json
      if ($msg.state -and $colors.ContainsKey([string]$msg.state)) { $script:state = [string]$msg.state; Set-Look }
    } catch { }
  }
  # Ctrl + Shift + Space held = dictation (the keys still reach the app; Novi only watches them).
  $down = (([NoviOrbNative]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -and (([NoviOrbNative]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0) -and (([NoviOrbNative]::GetAsyncKeyState(0x20) -band 0x8000) -ne 0)
  if ($down -and -not $script:held) { $script:held = $true; Send-Event 'hold_start'; $script:state = 'listening'; Set-Look }
  elseif (-not $down -and $script:held) { $script:held = $false; Send-Event 'hold_end' }
  $script:t += 1
  $pulse = switch ($script:state) {
    'listening' { 1 + 0.12 * [Math]::Sin($script:t / 3) }
    'speaking' { 1 + 0.08 * [Math]::Sin($script:t / 1.5) }
    default { 1 }
  }
  $scale.ScaleX = $pulse; $scale.ScaleY = $pulse
  if ($script:state -eq 'thinking') { $spin.Angle = ($spin.Angle + 12) % 360 }
})
$timer.Start()

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($win)
