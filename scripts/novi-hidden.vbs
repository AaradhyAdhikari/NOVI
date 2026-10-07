' Starts Novi with no console window (used by the "Novi" logon task).
' Builds the UI, then runs the supervisor, which restarts Novi if it crashes.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "cmd /c npm.cmd start", 0, False
