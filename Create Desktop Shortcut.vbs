' Put Companion on the desktop, with its own icon.
'
' Why this exists: a .vbs file cannot carry an icon. Windows draws every script
' with the Windows Script Host icon, and there is no property on the file to
' change that — the icon belongs to the shortcut, not to what it points at. So
' rather than have you set it by hand every time, this builds the shortcut and
' sets IconLocation to Companion.ico, which ships beside it.
'
' Run it again whenever you like; it overwrites the existing shortcut rather
' than making a second one. Pass --local for a shortcut that keeps the server
' loopback-only, with no phone access.
Option Explicit

Dim shell, fso, here, desktop, link, target, icon, args, i, extra
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(here, "Companion.vbs")
icon = fso.BuildPath(here, "Companion.ico")

If Not fso.FileExists(target) Then
  MsgBox "Companion.vbs is not beside this script." & vbCrLf & _
         "Keep the whole folder together and run this from inside it.", _
         vbExclamation, "Companion"
  WScript.Quit 1
End If

extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next

desktop = shell.SpecialFolders("Desktop")
Set link = shell.CreateShortcut(fso.BuildPath(desktop, "Companion.lnk"))
link.TargetPath = target
link.Arguments = Trim(extra)
link.WorkingDirectory = here
link.Description = "Companion — a read-only second screen for FC 26 Manager Career"

' Only claim the icon if it is actually there; a missing IconLocation leaves a
' shortcut with a blank square, which is worse than the default script icon.
If fso.FileExists(icon) Then link.IconLocation = icon & ", 0"

link.Save

MsgBox "Companion is on your desktop." & vbCrLf & vbCrLf & _
       "Double-click it to start the server and open the page." & vbCrLf & _
       "If the icon still looks like the old one, press F5 on the desktop.", _
       vbInformation, "Companion"
