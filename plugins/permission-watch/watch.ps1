# Novi's watcher for Allow and Yes/No boxes in other apps. Reads window buttons through Windows accessibility.
# Out: JSON lines { boxes: [{ hwnd, process, title, text, buttons }] } when the list changes,
#      { pressed: { id, ok } } after a press. In: { press: { id, hwnd, button } }.
# It presses only a button with that exact name in that exact window, and only when told to.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace NoviWatch -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);'
$AE = [System.Windows.Automation.AutomationElement]
$Types = [System.Windows.Automation.ControlType]
$Scope = [System.Windows.Automation.TreeScope]
# Standard Windows buttons (Word, message boxes) show up as plain panels here, so both count, by name.
$isPress = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $Types::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $Types::Pane)))
$isWords = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $Types::Text)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $Types::Pane)))
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$answer = '^(allow|allow once|allow this time|approve|grant|yes|decline|deny|block|reject|no|don.t allow|do not allow|always allow|allow always)$'
$skipProcess = 'TextInputHost|ApplicationFrameHost|SearchHost|ShellExperienceHost|StartMenuExperienceHost|LockApp|SearchApp|Widgets'
# A browser's own pages are left out: cookie banners and "Was this helpful?" would flood the phone. Its
# pop-ups, like a site asking for the camera, are separate windows and still count.
$browserPage = ' - (Google Chrome|Brave|Microsoft Edge|Mozilla Firefox|Opera|Vivaldi)$'

function Clean($name) { return ([string]$name).Replace('&', '').Trim() }

function Find-Box($window) {
  $all = $window.FindAll($Scope::Descendants, $isPress)
  $hits = @($all | Where-Object { (Clean $_.Current.Name) -match $answer })
  if ($hits.Count -lt 2) { return $null }
  # The box is the smallest part of the window holding two of these buttons.
  $node = $hits[0]
  for ($up = 0; $up -lt 8; $up++) {
    $node = $walker.GetParent($node)
    if ($null -eq $node) { return $null }
    $inside = @($node.FindAll($Scope::Descendants, $isPress) | Where-Object { (Clean $_.Current.Name) -match $answer })
    if ($inside.Count -ge 2) {
      $words = @($node.FindAll($Scope::Descendants, $isWords) | ForEach-Object { ([string]$_.Current.Name).Trim() } | Where-Object { $_ -and (Clean $_) -notmatch $answer })
      $joined = ($words | Select-Object -First 30) -join ' | '
      $cut = $words.Count -gt 30 -or $joined.Length -gt 900
      return @{ node = $node; cut = $cut; text = $joined.Substring(0, [Math]::Min(900, $joined.Length)); buttons = @($inside | ForEach-Object { [string]$_.Current.Name }) }
    }
  }
  return $null
}

function Scan {
  $boxes = @()
  $names = @{}
  foreach ($p in Get-Process) { $names[[int]$p.Id] = $p.ProcessName }
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $title = [string]$w.Current.Name
      $proc = [string]$names[[int]$w.Current.ProcessId]
      if ($proc -match $skipProcess -or $title -match $browserPage -or $title -cmatch '^(NOVI|Novi work)') { continue }
      $box = Find-Box $w
      if ($box) { $boxes += @{ hwnd = [int64]$w.Current.NativeWindowHandle; process = $proc; title = $title; text = $box.text; cut = [bool]$box.cut; buttons = $box.buttons } }
    } catch { }
  }
  return ,$boxes
}

function Press($hwnd, $button, $expect) {
  try {
    $w = $AE::FromHandle([IntPtr][int64]$hwnd)
    # Read the box again, right now: only the words on the card get this answer, and only inside this box.
    $box = Find-Box $w
    if (-not $box -or [string]$box.text -cne [string]$expect) { return $false }
    $hit = @($box.node.FindAll($Scope::Descendants, $isPress) | Where-Object { [string]$_.Current.Name -ceq $button })
    if ($hit.Count -ne 1) { return $false } # gone, or two with that name: press nothing rather than guess
    $pattern = $null
    if ($hit[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return $true }
    # A standard Windows button: a click message to that control, so the mouse never moves.
    $handle = $hit[0].Current.NativeWindowHandle
    if (-not $handle) { return $false }
    return [NoviWatch.Win32]::PostMessage([IntPtr][int64]$handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  } catch { return $false }
}

function Say($object) { [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

$last = $null
# Console.In blocks even when asked for async, so the scan would never run: read the raw stream instead.
$input2 = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$reading = $input2.ReadLineAsync()
$nextScan = Get-Date
while ($true) {
  if ($reading.IsCompleted) {
    $line = $reading.Result
    if ($null -eq $line) { break }
    try {
      $msg = $line | ConvertFrom-Json
      if ($msg.press) { Say @{ pressed = @{ id = $msg.press.id; ok = (Press $msg.press.hwnd $msg.press.button $msg.press.expect) } }; $nextScan = (Get-Date).AddMilliseconds(400) }
    } catch { }
    $reading = $input2.ReadLineAsync()
  }
  if ((Get-Date) -ge $nextScan) {
    $boxes = Scan
    $now = ConvertTo-Json -InputObject @($boxes) -Compress -Depth 6
    if ($now -ne $last) { $last = $now; [Console]::Out.WriteLine('{"boxes":' + $(if ($boxes.Count) { if ($now.StartsWith('[')) { $now } else { "[$now]" } } else { '[]' }) + '}'); [Console]::Out.Flush() }
    $nextScan = (Get-Date).AddSeconds(2)
  }
  Start-Sleep -Milliseconds 100
}
