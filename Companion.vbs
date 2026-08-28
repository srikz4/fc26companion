' Companion, one double-click, no terminal flash.
' Runs Companion.cmd hidden; the server itself still appears as a minimised
' "Companion server" window in the taskbar so it can be watched or closed.
' Phone access is on by default; make a shortcut passing --local to disable.
Dim shell, fso, here, args, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
shell.Run """" & here & "\Companion.cmd""" & args, 0, False
