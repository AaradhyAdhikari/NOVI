# Novi laptop controls (plugins/laptop-control). Started once by worker.js and kept running.
# Reads one JSON line per command on stdin: {"id":1,"cmd":"volume","args":{...}}
# Writes one JSON line back: {"id":1,"ok":true,...} or {"id":1,"ok":false,"error":"..."}.
# Commands arrive as data (cmd + args), never as code. No admin rights needed.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class NoviAudio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
    return epv;
  }
  public static float Volume {
    get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
  }
  public static bool Mute {
    get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
  }
}

public static class NoviWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();

  // Visible, titled, top-level app windows in z-order (front first): [handle, title, pid].
  public static List<object[]> List() {
    var list = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; // hidden or owned
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // tool window
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden UWP
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new object[] { h.ToInt64(), sb.ToString(), (int)pid });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  static void Key(byte k, bool ext) { keybd_event(k, 0, ext ? 1u : 0u, UIntPtr.Zero); keybd_event(k, 0, ext ? 3u : 2u, UIntPtr.Zero); }
  public static void Focus(long id) {
    var h = new IntPtr(id);
    if (IsIconic(h)) ShowWindow(h, 9);
    Key(0x12, false); // a key press lets this process bring another window to the front
    SetForegroundWindow(h);
  }
  public static void Show(long id, int how) { ShowWindow(new IntPtr(id), how); }
  public static void Close(long id) { PostMessage(new IntPtr(id), 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE: the app may ask to save
  public static void Media(byte vk) { Key(vk, true); }
  public static void Ctrl(byte letter) {
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(letter, 0, 0, UIntPtr.Zero);
    keybd_event(letter, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
'@

# WinRT (Wi-Fi / Bluetooth radios): await an IAsyncOperation from PowerShell 5.1.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(8000)) { throw 'timeout' }
  $task.Result
}

function Clamp($n) { [Math]::Max(0, [Math]::Min(100, [int]$n)) }

$handlers = @{
  ping = { param($a) @{ pong = $true } }
  volume = { param($a)
    if ($null -ne $a.level) { [NoviAudio]::Volume = [float]((Clamp $a.level) / 100); if ($a.level -gt 0) { [NoviAudio]::Mute = $false } }
    elseif ($null -ne $a.delta) {
      [NoviAudio]::Volume = [float]((Clamp ([Math]::Round([NoviAudio]::Volume * 100) + $a.delta)) / 100)
      if ($a.delta -gt 0) { [NoviAudio]::Mute = $false }
    }
    if ($null -ne $a.mute) { [NoviAudio]::Mute = [bool]$a.mute }
    @{ level = [int][Math]::Round([NoviAudio]::Volume * 100); muted = [NoviAudio]::Mute }
  }
  brightness = { param($a)
    $now = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1
    $set = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $now -or -not $set) { throw 'no-brightness' }
    $level = [int]$now.CurrentBrightness
    if ($null -ne $a.level) { $level = Clamp $a.level } elseif ($null -ne $a.delta) { $level = Clamp ($level + $a.delta) }
    Invoke-CimMethod -InputObject $set -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$level } | Out-Null
    @{ level = $level }
  }
  media = { param($a)
    $vk = @{ play = 0xB3; next = 0xB0; previous = 0xB1 }[[string]$a.key]
    if (-not $vk) { throw 'bad-key' }
    [NoviWin]::Media([byte]$vk)
    @{}
  }
  battery = { param($a)
    $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $b) { return @{ none = $true } }
    $out = @{ percent = [int]$b.EstimatedChargeRemaining; charging = @(2, 6, 7, 8, 9) -contains [int]$b.BatteryStatus }
    if (-not $out.charging -and $b.EstimatedRunTime -and $b.EstimatedRunTime -lt 71582788) { $out.minutesLeft = [int]$b.EstimatedRunTime }
    $out
  }
  radio = { param($a)
    [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
    Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null
    $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $kind = if ($a.kind -eq 'bluetooth') { 'Bluetooth' } else { 'WiFi' }
    $r = $radios | Where-Object { "$($_.Kind)" -eq $kind } | Select-Object -First 1
    if (-not $r) { throw 'no-radio' }
    if ($null -ne $a.on) {
      $status = Await ($r.SetStateAsync($(if ($a.on) { 'On' } else { 'Off' }))) ([Windows.Devices.Radios.RadioAccessStatus])
      if ("$status" -ne 'Allowed') { throw 'no-radio' }
    }
    @{ on = ("$($r.State)" -eq 'On') }
  }
  lock = { param($a) [NoviWin]::LockWorkStation() | Out-Null; @{} }
  sleep = { param($a) [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null; @{} }
  power = { param($a)
    $flag = @{ shutdown = @('/s', '/t', '15'); restart = @('/r', '/t', '15'); signout = @('/l') }[[string]$a.action]
    if (-not $flag) { throw 'bad-action' }
    Start-Process -FilePath shutdown.exe -ArgumentList $flag -WindowStyle Hidden
    @{}
  }
  'power-cancel' = { param($a) Start-Process -FilePath shutdown.exe -ArgumentList '/a' -WindowStyle Hidden; @{} }
  windows = { param($a)
    $names = @{}
    Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }
    $list = @([NoviWin]::List() | ForEach-Object { @{ id = $_[0]; title = $_[1]; process = [string]$names[[int]$_[2]] } })
    @{ windows = $list }
  }
  window = { param($a)
    $id = [long]$a.id
    switch ([string]$a.do) {
      'focus' { [NoviWin]::Focus($id) }
      'minimize' { [NoviWin]::Show($id, 6) }
      'maximize' { [NoviWin]::Show($id, 3); [NoviWin]::Focus($id) }
      'restore' { [NoviWin]::Show($id, 9) }
      'close' { [NoviWin]::Close($id) }
      default { throw 'bad-window-action' }
    }
    @{}
  }
  'clip-get' = { param($a) $t = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue; @{ text = [string]$t } }
  'clip-set' = { param($a) Set-Clipboard -Value ([string]$a.text); @{} }
  keys = { param($a)
    $letter = @{ copy = 0x43; paste = 0x56 }[[string]$a.combo]
    if (-not $letter) { throw 'bad-keys' }
    [NoviWin]::Ctrl([byte]$letter)
    @{}
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $handler = $handlers[[string]$req.cmd]
    if (-not $handler) { throw 'unknown-command' }
    $result = & $handler $req.args
    $reply = @{ id = $id; ok = $true }
    if ($result -is [hashtable]) { foreach ($k in $result.Keys) { $reply[$k] = $result[$k] } }
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
