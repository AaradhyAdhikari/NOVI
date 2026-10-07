# Removes the "Novi" logon task created by Install Autostart.cmd.
if (Get-ScheduledTask -TaskName 'Novi' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'Novi' -Confirm:$false
  Write-Host 'Done: Novi will no longer start by itself.'
} else {
  Write-Host 'Novi was not set to start by itself.'
}
